// Importing a Capacities "Full export" (Settings › Import): the ZIP is read here, in the browser,
// so it never travels whole. Its media files go to the server one at a time, by key (the server
// keeps one copy of the same bytes), then the space folder's Markdown files in one request, which
// the server maps and writes (packages/importer-capacities/src/export.ts).
import { inflateSync } from 'fflate'
import type { Id } from '@vasta/core'
import { api, MAX_UPLOAD_BYTES, type CapacitiesImportReport } from './api.ts'

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  svg: 'image/svg+xml', pdf: 'application/pdf', mp3: 'audio/mpeg', m4a: 'audio/mp4', oga: 'audio/ogg', ogg: 'audio/ogg',
  wav: 'audio/wav', webm: 'audio/webm', mp4: 'video/mp4', mov: 'video/quicktime',
}

/** A space folder of the export. */
export interface ExportSpace {
  name: string
  notes: number
  files: number
}

export interface ExportArchive {
  data: Uint8Array
  spaces: ExportSpace[]
}

export interface ImportProgress {
  phase: 'media' | 'notes'
  done: number
  total: number
}

export interface ImportOutcome {
  report: CapacitiesImportReport
  /** Media files over the server's upload limit, left out. */
  tooLarge: string[]
}

interface ZipEntry {
  name: string
  /** 0 stored, 8 deflated. */
  method: number
  compressedSize: number
  size: number
  /** Of its local header. */
  offset: number
}

// The archive's entries, read from its central directory. fflate's unzipSync takes the sizes ZIP64
// archives (as Capacities makes them) mark as 0xFFFFFFFF for real ones and allocates 4 GB per file,
// which a browser refuses; the real sizes are in the ZIP64 extra field read here.
function entries(data: Uint8Array): ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let end = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end === -1) throw new Error('not a ZIP archive')
  let count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  if ((count === 0xffff || at === 0xffffffff) && end >= 20 && view.getUint32(end - 20, true) === 0x07064b50) {
    const zip64 = Number(view.getBigUint64(end - 12, true))
    count = Number(view.getBigUint64(zip64 + 32, true))
    at = Number(view.getBigUint64(zip64 + 48, true))
  }
  const decoder = new TextDecoder()
  const found: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('not a ZIP archive')
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const entry: ZipEntry = {
      name: decoder.decode(data.subarray(at + 46, at + 46 + nameLength)),
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      offset: view.getUint32(at + 42, true),
    }
    // ZIP64 extra field: the 64-bit values of those marked 0xFFFFFFFF, in this order.
    for (let extra = at + 46 + nameLength; extra < at + 46 + nameLength + extraLength; extra += 4 + view.getUint16(extra + 2, true)) {
      if (view.getUint16(extra, true) !== 0x0001) continue
      let field = extra + 4
      for (const key of ['size', 'compressedSize', 'offset'] as const) {
        if (entry[key] !== 0xffffffff) continue
        entry[key] = Number(view.getBigUint64(field, true))
        field += 8
      }
    }
    if (!entry.name.endsWith('/')) found.push(entry)
    at += 46 + nameLength + extraLength + view.getUint16(at + 32, true)
  }
  return found
}

function unpack(data: Uint8Array, entry: ZipEntry): Uint8Array {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true)
  const raw = data.subarray(start, start + entry.compressedSize)
  if (entry.method === 0) return raw.slice()
  if (entry.method === 8) return inflateSync(raw, { out: new Uint8Array(entry.size) })
  throw new Error(`${entry.name} is compressed in a way Vasta cannot read`)
}

/** Read the export and list its space folders. Throws when the file is not one. */
export async function readExport(file: File): Promise<ExportArchive> {
  const data = new Uint8Array(await file.arrayBuffer())
  let list: ZipEntry[]
  try {
    list = entries(data)
  } catch {
    throw new Error('This file is not a ZIP archive.')
  }
  const spaces = new Map<string, ExportSpace>()
  for (const entry of list) {
    const slash = entry.name.indexOf('/')
    // macOS adds __MACOSX/ (resource forks) to archives it makes.
    if (slash === -1 || entry.name.startsWith('__MACOSX/')) continue
    const name = entry.name.slice(0, slash)
    const space = spaces.get(name) ?? { name, notes: 0, files: 0 }
    if (entry.name.endsWith('.md')) space.notes++
    else space.files++
    spaces.set(name, space)
  }
  const found = [...spaces.values()].filter((s) => s.notes)
  if (!found.length) throw new Error('No notes in this file. Choose the ZIP of a full export from Capacities.')
  return { data, spaces: found }
}

/** "<sha256>.<extension>", as the server's mediaKey. */
async function mediaKey(data: Uint8Array, name: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>))
  const hash = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
  const dot = name.lastIndexOf('.')
  const extension = dot === -1 ? '' : name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '')
  return extension ? `${hash}.${extension}` : hash
}

/** Import one space folder of the export into a space. */
export async function importExport(archive: ExportArchive, folder: string, spaceId: Id, progress: (p: ImportProgress) => void): Promise<ImportOutcome> {
  const prefix = `${folder}/`
  const list = entries(archive.data).filter((e) => e.name.startsWith(prefix))
  const notes = list.filter((e) => e.name.endsWith('.md'))
  const files = list.filter((e) => !e.name.endsWith('.md'))

  const media: Record<string, { key: string; name: string; sizeBytes: number; mimeType?: string }> = {}
  const tooLarge: string[] = []
  for (const [i, entry] of files.entries()) {
    progress({ phase: 'media', done: i, total: files.length })
    const path = entry.name.slice(prefix.length)
    if (entry.size > MAX_UPLOAD_BYTES) {
      tooLarge.push(path)
      continue
    }
    const data = unpack(archive.data, entry)
    const name = path.slice(path.lastIndexOf('/') + 1)
    const key = await mediaKey(data, name)
    const { missing } = await api.missingMedia([key])
    if (missing.length) await api.putMedia(key, data)
    const mimeType = MIME_BY_EXTENSION[name.slice(name.lastIndexOf('.') + 1).toLowerCase()]
    media[path] = { key, name, sizeBytes: data.byteLength, ...(mimeType ? { mimeType } : {}) }
  }

  progress({ phase: 'notes', done: 0, total: notes.length })
  const decoder = new TextDecoder()
  const markdown = Object.fromEntries(notes.map((entry) => [entry.name.slice(prefix.length), decoder.decode(unpack(archive.data, entry))]))
  const report = await api.importCapacities(spaceId, { markdown, media })
  progress({ phase: 'notes', done: notes.length, total: notes.length })
  return { report, tooLarge }
}
