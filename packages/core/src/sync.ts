// Sync primitives shared by the server and (later) the clients' local stores: hybrid logical
// clocks, and the fields of each synced record that merge one by one, the later write winning.
// See docs/sync.md.
import type { CalendarSource, Id, IsoDateTime, ObjectRecord, ObjectType, Space } from './model.ts'

/** Version of the pull/push protocol; a client speaking another one resets its replica. */
export const SYNC_PROTOCOL = 2

/** How far ahead of the receiver's clock a remote HLC may be before it is refused. */
export const MAX_CLOCK_DRIFT_MS = 24 * 3_600_000

/**
 * Hybrid logical clock value: `<ISO time>-<counter, 4 hex>-<node id>`. ISO times have a fixed
 * width, so HLCs sort as text; the counter orders writes within a millisecond and the node id
 * breaks ties between devices.
 */
export type Hlc = string

const HLC_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)-([0-9a-f]{4})-([\w.:-]{1,64})$/
const MAX_COUNTER = 0xffff

export function formatHlc(time: number, counter: number, node: string): Hlc {
  return `${new Date(time).toISOString()}-${counter.toString(16).padStart(4, '0')}-${node}`
}

export function parseHlc(value: unknown): { time: number; counter: number; node: string } | undefined {
  const match = typeof value === 'string' ? HLC_PATTERN.exec(value) : null
  if (!match) return undefined
  const time = Date.parse(match[1]!)
  return Number.isNaN(time) ? undefined : { time, counter: parseInt(match[2]!, 16), node: match[3]! }
}

export const isHlc = (value: unknown): value is Hlc => parseHlc(value) !== undefined

/** The wall time of an HLC in epoch ms (0 when it is not one). */
export const hlcTime = (hlc: Hlc): number => parseHlc(hlc)?.time ?? 0

/** An HLC at a stored time (e.g. a row's updatedAt), for rows written before clocks existed. */
export function hlcAt(at: IsoDateTime | undefined, node: string): Hlc {
  const time = at ? Date.parse(at) : NaN
  return formatHlc(Number.isNaN(time) ? 0 : time, 0, node)
}

export class ClockDriftError extends Error {}

export class HybridClock {
  readonly node: string
  private time = 0
  private counter = 0

  constructor(node: string) {
    this.node = node
    if (!/^[\w.:-]{1,64}$/.test(node)) throw new Error(`invalid clock node id ${node}`)
  }

  /** A new HLC for a local write. */
  tick(now = Date.now()): Hlc {
    if (now > this.time) {
      this.time = now
      this.counter = 0
    } else this.bump()
    return formatHlc(this.time, this.counter, this.node)
  }

  /**
   * Merge an HLC from another node, so local writes made after it sort after it. Refuses one more
   * than MAX_CLOCK_DRIFT_MS ahead of `now`: a device with a wrong clock must not win every merge.
   */
  receive(remote: Hlc, now = Date.now()): Hlc {
    const parsed = parseHlc(remote)
    if (!parsed) throw new ClockDriftError(`invalid HLC ${remote}`)
    if (parsed.time > now + MAX_CLOCK_DRIFT_MS) throw new ClockDriftError(`clock too far ahead: ${remote}`)
    const time = Math.max(this.time, parsed.time, now)
    if (time === this.time && time === parsed.time) this.counter = Math.max(this.counter, parsed.counter) + 1
    else if (time === this.time) this.counter++
    else if (time === parsed.time) this.counter = parsed.counter + 1
    else this.counter = 0
    this.time = time
    if (this.counter > MAX_COUNTER) this.bump()
    return formatHlc(this.time, this.counter, this.node)
  }

  /** Move past an HLC already stored locally (no drift check), so the next tick sorts after it. */
  observe(stored: Hlc) {
    const parsed = parseHlc(stored)
    if (!parsed) return
    if (parsed.time > this.time || (parsed.time === this.time && parsed.counter > this.counter)) {
      this.time = parsed.time
      this.counter = parsed.counter
    }
  }

  private bump() {
    if (this.counter < MAX_COUNTER) this.counter++
    else {
      this.time++
      this.counter = 0
    }
  }
}

// -----------------------------------------------------------------------------
// Synced records and their fields

export type SyncTable = 'spaces' | 'types' | 'objects' | 'calendar_sources'
export const SYNC_TABLES: SyncTable[] = ['spaces', 'types', 'objects', 'calendar_sources']

export interface SyncRecords {
  spaces: Space & { deletedAt?: IsoDateTime }
  types: ObjectType
  objects: ObjectRecord
  calendar_sources: CalendarSource
}

/** A change a client pushes: field values with the HLCs of their writes, and/or a Yjs update of the text. */
export interface SyncChange {
  table: SyncTable
  id: Id
  /** Required to create a row; checked against the stored row otherwise. */
  spaceId?: Id
  /** When a new row was created on the client; defaults to its earliest HLC. */
  createdAt?: string
  fields?: Record<string, { value: unknown; hlc: Hlc }>
  /** A Yjs update of the object's rich text (base64), made on top of what the client pulled. */
  text?: string
}

export interface SyncChangeResult {
  table: string
  id: string
  /** Fields whose stored value is newer: pull to get it. */
  lost: string[]
  /** Why the change was refused as a whole (nothing of it was kept). */
  error?: string
}

/** Field name → value of a record, null when absent. Map entries are `<map>.<key>` (`props.status`). */
export type FieldValues = Record<string, unknown>
/** Field name → HLC of the write that set it. A missing field sorts before any write. */
export type FieldClock = Record<string, Hlc>

/**
 * The fields that merge on their own. Ids, `spaceId`, a type's `system` and `createdAt` never
 * change after creation; `updatedAt` follows the writes. Arrays edited as a whole (a type's
 * properties, the sidebar) are one field each. An object's rich text (`content`) is not a field:
 * it is a Yjs document that merges edit by edit (see `object_docs`).
 */
export const PLAIN_FIELDS: Record<SyncTable, readonly string[]> = {
  spaces: ['name', 'icon', 'sidebar', 'nutrition', 'sprints', 'deletedAt'],
  types: ['name', 'pluralName', 'description', 'icon', 'color', 'properties', 'views', 'deletedAt'],
  objects: ['typeId', 'title', 'description', 'icon', 'coverUrl', 'color', 'parentId', 'aliases', 'tagIds', 'collectionIds', 'date', 'query', 'media', 'template', 'deletedAt'],
  calendar_sources: ['name', 'url', 'color', 'username', 'enabled'],
}

/** Maps whose entries are fields of their own: each property value of an object. */
export const MAP_FIELDS: Partial<Record<SyncTable, readonly string[]>> = { objects: ['props'] }

/**
 * What a client may change. Media (files, a weblink's page data) is written by the server only;
 * a space's trash and a calendar's address and login go through their HTTP routes, which check
 * ownership or fetch the feed.
 */
export function isPushable(table: SyncTable, name: string): boolean {
  if (table === 'spaces') return ['name', 'icon', 'sidebar', 'nutrition', 'sprints'].includes(name)
  if (table === 'calendar_sources') return ['name', 'color', 'enabled'].includes(name)
  return name !== 'media' && isSyncField(table, name)
}

/** Whether `name` is a field of `table` (a plain one, or `<map>.<key>`). */
export function isSyncField(table: SyncTable, name: string): boolean {
  if (PLAIN_FIELDS[table].includes(name)) return true
  const dot = name.indexOf('.')
  return dot > 0 && dot < name.length - 1 && !!MAP_FIELDS[table]?.includes(name.slice(0, dot))
}

export function recordFields<T extends SyncTable>(table: T, record: SyncRecords[T]): FieldValues {
  const source = record as unknown as Record<string, unknown>
  const fields: FieldValues = {}
  for (const name of PLAIN_FIELDS[table]) fields[name] = source[name] ?? null
  for (const map of MAP_FIELDS[table] ?? []) {
    for (const [key, value] of Object.entries((source[map] ?? {}) as Record<string, unknown>)) fields[`${map}.${key}`] = value ?? null
  }
  return fields
}

/** A copy of `record` with `fields` set; null removes a field (or a map entry). */
export function applyFields<T extends SyncTable>(table: T, record: SyncRecords[T], fields: FieldValues): SyncRecords[T] {
  const next = { ...(record as unknown as Record<string, unknown>) }
  for (const map of MAP_FIELDS[table] ?? []) next[map] = { ...((next[map] ?? {}) as Record<string, unknown>) }
  for (const [name, value] of Object.entries(fields)) {
    if (!isSyncField(table, name)) continue
    const dot = name.indexOf('.')
    const map = dot > 0 && !PLAIN_FIELDS[table].includes(name) ? name.slice(0, dot) : undefined
    const target = map ? (next[map] as Record<string, unknown>) : next
    const key = map ? name.slice(dot + 1) : name
    if (value === null || value === undefined) delete target[key]
    else target[key] = value
  }
  return next as unknown as SyncRecords[T]
}

/** JSON with object keys sorted, so equal values compare equal whatever order their keys came in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * The clock after a whole-record write (a PUT from the app, a capture, an import): the fields
 * that differ from `before` (every field with a value, of a new record) get `hlc`, the others
 * keep theirs. An empty field of a new record has no HLC: nothing older can exist to overrule,
 * and a device would otherwise hold stamps of fields it never pushes (`media`).
 */
export function stampChanges(before: FieldValues | undefined, after: FieldValues, clock: FieldClock, hlc: Hlc): FieldClock {
  const next = { ...clock }
  const names = new Set([...Object.keys(before ?? {}), ...Object.keys(after)])
  for (const name of names) {
    if (before ? canonicalJson(before[name] ?? null) !== canonicalJson(after[name] ?? null) : (after[name] ?? null) !== null) next[name] = hlc
  }
  return next
}

/**
 * Merge field changes into a record's fields: a change is taken when its HLC is newer than the
 * stored one. Returns the values taken, the new clock, and the names of fields that lost (the
 * stored value is newer). A change with the stored HLC is the same write again and is neither.
 */
export function mergeFields(
  clock: FieldClock,
  changes: Record<string, { value: unknown; hlc: Hlc }>
): { taken: FieldValues; clock: FieldClock; lost: string[] } {
  const taken: FieldValues = {}
  const next = { ...clock }
  const lost: string[] = []
  for (const [name, { value, hlc }] of Object.entries(changes)) {
    const stored = clock[name] ?? ''
    if (hlc > stored) {
      taken[name] = value ?? null
      next[name] = hlc
    } else if (hlc < stored) lost.push(name)
  }
  return { taken, clock: next, lost }
}

// Base64 for Yjs updates and state vectors in the protocol (no Buffer in browsers).
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
