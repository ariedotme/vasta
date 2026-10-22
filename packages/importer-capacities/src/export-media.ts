// Attaches media files from a Capacities "Full export" ZIP to imported objects.
//
// The export is Markdown: one folder per space, one folder per type, one .md file per object
// with YAML front matter (type, title, createdAt…). Media objects reference their file with a
// line such as `Media: ![Image](./Media/Some%20name.png)`. The export carries no object ids, so
// files are matched to objects by media kind and exact creation time, with the title as a check.
import { unzipSync } from 'fflate'
import { readFileSync } from 'node:fs'
import type { ObjectRecord, Space, SystemTypeKey } from '@vasta/core'
import type { MediaStore } from '@vasta/core/media'

const EXPORT_TYPE_TO_SYSTEM: Record<string, SystemTypeKey> = {
  Image: 'image',
  PDF: 'pdf',
  Audio: 'audio',
  Video: 'video',
  File: 'file',
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', svg: 'image/svg+xml', pdf: 'application/pdf', mp3: 'audio/mpeg', m4a: 'audio/mp4',
  oga: 'audio/ogg', ogg: 'audio/ogg', wav: 'audio/wav', webm: 'audio/webm', mp4: 'video/mp4', mov: 'video/quicktime',
}

export interface ExportMediaEntry {
  space: string
  system: SystemTypeKey
  title: string
  createdAt: string
  /** Path of the media file inside the archive. */
  file: string
}

export interface MediaAttachReport {
  entries: number
  attached: number
  withoutFile: number
  unmatched: { title: string; createdAt: string }[]
}

/** Minimal front matter reader: flat `key: value` lines between `---` fences. */
export function readFrontMatter(markdown: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---/.exec(markdown)
  const fields: Record<string, string> = {}
  for (const line of match?.[1]?.split('\n') ?? []) {
    const kv = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    let value = kv[2]!.trim()
    if (/^'.*'$/.test(value)) value = value.slice(1, -1).replace(/''/g, "'")
    else if (/^".*"$/.test(value)) value = JSON.parse(value) as string
    fields[kv[1]!] = value
  }
  return fields
}

export function listExportMedia(files: Record<string, Uint8Array>): ExportMediaEntry[] {
  const entries: ExportMediaEntry[] = []
  const decoder = new TextDecoder()
  for (const [name, data] of Object.entries(files)) {
    if (!name.endsWith('.md')) continue
    const markdown = decoder.decode(data)
    const meta = readFrontMatter(markdown)
    const system = EXPORT_TYPE_TO_SYSTEM[meta.type ?? '']
    if (!system || !meta.createdAt) continue
    const link = /^Media: !\[[^\]]*\]\((\.\/Media\/.+)\)\s*$/m.exec(markdown)?.[1]
    const folder = name.slice(0, name.lastIndexOf('/'))
    entries.push({
      space: name.split('/')[0]!,
      system,
      title: meta.title ?? '',
      createdAt: meta.createdAt,
      file: link ? `${folder}/${decodeURIComponent(link.slice(2))}` : '',
    })
  }
  return entries
}

export function readExportArchive(zipPath: string): Record<string, Uint8Array> {
  return unzipSync(readFileSync(zipPath))
}

/** Copy matched media files into the store and record them on the objects (mutates `objects`). */
export async function attachExportMedia(
  files: Record<string, Uint8Array>,
  spaces: Space[],
  objects: ObjectRecord[],
  media: MediaStore
): Promise<MediaAttachReport> {
  const entries = listExportMedia(files)
  const spaceIdByName = new Map(spaces.map((space) => [space.name, space.id]))
  const report: MediaAttachReport = { entries: entries.length, attached: 0, withoutFile: 0, unmatched: [] }
  const candidates = new Map<string, ObjectRecord[]>()
  for (const object of objects) {
    const system = object.typeId.split(':')[0]
    const key = `${object.spaceId}|${system}|${object.createdAt}`
    candidates.set(key, [...(candidates.get(key) ?? []), object])
  }
  for (const entry of entries) {
    const data = entry.file ? files[entry.file] : undefined
    if (!data) {
      report.withoutFile++
      continue
    }
    const spaceId = spaceIdByName.get(entry.space)
    const matches = candidates.get(`${spaceId}|${entry.system}|${entry.createdAt}`) ?? []
    const object = matches.length > 1 ? matches.find((o) => o.title === entry.title) ?? matches[0] : matches[0]
    if (!object) {
      report.unmatched.push({ title: entry.title, createdAt: entry.createdAt })
      continue
    }
    const name = entry.file.slice(entry.file.lastIndexOf('/') + 1)
    const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    const mimeType = object.media?.mimeType ?? MIME_BY_EXTENSION[extension]
    object.media = { ...object.media, file: await media.put(data, name, mimeType) }
    report.attached++
  }
  return report
}
