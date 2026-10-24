// Sync endpoints (docs/sync.md): `pull` answers what changed in the user's spaces after a
// revision; `push` merges field changes from a client, each field kept only if its HLC is newer
// than the stored one, and Yjs updates of rich text; `text` hands out the Yjs updates a client
// lacks. The app's other routes keep writing whole records; the store stamps them.
import type { Id, ObjectRecord, ObjectType } from '@vasta/core'
import { ClockDriftError, SYNC_TABLES, WriteRefused, applyFields, builtinTypeKey, canonicalJson, hlcTime, isHlc, isPushable, mergeFields, type SyncRecords, type SyncTable } from '@vasta/core'
import type { NodeStore, PulledRow, SyncChange, SyncChangeResult, SyncRow, SyncTombstone } from '@vasta/core/node'
import { Y, readContent } from '@vasta/editor-schema/yjs'

export type { PulledRow, SyncChange, SyncChangeResult }

export const MAX_PULL_LIMIT = 1000
export const MAX_PUSH_CHANGES = 1000
export const MAX_TEXT_OBJECTS = 1000
/** Largest Yjs update one change may carry (decoded). */
export const MAX_TEXT_UPDATE = 8 * 1024 * 1024

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

export interface SyncPull {
  rev: number
  more: boolean
  rows: PulledRow[]
  tombstones: SyncTombstone[]
  /** How many are left after this page, when asked for. */
  remaining?: number
}

/** Rows and tombstones of `spaceIds` with a revision above `since`, `limit` at a time; `count`: and how many are left. */
export function pull(store: NodeStore, spaceIds: Id[], since: number, limit: number, count = false): SyncPull {
  const { rows, tombstones, more } = store.syncChanges(spaceIds, since, limit)
  // A full page answers the revision it reached, so the next pull continues after it.
  const last = Math.max(0, ...rows.map((r) => r.rev), ...tombstones.map((t) => t.rev))
  const vectors = store.textVectors(rows.filter((row) => row.table === 'objects').map((row) => row.id))
  const pulled = rows.map((row): PulledRow => {
    const vector = row.table === 'objects' ? vectors.get(row.id) : undefined
    return vector ? { ...row, textVector: toBase64(vector) } : row
  })
  const rev = more ? last : store.currentRev()
  return { rev, more, rows: pulled, tombstones, ...(count ? { remaining: more ? store.syncCount(spaceIds, rev) : 0 } : {}) }
}

/**
 * The Yjs updates of objects' rich text that a client lacks: `vectors` maps an object id to the
 * client's state vector (base64; empty for everything). Objects outside `spaceIds` or unknown are
 * left out of the answer.
 */
export function textUpdates(store: NodeStore, spaceIds: Set<Id>, vectors: Record<string, unknown>): Record<Id, string> {
  const updates: Record<Id, string> = {}
  for (const [id, vector] of Object.entries(vectors)) {
    const spaceId = store.objectSpaceId(id)
    if (!spaceId || !spaceIds.has(spaceId) || typeof vector !== 'string') continue
    const ydoc = store.loadText(id)
    if (!ydoc) continue
    let known: Uint8Array | undefined
    try {
      known = vector ? Buffer.from(vector, 'base64') : undefined
      updates[id] = toBase64(Y.encodeStateAsUpdate(ydoc, known))
    } catch {
      // A vector that does not decode: send everything; applying it again is harmless.
      updates[id] = toBase64(Y.encodeStateAsUpdate(ydoc))
    }
  }
  return updates
}

const isObject = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v)
const isStringArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string')
const optional = (check: (v: unknown) => boolean) => (v: unknown) => v === null || check(v)
const isString = (v: unknown) => typeof v === 'string'
const isNonEmpty = (v: unknown) => typeof v === 'string' && v.trim() !== ''

/** The shape each field's value must have; null clears an optional one. */
const VALUE_CHECKS: Record<string, (value: unknown) => boolean> = {
  name: isNonEmpty,
  pluralName: isNonEmpty,
  title: isString,
  typeId: isNonEmpty,
  description: optional(isString),
  coverUrl: optional(isString),
  color: optional(isString),
  parentId: optional(isNonEmpty),
  deletedAt: optional((v) => typeof v === 'string' && !Number.isNaN(Date.parse(v))),
  icon: optional(isObject),
  sidebar: Array.isArray,
  nutrition: optional((v) => isObject(v) && Array.isArray((v as { meals?: unknown }).meals)),
  sprints: optional((v) => isObject(v) && isNonEmpty((v as { name?: unknown }).name) && isNonEmpty((v as { pluralName?: unknown }).pluralName)),
  properties: Array.isArray,
  views: Array.isArray,
  aliases: isStringArray,
  tagIds: isStringArray,
  collectionIds: isStringArray,
  date: optional((v) => isObject(v) && typeof (v as { start?: unknown }).start === 'string'),
  query: optional(isObject),
  template: optional((v) => isObject(v) && ['template', 'snippet'].includes((v as { kind?: unknown }).kind as string) && isString((v as { name?: unknown }).name)),
  enabled: (v) => typeof v === 'boolean',
}

function validValue(name: string, value: unknown): boolean {
  if (name.startsWith('props.')) return value === null || isObject(value)
  return VALUE_CHECKS[name]?.(value) ?? false
}

class Refused extends Error {}

/** A record to merge the first changes of a new row into. */
function newRecord(table: 'types' | 'objects', id: Id, spaceId: Id, createdAt: string): SyncRecords['types'] | SyncRecords['objects'] {
  if (table === 'types') return { id, spaceId, name: '', pluralName: '', properties: [], views: [], createdAt, updatedAt: createdAt } satisfies ObjectType
  return { id, spaceId, typeId: '', title: '', aliases: [], tagIds: [], collectionIds: [], props: {}, content: {}, createdAt, updatedAt: createdAt } satisfies ObjectRecord
}

export interface SyncPush {
  rev: number
  changes: SyncChangeResult[]
  /** Rows that changed, so the caller can announce them. */
  written: SyncRow[]
}

/**
 * Merge a client's changes. Each change is checked on its own (membership, field names and
 * values, clocks) and refused whole when something is wrong; the others still apply.
 */
export function push(store: NodeStore, spaceIds: Set<Id>, changes: SyncChange[], now: () => string): SyncPush {
  const results: SyncChangeResult[] = []
  const written: SyncRow[] = []
  store.transaction(() => {
    for (const change of changes) {
      const table = String((change as { table?: unknown })?.table)
      const id = String((change as { id?: unknown })?.id)
      try {
        const row = merge(store, spaceIds, change, now)
        results.push({ table, id, lost: row.lost })
        if (row.written) written.push(row.written)
      } catch (error) {
        if (!(error instanceof Refused || error instanceof ClockDriftError || error instanceof WriteRefused)) throw error
        results.push({ table, id, lost: [], error: error.message })
      }
    }
  })
  return { rev: store.currentRev(), changes: results, written }
}

function merge(store: NodeStore, spaceIds: Set<Id>, change: SyncChange, now: () => string): { lost: string[]; written?: SyncRow } {
  const { table, id } = change
  const fields = change.fields ?? {}
  if (!SYNC_TABLES.includes(table)) throw new Refused(`unknown table ${String(table)}`)
  if (typeof id !== 'string' || !id || id.length > 200) throw new Refused('id is required')
  if (change.text !== undefined && table !== 'objects') throw new Refused('only objects have rich text')
  if (!isObject(fields) || (!Object.keys(fields).length && change.text === undefined)) throw new Refused('fields or text are required')
  for (const [name, field] of Object.entries(fields)) {
    if (!isPushable(table, name)) throw new Refused(`${name} cannot be changed by a client`)
    if (!isObject(field) || !isHlc(field.hlc)) throw new Refused(`${name} needs a value and an hlc`)
    if (!validValue(name, field.value ?? null)) throw new Refused(`invalid value for ${name}`)
  }
  // Every HLC first, so a clock too far ahead refuses the change before anything is written.
  for (const { hlc } of Object.values(fields)) store.clock.receive(hlc)

  const existing = store.syncRow(table, id)
  if (existing && !spaceIds.has(existing.spaceId)) throw new Refused('not found')
  if (existing && change.spaceId !== undefined && change.spaceId !== existing.spaceId) throw new Refused('a row cannot move to another space')
  if (!existing) {
    if (table === 'spaces' || table === 'calendar_sources') throw new Refused(`create ${table === 'spaces' ? 'spaces' : 'calendar subscriptions'} over HTTP`)
    // A daily note's id is derived from its day (dailyNoteId): a device that wrote that day offline
    // brings it back after a purge rather than losing what it wrote.
    if (store.isTombstoned(table, id) && !(table === 'objects' && id.startsWith('daily-'))) throw new Refused('deleted for good')
    if (typeof change.spaceId !== 'string' || !spaceIds.has(change.spaceId)) throw new Refused('not found')
  }

  const spaceId = existing?.spaceId ?? change.spaceId!
  const firstHlc = Object.values(fields).map((f) => f.hlc).sort()[0]
  const createdAt =
    typeof change.createdAt === 'string' && !Number.isNaN(Date.parse(change.createdAt))
      ? change.createdAt
      : new Date(firstHlc ? hlcTime(firstHlc) : Date.parse(now())).toISOString()
  const base = existing?.record ?? newRecord(table as 'types' | 'objects', id, spaceId, createdAt)
  const text = change.text === undefined ? undefined : applyText(store, id, change.text)
  const { taken, clock, lost } = mergeFields(existing?.clock ?? {}, fields)
  if (!Object.keys(taken).length && !text?.changed) return { lost }

  const record = applyFields(table, base as never, taken) as SyncRecords[SyncTable]
  if (table === 'objects') {
    const object = record as ObjectRecord
    if (store.getType(object.typeId)?.spaceId !== spaceId) throw new Refused('typeId must be a type of the same space')
  }
  if (table === 'types') {
    const type = record as ObjectType
    if (!type.name) throw new Refused('a new type needs a name')
    if (!type.pluralName) type.pluralName = type.name
    // `system` is not a field: a built-in type made on a device (Food, when food tracking was
    // turned on offline) is known by its id.
    const system = existing ? undefined : builtinTypeKey(spaceId, id)
    if (system) type.system = system
    if (type.system && 'deletedAt' in taken) throw new Refused('built-in types cannot be deleted')
  }
  // updatedAt follows the newest change taken (never ahead of the server's time) and never goes back.
  // Text carries no time of its own: a text change counts as made now.
  if ('updatedAt' in record) {
    const times = [...Object.keys(taken).map((name) => hlcTime(clock[name]!)), ...(text?.changed ? [Date.parse(now())] : [])]
    const newest = Math.min(Math.max(...times), Date.parse(now()))
    record.updatedAt = new Date(Math.max(Date.parse((base as { updatedAt: string }).updatedAt), newest)).toISOString()
  }

  if (table === 'spaces') store.putSpace(record as SyncRecords['spaces'], clock)
  else if (table === 'types') store.putType(record as ObjectType, clock)
  else if (table === 'objects') store.putObject(record as ObjectRecord, clock, text?.changed ? text.ydoc : undefined)
  else store.putCalendarSource(record as SyncRecords['calendar_sources'], undefined, clock)
  return { lost, written: store.syncRow(table, id)! }
}

/**
 * Apply a client's Yjs update to the object's rich text (a new document for a new object).
 * Refused when it does not decode, or builds on changes the server never received (the client
 * must pull first). `changed` when the text or the Yjs state moved.
 */
function applyText(store: NodeStore, id: Id, encoded: unknown): { ydoc: Y.Doc; changed: boolean } {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Refused('text must be a base64 Yjs update')
  const update = Buffer.from(encoded, 'base64')
  if (update.length > MAX_TEXT_UPDATE) throw new Refused('text update too large')
  const ydoc = store.loadText(id) ?? new Y.Doc()
  const before = { snapshot: Y.snapshot(ydoc), content: canonicalJson(readContent(ydoc)) }
  try {
    Y.applyUpdate(ydoc, update)
  } catch {
    throw new Refused('text must be a base64 Yjs update')
  }
  if (ydoc.store.pendingStructs || ydoc.store.pendingDs) throw new Refused('the text update builds on changes the server lacks; pull first')
  const changed = !Y.equalSnapshots(before.snapshot, Y.snapshot(ydoc)) || canonicalJson(readContent(ydoc)) !== before.content
  return { ydoc, changed }
}
