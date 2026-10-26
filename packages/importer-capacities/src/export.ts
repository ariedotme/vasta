// Maps a Capacities "Full export" (a ZIP of Markdown files) to Vasta types and objects, into a
// space that may already hold notes.
//
// The export has one folder per space, one folder per type in it and one .md file per object:
// YAML front matter (type, title, tags, the type's properties by camelCased name) and the body in
// Markdown. Media objects carry their file in a Media/ folder next to them. Objects link to each
// other with relative Markdown links ([Title](../People/Title.md)) or, when chosen at export,
// wikilinks ([[Title]], [[File name|label]]); a date mention is [[Date/2026-05-04]].
//
// The export has no ids and no property definitions, so properties are read off their values
// (a link is a relation, an ISO date a date, a short repeated word a select…), types get the name
// of their front matter `type` split into words, and queries come without their filters.
import {
  BODY_PROPERTY_ID,
  builtinTypeId,
  dailyNoteId,
  type DateValue,
  type Doc,
  type DocNode,
  type Icon,
  type Id,
  type IsoDateTime,
  type MediaInfo,
  type ObjectRecord,
  type ObjectType,
  type PropertyDef,
  type PropertyValue,
  type SelectOption,
  type StoredFile,
  type SystemTypeKey,
} from '@vasta/core'
import { markdownToDoc } from '@vasta/core/markdown'
import { parse as parseYaml } from 'yaml'
import { Warnings } from './common.ts'

/** Capacities' built-in types, by their front matter `type`. */
const SYSTEM_TYPES: Record<string, SystemTypeKey> = {
  Page: 'page',
  DailyNote: 'daily-note',
  Tag: 'tag',
  Collection: 'collection',
  Query: 'query',
  Task: 'task',
  Weblink: 'weblink',
  Image: 'image',
  PDF: 'pdf',
  Audio: 'audio',
  Video: 'video',
  File: 'file',
}

const MEDIA_TYPES = new Set<SystemTypeKey>(['image', 'pdf', 'audio', 'video', 'file'])

/** Front matter keys that are fields of every object rather than properties. */
const FIELD_KEYS = new Set(['type', 'title', 'aliases', 'description', 'icon', 'tags', 'createdAt', 'lastUpdated'])

const TASK_STATUS: Record<string, string> = { 'not started': 'todo', 'not-started': 'todo', 'in progress': 'doing', 'in-progress': 'doing', done: 'done' }
const TASK_PRIORITY = new Set(['high', 'medium', 'low'])
/** A task's due date, under the names Capacities gives it in the languages it speaks. */
const TASK_DUE_KEYS = new Set(['due', 'dueDate', 'deadline', 'prazo', 'vencimento', 'fechaLimite', 'vencimiento', 'echeance', 'faelligkeit', 'fälligkeit'])

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/
const DATE_RANGE = /^(\S+) -> (\S+)$/
const MARKDOWN_LINK = /^\[([^\]]*)\]\((.+)\)$/
const WIKILINK = /\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g
const DATE_LINK = /^Date\/(\d{4}-\d{2}-\d{2})(?: \d{2}:\d{2})?$/
const MEDIA_LINE = /^Media: (?:!\[[^\]]*\]\((.+)\)|.*)\s*$/m
const MIME = /^[a-z]+\/[a-z0-9.+-]+$/

/** The space being imported into. */
export interface ExportTarget {
  spaceId: Id
  types: ObjectType[]
  /** Its tags, matched to the export's by name. */
  tags: { id: Id; title: string }[]
  /** Its daily note of a day, which imported notes of that day are added to. */
  dailyNote(day: string): ObjectRecord | undefined
  /** Whether an id is taken (a daily note's derived id may be, by one in the trash). */
  exists(id: Id): boolean
  newId(): Id
}

export interface ExportInput {
  /** The space folder's Markdown files, by path inside it ("People/Ada.md"). */
  markdown: Record<string, string>
  /** Media files already in the media store, by path inside the space folder ("Images/Media/Cat.png"). */
  media: Record<string, StoredFile>
}

export interface ExportReport {
  objects: number
  objectsByType: Record<string, number>
  /** Daily notes that existed already, which the imported ones were added to. */
  mergedDailyNotes: number
  types: { created: string[]; matched: string[] }
  tags: { created: number; matched: number }
  media: { attached: number; missing: string[] }
  /** Links to notes that are not in the export, by the name they gave. */
  unresolvedLinks: string[]
  /** Queries, which the export carries without their filters. */
  queries: string[]
  skipped: string[]
  warnings: Record<string, number>
}

export interface ExportImport {
  /** New types, and existing ones given properties. */
  types: ObjectType[]
  /** New objects, and existing daily notes given the imported ones' text. */
  objects: ObjectRecord[]
  report: ExportReport
}

interface Entry {
  /** Path inside the space folder. */
  path: string
  folder: string
  /** File name without .md. */
  name: string
  capType: string
  fields: Record<string, unknown>
  body: string
  id: Id
  typeId: Id
  system?: SystemTypeKey
  /** Set for a daily note that already exists. */
  existing?: ObjectRecord
}

/** "PersonagemDeRpg" → "Personagem de rpg". */
export function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z]{2,})/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
  return words.map((word, i) => (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : /^[A-Z]{2,}$/.test(word) ? word : word.toLowerCase())).join(' ')
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()

function splitFrontMatter(markdown: string, warnings: Warnings): { fields: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown)
  if (!match) return { fields: {}, body: markdown }
  try {
    const fields = parseYaml(match[1]!) as unknown
    return { fields: fields && typeof fields === 'object' ? (fields as Record<string, unknown>) : {}, body: markdown.slice(match[0].length) }
  } catch {
    warnings.add('front matter that could not be read')
    return { fields: {}, body: markdown.slice(match[0].length) }
  }
}

/** A path relative to `folder`, normalized (".." and "." resolved, %-escapes decoded). */
function resolvePath(folder: string, href: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(href)
  } catch {
    decoded = href
  }
  const parts = folder ? folder.split('/') : []
  for (const part of decoded.split('/')) {
    if (part === '..') {
      if (!parts.length) return undefined
      parts.pop()
    } else if (part && part !== '.') parts.push(part)
  }
  return parts.join('/')
}

const isEmpty = (value: unknown) => value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)

function toIcon(value: unknown): Icon | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const text = value.trim()
  if (/^[a-z0-9]+[-:][a-z0-9-]+$/.test(text)) return { kind: 'icon', value: text.includes(':') ? text : text.replace(/^([a-z0-9]+)-/, '$1:') }
  return { kind: 'emoji', value: text }
}

function toDate(value: unknown): DateValue | undefined {
  if (typeof value !== 'string') return undefined
  const range = DATE_RANGE.exec(value.trim())
  const [start, end] = range ? [range[1]!, range[2]!] : [value.trim(), undefined]
  if (!ISO_DATE.test(start) || (end && !ISO_DATE.test(end))) return undefined
  const withTime = !start.endsWith('T00:00:00.000Z') || (!!end && !end.endsWith('T00:00:00.000Z'))
  return { start, ...(end ? { end } : {}), resolution: withTime ? 'time' : 'day' }
}

const isUrl = (value: string) => /^https?:\/\/\S+$/.test(value)

/** Values of a select: Capacities writes several labels as "A, B". */
const labels = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).flatMap((v) => (typeof v === 'string' ? v.split(', ') : typeof v === 'number' ? [String(v)] : [])).map((v) => v.trim()).filter(Boolean)

type Shape = 'relation' | 'checkbox' | 'number' | 'date' | 'url' | 'select' | 'text'

export function mapExport(input: ExportInput, target: ExportTarget, now: IsoDateTime = new Date().toISOString()): ExportImport {
  const warnings = new Warnings()
  const report: ExportReport = {
    objects: 0,
    objectsByType: {},
    mergedDailyNotes: 0,
    types: { created: [], matched: [] },
    tags: { created: 0, matched: 0 },
    media: { attached: 0, missing: [] },
    unresolvedLinks: [],
    queries: [],
    skipped: [],
    warnings: {},
  }
  const spaceId = target.spaceId
  const unresolved = new Set<string>()

  // -------------------------------------------------------------------------
  // The files and their types

  const typesById = new Map(target.types.map((type) => [type.id, structuredClone(type)]))
  const changedTypes = new Set<Id>()
  const typeByName = new Map<string, Id>()
  for (const type of target.types) if (!type.deletedAt) typeByName.set(fold(type.name), type.id)
  const typeForCap = new Map<string, Id>()

  const typeIdFor = (capType: string, folder: string): { typeId: Id; system?: SystemTypeKey } => {
    const system = SYSTEM_TYPES[capType]
    if (system) return { typeId: builtinTypeId(spaceId, system), system }
    const known = typeForCap.get(capType)
    if (known) return { typeId: known, ...(typesById.get(known)?.system ? { system: typesById.get(known)!.system! } : {}) }
    const name = humanize(capType)
    const matched = typeByName.get(fold(name))
    if (matched) {
      typeForCap.set(capType, matched)
      report.types.matched.push(typesById.get(matched)!.name)
      const matchedSystem = typesById.get(matched)!.system
      return { typeId: matched, ...(matchedSystem ? { system: matchedSystem } : {}) }
    }
    const id = target.newId()
    typesById.set(id, {
      id,
      spaceId,
      name,
      pluralName: humanize(folder.split('/').pop() || capType),
      properties: [{ id: BODY_PROPERTY_ID, kind: 'rich-text', name: 'Notes' }],
      views: [{ id: `${id}:all`, name: 'All', layout: 'list' }],
      createdAt: now,
      updatedAt: now,
    })
    changedTypes.add(id)
    typeForCap.set(capType, id)
    typeByName.set(fold(name), id)
    report.types.created.push(name)
    return { typeId: id }
  }

  const entries: Entry[] = []
  const takenDailyIds = new Set<Id>()
  for (const [path, markdown] of Object.entries(input.markdown).sort(([a], [b]) => a.localeCompare(b))) {
    if (!path.endsWith('.md')) continue
    const slash = path.lastIndexOf('/')
    const folder = slash === -1 ? '' : path.slice(0, slash)
    const name = path.slice(slash + 1, -3)
    const { fields, body } = splitFrontMatter(markdown, warnings)
    const capType = typeof fields.type === 'string' ? fields.type.trim() : ''
    if (!capType) {
      report.skipped.push(path)
      continue
    }
    const { typeId, system } = typeIdFor(capType, folder)
    if (!typesById.has(typeId)) {
      // A space made before a built-in type existed.
      report.skipped.push(path)
      warnings.add(`notes of a type the space lacks (${capType})`)
      continue
    }
    let id = target.newId()
    let existing: ObjectRecord | undefined
    if (system === 'daily-note') {
      const day = toDate(fields.date)?.start.slice(0, 10)
      if (!day) {
        report.skipped.push(path)
        warnings.add('daily notes without a date')
        continue
      }
      fields.date = `${day}T00:00:00.000Z`
      existing = target.dailyNote(day)
      const derived = dailyNoteId(spaceId, day)
      if (existing) id = existing.id
      else if (!target.exists(derived) && !takenDailyIds.has(derived)) id = derived
      takenDailyIds.add(id)
    }
    entries.push({ path, folder, name, capType, fields, body, id, typeId, ...(system ? { system } : {}), ...(existing ? { existing } : {}) })
  }

  // -------------------------------------------------------------------------
  // Links: by path, and by file name for wikilinks (the same name in two folders goes to the
  // first; a link from the same folder prefers its neighbour)

  const byPath = new Map(entries.map((entry) => [entry.path, entry]))
  const byName = new Map<string, Entry[]>()
  for (const entry of entries) {
    for (const key of new Set([entry.name, fold(entry.name)])) byName.set(key, [...(byName.get(key) ?? []), entry])
  }

  /** Daily notes that date mentions point to and the export lacks, made on the way. */
  const madeDailyNotes = new Map<string, ObjectRecord>()
  const dailyNoteFor = (day: string): Id => {
    const inExport = entries.find((e) => e.system === 'daily-note' && (e.fields.date as string).startsWith(day))
    if (inExport) return inExport.id
    const existing = target.dailyNote(day) ?? madeDailyNotes.get(day)
    if (existing) return existing.id
    const derived = dailyNoteId(spaceId, day)
    const id = target.exists(derived) || takenDailyIds.has(derived) ? target.newId() : derived
    takenDailyIds.add(id)
    const type = typesById.get(builtinTypeId(spaceId, 'daily-note'))!
    madeDailyNotes.set(day, {
      id,
      spaceId,
      typeId: type.id,
      title: '',
      aliases: [],
      tagIds: [],
      collectionIds: [],
      props: {},
      content: {},
      date: { start: `${day}T00:00:00.000Z`, resolution: 'day' },
      createdAt: now,
      updatedAt: now,
    })
    return id
  }

  /** The object a link points to: a relative path to a .md file, or a wikilink's name. */
  const resolve = (from: Entry, link: { href?: string; wiki?: string }): Id | undefined => {
    if (link.href !== undefined) {
      if (/^[a-z]+:/i.test(link.href) || !/\.md$/i.test(link.href.split('#')[0]!)) return undefined
      const path = resolvePath(from.folder, link.href.split('#')[0]!)
      return path ? byPath.get(path)?.id : undefined
    }
    const name = link.wiki!.trim()
    const date = DATE_LINK.exec(name)
    if (date) return dailyNoteFor(date[1]!)
    // The export doubles a quote in some wikilinks ("Peterson''s").
    const candidates = byName.get(name) ?? byName.get(name.replaceAll("''", "'")) ?? byName.get(fold(name)) ?? []
    return (candidates.find((c) => c.folder === from.folder) ?? candidates[0])?.id
  }

  /** A property value's link ('[Title](../X/Title.md)' or '[[Title]]'), or undefined when it is not one. */
  const linkIn = (from: Entry, value: unknown): { id?: Id; label: string } | undefined => {
    if (typeof value !== 'string') return undefined
    const text = value.trim()
    const markdown = MARKDOWN_LINK.exec(text)
    if (markdown && /\.md$/i.test(markdown[2]!)) return { label: markdown[1]!, ...withId(resolve(from, { href: markdown[2]! })) }
    const wiki = /^\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]$/.exec(text)
    if (wiki) return { label: wiki[2] ?? wiki[1]!, ...withId(resolve(from, { wiki: wiki[1]! })) }
    return undefined
  }
  const withId = (id: Id | undefined) => (id ? { id } : {})

  // -------------------------------------------------------------------------
  // Properties, read off the values each type's notes have

  const entriesOfType = new Map<Id, Entry[]>()
  for (const entry of entries) entriesOfType.set(entry.typeId, [...(entriesOfType.get(entry.typeId) ?? []), entry])

  /** Front matter key → property, per type. */
  const propertyFor = new Map<Id, Map<string, PropertyDef>>()
  /** Select labels → option ids, per property. */
  const optionIds = new Map<PropertyDef, Map<string, Id>>()

  const shapeOf = (from: Entry, value: unknown): Shape => {
    const values = Array.isArray(value) ? value : [value]
    if (values.every((v) => linkIn(from, v))) return 'relation'
    if (Array.isArray(value)) return values.every((v) => typeof v === 'string' && !v.includes('\n')) ? 'select' : 'text'
    if (typeof value === 'boolean') return 'checkbox'
    if (typeof value === 'number') return 'number'
    if (typeof value !== 'string') return 'text'
    if (toDate(value)) return 'date'
    if (isUrl(value.trim())) return 'url'
    const parts = labels(value)
    if (!value.includes('\n') && !/\]\(|https?:\/\//.test(value) && parts.every((p) => p.length <= 50)) return 'select'
    return 'text'
  }

  const addProperty = (type: ObjectType, key: string, shape: Shape, values: { entry: Entry; value: unknown }[]): PropertyDef => {
    const name = humanize(key)
    const existing = type.properties.find((p) => fold(p.name) === fold(name))
    if (existing && (existing.kind === shape || (shape === 'url' && existing.kind === 'text'))) return existing
    const id = target.newId()
    const base = { id, name: existing ? `${name} (Capacities)` : name }
    let def: PropertyDef
    switch (shape) {
      case 'relation': {
        const targets = new Set<Id>()
        let multiple = false
        for (const { entry, value } of values) {
          if (Array.isArray(value)) multiple = true
          for (const v of Array.isArray(value) ? value : [value]) {
            const id = linkIn(entry, v)?.id
            const to = id && entries.find((e) => e.id === id)
            if (to) targets.add(to.typeId)
          }
        }
        def = { ...base, kind: 'relation', multiple, targetTypeIds: [...targets] }
        break
      }
      case 'date': {
        const dates = values.map(({ value }) => toDate(value)).filter((d): d is DateValue => !!d)
        def = { ...base, kind: 'date', withTime: dates.some((d) => d.resolution === 'time'), ...(dates.some((d) => d.end) ? { allowRange: true } : {}) }
        break
      }
      case 'select': {
        const all = [...new Set(values.flatMap(({ value }) => labels(value)))]
        const multiple = values.some(({ value }) => labels(value).length > 1 || Array.isArray(value))
        def = { ...base, kind: 'select', multiple, options: all.map((label): SelectOption => ({ id: target.newId(), label })) }
        break
      }
      default:
        def = { ...base, kind: shape } as PropertyDef
    }
    type.properties.push(def)
    changedTypes.add(type.id)
    return def
  }

  for (const [typeId, list] of entriesOfType) {
    const type = typesById.get(typeId)!
    const map = new Map<string, PropertyDef>()
    propertyFor.set(typeId, map)
    // What the built-in types hold in fields of their own (media, links, queries) is read below.
    if (type.system && (MEDIA_TYPES.has(type.system) || type.system === 'weblink' || type.system === 'query' || type.system === 'tag')) continue
    const keys = [...new Set(list.flatMap((entry) => Object.keys(entry.fields)))].filter((key) => !FIELD_KEYS.has(key) && !(type.system === 'daily-note' && key === 'date'))
    for (const key of keys) {
      const values = list.flatMap((entry) => (isEmpty(entry.fields[key]) ? [] : [{ entry, value: entry.fields[key] }]))
      if (type.system === 'task') {
        const words = values.flatMap(({ value }) => labels(value).map((v) => v.toLowerCase()))
        if (key === 'status' && words.every((w) => TASK_STATUS[w])) continue
        if (words.length && words.every((w) => TASK_PRIORITY.has(w))) {
          map.set(key, type.properties.find((p) => p.id === 'priority')!)
          continue
        }
        if (TASK_DUE_KEYS.has(key) && values.every(({ value }) => toDate(value))) {
          map.set(key, type.properties.find((p) => p.id === 'due')!)
          continue
        }
      }
      // A key no note fills in tells nothing of what it holds.
      if (!values.length) continue
      // Values that disagree (a date in one note, words in another) make text.
      const shapes = new Set(values.map(({ entry, value }) => shapeOf(entry, value)))
      const shape: Shape = shapes.size === 1 ? [...shapes][0]! : 'text'
      map.set(key, addProperty(type, key, shape, values))
    }
  }

  const optionId = (def: Extract<PropertyDef, { kind: 'select' }>, label: string): Id => {
    let ids = optionIds.get(def)
    if (!ids) {
      ids = new Map(def.options.map((o) => [fold(o.label), o.id]))
      optionIds.set(def, ids)
    }
    const known = ids.get(fold(label))
    if (known) return known
    const id = target.newId()
    def.options.push({ id, label })
    ids.set(fold(label), id)
    for (const type of typesById.values()) if (type.properties.includes(def)) changedTypes.add(type.id)
    return id
  }

  const valueOf = (entry: Entry, def: PropertyDef, raw: unknown): PropertyValue | undefined => {
    switch (def.kind) {
      case 'relation': {
        const ids: Id[] = []
        for (const v of Array.isArray(raw) ? raw : [raw]) {
          const link = linkIn(entry, v)
          if (link?.id) ids.push(link.id)
          else if (link) unresolved.add(link.label)
        }
        return ids.length ? { kind: 'relation', value: ids } : undefined
      }
      case 'date': {
        const date = toDate(raw)
        return date ? { kind: 'date', value: date } : undefined
      }
      case 'checkbox':
        return typeof raw === 'boolean' ? { kind: 'checkbox', value: raw } : undefined
      case 'number':
        return typeof raw === 'number' ? { kind: 'number', value: raw } : undefined
      case 'url':
        return typeof raw === 'string' ? { kind: 'url', value: raw.trim() } : undefined
      case 'select': {
        const values = labels(raw).map((label) => (def.id === 'priority' ? label.toLowerCase() : optionId(def, label)))
        return values.length ? { kind: 'select', value: def.multiple ? values : values.slice(0, 1) } : undefined
      }
      case 'text': {
        const text = Array.isArray(raw) ? raw.map(String).join(', ') : typeof raw === 'object' ? JSON.stringify(raw) : String(raw)
        return text.trim() ? { kind: 'text', value: text.trim() } : undefined
      }
    }
    return undefined
  }

  // -------------------------------------------------------------------------
  // Tags, matched by name

  const tagType = builtinTypeId(spaceId, 'tag')
  const tagIdByName = new Map(target.tags.map((tag) => [fold(tag.title), tag.id]))
  const usedTags = new Set<Id>()
  const newTags: ObjectRecord[] = []
  for (const entry of entries.filter((e) => e.system === 'tag')) tagIdByName.set(fold(String(entry.fields.title ?? entry.name)), entry.id)
  const tagIds = (names: unknown): Id[] =>
    labels(Array.isArray(names) ? names : typeof names === 'string' ? [names] : []).map((name) => {
      let id = tagIdByName.get(fold(name))
      if (!id) {
        id = target.newId()
        tagIdByName.set(fold(name), id)
        newTags.push({ id, spaceId, typeId: tagType, title: name, aliases: [], tagIds: [], collectionIds: [], props: {}, content: {}, createdAt: now, updatedAt: now })
      }
      usedTags.add(id)
      return id
    })

  // -------------------------------------------------------------------------
  // Bodies: Markdown → rich text, then the links to other notes become mentions

  const linkHref = (node: DocNode) => (node.marks ?? []).find((m) => m.type === 'link')?.attrs?.href as string | undefined
  const withoutLink = (node: DocNode): DocNode => {
    const marks = (node.marks ?? []).filter((m) => m.type !== 'link')
    const { marks: _marks, ...rest } = node
    return marks.length ? { ...rest, marks } : rest
  }

  const wikiSplit = (from: Entry, node: DocNode): DocNode[] => {
    const text = node.text ?? ''
    if (!text.includes('[[')) return [node]
    const out: DocNode[] = []
    let last = 0
    for (const match of text.matchAll(WIKILINK)) {
      if (match.index > last) out.push({ ...node, text: text.slice(last, match.index) })
      const id = resolve(from, { wiki: match[1]! })
      const label = (match[2] ?? DATE_LINK.exec(match[1]!.trim())?.[0].slice(5) ?? match[1]!).trim()
      if (id) out.push({ type: 'mention', attrs: { objectId: id, label } })
      else {
        unresolved.add(match[1]!.trim())
        out.push({ ...node, text: label })
      }
      last = match.index + match[0].length
    }
    if (last < text.length) out.push({ ...node, text: text.slice(last) })
    return out
  }

  const inline = (from: Entry, nodes: DocNode[]): DocNode[] => {
    const out: DocNode[] = []
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!
      const href = node.type === 'text' ? linkHref(node) : undefined
      if (href === undefined || /^[a-z]+:/i.test(href) || !/\.md(#.*)?$/i.test(href)) {
        if (node.type === 'text') out.push(...wikiSplit(from, node))
        else out.push(node.content ? { ...node, content: inline(from, node.content) } : node)
        continue
      }
      // Marks inside a link split it into several text nodes: one mention for all of them.
      let label = node.text ?? ''
      while (nodes[i + 1]?.type === 'text' && linkHref(nodes[i + 1]!) === href) label += nodes[++i]!.text ?? ''
      const id = resolve(from, { href })
      if (id) out.push({ type: 'mention', attrs: { objectId: id, label: label.trim() } })
      else {
        unresolved.add(label.trim() || href)
        out.push(withoutLink({ ...node, text: label }))
      }
    }
    return out
  }

  const embedDisplay = (id: Id) => (entries.find((e) => e.id === id)?.system === 'query' ? 'embed' : 'inline')

  const blocks = (from: Entry, nodes: DocNode[], top: boolean): DocNode[] =>
    nodes.map((node) => {
      if (!node.content) return node
      if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableHeader' || node.type === 'tableCell') {
        if (node.type === 'tableHeader' || node.type === 'tableCell') return { ...node, content: blocks(from, node.content, false) }
        const content = inline(from, node.content)
        // A link alone on its line was an embedded object in Capacities.
        const parts = content.filter((n) => !(n.type === 'text' && !n.text?.trim()))
        if (top && node.type === 'paragraph' && parts.length === 1 && parts[0]!.type === 'mention') {
          const id = parts[0]!.attrs!.objectId as Id
          return { type: 'objectEmbed', attrs: { objectId: id, display: embedDisplay(id) } }
        }
        return { ...node, content }
      }
      return { ...node, content: blocks(from, node.content, false) }
    })

  const bodyOf = (entry: Entry): Doc | undefined => {
    let markdown = entry.body
    if (entry.system && MEDIA_TYPES.has(entry.system)) markdown = markdown.replace(MEDIA_LINE, '')
    if (!markdown.trim()) return undefined
    const doc = markdownToDoc(markdown)
    return { type: 'doc', content: blocks(entry, doc.content, true) }
  }

  // -------------------------------------------------------------------------
  // Media and weblinks: what the export says about the file or the page

  const mediaOf = (entry: Entry): MediaInfo | undefined => {
    const media: MediaInfo = {}
    const values = Object.entries(entry.fields).filter(([key]) => !FIELD_KEYS.has(key))
    if (entry.system && MEDIA_TYPES.has(entry.system)) {
      const href = MEDIA_LINE.exec(entry.body)?.[1]
      if (href && isUrl(href)) media.url = href
      else if (href) {
        const path = resolvePath(entry.folder, href)
        const file = path ? input.media[path] : undefined
        if (file) {
          media.file = file
          media.sizeBytes = file.sizeBytes
          if (file.mimeType) media.mimeType = file.mimeType
          report.media.attached++
        } else report.media.missing.push(entry.path)
      } else report.media.missing.push(entry.path)
    }
    for (const [, value] of values) {
      if (typeof value !== 'string') continue
      const text = value.trim()
      if (isUrl(text)) {
        if (/\/embed\//.test(text)) media.embedUrl ??= text
        else media.url ??= text
      } else if (MIME.test(text) && !media.mimeType) media.mimeType = text
      else if (entry.system === 'weblink') {
        const link = linkIn(entry, text)
        const preview = link?.id && entries.find((e) => e.id === link.id)
        const previewHref = preview && MEDIA_LINE.exec(preview.body)?.[1]
        if (previewHref && isUrl(previewHref)) media.previewImageUrl ??= previewHref
        else if (preview && previewHref) {
          const file = input.media[resolvePath(preview.folder, previewHref) ?? '']
          if (file) media.previewImageFile ??= file
        }
      }
    }
    if (media.url) {
      try {
        media.host = new URL(media.url).host
      } catch {}
    }
    return Object.keys(media).length ? media : undefined
  }

  // -------------------------------------------------------------------------
  // The objects

  const objects: ObjectRecord[] = []
  for (const entry of entries) {
    const type = typesById.get(entry.typeId)!
    const { fields } = entry
    const props: Record<Id, PropertyValue> = {}
    for (const [key, def] of propertyFor.get(entry.typeId) ?? []) {
      if (isEmpty(fields[key])) continue
      const value = valueOf(entry, def, fields[key])
      if (value) props[def.id] = value
    }
    if (entry.system === 'task' && typeof fields.status === 'string') {
      const status = TASK_STATUS[fields.status.toLowerCase()]
      if (status) props.status = { kind: 'select', value: [status] }
    }
    const bodyProperty = type.properties.find((p) => p.id === BODY_PROPERTY_ID) ?? type.properties.find((p) => p.kind === 'rich-text')
    const body = bodyOf(entry)
    const content: Record<Id, Doc> = body && bodyProperty ? { [bodyProperty.id]: body } : {}
    const icon = toIcon(fields.icon)
    const description = typeof fields.description === 'string' && fields.description.trim() ? fields.description.trim() : undefined
    const aliases = labels(fields.aliases)
    const media = entry.system && (MEDIA_TYPES.has(entry.system) || entry.system === 'weblink') ? mediaOf(entry) : undefined
    const createdAt = toDate(fields.createdAt)?.start ?? now
    const updatedAt = toDate(fields.lastUpdated)?.start ?? createdAt
    const date = entry.system === 'daily-note' ? ({ start: fields.date as string, resolution: 'day' } as DateValue) : undefined
    if (entry.system === 'query') report.queries.push(String(fields.title ?? entry.name))

    if (entry.existing) {
      // The day's note is there already: the imported text goes below its own.
      const note = entry.existing
      const own = note.content[BODY_PROPERTY_ID]
      objects.push({
        ...note,
        tagIds: [...new Set([...note.tagIds, ...tagIds(fields.tags)])],
        props: { ...props, ...note.props },
        content: body ? { ...note.content, [BODY_PROPERTY_ID]: { type: 'doc', content: [...(own?.content ?? []), ...body.content] } } : note.content,
        updatedAt: now,
      })
      report.mergedDailyNotes++
    } else {
      objects.push({
        id: entry.id,
        spaceId,
        typeId: entry.typeId,
        title: entry.system === 'daily-note' ? '' : String(fields.title ?? entry.name).trim(),
        ...(description ? { description } : {}),
        ...(icon ? { icon } : {}),
        aliases,
        tagIds: tagIds(fields.tags),
        collectionIds: [],
        props,
        content,
        ...(date ? { date } : {}),
        ...(entry.system === 'query' ? { query: { typeIds: [], layout: 'list' as const } } : {}),
        ...(media ? { media } : {}),
        createdAt,
        updatedAt,
      })
    }
    report.objects++
    report.objectsByType[type.name] = (report.objectsByType[type.name] ?? 0) + 1
  }

  for (const tag of newTags) objects.push(tag)
  for (const note of madeDailyNotes.values()) objects.push(note)
  report.tags = { created: newTags.length, matched: [...usedTags].filter((id) => !newTags.some((t) => t.id === id)).length }
  report.unresolvedLinks = [...unresolved].sort()
  report.warnings = warnings.toJSON()
  return { types: [...changedTypes].map((id) => ({ ...typesById.get(id)!, updatedAt: now })), objects, report }
}
