// A space exported to take away (issue #1, docs/export.md): one ZIP with
//   vasta.json       everything, as the sync's rows with their clocks plus each object's Yjs text,
//                    in the shape the server's import of moved notes reads (transfer.ts ImportBatch)
//   <Type>/<Title>.md  each object as Markdown with its properties in front matter, links between
//                    objects as relative links (Obsidian and other Markdown apps follow them)
//   <Board>.canvas   each whiteboard as a JSON Canvas beside its note
//   media/<key>      the files objects use (pictures, PDFs, covers, link previews)
//   README.md        what is where
// The Markdown is for reading and for other apps; vasta.json is what an import reads back.
import { Readable } from 'node:stream'
import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate'
import {
  BOARD_FIELD,
  boardToJsonCanvas,
  commentsOf,
  readBoard,
  tagPath,
  toBase64,
  type Id,
  type ObjectRecord,
  type ObjectType,
  type PropertyDef,
  type Space,
} from '@vasta/core'
import { docToMarkdown } from '@vasta/core/markdown'
import type { MediaStore } from '@vasta/core/media'
import type { NodeStore, SyncRow } from '@vasta/core/node'
import { Y } from '@vasta/editor-schema/yjs'
import { dateText, valueOf } from './agent.ts'

export const EXPORT_FORMAT = 'vasta-export'
export const EXPORT_VERSION = 1

/** What vasta.json holds. */
export interface ExportJson {
  format: typeof EXPORT_FORMAT
  version: typeof EXPORT_VERSION
  exportedAt: string
  space: { id: Id; name: string }
  /** The space, its types, objects (trashed and templates too) and calendar subscriptions, as sync rows. */
  rows: SyncRow[]
  /** Each object's rich text as its Yjs state (base64), by object id. */
  texts: Record<Id, string>
}

export interface SpaceExport {
  /** The ZIP's name, e.g. "Notes 2026-11-05.zip". */
  name: string
  files: { path: string; data: Uint8Array }[]
  /** Media files to stream into the ZIP after the others. */
  media: { path: string; key: string }[]
}

const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|heic|bmp)$/i

/** A file or folder name from a title: no path or Markdown-link characters, not too long. */
export function safeName(text: string, fallback = 'Untitled'): string {
  const cleaned = text
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
  return cleaned || fallback
}

/** A relative link from a note in a folder to a path from the export's root. */
const fromNote = (path: string) => `../${path.split('/').map(encodeURIComponent).join('/')}`

/** A YAML key: plain when it can be, else quoted. */
const yamlKey = (key: string) => (/^[A-Za-z][\w -]*$/.test(key) && !/\s$/.test(key) ? key : JSON.stringify(key))
/** A YAML value: JSON is valid YAML, and keeps strings with colons or quotes safe. */
const yamlValue = (value: unknown) => JSON.stringify(value)

/** Every media key a row of an object points at: its file, a weblink's preview, a cover. */
function mediaKeysOf(object: ObjectRecord): string[] {
  const keys = [object.media?.file?.key, object.media?.previewImageFile?.key]
  const cover = /^\/media\/([^/?#]+)$/.exec(object.coverUrl ?? '')?.[1]
  if (cover) keys.push(decodeURIComponent(cover))
  return keys.filter((k): k is string => !!k)
}

/** Everything of a space, in rev order, as the sync hands it out (rows only; no tombstones). */
function spaceRows(store: NodeStore, spaceId: Id): SyncRow[] {
  const rows: SyncRow[] = []
  let since = 0
  for (;;) {
    const page = store.syncChanges([spaceId], since, 1000)
    rows.push(...page.rows)
    const last = [...page.rows.map((r) => r.rev), ...page.tombstones.map((t) => t.rev)].reduce((a, b) => Math.max(a, b), since)
    if (!page.more || last === since) break
    since = last
  }
  return rows
}

/** Build the files of a space's export (media are listed, read when the ZIP is written). */
export function buildExport(store: NodeStore, spaceId: Id, options: { now: string; media?: boolean }): SpaceExport {
  const space = store.getSpace(spaceId) as Space | undefined
  if (!space) throw new Error(`no space ${spaceId}`)
  const rows = spaceRows(store, spaceId)
  const objects = rows.filter((r) => r.table === 'objects').map((r) => r.record as ObjectRecord)
  const types = new Map(rows.filter((r) => r.table === 'types').map((r) => [r.id, r.record as ObjectType]))
  const byId = new Map(objects.map((o) => [o.id, o]))

  // vasta.json ------------------------------------------------------------------------------------
  const texts: Record<Id, string> = {}
  for (const object of objects) {
    const ydoc = store.loadText(object.id)
    if (ydoc) texts[object.id] = toBase64(Y.encodeStateAsUpdate(ydoc))
  }
  const json: ExportJson = { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: options.now, space: { id: space.id, name: space.name }, rows, texts }
  const files: SpaceExport['files'] = [{ path: 'vasta.json', data: strToU8(JSON.stringify(json)) }]

  // Media -----------------------------------------------------------------------------------------
  const mediaKeys = [...new Set(objects.flatMap(mediaKeysOf))].sort()
  const media = options.media === false ? [] : mediaKeys.map((key) => ({ key, path: `media/${key}` }))
  const mediaPath = (key: string) => `media/${key}`

  // Where each note goes: a folder per type (daily notes by day), names unique within a folder.
  const shown = objects.filter((o) => !o.deletedAt && !o.template)
  const paths = new Map<Id, string>()
  const stems = new Map<Id, string>()
  const taken = new Set<string>()
  const folderOf = (o: ObjectRecord) => {
    const type = types.get(o.typeId)
    return type?.system === 'daily-note' ? 'Daily notes' : safeName(type?.pluralName ?? 'Objects', 'Objects')
  }
  for (const o of [...shown].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
    const folder = folderOf(o)
    const base = types.get(o.typeId)?.system === 'daily-note' && o.date ? o.date.start.slice(0, 10) : safeName(o.title)
    let stem = base
    for (let n = 2; taken.has(`${folder}/${stem}`.toLowerCase()); n++) stem = `${base} (${n})`
    taken.add(`${folder}/${stem}`.toLowerCase())
    stems.set(o.id, stem)
    paths.set(o.id, `${folder}/${stem}.md`)
  }

  const titleOf = (id: Id) => byId.get(id)?.title
  const personName = (id: Id) => store.getUser(id)?.name ?? 'Former member'
  /** A link to another note in front matter: [[its file]] when exported, else its title. */
  const noteRef = (id: Id) => (stems.has(id) ? `[[${stems.get(id)}]]` : (titleOf(id) ?? id))

  /** Links between objects (vasta://o/<id>) as relative links; embedded pictures as the picture. */
  const rewrite = (markdown: string) =>
    markdown.replace(/(!?)\[([^\]]*)\]\(vasta:\/\/o\/([^)#\s]+)(?:#b-[A-Za-z0-9]+)?\)/g, (_whole, bang: string, text: string, id: string) => {
      const target = byId.get(decodeURIComponent(id))
      const file = target?.media?.file
      if (bang && file && media.length) return `${IMAGE.test(file.key) ? '!' : ''}[${text || file.name}](${fromNote(mediaPath(file.key))})`
      const path = target && paths.get(target.id)
      // An object that is gone (or in the trash) leaves its name, as plain text.
      return path ? `[${text}](${fromNote(path)})` : text
    })

  const frontMatter = (o: ObjectRecord, type: ObjectType | undefined) => {
    const lines: [string, unknown][] = [
      ['id', o.id],
      ['title', o.title],
      ['type', type?.name ?? ''],
      ['created', o.createdAt],
      ['updated', o.updatedAt],
    ]
    if (o.date) lines.push(['date', dateText(o.date)])
    if (o.aliases.length) lines.push(['aliases', o.aliases])
    if (o.tagIds.length) lines.push(['tags', o.tagIds.map((id) => tagPath(id, (at) => byId.get(at)).replace(/\s+/g, '-'))])
    if (o.collectionIds.length) lines.push(['collections', o.collectionIds.map(noteRef)])
    if (o.media?.url) lines.push(['url', o.media.url])
    if (o.coverUrl) {
      const key = /^\/media\/([^/?#]+)$/.exec(o.coverUrl)?.[1]
      lines.push(['cover', key && media.length ? mediaPath(decodeURIComponent(key)) : o.coverUrl])
    }
    const reserved = new Set(lines.map(([k]) => k.toLowerCase()))
    for (const def of type?.properties ?? []) {
      if (def.kind === 'rich-text' || def.kind === 'formula') continue
      const value = o.props[def.id]
      if (!value) continue
      const name = reserved.has(def.name.toLowerCase()) ? `${def.name} (property)` : def.name
      lines.push([name, propertyValue(def, value, noteRef, personName)])
    }
    return ['---', ...lines.map(([k, v]) => `${yamlKey(k)}: ${yamlValue(v)}`), '---', ''].join('\n')
  }

  for (const o of shown) {
    const type = types.get(o.typeId)
    const path = paths.get(o.id)!
    const body: string[] = []
    const file = o.media?.file
    if (file) body.push(media.length ? `${IMAGE.test(file.key) ? '!' : ''}[${file.name}](${fromNote(mediaPath(file.key))})` : `File: ${file.name}`)
    if (type?.system === 'weblink' && o.media?.url) body.push(`<${o.media.url}>`)
    if (type?.system === 'whiteboard') {
      const ydoc = store.loadText(o.id)
      if (ydoc) {
        const canvas = boardToJsonCanvas(readBoard(ydoc), (id) => (paths.has(id) ? { title: titleOf(id) ?? '', url: paths.get(id)! } : undefined))
        const canvasPath = path.replace(/\.md$/, '.canvas')
        files.push({ path: canvasPath, data: strToU8(JSON.stringify(canvas, null, 2)) })
        body.push(`[Open the board](${encodeURIComponent(stems.get(o.id)!)}.canvas)`)
      }
    }
    // Text fields: the type's in order, then any others (a board's derived blocks).
    const fields = (type?.properties ?? []).filter((p) => p.kind === 'rich-text').map((p) => [p.id, p.name] as const)
    for (const key of Object.keys(o.content)) if (!fields.some(([id]) => id === key)) fields.push([key, key === BOARD_FIELD ? 'On the board' : key])
    const written = fields.filter(([id]) => o.content[id]?.content.length)
    for (const [id, name] of written) {
      const markdown = rewrite(docToMarkdown(o.content[id], { titleOf: (at) => titleOf(at) ?? '' })).trim()
      if (!markdown) continue
      if (written.length > 1 || id === BOARD_FIELD) body.push(`## ${name}`)
      body.push(markdown)
    }
    const comments = commentsOf(o)
    if (comments.length) body.push('## Comments', comments.map((c) => `- **${personName(c.author)}** (${c.at.slice(0, 10)}): ${c.text.replace(/\n/g, ' ')}`).join('\n'))
    files.push({ path, data: strToU8(`${frontMatter(o, type)}\n${body.join('\n\n')}\n`) })
  }

  const day = options.now.slice(0, 10)
  files.unshift({ path: 'README.md', data: strToU8(readme(space, day, shown.length, objects.length, media.length, mediaKeys.length)) })
  return { name: `${safeName(space.name, 'Space')} ${day}.zip`, files, media }
}

/** A property's value in front matter: words, numbers and lists, related objects as [[links]]. */
function propertyValue(def: PropertyDef, value: ObjectRecord['props'][string], noteRef: (id: Id) => string, personName: (id: Id) => string): unknown {
  const shown = valueOf(def, value, (ids) => ids.map((id) => ({ id, title: noteRef(id) })), personName)
  if (def.kind === 'relation') {
    const list = (shown as { title: string }[]).map((r) => r.title)
    return def.multiple ? list : list[0]
  }
  return shown
}

function readme(space: Space, day: string, notes: number, objects: number, files: number, known: number) {
  return `# ${space.name}

Exported from Vasta on ${day}.

- One folder per type, a Markdown file per object (${notes} of them): its properties in the front
  matter, its text below, links to other objects as links to their files. Daily notes are in
  "Daily notes", named by day. Whiteboards also have a \`.canvas\` file (JSON Canvas, which
  Obsidian opens).
- \`media/\`: the files objects use (${files}${files === known ? '' : ` of ${known}; the export was made without them`}).
- \`vasta.json\`: everything (${objects} objects, the trash and templates included), the way Vasta
  stores it, nothing left out. Its format is described in Vasta's docs/export.md.

Open the folder in Obsidian or any Markdown editor to read it.
`
}

/**
 * The export as a ZIP stream: text files compressed, media copied as they are. Media are read one
 * at a time while the ZIP is being read, so a large space never sits in memory whole. A file the
 * store has lost is left out.
 */
export function zipExport(exported: SpaceExport, store: MediaStore): ReadableStream<Uint8Array> {
  async function* chunks() {
    const queue: Uint8Array[] = []
    let failure: Error | null = null
    const zip = new Zip((error, chunk) => {
      if (error) failure = error
      else queue.push(chunk)
    })
    const drain = function* () {
      if (failure) throw failure
      while (queue.length) yield queue.shift()!
    }
    for (const file of exported.files) {
      const entry = new ZipDeflate(file.path, { level: 6 })
      zip.add(entry)
      entry.push(file.data, true)
      yield* drain()
    }
    for (const item of exported.media) {
      const file = await store.get(item.key).catch(() => undefined)
      if (!file) continue
      const entry = new ZipPassThrough(item.path)
      zip.add(entry)
      const reader = file.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        entry.push(value)
        yield* drain()
      }
      entry.push(new Uint8Array(0), true)
      yield* drain()
    }
    zip.end()
    yield* drain()
  }
  return Readable.toWeb(Readable.from(chunks())) as unknown as ReadableStream<Uint8Array>
}

