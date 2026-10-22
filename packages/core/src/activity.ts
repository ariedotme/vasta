// An object's activity: who created it, changed its title or a property, moved it to the trash or
// back, and when. The server records it where a user's write is applied (Store.putObject, with
// Store.actor set), so the app, sync pushes, captures and agents all leave the same trail; the
// server's own jobs and imports leave none. Entries older than a space's retention are deleted
// (3 months unless the space says otherwise). Flow metrics read the status changes.
import type { Id, IsoDateTime, ObjectRecord, ObjectType, PropertyValue } from './model.ts'
import { canonicalJson } from './sync.ts'

export type ActivityKind = 'created' | 'changed' | 'trashed' | 'restored'

export interface ActivityEntry {
  id: number
  spaceId: Id
  objectId: Id
  at: IsoDateTime
  /** The user who did it. */
  actor?: Id
  kind: ActivityKind
  /** For `changed`: "title", "typeId", "date", or a property id. */
  field?: string
  /** For `changed`: the value before and after (a title, a type id, a DateValue, a PropertyValue); absent when empty. */
  before?: unknown
  after?: unknown
}

/** An entry about to be recorded: no id yet, and `at` is when the field was written. */
export type ActivityChange = Omit<ActivityEntry, 'id' | 'spaceId' | 'objectId' | 'actor'>

/** How long a space keeps activity unless it says otherwise. */
export const DEFAULT_ACTIVITY_RETENTION_DAYS = 90

/** Choices offered for a space's retention; 0 keeps everything. */
export const ACTIVITY_RETENTION_CHOICES = [30, 90, 180, 365, 0] as const

/** Edits of the same field by the same person this close together are one change. */
export const ACTIVITY_MERGE_MS = 10 * 60_000

/** Property kinds whose values are activity: everything but rich text (merged live) and formulas (computed). */
const tracked = (type: ObjectType | undefined) => new Set((type?.properties ?? []).filter((p) => p.kind !== 'rich-text' && p.kind !== 'formula').map((p) => p.id))

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null)

/**
 * The activity of writing `after` over `before`, of type `type` (the type after the write).
 * `timeOf(field)` is when a field was written: a sync field's name ("title", "props.status").
 */
export function activityChanges(
  before: ObjectRecord | undefined,
  after: ObjectRecord,
  type: ObjectType | undefined,
  timeOf: (field: string) => IsoDateTime
): ActivityChange[] {
  if (!before) return [{ at: after.createdAt, kind: 'created' }]
  const changes: ActivityChange[] = []
  if (!before.deletedAt && after.deletedAt) changes.push({ at: timeOf('deletedAt'), kind: 'trashed' })
  if (before.deletedAt && !after.deletedAt) changes.push({ at: timeOf('deletedAt'), kind: 'restored' })
  const field = (name: string, from: unknown, to: unknown, clockName = name) => {
    if (!same(from, to)) changes.push({ at: timeOf(clockName), kind: 'changed', field: name, ...(from != null && from !== '' ? { before: from } : {}), ...(to != null && to !== '' ? { after: to } : {}) })
  }
  field('title', before.title, after.title)
  field('typeId', before.typeId, after.typeId)
  field('date', before.date, after.date)
  for (const id of tracked(type)) field(id, emptyAsNull(before.props[id]), emptyAsNull(after.props[id]), `props.${id}`)
  return changes
}

/** A value that holds nothing (an empty list of ids, empty text) counts as no value. */
function emptyAsNull(value: PropertyValue | undefined): PropertyValue | null {
  if (!value) return null
  if (Array.isArray(value.value) && !value.value.length) return null
  if (typeof value.value === 'string' && !value.value) return null
  return value
}
