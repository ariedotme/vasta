// A device's replica of its user's spaces (the web app's worker; Tauri later): the shared store,
// written by the user on this device and by pulls from the server, plus an outbox of what this
// device changed and has not pushed yet. See docs/sync-plan.md, "Client".
//
// Local writes go through the store's ordinary methods, which stamp the fields they change with
// this device's HLC; the `stamped` and `textSaved` hooks put those fields (and objects whose text
// changed) in the outbox. Pulled rows merge field by field, the newer HLC winning, so a local
// change not pushed yet survives an older one from the server. Rich text merges through Yjs.
import { Y } from '@vasta/editor-schema/yjs'
import { OccurrenceError, calendarObjects, changeOccurrence, compareEntries, dayReferences, objectEntries, type DayRange, type OccurrenceEdit } from './calendar.ts'
import { calendarEntries, parseCalendar, type ParsedCalendar } from './ics.ts'
import type { CalendarEntry, Icon, Id, IsoDateTime, ObjectRecord, ObjectSummary, ObjectType, Person, Space } from './model.ts'
import { QuoteError, appendCapture, applyEdit, createQuote, findOrCreateDailyNote, listInbox, newObject, newType, querySpace, setCaptureDone, type InboxItem } from './operations.ts'
import { NutritionError, deleteFoodEntry, foodLineAnswer, logFood, logFoodLine, normalizeNutritionSettings, setNutritionEnabled, type FoodLineAnswer, type LogFoodInput } from './nutrition.ts'
import { SprintError, setSprints } from './sprints.ts'
import { textToBlocks } from './text-doc.ts'
import { describeCapture, objectFromLine, type LineContext, type LineObject } from './capture-line.ts'
import { EMPTY_TEXT, Store, type PulledRow, type SqlDatabase, type SyncTombstone } from './store.ts'
import {
  applyFields,
  fromBase64,
  isPushable,
  mergeFields,
  recordFields,
  toBase64,
  type FieldClock,
  type SyncChange,
  type SyncChangeResult,
  type SyncRecords,
  type SyncTable,
} from './sync.ts'

const CLIENT_SCHEMA = `
-- Fields (and, as '#text', rich text) this device changed and has not pushed yet. The values are
-- read from the rows when pushing, so a field changed twice is sent once, with its last value.
CREATE TABLE IF NOT EXISTS sync_outbox (
  kind     TEXT NOT NULL,
  id       TEXT NOT NULL,
  field    TEXT NOT NULL,
  space_id TEXT NOT NULL,
  PRIMARY KEY (kind, id, field)
);
CREATE INDEX IF NOT EXISTS sync_outbox_space ON sync_outbox(space_id);

-- The state vector of the server's copy of an object's text, as last known: a push sends what
-- the local document holds beyond it.
CREATE TABLE IF NOT EXISTS sync_text (
  object_id     TEXT PRIMARY KEY,
  server_vector BLOB NOT NULL
);

-- Changes the server refused. They leave the outbox; these rows say so on the device until the
-- user dismisses them.
CREATE TABLE IF NOT EXISTS sync_refused (
  id     INTEGER PRIMARY KEY,
  at     TEXT NOT NULL,
  kind   TEXT NOT NULL,
  row_id TEXT NOT NULL,
  title  TEXT NOT NULL,
  reason TEXT NOT NULL
);
`

const TEXT = '#text'
/** Yjs transaction origin of updates that came from the server. */
export const REMOTE_ORIGIN = 'remote'

/** What changed in the replica, for the UI (the same shapes the server's live events have). */
export type ReplicaChange =
  | { kind: 'object'; id: Id; spaceId: Id; typeId: Id; updatedAt: IsoDateTime }
  | { kind: 'type'; id: Id; spaceId: Id }
  | { kind: 'calendar'; sourceId: Id; spaceId: Id }
  /** A space was renamed, joined, or dropped (left or deleted). */
  | { kind: 'space'; id: Id }

/** What a capture into a daily note answers (the server's capture routes answer the same). */
export interface CaptureAnswer {
  dailyNoteId: Id
  blockId: Id
  /** What an object capture made, in words: "Book “Dune”, author Frank Herbert". */
  summary?: string
  /** Properties in the line whose values could not be read (they stayed in the title). */
  unreadable?: string[]
  /** Objects the capture made: for an object capture, that object first, then relation targets. */
  objects?: { id: Id; typeId: Id; title: string }[]
}

export class NotFoundError extends Error {}
export class InvalidError extends Error {}

/** A change the server refused, kept to show on the device. */
export interface RefusedChange {
  id: number
  at: IsoDateTime
  table: SyncTable
  rowId: Id
  /** The row's title or name when it was refused. */
  title: string
  reason: string
}

/** A push batch and what is needed to acknowledge it. */
export interface PushBatch {
  changes: SyncChange[]
  /** The local text vector each text change was made from, by object id. */
  vectors: Map<Id, Uint8Array>
  /**
   * The local text each text change was made from (its vector and deletions), by object id: a
   * change that only deletes leaves the vector as it was, so the vector cannot tell it was made.
   */
  snapshots: Map<Id, Y.Snapshot>
}

const TABLE_ORDER: Record<SyncTable, number> = { spaces: 0, types: 1, objects: 2, calendar_sources: 3 }

export class ClientStore extends Store {
  /** Above 0 while writing what came from the server: nothing goes to the outbox then. */
  private remote = 0
  /** The replica's user: the author of the writes made on this device (not of pulled ones). */
  user?: Id

  override actor = () => (this.remote ? undefined : this.user)
  private open = new Map<Id, { doc: Y.Doc; count: number; listener: (update: Uint8Array, origin: unknown) => void }>()
  private textListeners = new Set<(id: Id, update: Uint8Array, origin: unknown) => void>()
  private parsedCalendars = new Map<Id, { version: string; calendar: ParsedCalendar }>()
  /** Rows written since the last takeChanges; purged objects keep what the UI needs to know of them. */
  private changed = new Map<string, { table: SyncTable; id: Id; spaceId: Id; typeId?: Id }>()

  constructor(db: SqlDatabase, node = 'device') {
    super(db, node)
    // The replica mirrors the server, which keeps rows consistent; pulls arrive in revision
    // order, so an object may come before its type.
    this.db.exec('PRAGMA foreign_keys = OFF;')
    this.db.exec(CLIENT_SCHEMA)
  }

  // ---------------------------------------------------------------------------
  // Outbox

  protected override stamped(table: SyncTable, id: Id, spaceId: Id, before: FieldClock, after: FieldClock) {
    this.noteRow(table, id, spaceId)
    if (this.remote) return
    const insert = this.db.prepare('INSERT OR IGNORE INTO sync_outbox (kind, id, field, space_id) VALUES (?, ?, ?, ?)')
    for (const [name, hlc] of Object.entries(after)) if (before[name] !== hlc && isPushable(table, name)) insert.run(table, id, name, spaceId)
  }

  protected override textSaved(id: Id) {
    const spaceId = this.objectSpaceId(id)
    if (spaceId) this.noteRow('objects', id, spaceId)
    if (this.remote) return
    if (spaceId) this.db.prepare('INSERT OR IGNORE INTO sync_outbox (kind, id, field, space_id) VALUES (?, ?, ?, ?)').run('objects', id, TEXT, spaceId)
  }

  /** How many rows have changes waiting to be pushed. */
  outboxSize(): number {
    return Number((this.db.prepare('SELECT count(DISTINCT kind || id) AS n FROM sync_outbox').get() as { n: number }).n)
  }

  private asRemote<T>(fn: () => T): T {
    this.remote++
    try {
      return fn()
    } finally {
      this.remote--
    }
  }

  /** The changes of up to `limit` rows, types before the objects that may use them. */
  pushBatch(limit = 200): PushBatch {
    const keys = this.db.prepare('SELECT DISTINCT kind, id FROM sync_outbox LIMIT ?').all(limit) as { kind: SyncTable; id: Id }[]
    keys.sort((a, b) => TABLE_ORDER[a.kind] - TABLE_ORDER[b.kind])
    const changes: SyncChange[] = []
    const vectors = new Map<Id, Uint8Array>()
    const snapshots = new Map<Id, Y.Snapshot>()
    for (const { kind: table, id } of keys) {
      const fields = (this.db.prepare('SELECT field FROM sync_outbox WHERE kind = ? AND id = ?').all(table, id) as { field: string }[]).map((r) => r.field)
      const row = this.syncRow(table, id)
      if (!row) {
        this.db.prepare('DELETE FROM sync_outbox WHERE kind = ? AND id = ?').run(table, id)
        continue
      }
      const values = recordFields(table, row.record as never)
      const change: SyncChange = { table, id, spaceId: row.spaceId, createdAt: (row.record as { createdAt: string }).createdAt }
      const sent = fields.filter((name) => name !== TEXT && row.clock[name])
      if (sent.length) change.fields = Object.fromEntries(sent.map((name) => [name, { value: values[name] ?? null, hlc: row.clock[name]! }]))
      if (fields.includes(TEXT)) {
        const doc = this.loadText(id)
        if (doc) {
          change.text = toBase64(Y.encodeStateAsUpdate(doc, this.serverVector(id)))
          vectors.set(id, Y.encodeStateVector(doc))
          snapshots.set(id, Y.snapshot(doc))
        }
      }
      if (change.fields || change.text !== undefined) changes.push(change)
      else this.db.prepare('DELETE FROM sync_outbox WHERE kind = ? AND id = ?').run(table, id)
    }
    return { changes, vectors, snapshots }
  }

  /**
   * Take the server's answers to a push: fields it took (or that lost to a newer write) leave the
   * outbox unless they changed again meanwhile; the text it took becomes the server's known
   * state. A change refused whole is dropped, except text that builds on what the server lacks,
   * which goes again in full. Returns the refusals (also kept, see refusedChanges).
   */
  ackPush(batch: PushBatch, results: SyncChangeResult[]): RefusedChange[] {
    const refused: RefusedChange[] = []
    this.transaction(() => {
      results.forEach((result, index) => {
        const change = batch.changes[index]
        if (!change || change.id !== result.id) return
        const remove = (field: string) => this.db.prepare('DELETE FROM sync_outbox WHERE kind = ? AND id = ? AND field = ?').run(change.table, change.id, field)
        if (result.error) {
          if (change.text !== undefined && /pull first/.test(result.error)) {
            this.db.prepare('DELETE FROM sync_text WHERE object_id = ?').run(change.id)
            for (const field of Object.keys(change.fields ?? {})) remove(field)
            return
          }
          refused.push(this.keepRefusal(change.table, change.id, result.error))
          this.db.prepare('DELETE FROM sync_outbox WHERE kind = ? AND id = ?').run(change.table, change.id)
          return
        }
        const clock = this.syncRow(change.table, change.id)?.clock ?? {}
        for (const [field, { hlc }] of Object.entries(change.fields ?? {})) if (clock[field] === hlc) remove(field)
        const vector = batch.vectors.get(change.id)
        if (vector) {
          this.setServerVector(change.id, vector)
          // Unless the text changed while the push was on its way.
          const doc = this.loadText(change.id)
          const sent = batch.snapshots.get(change.id)
          if (!doc || (sent && Y.equalSnapshots(Y.snapshot(doc), sent))) remove(TEXT)
        }
      })
    })
    return refused
  }

  private keepRefusal(table: SyncTable, rowId: Id, reason: string): RefusedChange {
    const record = this.syncRow(table, rowId)?.record as { title?: string; name?: string } | undefined
    const refusal = { at: new Date().toISOString(), table, rowId, title: record?.title ?? record?.name ?? '', reason }
    const { id } = this.db
      .prepare('INSERT INTO sync_refused (at, kind, row_id, title, reason) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .get(refusal.at, table, rowId, refusal.title, reason)!
    return { id: Number(id), ...refusal }
  }

  /** Changes the server refused and the user has not dismissed, oldest first. */
  refusedChanges(): RefusedChange[] {
    return (this.db.prepare('SELECT * FROM sync_refused ORDER BY id').all() as Record<string, unknown>[]).map((row) => ({
      id: Number(row.id),
      at: row.at as string,
      table: row.kind as SyncTable,
      rowId: row.row_id as string,
      title: row.title as string,
      reason: row.reason as string,
    }))
  }

  /** Forget a refusal, or all of them. */
  dismissRefused(id?: number) {
    if (id === undefined) this.db.exec('DELETE FROM sync_refused')
    else this.db.prepare('DELETE FROM sync_refused WHERE id = ?').run(id)
  }

  private serverVector(id: Id): Uint8Array | undefined {
    const row = this.db.prepare('SELECT server_vector FROM sync_text WHERE object_id = ?').get(id)
    return row ? (row.server_vector as Uint8Array) : undefined
  }

  private setServerVector(id: Id, vector: Uint8Array) {
    this.db.prepare('INSERT OR REPLACE INTO sync_text (object_id, server_vector) VALUES (?, ?)').run(id, vector)
  }

  // ---------------------------------------------------------------------------
  // Pulls

  /** The server revision this replica has pulled up to. */
  pulledRev(): number {
    return Number(this.getMeta('sync.pulled') ?? 0)
  }

  setPulledRev(rev: number) {
    this.setMeta('sync.pulled', String(rev))
  }

  /**
   * Whether the first pull finished (it may stop halfway: offline, the tab closed). Until then the
   * app keeps working with the server.
   */
  filled(): boolean {
    return this.pulledRev() > 0 && this.getMeta('sync.filled') !== '0'
  }

  setFilled(filled: boolean) {
    this.setMeta('sync.filled', filled ? '1' : '0')
  }

  /** How many rows the replica holds (spaces, types, objects, calendar subscriptions). */
  rowCount(): number {
    const row = this.db
      .prepare('SELECT (SELECT count(*) FROM spaces) + (SELECT count(*) FROM types) + (SELECT count(*) FROM objects) + (SELECT count(*) FROM calendar_sources) AS n')
      .get() as { n: number }
    return Number(row.n)
  }

  /** Spaces pulled in full; a space joined later is pulled from the start on its own. */
  completeSpaces(): Id[] {
    return JSON.parse(this.getMeta('sync.spaces') ?? '[]') as Id[]
  }

  setCompleteSpaces(ids: Id[]) {
    this.setMeta('sync.spaces', JSON.stringify([...new Set(ids)]))
  }

  /** Objects of pulled rows whose text the server has beyond the local copy (to fetch with the rows). */
  textToFetch(rows: PulledRow[]): Id[] {
    const objects = rows.filter((row) => row.table === 'objects' && row.textVector)
    const local = this.localVectors(objects.map((row) => row.id))
    return objects.filter((row) => lacks(local.get(row.id)!, fromBase64(row.textVector!))).map((row) => row.id)
  }

  /**
   * Write a page of pulled rows and tombstones (in revision order), with the text of their objects
   * when it was fetched with them (`text`, Yjs updates by object id: each object is then written
   * once). Returns the objects whose text the server still has beyond the local copy, and the
   * calendars whose data is out of date.
   */
  applyPull(rows: PulledRow[], tombstones: SyncTombstone[], text: Record<Id, Uint8Array> = {}): { text: Id[]; calendars: Id[] } {
    const stale: Id[] = []
    const calendars: Id[] = []
    const entries = [...rows.map((row) => ({ rev: row.rev, row })), ...tombstones.map((tombstone) => ({ rev: tombstone.rev, tombstone }))].sort((a, b) => a.rev - b.rev)
    this.transaction(() =>
      this.asRemote(() => {
        for (const entry of entries) {
          if ('tombstone' in entry) this.applyTombstone(entry.tombstone)
          else {
            const needs = this.applyRow(entry.row, text[entry.row.id])
            if (needs === 'text') stale.push(entry.row.id)
            if (needs === 'calendar') calendars.push(entry.row.id)
          }
        }
      })
    )
    if (calendars.length) this.setMeta('sync.calendars', JSON.stringify([...new Set([...this.staleCalendars(), ...calendars])]))
    // Kept until fetched: the pull's cursor moves past these rows, so a sync that fails before the
    // text arrives (offline halfway) would otherwise never ask for it again.
    if (stale.length) this.setMeta('sync.text', JSON.stringify([...new Set([...this.staleText(), ...stale])]))
    return { text: [...new Set(stale)], calendars }
  }

  /** Objects whose text the server has beyond the local copy, to fetch. */
  staleText(): Id[] {
    return JSON.parse(this.getMeta('sync.text') ?? '[]') as Id[]
  }

  private applyRow(row: PulledRow, text?: Uint8Array): 'text' | 'calendar' | undefined {
    const { table, id } = row
    const existing = this.syncRow(table, id)
    let record = row.record as SyncRecords[SyncTable]
    let clock = row.clock
    if (existing) {
      const values = recordFields(table, row.record as never)
      const changes = Object.fromEntries(Object.entries(row.clock).map(([name, hlc]) => [name, { value: values[name] ?? null, hlc }]))
      const merged = mergeFields(existing.clock, changes)
      record = { ...(applyFields(table, existing.record as never, merged.taken) as SyncRecords[SyncTable]) }
      clock = merged.clock
      // What is not a field follows the server: when the row was made (two devices may make the
      // same daily note), the time of the last change, a calendar's status.
      const remote = row.record as unknown as Record<string, unknown>
      const target = record as unknown as Record<string, unknown>
      if (typeof remote.createdAt === 'string') target.createdAt = remote.createdAt
      if (typeof remote.updatedAt === 'string' && remote.updatedAt > String(target.updatedAt ?? '')) target.updatedAt = remote.updatedAt
      // Who made and last changed an object are the server's to say (it knows who pushed).
      if (table === 'objects') for (const key of ['createdBy', 'updatedBy']) if (typeof remote[key] === 'string') target[key] = remote[key]
      if (table === 'calendar_sources') for (const key of ['hasPassword', 'syncedAt', 'error', 'eventCount', 'dataVersion']) target[key] = remote[key]
    }
    if (table === 'spaces') {
      this.putSpace(record as SyncRecords['spaces'], clock)
    } else if (table === 'types') {
      this.putType(record as ObjectType, clock)
    } else if (table === 'objects') {
      // The text comes apart (`textUpdates`); the row keeps the JSON of the local document. A Y.Doc
      // built from the pulled JSON would have other items than the server's and double the text.
      if (text) {
        const doc = this.loadText(id) ?? new Y.Doc()
        Y.applyUpdate(doc, text, REMOTE_ORIGIN)
        this.putObject(record as ObjectRecord, clock, doc)
      } else this.putObjectRow(record as ObjectRecord, clock)
      if (row.textVector) {
        const server = fromBase64(row.textVector)
        this.setServerVector(id, server)
        if (lacks(this.localVector(id), server)) return 'text'
      }
    } else {
      const source = record as SyncRecords['calendar_sources']
      this.putCalendarSource(source, undefined, clock)
      this.db
        .prepare('UPDATE calendar_sources SET synced_at = ?, error = ?, event_count = ? WHERE id = ?')
        .run(source.syncedAt ?? null, source.error ?? null, source.eventCount ?? null, id)
      if (source.dataVersion && source.dataVersion !== this.heldCalendarVersion(id)) return 'calendar'
    }
    return undefined
  }

  private applyTombstone(tombstone: SyncTombstone) {
    const { table, id, spaceId } = tombstone
    const object = table === 'objects' ? this.getObject(id) : undefined
    if (table === 'objects') this.purgeObject(id)
    else if (table === 'types') this.purgeType(id)
    else if (table === 'calendar_sources') this.deleteCalendarSource(id)
    this.db.prepare('DELETE FROM sync_outbox WHERE kind = ? AND id = ?').run(table, id)
    this.db.prepare('DELETE FROM sync_text WHERE object_id = ?').run(id)
    this.noteRow(table, id, spaceId, object?.typeId)
  }

  /** Drop every space the user can no longer see (left, removed or deleted), with what is in it. */
  dropSpaces(visible: Id[]): Id[] {
    const dropped = this.listSpaces()
      .map((s) => s.id)
      .filter((id) => !visible.includes(id))
    if (!dropped.length) return []
    this.transaction(() =>
      this.asRemote(() => {
        for (const id of dropped) {
          this.db.prepare(`DELETE FROM sync_text WHERE object_id IN (SELECT id FROM objects WHERE space_id = ?)`).run(id)
          this.purgeSpace(id)
          this.db.prepare('DELETE FROM sync_outbox WHERE space_id = ?').run(id)
          this.noteRow('spaces', id, id)
        }
      })
    )
    this.setCompleteSpaces(this.completeSpaces().filter((id) => !dropped.includes(id)))
    return dropped
  }

  /** The state vector of an object's local text (an open document's, or the stored one's). */
  private localVector(id: Id): Uint8Array {
    const open = this.open.get(id)
    return open ? Y.encodeStateVector(open.doc) : (this.textVectors([id]).get(id) ?? EMPTY_TEXT.vector)
  }

  private localVectors(ids: Id[]): Map<Id, Uint8Array> {
    const stored = this.textVectors(ids)
    return new Map(ids.map((id) => [id, this.open.has(id) ? this.localVector(id) : (stored.get(id) ?? EMPTY_TEXT.vector)]))
  }

  /** The local state vectors of objects' text, to ask the server for what they lack. */
  localTextVectors(ids: Id[]): Record<Id, string> {
    return Object.fromEntries([...this.localVectors(ids)].map(([id, vector]) => [id, toBase64(vector)]))
  }

  /**
   * Apply Yjs updates of objects' text from the server, by object id. `asked`: the objects they
   * answer (the server leaves out those it does not have), no longer to fetch.
   */
  applyRemoteText(updates: Record<Id, Uint8Array>, asked: Id[] = Object.keys(updates)) {
    this.transaction(() =>
      this.asRemote(() => {
        for (const [id, update] of Object.entries(updates)) {
          const object = this.getObject(id)
          if (!object) continue
          const doc = this.loadText(id) ?? new Y.Doc()
          Y.applyUpdate(doc, update, REMOTE_ORIGIN)
          this.putObject(object, undefined, doc)
        }
        const done = new Set(asked)
        const stale = this.staleText()
        if (stale.some((id) => done.has(id))) this.setMeta('sync.text', JSON.stringify(stale.filter((id) => !done.has(id))))
      })
    )
  }

  /** Drop the changes noted so far (nobody needs to hear of them). */
  forgetChanges() {
    this.changed.clear()
  }

  /** Changes since the last call, for the UI (local writes and pulls); each row once. */
  takeChanges(): ReplicaChange[] {
    const changes = [...this.changed.values()].flatMap((row): ReplicaChange[] => {
      if (row.table === 'spaces') return [{ kind: 'space', id: row.id }]
      if (row.table === 'types') return [{ kind: 'type', id: row.id, spaceId: row.spaceId }]
      if (row.table === 'calendar_sources') return [{ kind: 'calendar', sourceId: row.id, spaceId: row.spaceId }]
      const object = this.getObject(row.id)
      const typeId = object?.typeId ?? row.typeId
      return typeId ? [{ kind: 'object', id: row.id, spaceId: row.spaceId, typeId, updatedAt: object?.updatedAt ?? new Date().toISOString() }] : []
    })
    this.changed.clear()
    return changes
  }

  private noteRow(table: SyncTable, id: Id, spaceId: Id, typeId?: Id) {
    const key = `${table}:${id}`
    const known = typeId ?? this.changed.get(key)?.typeId
    this.changed.set(key, { table, id, spaceId, ...(known ? { typeId: known } : {}) })
  }

  // ---------------------------------------------------------------------------
  // Subscribed calendars: the iCalendar data is downloaded apart from the rows.

  /** Calendars whose data is older than the server's (to download). */
  staleCalendars(): Id[] {
    return JSON.parse(this.getMeta('sync.calendars') ?? '[]') as Id[]
  }

  private heldCalendarVersion(id: Id): string | undefined {
    const row = this.db.prepare('SELECT data_hash FROM calendar_sources WHERE id = ?').get(id)
    return (row?.data_hash as string | null) ?? undefined
  }

  /** Keep a calendar's downloaded data (and the version it is). */
  storeCalendarData(id: Id, data: string, version: string) {
    this.db.prepare('UPDATE calendar_sources SET data = ?, data_hash = ? WHERE id = ?').run(data, version, id)
    this.setMeta('sync.calendars', JSON.stringify(this.staleCalendars().filter((c) => c !== id)))
    this.parsedCalendars.delete(id)
    const source = this.getCalendarSource(id)
    if (source) this.noteRow('calendar_sources', id, source.spaceId)
  }

  /** Drop a calendar from the download list (gone on the server). */
  forgetStaleCalendar(id: Id) {
    this.setMeta('sync.calendars', JSON.stringify(this.staleCalendars().filter((c) => c !== id)))
  }

  /** Everything dated between two days (inclusive) in `timeZone`, as the server's calendar route answers. */
  calendar(spaceId: Id, range: DayRange, timeZone: string): { entries: CalendarEntry[]; objects: ObjectSummary[]; references: Record<string, number> } {
    const types = new Map(this.listTypes(spaceId).map((t) => [t.id, t]))
    const objects = calendarObjects(this, spaceId, types, range)
    const subscribed = this.listCalendarSources(spaceId)
      .filter((source) => source.enabled)
      .flatMap((source) => {
        const calendar = this.parsedCalendar(source.id)
        return calendar ? calendarEntries(calendar, source.id, range, timeZone) : []
      })
    const entries = [...objectEntries(objects, types, range, timeZone), ...subscribed].sort(compareEntries)
    const used = new Set(entries.map((e) => e.objectId).filter(Boolean))
    return { entries, objects: objects.filter((o) => used.has(o.id)), references: dayReferences(objects, types, range, timeZone, (ids) => this.linkCounts(ids)) }
  }

  private parsedCalendar(id: Id): ParsedCalendar | undefined {
    const row = this.db.prepare('SELECT data, data_hash FROM calendar_sources WHERE id = ? AND data IS NOT NULL').get(id)
    if (!row) return undefined
    const version = String(row.data_hash ?? '')
    const cached = this.parsedCalendars.get(id)
    if (cached?.version === version) return cached.calendar
    try {
      const calendar = parseCalendar(row.data as string)
      this.parsedCalendars.set(id, { version, calendar })
      return calendar
    } catch {
      return undefined
    }
  }

  // ---------------------------------------------------------------------------
  // Open documents: an editor of this device edits an object's Y.Doc held here in memory, so
  // every change to the text (a pull, a capture marked done) reaches it as a Yjs update.

  /** Hear about updates of open documents, with the Yjs origin of each. */
  onTextUpdate(listener: (id: Id, update: Uint8Array, origin: unknown) => void): () => void {
    this.textListeners.add(listener)
    return () => this.textListeners.delete(listener)
  }

  /** Keep an object's document in memory and return its whole state, for an editor to start from. */
  openText(id: Id): Uint8Array {
    let entry = this.open.get(id)
    if (!entry) {
      const doc = super.loadText(id) ?? new Y.Doc()
      const listener = (update: Uint8Array, origin: unknown) => {
        for (const notify of this.textListeners) notify(id, update, origin)
      }
      doc.on('update', listener)
      entry = { doc, count: 0, listener }
      this.open.set(id, entry)
    }
    entry.count++
    return Y.encodeStateAsUpdate(entry.doc)
  }

  closeText(id: Id) {
    const entry = this.open.get(id)
    if (!entry || --entry.count > 0) return
    entry.doc.off('update', entry.listener)
    this.open.delete(id)
  }

  override loadText(id: Id): Y.Doc | undefined {
    return this.open.get(id)?.doc ?? super.loadText(id)
  }

  /** Apply an editor's Yjs update (`origin` tags it, so it is not echoed back) and keep the derived JSON in step. */
  applyLocalText(id: Id, update: Uint8Array, at: IsoDateTime, origin: unknown) {
    this.transaction(() => {
      const object = this.getObject(id)
      if (!object) throw new NotFoundError('not found')
      const doc = this.loadText(id) ?? new Y.Doc()
      Y.applyUpdate(doc, update, origin)
      this.putObject({ ...object, updatedAt: at }, undefined, doc)
    })
  }

  // ---------------------------------------------------------------------------
  // What the app's HTTP routes do, done locally (same rules; see packages/server/src/app.ts).

  spaceBundle(id: Id) {
    const space = this.getSpace(id)
    if (!space) throw new NotFoundError('not found')
    return { space, types: this.listTypes(id), counts: this.typeCounts(id), trash: this.trashCount(id) }
  }

  requireObject(id: Id): ObjectRecord {
    const object = this.getObject(id)
    if (!object) throw new NotFoundError('not found')
    return object
  }

  requireType(id: Id): ObjectType {
    const type = this.getType(id)
    if (!type) throw new NotFoundError('not found')
    return type
  }

  /** A space's members as the app last loaded them, for person values in lines typed offline (`assignee:ana`). */
  setPeople(spaceId: Id, people: Person[]) {
    this.setMeta(`people.${spaceId}`, JSON.stringify(people))
  }

  people(spaceId: Id): Person[] {
    return JSON.parse(this.getMeta(`people.${spaceId}`) ?? '[]') as Person[]
  }

  private lineContext(spaceId: Id, context: LineContext): LineContext {
    return { ...context, people: context.people ?? this.people(spaceId), ...(this.user ? { me: this.user } : {}) }
  }

  /** With `line`, the title and properties are read from it as captures read theirs (capture-line.ts). */
  createObject(data: Partial<ObjectRecord> & { typeId: Id }, at: IsoDateTime, line?: { text: string; context: LineContext }): ObjectRecord {
    const type = this.getType(data.typeId)
    if (!type) throw new InvalidError('typeId is required')
    if (line) {
      const made = objectFromLine(this, { type, line: line.text, ...(data.title ? { title: data.title } : {}), at, context: this.lineContext(type.spaceId, line.context) })
      return this.transaction(() => this.writeLineObject(made))
    }
    const { media: _media, ...rest } = data
    return this.putObject(newObject(type, rest, crypto.randomUUID(), at))
  }

  /**
   * Save the fields of an object. Only fields that differ from `base` (the copy the caller
   * edited, when it kept one for a while) are written, so a change pulled meanwhile is not
   * undone. Rich text and media are left alone: text changes through the open Y.Doc.
   */
  saveObject(object: ObjectRecord, at: IsoDateTime, base?: ObjectRecord): ObjectRecord {
    const stored = this.requireObject(object.id)
    if (object.typeId !== stored.typeId && this.getType(object.typeId)?.spaceId !== stored.spaceId) throw new InvalidError('unknown type')
    const next = applyEdit(stored, object, base ?? stored)
    return next ? this.putObject({ ...next, content: stored.content, updatedAt: at }) : stored
  }

  createType(data: { spaceId: Id; name: string; pluralName?: string; icon?: Icon }, at: IsoDateTime): ObjectType {
    if (!data.spaceId || !this.getSpace(data.spaceId) || !data.name?.trim()) throw new InvalidError('spaceId and name are required')
    const type = newType(data.spaceId, data, crypto.randomUUID(), at)
    this.putType(type)
    return type
  }

  saveType(body: ObjectType, at: IsoDateTime): ObjectType {
    const existing = this.requireType(body.id)
    const type: ObjectType = { ...body, id: existing.id, spaceId: existing.spaceId, createdAt: existing.createdAt, updatedAt: at }
    if (existing.system) type.system = existing.system
    else delete type.system
    this.putType(type)
    return type
  }

  /** To the trash with its objects. */
  trashType(id: Id, at: IsoDateTime) {
    const type = this.requireType(id)
    if (type.deletedAt) throw new NotFoundError('not found')
    if (type.system) throw new InvalidError('built-in types cannot be deleted')
    this.deleteType(id, at)
  }

  untrashType(id: Id, at: IsoDateTime) {
    const result = this.restoreType(id, at)
    if (!result) throw new InvalidError('the type is not in the trash')
    return result
  }

  trashObject(id: Id, at: IsoDateTime) {
    this.deleteObject(id, at)
  }

  untrashObject(id: Id, at: IsoDateTime) {
    const result = this.restoreObject(id, at)
    if (!result) throw new InvalidError('the object is not in the trash')
    return result
  }

  /** Rename a space, change its icon, its sidebar or its meals. */
  updateSpace(id: Id, body: Partial<Space>): Space {
    const existing = this.getSpace(id)
    if (!existing) throw new NotFoundError('not found')
    const nutrition = normalizeNutritionSettings(body.nutrition)
    const space: Space = {
      ...existing,
      ...(body.name?.trim() ? { name: body.name.trim() } : {}),
      ...(body.icon ? { icon: body.icon } : {}),
      ...(Array.isArray(body.sidebar) ? { sidebar: body.sidebar } : {}),
      ...(nutrition ? { nutrition } : {}),
    }
    this.putSpace(space)
    return space
  }

  /** Turn sprints on or off, or rename them (see setSprints). */
  setSprints(spaceId: Id, input: { enabled?: boolean; name?: string; pluralName?: string }, at: IsoDateTime): { space: Space; types: ObjectType[] } {
    try {
      return setSprints(this, spaceId, input, at)
    } catch (error) {
      if (error instanceof SprintError) throw new InvalidError(error.message)
      throw error
    }
  }

  /** Turn food tracking on or off (see setNutritionEnabled). */
  setNutrition(spaceId: Id, enabled: boolean, at: IsoDateTime): { space: Space; types: ObjectType[] } {
    if (!this.getSpace(spaceId)) throw new NotFoundError('not found')
    return setNutritionEnabled(this, spaceId, enabled, at)
  }

  /** Log something eaten on a day's note (see logFood). */
  logFood(spaceId: Id, input: LogFoodInput, at: IsoDateTime): ReturnType<typeof logFood> {
    try {
      return logFood(this, spaceId, input, at)
    } catch (error) {
      if (error instanceof NutritionError) throw error.message.endsWith('not found') ? new NotFoundError(error.message) : new InvalidError(error.message)
      throw error
    }
  }

  /** A line of food, as after /food, offline (see logFoodLine); `today` and `timeZone` are the device's. */
  logFoodLine(spaceId: Id, text: string, today: string, timeZone: string, at: IsoDateTime): FoodLineAnswer {
    try {
      return foodLineAnswer(logFoodLine(this, spaceId, text, { today, timeZone }, at), today)
    } catch (error) {
      if (error instanceof NutritionError) throw error.message === 'not found' ? new NotFoundError(error.message) : new InvalidError(error.message)
      throw error
    }
  }

  deleteFoodEntry(noteId: Id, entryId: Id, at: IsoDateTime): ObjectRecord {
    const note = deleteFoodEntry(this, noteId, entryId, at)
    if (!note) throw new NotFoundError('not found')
    return note
  }

  dailyNote(spaceId: Id, day: string, at: IsoDateTime): ObjectRecord {
    if (!this.getSpace(spaceId)) throw new NotFoundError('not found')
    return findOrCreateDailyNote(this, spaceId, day, at).note
  }

  inbox(spaceId: Id, today: string, days: number): { items: InboxItem[]; objects: ObjectSummary[] } {
    const items = listInbox(this, spaceId, today, Math.min(Math.max(days, 1), 365))
    const objects = this.getObjectSummaries([...new Set(items.flatMap((i) => i.objectIds))]).filter((o) => o.spaceId === spaceId)
    return { items, objects }
  }

  /** Capture a text into the day's note, offline (online, the server does it and turns links into weblinks). */
  capture(spaceId: Id, text: string, channel: string, day: string, at: IsoDateTime): CaptureAnswer {
    if (!this.getSpace(spaceId)) throw new NotFoundError('not found')
    if (!text.trim()) throw new InvalidError('text is required')
    const capture = { id: crypto.randomUUID(), channel, at }
    const note = this.transaction(() => appendCapture(this, spaceId, day, capture, textToBlocks(text)))
    return { dailyNoteId: note.id, blockId: capture.id }
  }

  /**
   * Capture an object of a type into the day's note, offline: the text's first line is its title
   * and properties (capture-line.ts), the other lines its body, and the note embeds it.
   */
  captureObject(spaceId: Id, typeId: Id, text: string, channel: string, day: string, at: IsoDateTime, timeZone: string): CaptureAnswer {
    const type = this.getType(typeId)
    if (!this.getSpace(spaceId) || !type || type.spaceId !== spaceId) throw new NotFoundError('not found')
    const [line = '', ...rest] = text.split('\n')
    const made = objectFromLine(this, { type, line, text: rest.join('\n'), at, context: this.lineContext(spaceId, { today: day, timeZone }) })
    const capture = { id: crypto.randomUUID(), channel, at }
    const note = this.transaction(() => {
      this.writeLineObject(made)
      return appendCapture(this, spaceId, day, capture, [{ type: 'objectEmbed', attrs: { objectId: made.object.id, display: 'inline' } }])
    })
    const names = new Map(this.people(spaceId).map((p) => [p.id, p.name]))
    const summary = describeCapture(made.type ?? type, made.object, made.parsed, timeZone, (id) => this.getObject(id)?.title ?? '?', (id) => names.get(id) ?? '?')
    const objects = [made.object, ...made.related].map((o) => ({ id: o.id, typeId: o.typeId, title: o.title }))
    return { dailyNoteId: note.id, blockId: capture.id, summary, objects, ...(made.parsed?.errors.length ? { unreadable: made.parsed.errors } : {}) }
  }

  private writeLineObject(made: LineObject): ObjectRecord {
    if (made.type) this.putType(made.type)
    for (const object of made.related) this.putObject(object)
    return this.putObject(made.object)
  }

  markCaptureDone(noteId: Id, captureId: Id, done: boolean, at: IsoDateTime): ObjectRecord {
    const note = setCaptureDone(this, noteId, captureId, done, at)
    if (!note) throw new NotFoundError('not found')
    return note
  }

  /** A quote of a passage of an object's text (see createQuote). */
  createQuote(sourceId: Id, input: { text: string; note?: string }, at: IsoDateTime): ObjectRecord {
    try {
      return createQuote(this, sourceId, input, at)
    } catch (error) {
      if (error instanceof QuoteError) throw error.message === 'not found' ? new NotFoundError('not found') : new InvalidError(error.message)
      throw error
    }
  }

  /** Change one occurrence of a repeating date, the series from it on, or all of it (see changeOccurrence). */
  changeOccurrence(edit: OccurrenceEdit, timeZone: string, at: IsoDateTime): { object: ObjectRecord; created?: ObjectRecord } {
    try {
      return changeOccurrence(this, edit, at, timeZone)
    } catch (error) {
      if (error instanceof OccurrenceError) throw new InvalidError(error.message)
      throw error
    }
  }

  query(spaceId: Id, input: Parameters<typeof querySpace>[2], now: IsoDateTime): ObjectSummary[] {
    if (!this.getSpace(spaceId)) throw new NotFoundError('not found')
    return querySpace(this, spaceId, { ...input, ...(this.user ? { me: this.user } : {}) }, now)
  }

  trash(spaceId: Id) {
    return { types: this.listDeletedTypes(spaceId), objects: this.listDeletedObjects(spaceId) }
  }
}

/** Whether a state vector `server` holds changes that `local` lacks. */
function lacks(local: Uint8Array, server: Uint8Array): boolean {
  const mine = Y.decodeStateVector(local)
  for (const [client, clock] of Y.decodeStateVector(server)) if ((mine.get(client) ?? 0) < clock) return true
  return false
}

