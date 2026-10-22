// The SQLite store of spaces, types, objects and subscribed calendars, with sync revisions and the
// objects' Yjs documents. It runs on any SQLite through `SqlDatabase`: node:sqlite on the server
// (`NodeStore`, which adds accounts), sqlite-wasm in the browser.
import { Y, loadYDoc, markDeletions, newBlockId, normalizeDoc, readContent, writeContent, type JsonDoc } from '@vasta/editor-schema/yjs'
import { ACTIVITY_MERGE_MS, DEFAULT_ACTIVITY_RETENTION_DAYS, activityChanges, type ActivityEntry } from './activity.ts'
import { blockIds, nodeAt, setBlockId } from './blocks.ts'
import { WriteRefused, commentAuthorshipProblem } from './comments.ts'
import { CAPACITIES_TASK_STATUS, SOURCE_PROPERTY_ID, builtinTypeId } from './builtin-types.ts'
import { docToPlainText, objectLinks, withoutQuoteHighlight } from './doc.ts'
import type {
  Backlink,
  CalendarSource,
  ColorName,
  DateValue,
  Doc,
  Filter,
  FilterGroup,
  Id,
  IsoDateTime,
  ObjectRecord,
  ObjectSummary,
  ObjectType,
  Space,
} from './model.ts'
import { ADDED_COLUMNS, ADDED_INDEXES_SQL, SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts'
import { addDays } from './time.ts'
import {
  HybridClock,
  SYNC_TABLES,
  canonicalJson,
  hlcAt,
  hlcTime,
  recordFields,
  stampChanges,
  type FieldClock,
  type SyncRecords,
  type SyncTable,
} from './sync.ts'

const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value))
const parse = <T>(value: unknown): T | undefined => (typeof value === 'string' ? (JSON.parse(value) as T) : undefined)

export type Row = Record<string, unknown>

export function rowToSpace(row: Row): Space {
  return {
    id: row.id as string,
    name: row.name as string,
    ...(row.icon ? { icon: parse(row.icon) } : {}),
    sidebar: parse(row.sidebar) ?? [],
    ...(row.nutrition ? { nutrition: parse(row.nutrition) } : {}),
    ...(row.sprints ? { sprints: parse(row.sprints) } : {}),
    createdAt: row.created_at as string,
  }
}

function rowToType(row: Row): ObjectType {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    ...(row.system ? { system: row.system as ObjectType['system'] } : {}),
    name: row.name as string,
    pluralName: row.plural_name as string,
    ...(row.description ? { description: row.description as string } : {}),
    ...(row.icon ? { icon: parse(row.icon) } : {}),
    ...(row.color ? { color: row.color as ObjectType['color'] } : {}),
    properties: parse(row.properties) ?? [],
    views: parse(row.views) ?? [],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    ...(row.deleted_at ? { deletedAt: row.deleted_at as string } : {}),
  }
}

function rowToSummary(row: Row): ObjectSummary {
  const date: DateValue | undefined = row.date_start
    ? {
        start: row.date_start as string,
        ...(row.date_end ? { end: row.date_end as string } : {}),
        resolution: (row.date_res ?? 'day') as 'day' | 'time',
        ...(row.date_rrule ? { rrule: row.date_rrule as string } : {}),
        ...(row.date_tz ? { timeZone: row.date_tz as string } : {}),
        ...(row.date_exceptions ? { exceptions: parse(row.date_exceptions) } : {}),
      }
    : undefined
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    typeId: row.type_id as string,
    title: row.title as string,
    ...(row.description ? { description: row.description as string } : {}),
    ...(row.icon ? { icon: parse(row.icon) } : {}),
    ...(row.cover_url ? { coverUrl: row.cover_url as string } : {}),
    ...(row.color ? { color: row.color as ColorName } : {}),
    ...(row.parent_id ? { parentId: row.parent_id as string } : {}),
    aliases: parse(row.aliases) ?? [],
    tagIds: parse(row.tag_ids) ?? [],
    collectionIds: parse(row.collection_ids) ?? [],
    props: parse(row.props) ?? {},
    ...(date ? { date } : {}),
    ...(row.query ? { query: parse(row.query) } : {}),
    ...(row.media ? { media: parse(row.media) } : {}),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    ...(row.deleted_at ? { deletedAt: row.deleted_at as string } : {}),
    ...(row.created_by ? { createdBy: row.created_by as string } : {}),
    ...(row.updated_by ? { updatedBy: row.updated_by as string } : {}),
    preview: (row.preview as string | null) ?? '',
  }
}

function rowToActivity(row: Row): ActivityEntry {
  return {
    id: Number(row.id),
    spaceId: row.space_id as string,
    objectId: row.object_id as string,
    at: row.at as string,
    ...(row.actor ? { actor: row.actor as string } : {}),
    kind: row.kind as ActivityEntry['kind'],
    ...(row.field ? { field: row.field as string } : {}),
    ...(row.before != null ? { before: parse(row.before) } : {}),
    ...(row.after != null ? { after: parse(row.after) } : {}),
  }
}

function rowToCalendarSource(row: Row): CalendarSource {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    name: row.name as string,
    url: row.url as string,
    ...(row.color ? { color: row.color as CalendarSource['color'] } : {}),
    ...(row.username ? { username: row.username as string } : {}),
    hasPassword: !!row.password,
    enabled: !!row.enabled,
    ...(row.synced_at ? { syncedAt: row.synced_at as string } : {}),
    ...(row.error ? { error: row.error as string } : {}),
    ...(row.event_count != null ? { eventCount: Number(row.event_count) } : {}),
    ...(row.data_hash ? { dataVersion: row.data_hash as string } : {}),
    createdAt: row.created_at as string,
  }
}

const SUMMARY_COLUMNS = `o.id, o.space_id, o.type_id, o.title, o.description, o.icon, o.cover_url, o.color, o.parent_id, o.aliases, o.tag_ids,
  o.collection_ids, o.props, o.date_start, o.date_end, o.date_res, o.date_rrule, o.date_tz, o.date_exceptions, o.query, o.media, o.created_at, o.updated_at, o.deleted_at, o.created_by, o.updated_by,
  substr(f.body, 1, 280) AS preview`
const SUMMARY_FROM = 'objects o LEFT JOIN search_rows r ON r.object_id = o.id LEFT JOIN objects_fts f ON f.rowid = r.id'

/** A synced row as pull returns it: the record, the clock of its fields and its last revision. */
export interface SyncRow<T extends SyncTable = SyncTable> {
  table: T
  id: Id
  spaceId: Id
  rev: number
  clock: FieldClock
  record: SyncRecords[T]
}

/** A pulled row; objects carry the state vector of their rich text (base64), to compare with the client's own. */
export type PulledRow = SyncRow & { textVector?: string }

/** A synced row deleted for good. */
export interface SyncTombstone {
  table: SyncTable
  id: Id
  spaceId: Id
  rev: number
}

const SYNC_ROW_MAPPERS: { [T in SyncTable]: (row: Row) => SyncRecords[T] } = {
  spaces: (row) => ({ ...rowToSpace(row), ...(row.deleted_at ? { deletedAt: row.deleted_at as string } : {}) }),
  types: rowToType,
  objects: (row) => {
    const { preview: _preview, ...summary } = rowToSummary(row)
    return { ...summary, content: parse(row.content) ?? {} }
  },
  calendar_sources: rowToCalendarSource,
}

/** Rich-text fields as the editor would save them; empty documents count as absent. */
function normalizeContent(content: ObjectRecord['content'] | undefined): ObjectRecord['content'] {
  return Object.fromEntries(
    Object.entries(content ?? {})
      .filter(([, doc]) => doc?.content?.length)
      .map(([field, doc]) => [field, normalizeDoc(doc as JsonDoc) as Doc])
  )
}

/** A short hash of a text (53-bit cyrb53, hex): not for security, only to tell versions apart. */
export function textHash(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16)
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`)

/** Turn free text into an FTS5 prefix query: every word must match the start of a token. */
function ftsQuery(text: string): string | undefined {
  const words = text.normalize('NFC').match(/[\p{L}\p{N}]+/gu)
  return words?.length ? words.map((w) => `"${w}"*`).join(' ') : undefined
}

/** A value SQLite takes as a parameter; blobs come back as Uint8Array, integers as numbers. */
export type SqlValue = null | number | bigint | string | Uint8Array

/** A range of instants or days as ISO text, either end open: `from` included, `to` not. */
export interface Bounds {
  from?: string
  to?: string
}

export interface SqlStatement {
  all(...params: SqlValue[]): Row[]
  get(...params: SqlValue[]): Row | undefined
  run(...params: SqlValue[]): unknown
}

/** The few calls the store needs from a SQLite binding (node:sqlite's `DatabaseSync` has them as they are). */
export interface SqlDatabase {
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  close(): void
}

/** The stored form of a Yjs document with nothing in it. */
export const EMPTY_TEXT = (() => {
  const ydoc = new Y.Doc()
  return { update: Y.encodeStateAsUpdate(ydoc), vector: Y.encodeStateVector(ydoc) }
})()

const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')

export class Store {
  readonly db: SqlDatabase
  /** Stamps the fields this store writes; a push merges the clients' HLCs into it. */
  readonly clock: HybridClock

  /** Opens the schema on `db` (idempotent); `node` names this store in the HLCs it makes the first time. */
  constructor(db: SqlDatabase, node = 'node') {
    this.db = db
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.db.exec(SCHEMA_SQL)
    for (const { table, column, definition } of ADDED_COLUMNS) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      if (!columns.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    }
    this.db.exec(ADDED_INDEXES_SQL)
    this.linkSearchRows()
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
    let id = this.getMeta('sync.node')
    if (!id) this.setMeta('sync.node', (id = `${node}-${randomHex(4)}`))
    this.clock = new HybridClock(id)
  }


  /**
   * Rows written before sync existed (or by an older version after a rollback) get a revision and
   * a clock, every field stamped at the row's updatedAt (or createdAt).
   */
  protected backfillSync() {
    this.transaction(() => {
      for (const table of SYNC_TABLES) {
        const rows = this.db.prepare(`SELECT * FROM ${table} WHERE rev IS NULL ORDER BY created_at, rowid`).all() as Row[]
        const update = this.db.prepare(`UPDATE ${table} SET rev = ?, clock = ? WHERE id = ?`)
        for (const row of rows) {
          const record = SYNC_ROW_MAPPERS[table](row)
          const hlc = hlcAt((row.updated_at ?? row.created_at) as string | undefined, this.clock.node)
          this.clock.observe(hlc)
          const clock = Object.fromEntries(Object.keys(recordFields(table, record as never)).map((name) => [name, hlc]))
          update.run(this.nextRev(table === 'spaces' ? record.id : (row.space_id as string)), JSON.stringify(clock), record.id)
        }
      }
    })
  }

  /**
   * Objects whose rich text has no Yjs document yet (written before step 2 of the sync, or by an
   * older version after a rollback: the document's rev lags the object's) get one from their JSON.
   * The JSON is rewritten as the editor would save it (defaults filled in); revs do not move, the
   * text means the same. The clock loses its old `content.<field>` entries.
   */
  protected convertText() {
    const rows = this.db
      .prepare('SELECT o.id, o.content, o.clock, o.rev FROM objects o LEFT JOIN object_docs d ON d.object_id = o.id WHERE d.rev IS NOT o.rev')
      .all() as Row[]
    if (!rows.length) return
    const failed: string[] = []
    this.transaction(() => {
      const update = this.db.prepare('UPDATE objects SET content = ?, clock = ? WHERE id = ?')
      for (const row of rows) {
        const id = row.id as string
        try {
          const ydoc = this.loadText(id) ?? new Y.Doc()
          const content = normalizeContent(parse<ObjectRecord['content']>(row.content) ?? {})
          writeContent(ydoc, content as Record<string, JsonDoc>)
          const clock = Object.fromEntries(Object.entries(parse<FieldClock>(row.clock) ?? {}).filter(([name]) => !name.startsWith('content.')))
          update.run(JSON.stringify(readContent(ydoc)), JSON.stringify(clock), id)
          this.saveText(id, ydoc, row.rev as number | null)
        } catch (error) {
          failed.push(`${id}: ${(error as Error).message}`)
        }
      }
    })
    if (failed.length) console.warn(`Rich text of ${failed.length} objects could not be converted to Yjs:\n${failed.join('\n')}`)
  }

  /**
   * Early imports kept Capacities' task status ids ("not-started"…) although the Task type's
   * options are "todo", "doing" and "done". Rewrites task values and query filters once.
   */
  protected fixTaskStatuses() {
    const key = 'fix.task-status-ids'
    if (this.getMeta(key)) return
    const map = (ids: unknown) => (Array.isArray(ids) ? ids.map((id) => (typeof id === 'string' ? (CAPACITIES_TASK_STATUS[id] ?? id) : id)) : ids)
    const fixFilter = (item: Filter | FilterGroup): Filter | FilterGroup =>
      item.kind === 'group'
        ? { ...item, items: item.items.map(fixFilter) }
        : item.field === 'status' && item.value?.kind === 'literal'
          ? { ...item, value: { kind: 'literal', value: map(item.value.value) as Id[] } }
          : item
    this.transaction(() => {
      const rows = this.db
        .prepare(`SELECT o.id FROM objects o JOIN types t ON t.id = o.type_id WHERE t.system IN ('task', 'query')`)
        .all() as Row[]
      for (const row of rows) {
        const object = this.getObject(row.id as string)
        if (!object) continue
        const status = object.props.status
        const next = { ...object }
        if (status?.kind === 'select') next.props = { ...object.props, status: { kind: 'select', value: map(status.value) as Id[] } }
        if (object.query?.filter) next.query = { ...object.query, filter: fixFilter(object.query.filter) as FilterGroup }
        if (JSON.stringify(next) !== JSON.stringify(object)) this.putObject(next)
      }
      this.setMeta(key, new Date().toISOString())
    })
  }

  close() {
    this.db.close()
  }

  private depth = 0

  /** Run `fn` in a transaction; nested calls join the outer one. */
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn()
    this.db.exec('BEGIN')
    this.depth++
    let result: T
    try {
      result = fn()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      this.pendingRevs.clear()
      throw error
    } finally {
      this.depth--
    }
    this.announceRevs()
    return result
  }

  // -------------------------------------------------------------------------
  // Sync: every write to a synced row takes the next global revision (in the same transaction)
  // and stamps the fields it changed. See docs/sync-plan.md.

  private revListeners = new Set<(spaceId: Id, rev: number) => void>()
  private pendingRevs = new Map<Id, number>()

  /** Hear about new revisions, once per space and transaction, after it commits. */
  onRev(listener: (spaceId: Id, rev: number) => void): () => void {
    this.revListeners.add(listener)
    return () => this.revListeners.delete(listener)
  }

  private announceRevs() {
    const revs = [...this.pendingRevs]
    this.pendingRevs.clear()
    for (const [spaceId, rev] of revs) for (const listener of this.revListeners) listener(spaceId, rev)
  }

  /** The revision of the last write to any synced row. */
  currentRev(): number {
    return Number(this.getMeta('sync.rev') ?? 0)
  }

  /** Take the next revision; call inside a transaction. */
  private nextRev(spaceId: Id): number {
    const rev = this.currentRev() + 1
    this.setMeta('sync.rev', String(rev))
    this.pendingRevs.set(spaceId, rev)
    return rev
  }

  /**
   * The revision and clock for writing `after` over `before`. A merge passes the clock it built;
   * any other write stamps the fields it changed with a new HLC of this store.
   */
  private syncStamp<T extends SyncTable>(table: T, spaceId: Id, before: SyncRow<T> | undefined, after: SyncRecords[T], clock?: FieldClock) {
    let next = clock
    if (!next) {
      for (const hlc of Object.values(before?.clock ?? {})) this.clock.observe(hlc)
      next = stampChanges(before && recordFields(table, before.record), recordFields(table, after), before?.clock ?? {}, this.clock.tick())
    }
    this.stamped(table, after.id, spaceId, before?.clock ?? {}, next)
    return { rev: this.nextRev(spaceId), clock: JSON.stringify(next) }
  }

  /** Every write of a synced row passes here with the clocks before and after it (a client's outbox hooks in). */
  protected stamped(_table: SyncTable, _id: Id, _spaceId: Id, _before: FieldClock, _after: FieldClock) {}

  /** Every save of an object's Yjs document passes here, after the object's row was written. */
  protected textSaved(_id: Id) {}

  /** Rows of a synced table matching `where`, with their clocks. */
  private syncRows<T extends SyncTable>(table: T, where: string, ...params: (string | number)[]): SyncRow<T>[] {
    const rows = this.db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...params) as Row[]
    return rows.map((row) => ({
      table,
      id: row.id as string,
      spaceId: (table === 'spaces' ? row.id : row.space_id) as string,
      rev: Number(row.rev ?? 0),
      clock: parse<FieldClock>(row.clock) ?? {},
      record: SYNC_ROW_MAPPERS[table](row),
    }))
  }

  /** One synced row, deleted (in the trash) or not. */
  syncRow<T extends SyncTable>(table: T, id: Id): SyncRow<T> | undefined {
    return this.syncRows(table, 'id = ?', id)[0]
  }

  /** Whether a row was deleted for good; it cannot be created again under its id. */
  isTombstoned(table: SyncTable, id: Id): boolean {
    return !!this.db.prepare('SELECT 1 FROM sync_tombstones WHERE kind = ? AND id = ?').get(table, id)
  }

  private tombstone(table: SyncTable, id: Id, spaceId: Id) {
    this.db.prepare('INSERT OR REPLACE INTO sync_tombstones (kind, id, space_id, rev) VALUES (?, ?, ?, ?)').run(table, id, spaceId, this.nextRev(spaceId))
  }

  /**
   * What changed in `spaceIds` after revision `since`, oldest first: rows (with their clocks) and
   * tombstones, at most `limit` of them together; `more` when there are others after them.
   */
  syncChanges(spaceIds: Id[], since: number, limit: number): { rows: SyncRow[]; tombstones: SyncTombstone[]; more: boolean } {
    const spaces = JSON.stringify(spaceIds)
    const inSpaces = (column: string) => `${column} IN (SELECT value FROM json_each(?)) AND rev > ?`
    const entries = this.db
      .prepare(
        `SELECT kind, id, rev FROM (
           SELECT 'spaces' AS kind, id, rev FROM spaces WHERE ${inSpaces('id')}
           UNION ALL SELECT 'types', id, rev FROM types WHERE ${inSpaces('space_id')}
           UNION ALL SELECT 'objects', id, rev FROM objects WHERE ${inSpaces('space_id')}
           UNION ALL SELECT 'calendar_sources', id, rev FROM calendar_sources WHERE ${inSpaces('space_id')}
           UNION ALL SELECT 'tombstone', kind || ' ' || id, rev FROM sync_tombstones WHERE ${inSpaces('space_id')}
         ) ORDER BY rev LIMIT ?`
      )
      .all(spaces, since, spaces, since, spaces, since, spaces, since, spaces, since, limit + 1) as { kind: string; id: string; rev: number }[]
    const more = entries.length > limit
    const page = entries.slice(0, limit)
    const rows: SyncRow[] = []
    for (const table of SYNC_TABLES) {
      const ids = page.filter((e) => e.kind === table).map((e) => e.id)
      if (ids.length) rows.push(...this.syncRows(table, 'id IN (SELECT value FROM json_each(?))', JSON.stringify(ids)))
    }
    rows.sort((a, b) => a.rev - b.rev)
    const tombstoneKeys = page.filter((e) => e.kind === 'tombstone').map((e) => e.id)
    const tombstones = tombstoneKeys.length
      ? (
          this.db
            .prepare(`SELECT * FROM sync_tombstones WHERE kind || ' ' || id IN (SELECT value FROM json_each(?)) ORDER BY rev`)
            .all(JSON.stringify(tombstoneKeys)) as Row[]
        ).map((row) => ({ table: row.kind as SyncTable, id: row.id as string, spaceId: row.space_id as string, rev: Number(row.rev) }))
      : []
    return { rows, tombstones, more }
  }

  /** How many rows and tombstones of `spaceIds` have a revision above `since`. */
  syncCount(spaceIds: Id[], since: number): number {
    const spaces = JSON.stringify(spaceIds)
    const count = (table: string, column: string) => `(SELECT count(*) FROM ${table} WHERE ${column} IN (SELECT value FROM json_each(?)) AND rev > ?)`
    const row = this.db
      .prepare(
        `SELECT ${count('spaces', 'id')} + ${count('types', 'space_id')} + ${count('objects', 'space_id')} + ${count('calendar_sources', 'space_id')} + ${count('sync_tombstones', 'space_id')} AS n`
      )
      .get(spaces, since, spaces, since, spaces, since, spaces, since, spaces, since) as Row
    return Number(row.n)
  }

  /** Insert or update a space. Whether it is in the trash is set by setSpaceDeleted only. `clock`: see putObject. */
  putSpace(space: Space, clock?: FieldClock) {
    this.transaction(() => {
      const before = this.syncRow('spaces', space.id)
      const { deletedAt: _deletedAt, ...rest } = space as SyncRecords['spaces']
      const after = { ...rest, ...(before?.record.deletedAt ? { deletedAt: before.record.deletedAt } : {}) }
      const stamp = this.syncStamp('spaces', space.id, before, after, clock)
      // An upsert, not INSERT OR REPLACE: replacing deletes the row, which would cascade to its members.
      this.db
        .prepare(
          `INSERT INTO spaces (id, name, icon, sidebar, nutrition, sprints, created_at, rev, clock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET name = excluded.name, icon = excluded.icon, sidebar = excluded.sidebar, nutrition = excluded.nutrition, sprints = excluded.sprints,
             created_at = excluded.created_at, rev = excluded.rev, clock = excluded.clock`
        )
        .run(space.id, space.name, json(space.icon), json(space.sidebar), json(space.nutrition), json(space.sprints), space.createdAt, stamp.rev, stamp.clock)
    })
  }

  /** `clock`: see putObject. */
  putType(type: ObjectType, clock?: FieldClock) {
    this.transaction(() => {
      const stamp = this.syncStamp('types', type.spaceId, this.syncRow('types', type.id), type, clock)
      this.db
        .prepare(
          `INSERT OR REPLACE INTO types (id, space_id, system, name, plural_name, description, icon, color, properties, views, created_at, updated_at, deleted_at, rev, clock)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          type.id, type.spaceId, type.system ?? null, type.name, type.pluralName, type.description ?? null,
          json(type.icon), type.color ?? null, json(type.properties), json(type.views), type.createdAt, type.updatedAt,
          type.deletedAt ?? null, stamp.rev, stamp.clock
        )
      this.db.prepare("DELETE FROM sync_tombstones WHERE kind = 'types' AND id = ?").run(type.id)
    })
  }

  /** Move a type and all its objects to the trash. Built-in types cannot be deleted. */
  deleteType(id: Id, at: string): boolean {
    const type = this.getType(id)
    if (!type || type.system || type.deletedAt) return false
    this.transaction(() => {
      for (const object of this.listObjects(id)) this.deleteObject(object.id, at)
      this.putType({ ...type, deletedAt: at, updatedAt: at })
      const space = this.getSpace(type.spaceId)
      if (space) this.putSpace({ ...space, sidebar: space.sidebar.map((s) => ({ ...s, items: s.items.filter((i) => i !== id) })) })
    })
    return true
  }

  /**
   * Insert or replace an object whole. The fields that differ from the stored row are stamped with
   * a new HLC; a sync merge passes the `clock` it computed instead.
   *
   * Rich text goes through the object's Yjs document: the fields whose JSON changed are diffed
   * into it, and the stored JSON is read back from it (as the editor would save it). A sync merge
   * that already applied a client's Yjs update passes the document as `text`; `object.content` is
   * then ignored. Returns the object as stored.
   */
  putObject(object: ObjectRecord, clock?: FieldClock, text?: Y.Doc): ObjectRecord {
    return this.transaction(() => {
      const before = this.syncRow('objects', object.id)
      const { content, ydoc } = this.textAfter(object.id, object.content, before?.record.content, text)
      object = this.withAuthors({ ...object, content }, before?.record, !!ydoc)
      this.checkAuthorship(before?.record, object)
      const stamp = this.syncStamp('objects', object.spaceId, before, object, clock)
      this.writeObjectRow(object, stamp)
      this.recordActivity(before?.record, object, JSON.parse(stamp.clock) as FieldClock)
      const actor = this.actor?.()
      if (this.recordsActivity && actor) this.onObjectWrite?.(before?.record, object, actor)
      if (ydoc) this.saveText(object.id, ydoc, stamp.rev)
      else this.db.prepare('UPDATE object_docs SET rev = ? WHERE object_id = ?').run(stamp.rev, object.id)
      this.reindexObject(object)
      return object
    })
  }

  /**
   * The user whose write is being applied (the server: the request's user; a replica: its user),
   * recorded as who made and who last changed an object. Unset for writes nobody made.
   */
  actor?: () => Id | undefined

  /**
   * Who made `object` and who changed it last, after a write over `before`: those stay as stored
   * unless the actor changed something (`textChanged`: its rich text). Writes nobody made keep them.
   */
  private withAuthors(object: ObjectRecord, before: ObjectRecord | undefined, textChanged: boolean): ObjectRecord {
    const { createdBy: _c, updatedBy: _u, ...rest } = object
    const actor = this.actor?.()
    // A write nobody made (a replica applying the server's rows) keeps the authors it carries.
    const createdBy = before && actor ? before.createdBy : (object.createdBy ?? before?.createdBy)
    let updatedBy = before && actor ? before.updatedBy : (object.updatedBy ?? before?.updatedBy)
    if (actor) {
      const changed = !before || textChanged || canonicalJson(recordFields('objects', before)) !== canonicalJson(recordFields('objects', object))
      if (changed) updatedBy = actor
      if (!before) return { ...rest, createdBy: actor, updatedBy }
    }
    return { ...rest, ...(createdBy ? { createdBy } : {}), ...(updatedBy ? { updatedBy } : {}) }
  }

  /**
   * The server keeps comments their authors' (comments.ts): a write by a user that adds a comment
   * as someone else, or changes or deletes another's, is refused whole.
   */
  private checkAuthorship(before: ObjectRecord | undefined, after: ObjectRecord) {
    const actor = this.actor?.()
    if (!this.recordsActivity || !actor) return
    const problem = commentAuthorshipProblem(before, after, actor)
    if (problem) throw new WriteRefused(problem)
  }

  // -------------------------------------------------------------------------
  // Activity (activity.ts): recorded by the server only, for writes a user made.

  /** Hears every object written by a user on the server, inside the write's transaction (notifications). */
  onObjectWrite?: (before: ObjectRecord | undefined, after: ObjectRecord, actor: Id) => void

  /** Whether this store records activity (the server's; replicas read it over HTTP). */
  protected get recordsActivity() {
    return false
  }

  private recordActivity(before: ObjectRecord | undefined, after: ObjectRecord, clock: FieldClock) {
    const actor = this.actor?.()
    if (!this.recordsActivity || !actor) return
    const now = new Date().toISOString()
    // When the field was written: its HLC (a push brings the device's time), never ahead of now.
    const timeOf = (field: string) => {
      const time = clock[field] ? hlcTime(clock[field]) : 0
      return time ? new Date(Math.min(time, Date.parse(now))).toISOString() : now
    }
    const changes = activityChanges(before, after, this.getType(after.typeId), timeOf)
    const insert = this.db.prepare('INSERT INTO activity (space_id, object_id, at, actor, kind, field, before, after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    for (const change of changes) {
      if (change.kind === 'changed' && this.mergeActivity(after.id, actor, change)) continue
      insert.run(after.spaceId, after.id, change.at, actor, change.kind, change.field ?? null, json(change.before), json(change.after))
    }
  }

  /**
   * Fold a change into the same person's last change of the field, when it was moments ago
   * (typing a title saves it several times): it keeps its first value and takes the new one, and
   * goes away when the value is back where it started. Whether it was folded.
   */
  private mergeActivity(objectId: Id, actor: Id, change: { at: string; field?: string; before?: unknown; after?: unknown }): boolean {
    const last = this.db
      .prepare("SELECT id, at, actor, field, before FROM activity WHERE object_id = ? ORDER BY at DESC, id DESC LIMIT 1")
      .get(objectId) as Row | undefined
    if (!last || last.actor !== actor || last.field !== change.field) return false
    if (Date.parse(change.at) - Date.parse(last.at as string) > ACTIVITY_MERGE_MS || Date.parse(change.at) < Date.parse(last.at as string)) return false
    if (canonicalJson(parse(last.before) ?? null) === canonicalJson(change.after ?? null)) this.db.prepare('DELETE FROM activity WHERE id = ?').run(last.id as number)
    else this.db.prepare('UPDATE activity SET at = ?, after = ? WHERE id = ?').run(change.at, json(change.after), last.id as number)
    return true
  }

  /** An object's activity, newest first. */
  objectActivity(objectId: Id, limit = 200): ActivityEntry[] {
    return (this.db.prepare('SELECT * FROM activity WHERE object_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(objectId, limit) as Row[]).map(rowToActivity)
  }

  /** A space's activity at or after `since` (and before `until`), oldest first. */
  spaceActivity(spaceId: Id, options: { since?: IsoDateTime; until?: IsoDateTime; limit?: number } = {}): ActivityEntry[] {
    return (
      this.db
        .prepare('SELECT * FROM activity WHERE space_id = ? AND at >= ? AND at < ? ORDER BY at, id LIMIT ?')
        .all(spaceId, options.since ?? '', options.until ?? '9999', options.limit ?? 100_000) as Row[]
    ).map(rowToActivity)
  }

  /** Days a space keeps activity; 0 keeps everything. */
  activityRetention(spaceId: Id): number {
    const stored = this.getMeta(`activity.retention.${spaceId}`)
    return stored === undefined ? DEFAULT_ACTIVITY_RETENTION_DAYS : Number(stored)
  }

  setActivityRetention(spaceId: Id, days: number) {
    this.setMeta(`activity.retention.${spaceId}`, String(Math.max(0, Math.floor(days))))
  }

  /** Delete activity older than each space's retention. Returns how many entries went. */
  purgeActivity(now: IsoDateTime): number {
    let removed = 0
    this.transaction(() => {
      for (const space of this.db.prepare('SELECT DISTINCT space_id FROM activity').all() as Row[]) {
        const spaceId = space.space_id as string
        const days = this.activityRetention(spaceId)
        if (!days) continue
        const cutoff = new Date(Date.parse(now) - days * 86_400_000).toISOString()
        const before = Number((this.db.prepare('SELECT count(*) AS n FROM activity WHERE space_id = ? AND at < ?').get(spaceId, cutoff) as { n: number }).n)
        if (before) this.db.prepare('DELETE FROM activity WHERE space_id = ? AND at < ?').run(spaceId, cutoff)
        removed += before
      }
    })
    return removed
  }

  /**
   * Write an object's row with the clock a sync merge computed, its rich text left as stored (none
   * yet for a new object): a replica fetches the text apart and derives the JSON from it then.
   */
  protected putObjectRow(object: ObjectRecord, clock: FieldClock) {
    this.transaction(() => {
      const before = this.syncRow('objects', object.id)
      object = { ...object, content: before?.record.content ?? {} }
      const stamp = this.syncStamp('objects', object.spaceId, before, object, clock)
      this.writeObjectRow(object, stamp)
      this.db
        .prepare('INSERT INTO object_docs (object_id, ydoc, vector, rev) VALUES (?, ?, ?, ?) ON CONFLICT (object_id) DO UPDATE SET rev = excluded.rev')
        .run(object.id, EMPTY_TEXT.update, EMPTY_TEXT.vector, stamp.rev)
      this.reindexObject(object)
    })
  }

  private writeObjectRow(object: ObjectRecord, stamp: { rev: number; clock: string }) {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO objects (id, space_id, type_id, title, description, icon, cover_url, color, parent_id, aliases, tag_ids,
           collection_ids, props, content, date_start, date_end, date_res, date_rrule, date_tz, date_exceptions, query, media, created_at, updated_at, deleted_at,
           created_by, updated_by, rev, clock)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        object.id, object.spaceId, object.typeId, object.title, object.description ?? null, json(object.icon),
        object.coverUrl ?? null, object.color ?? null, object.parentId ?? null, json(object.aliases), json(object.tagIds), json(object.collectionIds), json(object.props),
        json(object.content), object.date?.start ?? null, object.date?.end ?? null, object.date?.resolution ?? null,
        object.date?.rrule ?? null, object.date?.timeZone ?? null,
        object.date?.exceptions && Object.keys(object.date.exceptions).length ? JSON.stringify(object.date.exceptions) : null,
        json(object.query), json(object.media), object.createdAt, object.updatedAt, object.deletedAt ?? null,
        object.createdBy ?? null, object.updatedBy ?? null, stamp.rev, stamp.clock
      )
    this.db.prepare("DELETE FROM sync_tombstones WHERE kind = 'objects' AND id = ?").run(object.id)
  }

  /** The rich text after a write, and the object's Y.Doc when the text changed (to save). */
  private textAfter(id: Id, content: ObjectRecord['content'], before: ObjectRecord['content'] | undefined, text?: Y.Doc) {
    if (text) return { content: readContent(text) as ObjectRecord['content'], ydoc: text }
    const next = normalizeContent(content)
    const fields = [...new Set([...Object.keys(next), ...Object.keys(before ?? {})])]
    const changed = fields.filter((field) => canonicalJson(next[field] ?? null) !== canonicalJson(before?.[field] ?? null))
    const hasText = !!this.db.prepare('SELECT 1 FROM object_docs WHERE object_id = ?').get(id)
    if (hasText && !changed.length) return { content: next }
    const ydoc = (hasText && this.loadText(id)) || new Y.Doc()
    writeContent(ydoc, next as Record<string, JsonDoc>, undefined, hasText ? changed : undefined)
    return { content: readContent(ydoc) as ObjectRecord['content'], ydoc }
  }

  /** The Yjs document holding an object's rich text. */
  loadText(id: Id): Y.Doc | undefined {
    const row = this.db.prepare('SELECT ydoc FROM object_docs WHERE object_id = ?').get(id) as Row | undefined
    return row ? loadYDoc(row.ydoc as Uint8Array) : undefined
  }

  /** The server's store marks changes that only delete (markDeletions), so devices notice them. */
  protected get announcesDeletions() {
    return false
  }

  private saveText(id: Id, ydoc: Y.Doc, rev: number | null) {
    if (this.announcesDeletions) {
      const stored = this.db.prepare('SELECT ydoc, vector FROM object_docs WHERE object_id = ?').get(id) as Row | undefined
      const vector = Y.encodeStateVector(ydoc)
      if (stored && sameBytes(stored.vector as Uint8Array, vector)) {
        // Same items: compare the delete sets (an update holding only them).
        const deletes = Y.encodeStateAsUpdate(ydoc, vector)
        if (!sameBytes(Y.diffUpdate(stored.ydoc as Uint8Array, stored.vector as Uint8Array), deletes)) markDeletions(ydoc)
      }
    }
    this.db
      .prepare('INSERT OR REPLACE INTO object_docs (object_id, ydoc, vector, rev) VALUES (?, ?, ?, ?)')
      .run(id, Y.encodeStateAsUpdate(ydoc), Y.encodeStateVector(ydoc), rev)
    this.textSaved(id)
  }

  /** The Yjs state vectors of objects' rich text (what a client compares with its own to see if it lags). */
  textVectors(ids: Id[]): Map<Id, Uint8Array> {
    const rows = this.db.prepare('SELECT object_id, vector FROM object_docs WHERE object_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as Row[]
    return new Map(rows.map((row) => [row.object_id as string, row.vector as Uint8Array]))
  }

  putImportSource(objectId: Id, source: string, sourceId: string, raw: unknown) {
    this.db
      .prepare('INSERT OR REPLACE INTO import_sources (object_id, source, source_id, raw) VALUES (?, ?, ?, ?)')
      .run(objectId, source, sourceId, JSON.stringify(raw))
  }

  /** Refresh the derived links and search rows of one object. */
  reindexObject(object: ObjectRecord) {
    this.db.prepare('DELETE FROM links WHERE from_id = ?').run(object.id)
    if (object.deletedAt) {
      this.dropSearchRow(object.id)
      return
    }
    const insertLink = this.db.prepare('INSERT OR IGNORE INTO links (from_id, to_id, kind, via) VALUES (?, ?, ?, ?)')
    for (const link of objectLinks(object)) insertLink.run(link.fromId, link.toId, link.kind, link.via ?? '')
    const body = Object.values(object.content).map(docToPlainText).filter(Boolean).join('\n\n')
    const row = this.db.prepare('SELECT id FROM search_rows WHERE object_id = ?').get(object.id)
    if (row) {
      this.db.prepare('UPDATE objects_fts SET title = ?, body = ? WHERE rowid = ?').run(object.title, body, row.id as number)
    } else {
      const { id } = this.db.prepare('INSERT INTO search_rows (object_id) VALUES (?) RETURNING id').get(object.id)!
      this.db.prepare('INSERT INTO objects_fts (rowid, object_id, title, body) VALUES (?, ?, ?, ?)').run(id as number, object.id, object.title, body)
    }
  }

  private dropSearchRow(id: Id) {
    const row = this.db.prepare('DELETE FROM search_rows WHERE object_id = ? RETURNING id').get(id)
    if (row) this.db.prepare('DELETE FROM objects_fts WHERE rowid = ?').run(row.id as number)
  }

  /**
   * Search rows written before search_rows existed, or by an older version after a rollback (it
   * replaces rows under new rowids), are matched to their objects again; duplicates go.
   */
  private linkSearchRows() {
    const count = (from: string) => Number((this.db.prepare(`SELECT count(*) AS n FROM ${from}`).get() as Row).n)
    const matched = count('objects_fts f JOIN search_rows r ON r.id = f.rowid AND r.object_id = f.object_id')
    if (matched === count('objects_fts') && matched === count('search_rows')) return
    this.transaction(() => {
      this.db.exec('DELETE FROM search_rows')
      this.db.exec('INSERT OR IGNORE INTO search_rows (id, object_id) SELECT rowid, object_id FROM objects_fts ORDER BY rowid DESC')
      this.db.exec('DELETE FROM objects_fts WHERE rowid NOT IN (SELECT id FROM search_rows)')
    })
  }

  // -------------------------------------------------------------------------
  // Reads

  /** Spaces in use; deleted ones (in the trash) are left out here and everywhere else but the trash calls below. */
  listSpaces(): Space[] {
    return (this.db.prepare('SELECT * FROM spaces WHERE deleted_at IS NULL ORDER BY created_at').all() as Row[]).map(rowToSpace)
  }

  getSpace(id: Id): Space | undefined {
    const row = this.db.prepare('SELECT * FROM spaces WHERE id = ? AND deleted_at IS NULL').get(id) as Row | undefined
    return row ? rowToSpace(row) : undefined
  }

  /** Spaces in the trash, with when they were deleted. */
  listDeletedSpaces(): (Space & { deletedAt: string })[] {
    return (this.db.prepare('SELECT * FROM spaces WHERE deleted_at IS NOT NULL ORDER BY deleted_at').all() as Row[]).map((row) => ({
      ...rowToSpace(row),
      deletedAt: row.deleted_at as string,
    }))
  }

  /** Move a space to the trash (`at`), or back out of it (null). */
  setSpaceDeleted(id: Id, at: string | null) {
    this.transaction(() => {
      const before = this.syncRow('spaces', id)
      if (!before) return
      const { deletedAt: _deletedAt, ...rest } = before.record
      const stamp = this.syncStamp('spaces', id, before, { ...rest, ...(at ? { deletedAt: at } : {}) })
      this.db.prepare('UPDATE spaces SET deleted_at = ?, rev = ?, clock = ? WHERE id = ?').run(at, stamp.rev, stamp.clock, id)
    })
  }

  /**
   * Delete a space and everything in it for good: objects (with their links and search entries),
   * types, subscribed calendars and memberships. Media files stay; they are shared by hash.
   */
  purgeSpace(id: Id) {
    this.transaction(() => {
      const objects = 'SELECT id FROM objects WHERE space_id = ?'
      this.db.prepare(`DELETE FROM links WHERE from_id IN (${objects}) OR to_id IN (${objects})`).run(id, id)
      this.db.prepare(`DELETE FROM objects_fts WHERE rowid IN (SELECT id FROM search_rows WHERE object_id IN (${objects}))`).run(id)
      this.db.prepare(`DELETE FROM search_rows WHERE object_id IN (${objects})`).run(id)
      this.db.prepare(`DELETE FROM import_sources WHERE object_id IN (${objects})`).run(id)
      this.db.prepare(`DELETE FROM object_docs WHERE object_id IN (${objects})`).run(id)
      this.db.prepare('DELETE FROM activity WHERE space_id = ?').run(id)
      this.db.prepare('DELETE FROM notifications WHERE space_id = ?').run(id)
      this.db.prepare("DELETE FROM meta WHERE key = 'activity.retention.' || ?").run(id)
      this.db.prepare('DELETE FROM objects WHERE space_id = ?').run(id)
      this.db.prepare('DELETE FROM types WHERE space_id = ?').run(id)
      this.db.prepare('DELETE FROM calendar_sources WHERE space_id = ?').run(id)
      this.db.prepare('UPDATE users SET capture_space_id = NULL WHERE capture_space_id = ?').run(id)
      // Nobody is a member any more, so no client pulls the space again: its tombstones can go too.
      this.db.prepare('DELETE FROM sync_tombstones WHERE space_id = ?').run(id)
      this.db.prepare('DELETE FROM spaces WHERE id = ?').run(id)
    })
  }

  listTypes(spaceId: Id): ObjectType[] {
    return (this.db.prepare('SELECT * FROM types WHERE space_id = ? AND deleted_at IS NULL ORDER BY name').all(spaceId) as Row[]).map(rowToType)
  }

  getType(id: Id): ObjectType | undefined {
    const row = this.db.prepare('SELECT * FROM types WHERE id = ?').get(id) as Row | undefined
    return row ? rowToType(row) : undefined
  }

  /** Object counts per type, for the sidebar and type pages. */
  typeCounts(spaceId: Id): Record<Id, number> {
    const rows = this.db
      .prepare('SELECT type_id, count(*) n FROM objects WHERE space_id = ? AND deleted_at IS NULL GROUP BY type_id')
      .all(spaceId) as { type_id: string; n: number }[]
    return Object.fromEntries(rows.map((r) => [r.type_id, Number(r.n)]))
  }

  listObjects(typeId: Id): ObjectSummary[] {
    return (
      this.db
        .prepare(`SELECT ${SUMMARY_COLUMNS} FROM ${SUMMARY_FROM} WHERE o.type_id = ? AND o.deleted_at IS NULL ORDER BY o.updated_at DESC`)
        .all(typeId) as Row[]
    ).map(rowToSummary)
  }

  /** Every live object of a space; queries over all types start from this. */
  listSpaceObjects(spaceId: Id): ObjectSummary[] {
    return (
      this.db
        .prepare(`SELECT ${SUMMARY_COLUMNS} FROM ${SUMMARY_FROM} WHERE o.space_id = ? AND o.deleted_at IS NULL ORDER BY o.updated_at DESC`)
        .all(spaceId) as Row[]
    ).map(rowToSummary)
  }

  /**
   * Live objects of a space that may have a date in a range of days: their own date within it
   * (a couple of days either side, for time zones) or repeating from before its end, and every
   * object of `dateTypeIds` (types with a date property: those dates are in the props).
   */
  listDatedObjects(spaceId: Id, range: { from: string; to: string }, dateTypeIds: Id[]): ObjectSummary[] {
    return (
      this.db
        .prepare(
          // The space is checked outside: inside, it would draw SQLite to an index by space and to
          // reading every row for its date, instead of objects_date.
          `SELECT ${SUMMARY_COLUMNS} FROM ${SUMMARY_FROM} WHERE o.rowid IN (
             SELECT rowid FROM objects WHERE type_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL
             UNION SELECT rowid FROM objects WHERE date_start IS NOT NULL AND date_start < ? AND (date_rrule IS NOT NULL OR coalesce(date_end, date_start) >= ?))
           AND o.space_id = ? AND o.deleted_at IS NULL
           ORDER BY o.updated_at DESC`
        )
        .all(JSON.stringify(dateTypeIds), addDays(range.to, 3), addDays(range.from, -2), spaceId) as Row[]
    ).map(rowToSummary)
  }

  /**
   * Live objects of a space, of some types (all when empty), created and changed within bounds
   * (instants or days, either end open: `from` included, `to` not).
   */
  listObjectsWithin(spaceId: Id, typeIds: Id[], bounds: { created?: Bounds; updated?: Bounds }): ObjectSummary[] {
    const where = ['o.space_id = ?', 'o.deleted_at IS NULL']
    const params: SqlValue[] = [spaceId]
    if (typeIds.length) {
      where.push('o.type_id IN (SELECT value FROM json_each(?))')
      params.push(JSON.stringify(typeIds))
    }
    for (const [column, range] of [['o.created_at', bounds.created], ['o.updated_at', bounds.updated]] as const) {
      if (range?.from) {
        where.push(`${column} >= ?`)
        params.push(range.from)
      }
      if (range?.to) {
        where.push(`${column} < ?`)
        params.push(range.to)
      }
    }
    return (
      this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM ${SUMMARY_FROM} WHERE ${where.join(' AND ')} ORDER BY o.updated_at DESC`).all(...params) as Row[]
    ).map(rowToSummary)
  }

  getObjectSummaries(ids: Id[]): ObjectSummary[] {
    if (!ids.length) return []
    const placeholders = ids.map(() => '?').join(',')
    return (this.db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM ${SUMMARY_FROM} WHERE o.id IN (${placeholders})`).all(...ids) as Row[]).map(rowToSummary)
  }

  getObject(id: Id): ObjectRecord | undefined {
    const row = this.db.prepare(`SELECT ${SUMMARY_COLUMNS}, o.content FROM ${SUMMARY_FROM} WHERE o.id = ?`).get(id) as Row | undefined
    if (!row) return undefined
    const { preview: _preview, ...summary } = rowToSummary(row)
    return { ...summary, content: parse(row.content) ?? {} }
  }

  /** How many live objects link to each of these (a link to itself does not count); ids nothing links to are left out. */
  linkCounts(ids: Id[]): Map<Id, number> {
    const rows = this.db
      .prepare(
        `SELECT l.to_id, count(DISTINCT l.from_id) AS n FROM links l JOIN objects o ON o.id = l.from_id
          WHERE l.to_id IN (SELECT value FROM json_each(?)) AND l.from_id != l.to_id AND o.deleted_at IS NULL
          GROUP BY l.to_id`
      )
      .all(JSON.stringify(ids)) as Row[]
    return new Map(rows.map((row) => [row.to_id as string, Number(row.n)]))
  }

  backlinks(id: Id): Backlink[] {
    const rows = this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS}, l.kind AS link_kind, l.via AS link_via
           FROM links l JOIN objects o ON o.id = l.from_id LEFT JOIN search_rows r ON r.object_id = o.id LEFT JOIN objects_fts f ON f.rowid = r.id
          WHERE l.to_id = ? AND o.deleted_at IS NULL
          ORDER BY o.updated_at DESC`
      )
      .all(id) as Row[]
    return rows.map((row) => ({ object: rowToSummary(row), kind: row.link_kind as Backlink['kind'], via: row.link_via as string }))
  }

  /** Title matches first (prefix, then substring), then full-text matches in the body. */
  search(spaceId: Id, text: string, limit = 30): ObjectSummary[] {
    const trimmed = text.trim()
    if (!trimmed) {
      return (
        this.db
          .prepare(`SELECT ${SUMMARY_COLUMNS} FROM ${SUMMARY_FROM} WHERE o.space_id = ? AND o.deleted_at IS NULL ORDER BY o.updated_at DESC LIMIT ?`)
          .all(spaceId, limit) as Row[]
      ).map(rowToSummary)
    }
    // The matches come from objects_titles alone; only those shown are read from the table.
    const like = escapeLike(trimmed)
    const byTitle = this.db
      .prepare(
        `SELECT ${SUMMARY_COLUMNS} FROM ${SUMMARY_FROM}
          WHERE o.rowid IN (
            SELECT rowid FROM objects WHERE space_id = ? AND deleted_at IS NULL AND (title LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\')
            ORDER BY CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, length(title) LIMIT ?)
          ORDER BY CASE WHEN o.title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, length(o.title)`
      )
      .all(spaceId, `%${like}%`, `%${like}%`, `${like}%`, limit, `${like}%`) as Row[]
    const results = byTitle.map(rowToSummary)
    const fts = ftsQuery(trimmed)
    if (fts && results.length < limit) {
      const seen = new Set(results.map((r) => r.id))
      const byBody = this.db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS} FROM objects_fts f JOIN objects o ON o.id = f.object_id
            WHERE objects_fts MATCH ? AND o.space_id = ? AND o.deleted_at IS NULL
            ORDER BY rank LIMIT ?`
        )
        .all(fts, spaceId, limit) as Row[]
      for (const row of byBody) {
        if (results.length >= limit) break
        if (!seen.has(row.id as string)) results.push(rowToSummary(row))
      }
    }
    return results
  }

  /** The live object of a type dated on a day ("YYYY-MM-DD"); used for daily notes. */
  findObjectOnDay(typeId: Id, day: string): ObjectRecord | undefined {
    const row = this.db
      .prepare('SELECT id FROM objects WHERE type_id = ? AND deleted_at IS NULL AND substr(date_start, 1, 10) = ? ORDER BY created_at LIMIT 1')
      .get(typeId, day) as Row | undefined
    return row ? this.getObject(row.id as string) : undefined
  }

  /** A live object of a type whose media points at a URL (e.g. a weblink saved before). */
  findObjectByMediaUrl(typeId: Id, url: string): ObjectRecord | undefined {
    const row = this.db
      .prepare(`SELECT id FROM objects WHERE type_id = ? AND deleted_at IS NULL AND json_extract(media, '$.url') = ? ORDER BY created_at LIMIT 1`)
      .get(typeId, url) as Row | undefined
    return row ? this.getObject(row.id as string) : undefined
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined
    return row ? (row.value as string) : undefined
  }

  setMeta(key: string, value: string) {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
  }

  /**
   * The id of the block at `path` in a field of an object's text, given one first when it has none
   * (to mention or embed a block that was never edited since ids came). Undefined when there is no
   * such block.
   */
  ensureBlockId(objectId: Id, field: Id, path: number[], at: string): string | undefined {
    const object = this.getObject(objectId)
    const doc = object?.content[field]
    const node = doc ? nodeAt(doc, path) : undefined
    if (!object || !doc || !node || node.type === 'text') return undefined
    if (typeof node.attrs?.id === 'string' && node.attrs.id) return node.attrs.id
    const taken = blockIds(object)
    let id = newBlockId()
    while (taken.has(id)) id = newBlockId()
    this.putObject({ ...object, content: { ...object.content, [field]: setBlockId(doc, path, id) }, updatedAt: at })
    return id
  }

  deleteObject(id: Id, at: string) {
    const object = this.getObject(id)
    if (!object) return
    this.transaction(() => {
      this.putObject({ ...object, deletedAt: at, updatedAt: at })
      // A quote's highlight in the text it was made from goes with it (createQuote, operations.ts).
      const source = object.props[SOURCE_PROPERTY_ID]
      if (object.typeId === builtinTypeId(object.spaceId, 'quote') && source?.kind === 'relation') for (const sourceId of source.value) this.unhighlightQuote(sourceId, id, at)
    })
  }

  private unhighlightQuote(sourceId: Id, quoteId: Id, at: string) {
    const source = this.getObject(sourceId)
    if (!source) return
    const content = { ...source.content }
    let changed = false
    for (const [field, doc] of Object.entries(source.content)) {
      const without = withoutQuoteHighlight(doc, quoteId)
      if (without) (content[field] = without), (changed = true)
    }
    if (changed) this.putObject({ ...source, content, updatedAt: at })
  }

  // -------------------------------------------------------------------------
  // Trash: deleted types and objects keep their rows (deleted_at set) until they are purged.

  /** Deleted types of a space, newest first, with how many objects were deleted together with each. */
  listDeletedTypes(spaceId: Id): (ObjectType & { deletedAt: string; objectCount: number })[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, (SELECT count(*) FROM objects o WHERE o.type_id = t.id AND o.deleted_at = t.deleted_at) AS object_count
           FROM types t WHERE t.space_id = ? AND t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC`
      )
      .all(spaceId) as Row[]
    return rows.map((row) => ({ ...rowToType(row), deletedAt: row.deleted_at as string, objectCount: Number(row.object_count) }))
  }

  /** Deleted objects of a space, newest first; those deleted together with their type are listed under the type instead. */
  listDeletedObjects(spaceId: Id): ObjectSummary[] {
    return (
      this.db
        .prepare(
          `SELECT ${SUMMARY_COLUMNS} FROM ${SUMMARY_FROM} JOIN types t ON t.id = o.type_id
            WHERE o.space_id = ? AND o.deleted_at IS NOT NULL AND o.deleted_at IS NOT t.deleted_at
            ORDER BY o.deleted_at DESC`
        )
        .all(spaceId) as Row[]
    ).map(rowToSummary)
  }

  /** How many entries the trash of a space lists. */
  trashCount(spaceId: Id): number {
    const row = this.db
      .prepare(
        `SELECT (SELECT count(*) FROM types WHERE space_id = ? AND deleted_at IS NOT NULL)
              + (SELECT count(*) FROM objects o JOIN types t ON t.id = o.type_id
                  WHERE o.space_id = ? AND o.deleted_at IS NOT NULL AND o.deleted_at IS NOT t.deleted_at) AS n`
      )
      .get(spaceId, spaceId) as { n: number }
    return Number(row.n)
  }

  /**
   * Take an object out of the trash. A deleted type comes back with it (without the type's other
   * objects), so the object is never left without a type. Returns the object and the type when
   * it was restored too.
   */
  restoreObject(id: Id, at: string): { object: ObjectRecord; type?: ObjectType } | undefined {
    const object = this.getObject(id)
    if (!object?.deletedAt) return undefined
    return this.transaction(() => {
      const type = this.getType(object.typeId)
      let restoredType: ObjectType | undefined
      if (type?.deletedAt) {
        const { deletedAt: _deletedAt, ...rest } = type
        restoredType = { ...rest, updatedAt: at }
        this.putType(restoredType)
      }
      const { deletedAt: _deletedAt, ...rest } = object
      const restored: ObjectRecord = { ...rest, updatedAt: at }
      this.putObject(restored)
      return { object: restored, ...(restoredType ? { type: restoredType } : {}) }
    })
  }

  /** Take a type out of the trash with the objects deleted together with it (not ones deleted before). */
  restoreType(id: Id, at: string): { type: ObjectType; objects: ObjectRecord[] } | undefined {
    const type = this.getType(id)
    if (!type?.deletedAt) return undefined
    return this.transaction(() => {
      const ids = (this.db.prepare('SELECT id FROM objects WHERE type_id = ? AND deleted_at = ?').all(id, type.deletedAt!) as Row[]).map((r) => r.id as string)
      const { deletedAt: _deletedAt, ...rest } = type
      const restored: ObjectType = { ...rest, updatedAt: at }
      this.putType(restored)
      const objects = ids.flatMap((objectId) => this.restoreObject(objectId, at)?.object ?? [])
      return { type: restored, objects }
    })
  }

  /** Delete an object for good. Media files stay; they are shared by hash. */
  purgeObject(id: Id) {
    this.transaction(() => {
      const spaceId = this.objectSpaceId(id)
      if (spaceId) this.tombstone('objects', id, spaceId)
      this.db.prepare('DELETE FROM links WHERE from_id = ?').run(id)
      this.dropSearchRow(id)
      this.db.prepare('DELETE FROM import_sources WHERE object_id = ?').run(id)
      this.db.prepare('DELETE FROM object_docs WHERE object_id = ?').run(id)
      this.db.prepare('DELETE FROM activity WHERE object_id = ?').run(id)
      this.db.prepare('DELETE FROM notifications WHERE object_id = ?').run(id)
      this.db.prepare('DELETE FROM objects WHERE id = ?').run(id)
    })
  }

  /** Delete a type for good, with every object of it. */
  purgeType(id: Id) {
    this.transaction(() => {
      for (const row of this.db.prepare('SELECT id FROM objects WHERE type_id = ?').all(id) as Row[]) this.purgeObject(row.id as string)
      const type = this.getType(id)
      if (type) this.tombstone('types', id, type.spaceId)
      this.db.prepare('DELETE FROM types WHERE id = ?').run(id)
    })
  }

  /**
   * Purge types and objects deleted at or before `cutoff` (every space), or everything in the
   * trash of one space (`spaceId`, no cutoff). Returns how many of each went.
   */
  purgeTrash(options: { cutoff?: string; spaceId?: Id }): { types: number; objects: number } {
    const where = [options.cutoff ? 'deleted_at <= ?' : 'deleted_at IS NOT NULL', ...(options.spaceId ? ['space_id = ?'] : [])].join(' AND ')
    const params = [...(options.cutoff ? [options.cutoff] : []), ...(options.spaceId ? [options.spaceId] : [])]
    return this.transaction(() => {
      const types = this.db.prepare(`SELECT id FROM types WHERE ${where}`).all(...params) as Row[]
      let objects = 0
      for (const row of types) {
        objects += Number((this.db.prepare('SELECT count(*) n FROM objects WHERE type_id = ?').get(row.id as string) as { n: number }).n)
        this.purgeType(row.id as string)
      }
      const rest = this.db.prepare(`SELECT id FROM objects WHERE ${where}`).all(...params) as Row[]
      for (const row of rest) this.purgeObject(row.id as string)
      return { types: types.length, objects: objects + rest.length }
    })
  }

  // -------------------------------------------------------------------------
  // Subscribed calendars

  listCalendarSources(spaceId?: Id): CalendarSource[] {
    const rows = (spaceId
      ? this.db.prepare('SELECT * FROM calendar_sources WHERE space_id = ? ORDER BY created_at').all(spaceId)
      : // Every source, for the periodic sync; not those of spaces in the trash.
        this.db.prepare('SELECT * FROM calendar_sources WHERE space_id IN (SELECT id FROM spaces WHERE deleted_at IS NULL) ORDER BY created_at').all()) as Row[]
    return rows.map(rowToCalendarSource)
  }

  getCalendarSource(id: Id): CalendarSource | undefined {
    const row = this.db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(id) as Row | undefined
    return row ? rowToCalendarSource(row) : undefined
  }

  /**
   * Insert or update a source's settings. `password`: a string sets it, null clears it, undefined
   * keeps it (it never syncs). `clock`: see putObject.
   */
  putCalendarSource(source: CalendarSource, password?: string | null, clock?: FieldClock) {
    this.transaction(() => {
      const stamp = this.syncStamp('calendar_sources', source.spaceId, this.syncRow('calendar_sources', source.id), source, clock)
      this.db
        .prepare(
          `INSERT INTO calendar_sources (id, space_id, name, url, color, username, enabled, created_at, rev, clock) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, color = excluded.color,
             username = excluded.username, enabled = excluded.enabled, rev = excluded.rev, clock = excluded.clock`
        )
        .run(source.id, source.spaceId, source.name, source.url, source.color ?? null, source.username ?? null, source.enabled ? 1 : 0, source.createdAt, stamp.rev, stamp.clock)
      if (password !== undefined) this.db.prepare('UPDATE calendar_sources SET password = ? WHERE id = ?').run(password, source.id)
      this.db.prepare("DELETE FROM sync_tombstones WHERE kind = 'calendar_sources' AND id = ?").run(source.id)
    })
  }

  deleteCalendarSource(id: Id) {
    this.transaction(() => {
      const source = this.getCalendarSource(id)
      if (!source) return
      this.tombstone('calendar_sources', id, source.spaceId)
      this.db.prepare('DELETE FROM calendar_sources WHERE id = ?').run(id)
    })
  }

  /** What a sync needs: where to fetch, how to authenticate, and the last version seen. */
  calendarFetchInfo(id: Id): { url: string; username?: string; password?: string; etag?: string } | undefined {
    const row = this.db.prepare('SELECT url, username, password, etag FROM calendar_sources WHERE id = ?').get(id) as Row | undefined
    if (!row) return undefined
    return {
      url: row.url as string,
      ...(row.username ? { username: row.username as string } : {}),
      ...(row.password ? { password: row.password as string } : {}),
      ...(row.etag ? { etag: row.etag as string } : {}),
    }
  }

  /** The last iCalendar text fetched for a source, and when. */
  calendarData(id: Id): { data: string; syncedAt: string } | undefined {
    const row = this.db.prepare('SELECT data, synced_at FROM calendar_sources WHERE id = ? AND data IS NOT NULL').get(id) as Row | undefined
    return row ? { data: row.data as string, syncedAt: row.synced_at as string } : undefined
  }

  /** Record a sync: new data (or null when unchanged), or an error that keeps the previous data. */
  recordCalendarSync(id: Id, result: { at: string; data?: string; etag?: string; eventCount?: number; error?: string }) {
    this.transaction(() => {
      const before = this.getCalendarSource(id)
      this.writeCalendarSync(id, result)
      // Clients see the status (error, event count, the data's version) and download the data
      // apart; a sync that only moved syncedAt is not worth a pull.
      const after = this.getCalendarSource(id)
      const status = (source?: CalendarSource) => source && JSON.stringify({ ...source, syncedAt: undefined })
      if (after && status(before) !== status(after)) this.db.prepare('UPDATE calendar_sources SET rev = ? WHERE id = ?').run(this.nextRev(after.spaceId), id)
    })
  }

  private writeCalendarSync(id: Id, result: { at: string; data?: string; etag?: string; eventCount?: number; error?: string }) {
    if (result.error !== undefined) {
      this.db.prepare('UPDATE calendar_sources SET error = ? WHERE id = ?').run(result.error, id)
    } else if (result.data !== undefined) {
      this.db
        .prepare('UPDATE calendar_sources SET data = ?, data_hash = ?, etag = ?, event_count = ?, synced_at = ?, error = NULL WHERE id = ?')
        .run(result.data, textHash(result.data), result.etag ?? null, result.eventCount ?? null, result.at, id)
    } else {
      this.db.prepare('UPDATE calendar_sources SET synced_at = ?, error = NULL WHERE id = ?').run(result.at, id)
    }
  }

  objectSpaceId(id: Id): Id | undefined {
    const row = this.db.prepare('SELECT space_id FROM objects WHERE id = ?').get(id) as Row | undefined
    return row?.space_id as string | undefined
  }

  counts() {
    const count = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n)
    return {
      spaces: count('SELECT count(*) n FROM spaces'),
      types: count('SELECT count(*) n FROM types'),
      objects: count('SELECT count(*) n FROM objects WHERE deleted_at IS NULL'),
      links: count('SELECT count(*) n FROM links'),
    }
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}
