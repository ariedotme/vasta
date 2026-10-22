// Calendar entries: everything dated in a space, expanded into occurrences within a range of days.
// Exported as `@vasta/core/calendar` (not from the package root) because it loads ical.js for
// recurrence rules, which the web app does not need.
import ICAL from 'ical.js'
import type { CalendarEntry, DateException, DateValue, Id, IsoDateTime, ObjectRecord, ObjectSummary, ObjectType } from './model.ts'
import { copyObject } from './operations.ts'
import type { Store } from './store.ts'
import { addDays, dayIn, daysBetween, instantOf, isValidTimeZone, wallTimeIn } from './time.ts'

/** Inclusive range of days ("YYYY-MM-DD") in the viewer's zone. */
export interface DayRange {
  from: string
  to: string
}

/** Stops runaway rules (e.g. every minute since 1970). */
const MAX_STEPS = 20_000

/** Rules the calendar can expand; anything ical.js cannot parse is shown as a single date. */
export function parseRule(rrule: string): ICAL.Recur | undefined {
  try {
    const rule = ICAL.Recur.fromString(rrule.replace(/^RRULE:/i, ''))
    return rule.freq ? rule : undefined
  } catch {
    return undefined
  }
}

const overlaps = (startDay: string, endDay: string, range: DayRange) => startDay <= range.to && endDay >= range.from

/** A date's times without the rest: one occurrence, or the change made to one. */
export interface Times {
  start: IsoDateTime
  end?: IsoDateTime
}

export interface Occurrence extends Times {
  startDay: string
  endDay: string
  /** Repeating dates: the start the rule gives this occurrence, the key of its exception. */
  occurrence?: IsoDateTime
}

/** The zone a repeating time keeps its wall-clock time in. */
const seriesZone = (value: DateValue, timeZone: string) => (value.timeZone && isValidTimeZone(value.timeZone) ? value.timeZone : timeZone)

/**
 * What a date's rule gives, in order and without its exceptions: the first start and its length,
 * repeated. Day-resolution values are stored at midnight UTC and repeat by day; timed values repeat
 * at the same wall-clock time in their own zone (or the viewer's), so a weekly 9:00 stays at 9:00
 * after DST.
 */
function* series(value: DateValue, rule: ICAL.Recur, timeZone: string): Generator<Times> {
  if (value.resolution === 'day') {
    const firstDay = value.start.slice(0, 10)
    const length = value.end ? Math.max(0, daysBetween(firstDay, value.end.slice(0, 10))) : 0
    const iterator = rule.iterator(ICAL.Time.fromDateString(firstDay))
    for (let step = 0, next = iterator.next(); next && step < MAX_STEPS; step++, next = iterator.next()) {
      const day = next.toString().slice(0, 10)
      yield { start: `${day}T00:00:00.000Z`, ...(length ? { end: `${addDays(day, length)}T00:00:00.000Z` } : {}) }
    }
    return
  }
  const zone = seriesZone(value, timeZone)
  const startMs = Date.parse(value.start)
  const duration = value.end ? Math.max(0, Date.parse(value.end) - startMs) : 0
  const iterator = rule.iterator(ICAL.Time.fromData({ ...wallTimeIn(startMs, zone), isDate: false }))
  for (let step = 0, next = iterator.next(); next && step < MAX_STEPS; step++, next = iterator.next()) {
    const at = instantOf({ year: next.year, month: next.month, day: next.day, hour: next.hour, minute: next.minute, second: next.second }, zone)
    yield { start: new Date(at).toISOString(), ...(duration ? { end: new Date(at + duration).toISOString() } : {}) }
  }
}

const validException = (exception: DateException | undefined): exception is { start: IsoDateTime; end?: IsoDateTime } =>
  !!exception && !('cancelled' in exception) && typeof exception.start === 'string'

/** Whether the rule gives an occurrence starting at `start`. */
export function isOccurrence(value: DateValue, start: IsoDateTime, timeZone: string): boolean {
  const rule = value.rrule ? parseRule(value.rrule) : undefined
  if (!rule) return false
  for (const next of series(value, rule, timeZone)) {
    if (next.start === start) return true
    if (next.start > start) return false
  }
  return false
}

/**
 * The occurrences of a date value that touch a range, as instants plus the days they cover.
 * Exceptions replace the occurrences they are keyed by; a moved one shows where it was moved to,
 * even far from where the rule puts it.
 */
export function occurrences(value: DateValue, range: DayRange, timeZone: string): Occurrence[] {
  const rule = value.rrule ? parseRule(value.rrule) : undefined
  if (!rule) {
    const days = spanOf(value, timeZone)
    return overlaps(days.startDay, days.endDay, range) ? [{ start: value.start, ...(value.end ? { end: value.end } : {}), ...days }] : []
  }
  const exceptions = value.exceptions ?? {}
  const results: Occurrence[] = []
  for (const next of series(value, rule, timeZone)) {
    const days = spanOf({ ...next, resolution: value.resolution }, timeZone)
    if (days.startDay > range.to) break
    if (exceptions[next.start] || days.endDay < range.from) continue
    results.push({ ...next, ...days, occurrence: next.start })
  }
  for (const [key, exception] of Object.entries(exceptions)) {
    if (!validException(exception)) continue
    const moved = { start: exception.start, ...(exception.end && exception.end > exception.start ? { end: exception.end } : {}) }
    const days = spanOf({ ...moved, resolution: value.resolution }, timeZone)
    if (overlaps(days.startDay, days.endDay, range) && isOccurrence(value, key, timeZone)) results.push({ ...moved, ...days, occurrence: key })
  }
  return results.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
}

// ---------------------------------------------------------------------------
// Changing a repeating date: one occurrence, the series from one on, or all of it.

/** What happens to an occurrence: new times, or cancelled (deleted from the series). */
export type OccurrenceChange = Times | { cancelled: true }
/** Which occurrences a change applies to, as other calendars ask. */
export type OccurrenceScope = 'this' | 'following' | 'all'

const isCancel = (change: OccurrenceChange): change is { cancelled: true } => 'cancelled' in change && change.cancelled === true

/** The times the rule gives an occurrence (before any exception). */
function ruleTimes(value: DateValue, occurrence: IsoDateTime): Times {
  if (!value.end) return { start: occurrence }
  if (value.resolution === 'day') {
    return { start: occurrence, end: `${addDays(occurrence.slice(0, 10), daysBetween(value.start.slice(0, 10), value.end.slice(0, 10)))}T00:00:00.000Z` }
  }
  return { start: occurrence, end: new Date(Date.parse(occurrence) + Date.parse(value.end) - Date.parse(value.start)).toISOString() }
}

/** Where an occurrence is: moved by its exception, or where the rule puts it. */
function currentTimes(value: DateValue, occurrence: IsoDateTime): Times {
  const exception = value.exceptions?.[occurrence]
  return validException(exception) ? { start: exception.start, ...(exception.end ? { end: exception.end } : {}) } : ruleTimes(value, occurrence)
}

const sameTimes = (a: Times, b: Times) => a.start === b.start && (a.end ?? '') === (b.end ?? '')

function withExceptions(value: DateValue, exceptions: Record<IsoDateTime, DateException>): DateValue {
  const { exceptions: _old, ...rest } = value
  return Object.keys(exceptions).length ? { ...rest, exceptions } : rest
}

/** Drop exceptions of occurrences the rule no longer gives (the rule or the start changed). */
export function pruneExceptions(value: DateValue, timeZone: string): DateValue {
  const keys = Object.keys(value.exceptions ?? {})
  const rule = value.rrule ? parseRule(value.rrule) : undefined
  if (!keys.length) return value
  if (!rule) return withExceptions(value, {})
  const last = keys.reduce((a, b) => (a > b ? a : b))
  const given = new Set<string>()
  for (const next of series(value, rule, timeZone)) {
    if (next.start > last) break
    given.add(next.start)
  }
  return withExceptions(value, Object.fromEntries(Object.entries(value.exceptions!).filter(([key]) => given.has(key))))
}

/** "This event": one occurrence moved, resized or cancelled. Moving it back where the rule puts it drops the exception. */
export function changeOneOccurrence(value: DateValue, occurrence: IsoDateTime, change: OccurrenceChange): DateValue {
  const exceptions = { ...value.exceptions }
  if (isCancel(change)) exceptions[occurrence] = { cancelled: true }
  else {
    const times = { start: change.start, ...(change.end && change.end > change.start ? { end: change.end } : {}) }
    if (sameTimes(times, ruleTimes(value, occurrence))) delete exceptions[occurrence]
    else exceptions[occurrence] = times
  }
  return withExceptions(value, exceptions)
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const wallMs = (iso: IsoDateTime, zone: string) => {
  const w = wallTimeIn(iso, zone)
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
}

/**
 * Moving a series so that one occurrence goes from `from` to `to`: every time moves by the same
 * days (day values) or wall-clock time in the series' zone (timed values), and weekdays named by
 * the rule move along.
 */
function shifter(value: DateValue, from: IsoDateTime, to: IsoDateTime, timeZone: string) {
  if (value.resolution === 'day') {
    const days = daysBetween(from.slice(0, 10), to.slice(0, 10))
    return { days, move: (iso: IsoDateTime) => `${addDays(iso.slice(0, 10), days)}T00:00:00.000Z` }
  }
  const zone = seriesZone(value, timeZone)
  const delta = wallMs(to, zone) - wallMs(from, zone)
  const days = daysBetween(dayIn(from, zone), dayIn(to, zone))
  return {
    days,
    move: (iso: IsoDateTime) => {
      const d = new Date(wallMs(iso, zone) + delta)
      const wall = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() }
      return new Date(instantOf(wall, zone)).toISOString()
    },
  }
}

/** A rule with its BYDAY weekdays moved by some days ("every Monday" becomes "every Tuesday"). */
function shiftWeekdays(rrule: string, days: number): string {
  const shift = ((days % 7) + 7) % 7
  if (!shift) return rrule
  return rrule
    .split(';')
    .map((part) => {
      const [name, list] = part.split('=')
      if (name?.toUpperCase() !== 'BYDAY' || !list) return part
      const moved = list.split(',').map((code) => {
        const match = /^([+-]?\d*)([A-Z]{2})$/i.exec(code)
        const index = match ? WEEKDAYS.indexOf(match[2]!.toUpperCase()) : -1
        return index < 0 ? code : `${match![1]}${WEEKDAYS[(index + shift) % 7]}`
      })
      return `${name}=${moved.join(',')}`
    })
    .join(';')
}

/**
 * "All events": the series moved and resized like one of its occurrences was (from where it is
 * now to `change`). Its exceptions move with it; the changed occurrence's own exception, if it had
 * one, keeps it where it was put.
 */
export function changeSeries(value: DateValue, occurrence: IsoDateTime, change: Times, timeZone: string): DateValue {
  const current = currentTimes(value, occurrence)
  const { days, move } = shifter(value, current.start, change.start, timeZone)
  const start = move(value.start)
  const length = change.end && change.end > change.start ? Date.parse(change.end) - Date.parse(change.start) : 0
  const end = !length ? undefined : value.resolution === 'day' ? `${addDays(start.slice(0, 10), daysBetween(change.start.slice(0, 10), change.end!.slice(0, 10)))}T00:00:00.000Z` : new Date(Date.parse(start) + length).toISOString()
  const { end: _end, exceptions: _exceptions, ...rest } = value
  const next: DateValue = {
    ...rest,
    start,
    ...(end ? { end } : {}),
    ...(value.rrule ? { rrule: shiftWeekdays(value.rrule, days) } : {}),
    ...(value.resolution === 'time' ? { timeZone: seriesZone(value, timeZone) } : {}),
  }
  const exceptions: Record<IsoDateTime, DateException> = {}
  for (const [key, exception] of Object.entries(value.exceptions ?? {})) {
    if (key === occurrence) {
      if (validException(exception)) exceptions[move(key)] = { start: change.start, ...(change.end && change.end > change.start ? { end: change.end } : {}) }
    } else if (validException(exception)) {
      exceptions[move(key)] = { start: move(exception.start), ...(exception.end ? { end: move(exception.end) } : {}) }
    } else exceptions[move(key)] = exception
  }
  // An exception that now matches what the rule gives is no exception.
  for (const [key, exception] of Object.entries(exceptions)) if (validException(exception) && sameTimes(exception, ruleTimes(next, key))) delete exceptions[key]
  return pruneExceptions(withExceptions(next, exceptions), timeZone)
}

const ruleParts = (rrule: string) => rrule.replace(/^RRULE:/i, '').split(';').filter(Boolean)

/** UNTIL naming one occurrence: its day, or its wall-clock time in the series' zone (floating, as the iterator runs). */
function untilOf(value: DateValue, last: IsoDateTime, timeZone: string): string {
  if (value.resolution === 'day') return last.slice(0, 10).replaceAll('-', '')
  const w = wallTimeIn(last, seriesZone(value, timeZone))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${w.year}${pad(w.month)}${pad(w.day)}T${pad(w.hour)}${pad(w.minute)}${pad(w.second)}`
}

/**
 * "This and following": the series cut before an occurrence (an UNTIL at the last one it keeps)
 * and the rest of it as a series of its own, starting at that occurrence (moved and resized like
 * it, when `change` has times) with a COUNT lowered by the occurrences kept. Undefined when the
 * occurrence is the first: then the change is for all of the series.
 */
export function splitSeries(value: DateValue, occurrence: IsoDateTime, change: OccurrenceChange, timeZone: string): { before: DateValue; after?: DateValue } | undefined {
  const rule = value.rrule ? parseRule(value.rrule) : undefined
  if (!rule) return undefined
  let kept = 0
  let last: IsoDateTime | undefined
  for (const next of series(value, rule, timeZone)) {
    if (next.start >= occurrence) break
    kept++
    last = next.start
  }
  if (!last) return undefined
  const parts = ruleParts(value.rrule!)
  const named = (name: string) => (part: string) => part.toUpperCase().startsWith(`${name}=`)
  const before = withExceptions(
    { ...value, rrule: [...parts.filter((p) => !named('UNTIL')(p) && !named('COUNT')(p)), `UNTIL=${untilOf(value, last, timeZone)}`].join(';') },
    Object.fromEntries(Object.entries(value.exceptions ?? {}).filter(([key]) => key < occurrence))
  )
  if (isCancel(change)) return { before }
  const count = Number(parts.find(named('COUNT'))?.split('=')[1])
  const { exceptions: _exceptions, ...rest } = value
  const first = ruleTimes(value, occurrence)
  const tail: DateValue = withExceptions(
    {
      ...rest,
      start: first.start,
      ...(first.end ? { end: first.end } : {}),
      rrule: count > 0 ? parts.map((p) => (named('COUNT')(p) ? `COUNT=${Math.max(1, count - kept)}` : p)).join(';') : value.rrule!,
    },
    Object.fromEntries(Object.entries(value.exceptions ?? {}).filter(([key]) => key >= occurrence))
  )
  return { before, after: changeSeries(tail, occurrence, change, timeZone) }
}

/** The date of an object's field: its own date ("date") or a date property. */
export function dateOf(object: ObjectRecord, field: string): DateValue | undefined {
  if (field === 'date') return object.date
  const value = object.props[field]
  return value?.kind === 'date' ? value.value : undefined
}

function withDate(object: ObjectRecord, field: string, value: DateValue): ObjectRecord {
  return field === 'date' ? { ...object, date: value } : { ...object, props: { ...object.props, [field]: { kind: 'date', value } } }
}

export interface OccurrenceEdit {
  objectId: Id
  /** "date" or a date property's id. */
  field: string
  /** The start the rule gives the occurrence (`CalendarEntry.occurrence`). */
  occurrence: IsoDateTime
  scope: OccurrenceScope
  change: OccurrenceChange
}

export class OccurrenceError extends Error {}

/**
 * Change one occurrence of an object's repeating date, the series from it on, or all of it; the
 * server's route and a device's replica both run this. "This and following" ends the series
 * before the occurrence and makes a copy of the object (text included) holding the rest of it;
 * cancelling "all" moves the object to the trash. `timeZone` is the viewer's, for timed values
 * that name no zone of their own.
 */
export function changeOccurrence(store: Store, edit: OccurrenceEdit, at: IsoDateTime, timeZone: string): { object: ObjectRecord; created?: ObjectRecord } {
  const object = store.getObject(edit.objectId)
  const value = object && !object.deletedAt ? dateOf(object, edit.field) : undefined
  if (!object || !value) throw new OccurrenceError('no such date')
  if (!isOccurrence(value, edit.occurrence, timeZone)) throw new OccurrenceError('no such occurrence')
  const { change } = edit
  if (!isCancel(change) && (typeof change.start !== 'string' || Number.isNaN(Date.parse(change.start)) || (change.end !== undefined && Number.isNaN(Date.parse(change.end))))) {
    throw new OccurrenceError('start must be a date')
  }
  return store.transaction(() => {
    const all = () => {
      if (isCancel(change)) {
        store.deleteObject(object.id, at)
        return { object: store.getObject(object.id)! }
      }
      return { object: store.putObject({ ...withDate(object, edit.field, changeSeries(value, edit.occurrence, change, timeZone)), updatedAt: at }) }
    }
    if (edit.scope === 'this') return { object: store.putObject({ ...withDate(object, edit.field, changeOneOccurrence(value, edit.occurrence, change)), updatedAt: at }) }
    if (edit.scope === 'all') return all()
    const split = splitSeries(value, edit.occurrence, change, timeZone)
    if (!split) return all()
    const before = store.putObject({ ...withDate(object, edit.field, split.before), updatedAt: at })
    if (!split.after) return { object: before }
    const type = store.getType(object.typeId)!
    const created = store.putObject(withDate(copyObject(object, type, crypto.randomUUID(), at, true), edit.field, split.after))
    return { object: before, created }
  })
}

/** First and last day a single date covers. A timed range ending exactly at midnight ends the day before. */
export function spanOf(value: Pick<DateValue, 'start' | 'end' | 'resolution'>, timeZone: string): { startDay: string; endDay: string } {
  if (value.resolution === 'day') {
    const startDay = value.start.slice(0, 10)
    const endDay = value.end ? value.end.slice(0, 10) : startDay
    return { startDay, endDay: endDay < startDay ? startDay : endDay }
  }
  const startDay = dayIn(value.start, timeZone)
  if (!value.end || value.end <= value.start) return { startDay, endDay: startDay }
  let endDay = dayIn(value.end, timeZone)
  const w = wallTimeIn(value.end, timeZone)
  if (endDay > startDay && w.hour === 0 && w.minute === 0 && w.second === 0) endDay = addDays(endDay, -1)
  return { startDay, endDay }
}

/** Date objects mostly exist because a date was mentioned; they belong on the calendar once they have notes. */
function showsOwnDate(object: ObjectSummary, type: ObjectType | undefined): boolean {
  return type?.system !== 'date' || !!object.preview.trim()
}

/** The objects that may have calendar entries or references in a range (objectEntries, dayReferences), read without the others. */
export function calendarObjects(store: Store, spaceId: Id, types: Map<Id, ObjectType>, range: DayRange): ObjectSummary[] {
  const dated = [...types.values()].filter((type) => type.properties.some((p) => p.kind === 'date')).map((type) => type.id)
  return store.listDatedObjects(spaceId, range, dated)
}

/**
 * Calendar entries of a space's objects in a range: daily notes, objects' own dates (date objects
 * with notes, events) and every date property (task due dates, meeting times…).
 */
export function objectEntries(objects: ObjectSummary[], types: Map<Id, ObjectType>, range: DayRange, timeZone: string): CalendarEntry[] {
  const entries: CalendarEntry[] = []
  const add = (object: ObjectSummary, kind: CalendarEntry['kind'], field: string, value: DateValue) => {
    for (const occurrence of occurrences(value, range, timeZone)) {
      entries.push({
        key: `${object.id}:${field}:${occurrence.occurrence ?? occurrence.start}`,
        kind,
        objectId: object.id,
        field,
        ...occurrence,
        allDay: value.resolution === 'day',
        ...(occurrence.occurrence ? { recurring: true } : {}),
      })
    }
  }
  for (const object of objects) {
    if (object.deletedAt) continue
    const type = types.get(object.typeId)
    if (!type || type.deletedAt) continue
    if (object.date) {
      if (type.system === 'daily-note') add(object, 'daily-note', 'date', { start: object.date.start, resolution: 'day' })
      else if (showsOwnDate(object, type)) add(object, 'object', 'date', object.date)
    }
    for (const def of type.properties) {
      const value = object.props[def.id]
      if (def.kind === 'date' && value?.kind === 'date') add(object, 'property', def.id, value.value)
    }
  }
  return entries
}

/** Order for display: all-day first, then by start, longer first. */
/**
 * Date references: per day, how many objects link to (mention, embed, relate to) that day, that is
 * to its daily note or to a date object of it (what mentioning a date makes, as in Capacities).
 */
export function dayReferences(
  objects: ObjectSummary[],
  types: Map<Id, ObjectType>,
  range: DayRange,
  timeZone: string,
  linkCounts: (ids: Id[]) => Map<Id, number>
): Record<string, number> {
  const targets: { id: Id; day: string }[] = []
  for (const object of objects) {
    if (object.deletedAt || !object.date) continue
    const system = types.get(object.typeId)?.system
    if (system !== 'daily-note' && system !== 'date') continue
    const value: DateValue = system === 'daily-note' ? { start: object.date.start, resolution: 'day' } : object.date
    for (const occurrence of occurrences(value, range, timeZone)) targets.push({ id: object.id, day: occurrence.startDay })
  }
  const counts = linkCounts([...new Set(targets.map((t) => t.id))])
  const references: Record<string, number> = {}
  for (const target of targets) {
    const count = counts.get(target.id)
    if (count) references[target.day] = (references[target.day] ?? 0) + count
  }
  return references
}

export function compareEntries(a: CalendarEntry, b: CalendarEntry): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
  if (a.start !== b.start) return a.start < b.start ? -1 : 1
  return (b.end ?? b.start).localeCompare(a.end ?? a.start)
}
