// Operations the server's routes and the client's local store share, so a write made offline on a
// device means the same as one made through the server: new objects and types, saving an edited
// copy, daily notes, the inbox, running a query.
import { ADDED_BUILTIN_PROPERTIES, BODY_PROPERTY_ID, SOURCE_PROPERTY_ID, builtinProperty, builtinTypeId, missingBuiltinTypes } from './builtin-types.ts'
import { docReferences } from './doc.ts'
import type { CaptureInfo, DocNode, Icon, Id, IsoDateTime, ObjectRecord, ObjectSummary, ObjectType, Person, QueryDef } from './model.ts'
import { addHabitFoodProperty } from './nutrition.ts'
import { queryRelations, relatedIds, runQuery, timeBounds } from './query.ts'
import type { Store } from './store.ts'
import { applyFields, canonicalJson, hlcAt, recordFields, stampChanges } from './sync.ts'
import { currentSprint } from './sprints.ts'
import { textToBlocks } from './text-doc.ts'
import { addDays, isValidDay } from './time.ts'

/** A new object of `type` from what the caller gave; ids, space and times are not theirs to choose. */
export function newObject(type: ObjectType, data: Partial<ObjectRecord>, id: Id, at: IsoDateTime): ObjectRecord {
  return {
    aliases: [],
    tagIds: [],
    collectionIds: [],
    props: {},
    content: {},
    ...data,
    id,
    spaceId: type.spaceId,
    typeId: type.id,
    title: data.title ?? '',
    createdAt: at,
    updatedAt: at,
  }
}

/**
 * `stored` with the fields that differ between `edited` and `base`, the copy the editor started
 * from: a field changed elsewhere meanwhile is not undone. Rich text and media are left as stored.
 * Undefined when nothing changed.
 */
export function applyEdit(stored: ObjectRecord, edited: ObjectRecord, base: ObjectRecord): ObjectRecord | undefined {
  const mine = recordFields('objects', edited)
  const before = recordFields('objects', base)
  const changed: Record<string, unknown> = {}
  for (const name of new Set([...Object.keys(mine), ...Object.keys(before)])) {
    if (name !== 'media' && canonicalJson(mine[name] ?? null) !== canonicalJson(before[name] ?? null)) changed[name] = mine[name] ?? null
  }
  return Object.keys(changed).length ? applyFields('objects', stored, changed) : undefined
}

/**
 * An editor's copy after a save: `saved`, the object as stored (changes made elsewhere merged in),
 * except what the user changed while the save was on its way (where `current` differs from
 * `sent`, the copy that was saved), which stays as typed. Keeping older values instead would show
 * them, and the next save, which writes what differs from `saved`, would write them back.
 */
export function afterSave(current: ObjectRecord, sent: ObjectRecord, saved: ObjectRecord): ObjectRecord {
  const mine = recordFields('objects', current)
  const before = recordFields('objects', sent)
  const typed: Record<string, unknown> = {}
  for (const name of new Set([...Object.keys(mine), ...Object.keys(before)])) {
    if (canonicalJson(mine[name] ?? null) !== canonicalJson(before[name] ?? null)) typed[name] = mine[name] ?? null
  }
  // Text typed meanwhile keeps its time too: a whole-object save merges what was captured after it.
  const textTyped = canonicalJson(current.content) !== canonicalJson(sent.content)
  const next = textTyped ? { ...saved, content: current.content, updatedAt: current.updatedAt } : saved
  return applyFields('objects', next, typed)
}

const CONTINUES = 'Continues from '

/** The "Continues from @…" line a series' copy ends with (see copyObject). */
const isContinuation = (node: DocNode) =>
  node.type === 'paragraph' && node.content?.length === 2 && node.content[0]!.text === CONTINUES && node.content[1]!.type === 'mention'

/**
 * A copy of an object, with everything the user made: title, type, properties, icon, tags and
 * the rich text (its content, not its history). Media stay with the original. With
 * `continues`, the copy's notes end with a mention of the original (its backlinks then list the
 * copy); the copied line of an earlier copy is replaced.
 */
export function copyObject(source: ObjectRecord, type: ObjectType, id: Id, at: IsoDateTime, continues = false): ObjectRecord {
  const { deletedAt: _deleted, media: _media, ...rest } = source
  const copy: ObjectRecord = { ...structuredClone(rest), id, createdAt: at, updatedAt: at }
  if (continues && type.properties.some((p) => p.id === BODY_PROPERTY_ID && p.kind === 'rich-text')) {
    const content = [...(copy.content[BODY_PROPERTY_ID]?.content ?? [])]
    while (content.length && isEmptyParagraph(content.at(-1)!)) content.pop()
    if (content.length && isContinuation(content.at(-1)!)) content.pop()
    content.push({ type: 'paragraph', content: [{ type: 'text', text: CONTINUES }, { type: 'mention', attrs: { objectId: source.id, label: source.title } }] })
    copy.content = { ...copy.content, [BODY_PROPERTY_ID]: { type: 'doc', content } }
  }
  return copy
}

/**
 * Give every space the built-in types added to Vasta after it was made (e.g. Quote), and built-in
 * types the properties added to them since (ADDED_BUILTIN_PROPERTIES, once each). Returns the
 * types added.
 */
export function ensureBuiltinTypes(store: Store, at: IsoDateTime): ObjectType[] {
  return store.transaction(() => {
    const added = store.listSpaces().flatMap((space) => {
      const missing = missingBuiltinTypes(space.id, store.listTypes(space.id), at)
      for (const type of missing) store.putType(type)
      return missing
    })
    for (const migration of ADDED_BUILTIN_PROPERTIES) {
      const metaKey = `builtin-properties:${migration.key}`
      if (store.getMeta(metaKey)) continue
      for (const space of store.listSpaces()) {
        const type = store.getType(builtinTypeId(space.id, migration.system))
        if (!type || added.some((t) => t.id === type.id)) continue
        const lacking = migration.ids.filter((id) => !type.properties.some((p) => p.id === id))
        const defs = lacking.flatMap((id) => builtinProperty(migration.system, id) ?? [])
        if (!defs.length) continue
        // After the property they follow in a new type, else in front of the rich-text body.
        const after = migration.after ? type.properties.findIndex((p) => p.id === migration.after) : -1
        const body = type.properties.findIndex((p) => p.kind === 'rich-text')
        const properties = [...type.properties]
        properties.splice(after >= 0 ? after + 1 : body < 0 ? properties.length : body, 0, ...defs)
        store.putType({ ...type, properties, updatedAt: at })
      }
      store.setMeta(metaKey, at)
    }
    // Spaces that turned food tracking on before habits could be done from food (2026-10-20).
    if (!store.getMeta('habit-food-2026-10-20')) {
      for (const space of store.listSpaces()) if (space.nutrition) addHabitFoodProperty(store, space.id, at)
      store.setMeta('habit-food-2026-10-20', at)
    }
    return added
  })
}

export class QuoteError extends Error {}

/**
 * A quote of a passage of an object's text: a Quote object titled with the passage, related to the
 * object (its Source) and with an optional note. The editor then highlights the passage with the
 * quote's id; deleting the quote removes that highlight (Store.deleteObject).
 */
export function createQuote(store: Store, sourceId: Id, input: { text: string; note?: string }, at: IsoDateTime): ObjectRecord {
  const source = store.getObject(sourceId)
  if (!source || source.deletedAt) throw new QuoteError('not found')
  const type = store.getType(builtinTypeId(source.spaceId, 'quote'))
  if (!type || type.deletedAt) throw new QuoteError('this space has no Quote type yet')
  const text = input.text.replace(/\s+/g, ' ').trim()
  if (!text) throw new QuoteError('select the passage to quote')
  const note = input.note?.trim()
  const quote = newObject(
    type,
    {
      title: text,
      props: { [SOURCE_PROPERTY_ID]: { kind: 'relation', value: [sourceId] } },
      content: note ? { [BODY_PROPERTY_ID]: { type: 'doc', content: textToBlocks(note) } } : {},
    },
    crypto.randomUUID(),
    at
  )
  return store.putObject(quote)
}

/** A new type with a Notes field and one list view. */
export function newType(spaceId: Id, data: { name: string; pluralName?: string; icon?: Icon }, id: Id, at: IsoDateTime): ObjectType {
  return {
    id,
    spaceId,
    name: data.name.trim(),
    pluralName: data.pluralName?.trim() || data.name.trim(),
    ...(data.icon ? { icon: data.icon } : {}),
    properties: [{ id: BODY_PROPERTY_ID, kind: 'rich-text', name: 'Notes' }],
    views: [{ id: `${id}:all`, name: 'All', layout: 'list' }],
    createdAt: at,
    updatedAt: at,
  }
}

/**
 * The id of a new daily note: derived from its space and day, so two devices opening the same day
 * offline create the same row, and their texts merge. Notes made before have random ids; they are
 * found by their day first.
 */
export const dailyNoteId = (spaceId: Id, day: string) => `daily-${spaceId}-${day}`

/** Find the daily note of a day, creating it if there is none. Day dates are stored at midnight UTC. */
export function findOrCreateDailyNote(store: Store, spaceId: Id, day: string, at: IsoDateTime): { note: ObjectRecord; created: boolean } {
  const typeId = builtinTypeId(spaceId, 'daily-note')
  const existing = store.findObjectOnDay(typeId, day)
  if (existing) return { note: existing, created: false }
  const type = store.getType(typeId)
  if (!type) throw new Error(`space ${spaceId} has no daily-note type`)
  // The day's note in the trash keeps its id; a new one then gets a random id, as before.
  const derived = dailyNoteId(spaceId, day)
  const id = store.getObject(derived) ? crypto.randomUUID() : derived
  const note = newObject(type, { date: { start: `${day}T00:00:00.000Z`, resolution: 'day' } }, id, at)
  // Another device may have made the same row already and changed it since (a title, a tag): what
  // a new note starts with is stamped as older than any change, so it never overrules one.
  const clock = id === derived ? stampChanges(undefined, recordFields('objects', note), {}, hlcAt(undefined, store.clock.node)) : undefined
  return { note: store.putObject(note, clock), created: true }
}

/** Run a query of a space. `parentId` is the object it is embedded in (the `parent` variable), never listed itself. */
export function querySpace(
  store: Store,
  spaceId: Id,
  input: { query: QueryDef; parentId?: Id; today?: string; timeZone?: string; me?: Id; people?: Person[] },
  now: IsoDateTime
): ObjectSummary[] {
  const types = new Map(store.listTypes(spaceId).map((t) => [t.id, t]))
  let timeZone = 'UTC'
  try {
    if (input.timeZone) timeZone = new Intl.DateTimeFormat('en', { timeZone: input.timeZone }).resolvedOptions().timeZone
  } catch {}
  const parent = input.parentId ? store.getObjectSummaries([input.parentId]).find((o) => o.spaceId === spaceId) : undefined
  const today = input.today && isValidDay(input.today) ? input.today : now.slice(0, 10)
  // A filter on when objects were made or changed reads only those around then.
  const bounds = timeBounds(input.query.filter, { today, timeZone })
  const typeIds = input.query.typeIds.filter((id) => types.has(id))
  let candidates: ObjectSummary[] = []
  if (input.query.typeIds.length && !typeIds.length) candidates = []
  else if (bounds.created || bounds.updated) candidates = store.listObjectsWithin(spaceId, typeIds, bounds)
  else candidates = typeIds.length ? typeIds.flatMap((typeId) => store.listObjects(typeId)) : store.listSpaceObjects(spaceId)
  // Filters on a related object's field (`author.country`), and formulas that read through
  // relations or tags, read the objects they point to.
  const related = new Map<Id, ObjectSummary>()
  const relations = queryRelations(input.query, types.values())
  if (relations.size) {
    const ids = relatedIds(candidates, relations)
    for (let i = 0; i < ids.length; i += 500) for (const o of store.getObjectSummaries(ids.slice(i, i + 500))) if (o.spaceId === spaceId) related.set(o.id, o)
  }
  // Nested tags: a filter on #recipe takes what is tagged with its sub-tags too.
  const tagParents = new Map(store.listObjects(builtinTypeId(spaceId, 'tag')).flatMap((t) => (t.parentId ? [[t.id, t.parentId] as const] : [])))
  const names = new Map((input.people ?? []).map((p) => [p.id, p.name]))
  const sprint = currentSprint(types.has(builtinTypeId(spaceId, 'sprint')) ? store.listObjects(builtinTypeId(spaceId, 'sprint')) : [], today, timeZone)
  const objects = runQuery(candidates, input.query, {
    types,
    today,
    timeZone,
    related: (id) => related.get(id),
    tagParent: (id) => tagParents.get(id),
    personName: (id) => names.get(id),
    ...(input.me ? { me: input.me } : {}),
    ...(sprint ? { currentSprint: sprint.id } : {}),
    ...(parent ? { parent } : {}),
  })
  return objects.filter((o) => o.id !== input.parentId)
}

// Captures --------------------------------------------------------------------
// Each item captured through a channel (Telegram, the capture API, the desktop app's quick
// capture…) is logged in that day's note as a callout carrying the channel's icon and the time.

const CHANNEL_ICONS: Record<string, string> = {
  telegram: 'ph:telegram-logo',
  api: 'ph:lightning',
  email: 'ph:envelope-simple',
  shortcuts: 'ph:device-mobile',
  raycast: 'ph:command',
  browser: 'ph:browser',
  desktop: 'ph:desktop',
}

export const channelIcon = (channel: string): Icon => ({ kind: 'icon', value: CHANNEL_ICONS[channel] ?? 'ph:tray-arrow-down' })

const isEmptyParagraph = (node: DocNode) => node.type === 'paragraph' && !node.content?.length

/** Add a captured item to the end of the day's note (made if needed). Run it in a transaction with the objects it embeds. */
export function appendCapture(store: Store, spaceId: Id, day: string, capture: CaptureInfo, blocks: DocNode[]): ObjectRecord {
  const callout: DocNode = { type: 'callout', attrs: { icon: channelIcon(capture.channel), capture }, content: blocks.length ? blocks : [{ type: 'paragraph' }] }
  const { note } = findOrCreateDailyNote(store, spaceId, day, capture.at)
  const body = note.content[BODY_PROPERTY_ID] ?? { type: 'doc', content: [] }
  const content = [...body.content]
  while (content.length && isEmptyParagraph(content.at(-1)!)) content.pop()
  // Keep an empty paragraph after the block so there is somewhere to type below it.
  content.push(callout, { type: 'paragraph' })
  return store.putObject({ ...note, content: { ...note.content, [BODY_PROPERTY_ID]: { ...body, content } }, updatedAt: capture.at })
}

// Inbox -----------------------------------------------------------------------
// Every item captured into the daily notes of the last days (callouts carrying `attrs.capture`,
// written by the server's CaptureService), newest first. An item can be marked done, which the
// inbox and the daily note show; the item itself stays in its note.

export interface InboxItem extends CaptureInfo {
  done: boolean
  /** The daily note holding it, and its day ("YYYY-MM-DD"). */
  noteId: Id
  day: string
  /** The callout's blocks. */
  content: DocNode[]
  /** Objects embedded or mentioned in it. */
  objectIds: Id[]
}

const captureOf = (node: DocNode): CaptureInfo | undefined => {
  const capture = node.type === 'callout' ? (node.attrs?.capture as CaptureInfo | undefined) : undefined
  return capture && typeof capture.id === 'string' ? capture : undefined
}

/** Capture callouts anywhere in a list of blocks (a moved one may sit inside a toggle or a column). */
function findCaptures(nodes: DocNode[] | undefined, found: { capture: CaptureInfo; node: DocNode }[] = []) {
  for (const node of nodes ?? []) {
    const capture = captureOf(node)
    if (capture) found.push({ capture, node })
    else findCaptures(node.content, found)
  }
  return found
}

/** Items captured in the space from `days` days before `today` (inclusive) on, newest first. */
export function listInbox(store: Store, spaceId: Id, today: string, days: number): InboxItem[] {
  const since = addDays(today, -(days - 1))
  const notes = store.listObjects(builtinTypeId(spaceId, 'daily-note')).filter((n) => {
    const day = n.date?.start.slice(0, 10)
    return day !== undefined && day >= since && day <= addDays(today, 1)
  })
  const items: InboxItem[] = []
  for (const summary of notes) {
    const note = store.getObject(summary.id)
    if (!note) continue
    for (const { capture, node } of findCaptures(note.content[BODY_PROPERTY_ID]?.content)) {
      const content = node.content ?? []
      items.push({
        ...capture,
        done: !!capture.done,
        noteId: note.id,
        day: note.date!.start.slice(0, 10),
        content,
        objectIds: [...new Set(docReferences({ type: 'doc', content }).map((r) => r.objectId))],
      })
    }
  }
  return items.sort((a, b) => b.at.localeCompare(a.at))
}

/** Mark a captured item done (or not). Returns the updated daily note, or undefined when the item is not in it. */
export function setCaptureDone(store: Store, noteId: Id, captureId: Id, done: boolean, at: IsoDateTime): ObjectRecord | undefined {
  const note = store.getObject(noteId)
  const body = note?.content[BODY_PROPERTY_ID]
  if (!note || !body) return undefined
  let found = false
  const update = (nodes: DocNode[] | undefined): DocNode[] | undefined =>
    nodes?.map((node) => {
      const capture = captureOf(node)
      if (capture?.id === captureId) {
        found = true
        const { done: _done, ...rest } = capture
        return { ...node, attrs: { ...node.attrs, capture: done ? { ...rest, done: true } : rest } }
      }
      return node.content ? { ...node, content: update(node.content) } : node
    })
  const content = update(body.content) ?? []
  if (!found) return undefined
  return store.putObject({ ...note, content: { ...note.content, [BODY_PROPERTY_ID]: { ...body, content } }, updatedAt: at })
}
