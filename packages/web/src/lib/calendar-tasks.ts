// Pure helpers for the calendar's scheduling sidebar: which types can be scheduled,
// whether an object has a done status, how items split into overdue / unscheduled / scheduled,
// and what date value a drop writes. Kept free of router/component imports so unit tests run directly.
import { addDays, daysBetween, statusProperty, type CalendarEntry, type DateValue, type Id, type ObjectSummary, type ObjectType, type PropertyDef } from '@vasta/core'
import { typeName } from './i18n.ts'

/** Default duration when scheduling an unscheduled or all-day item onto a time slot. */
export const DEFAULT_SCHEDULE_MINUTES = 60

export type ScheduleView = 'month' | 'week' | 'three-days' | 'day'

/** Local "YYYY-MM-DD" of a Date. */
function localDayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** A local wall-clock time on a day, as an ISO instant. */
function localInstantAt(day: string, minutes: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  return new Date(year, month - 1, date, Math.floor(minutes / 60), minutes % 60).toISOString()
}

/** Date properties of a type, in order; tasks put their due date first. */
export const datePropsOf = (type: ObjectType | undefined) =>
  (type?.properties ?? []).filter((p): p is Extract<PropertyDef, { kind: 'date' }> => p.kind === 'date')

/** Types that can be scheduled onto the calendar: any non-deleted type with a date property. */
export function schedulableTypes(types: ObjectType[]): ObjectType[] {
  return types
    .filter((item) => !item.deletedAt && item.system !== 'daily-note' && item.system !== 'date' && datePropsOf(item).length > 0)
    .sort((a, b) => (a.system === 'task' ? -1 : b.system === 'task' ? 1 : typeName(a).localeCompare(typeName(b))))
}

/** The date property written when scheduling an object of this type (for Task: `due`). */
export function primaryDateProperty(type: ObjectType | undefined): Extract<PropertyDef, { kind: 'date' }> | undefined {
  return datePropsOf(type)[0]
}

/** Whether objects of this type have both a "to do" and a "done" status option for a checkbox. */
export function canComplete(type: ObjectType | undefined): boolean {
  const def = statusProperty(type)
  if (!def) return false
  return def.options.some((o) => o.status === 'done') && def.options.some((o) => o.status === 'todo')
}

/** Selected status option ids on an object's status property. */
export function statusIdsOf(summary: ObjectSummary | undefined, type: ObjectType | undefined): Id[] | undefined {
  const def = statusProperty(type)
  if (!def || !summary) return undefined
  const value = summary.props[def.id]
  return value?.kind === 'select' ? value.value : undefined
}

/** Whether an object is in a "done" status. */
export function isObjectDone(summary: ObjectSummary | undefined, type: ObjectType | undefined): boolean {
  const def = statusProperty(type)
  const ids = statusIdsOf(summary, type)
  return !!def && !!ids?.some((id) => def.options.find((o) => o.id === id)?.status === 'done')
}

/** The primary date property value of an object, if set. */
export function primaryDateOf(summary: ObjectSummary, type: ObjectType | undefined): DateValue | undefined {
  const prop = primaryDateProperty(type)
  if (!prop) return undefined
  const value = summary.props[prop.id]
  return value?.kind === 'date' ? value.value : undefined
}

/** Local "YYYY-MM-DD" day of a DateValue. */
export function localDayOf(value: DateValue): string {
  return value.resolution === 'day' ? value.start.slice(0, 10) : localDayKey(new Date(value.start))
}

/** Duration in minutes of a timed DateValue, falling back to `fallback`. */
export function durationMinutesOf(value: DateValue | undefined, fallback = DEFAULT_SCHEDULE_MINUTES): number {
  if (!value || value.resolution !== 'time' || !value.end) return fallback
  const mins = Math.round((Date.parse(value.end) - Date.parse(value.start)) / 60_000)
  return mins >= 15 ? mins : fallback
}

const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }

function priorityRank(summary: ObjectSummary): number {
  const value = summary.props.priority
  if (value?.kind !== 'select' || !value.value.length) return 3
  return PRIORITY_RANK[value.value[0]!] ?? 3
}

export interface ScheduleBuckets {
  overdue: ObjectSummary[]
  unscheduled: ObjectSummary[]
  scheduled: ObjectSummary[]
}

/**
 * Split objects into Overdue, Unscheduled and Scheduled for the calendar sidebar.
 *
 * - On `month`, day-only items count as scheduled; only undated items sit in Unscheduled.
 * - On `week`, `three-days` and `day`, day-only items from today onward sit at the top of
 *   Unscheduled (ready to be dragged onto a time slot), followed by undated items.
 */
export function classifyScheduleItems(
  objects: ObjectSummary[],
  typesById: Map<Id, ObjectType>,
  options: { today: string; view: ScheduleView; showDone: boolean }
): ScheduleBuckets {
  const overdue: ObjectSummary[] = []
  const dayOnly: ObjectSummary[] = []
  const undated: ObjectSummary[] = []
  const scheduled: ObjectSummary[] = []

  for (const obj of objects) {
    const type = typesById.get(obj.typeId)
    if (!type || !primaryDateProperty(type)) continue
    const done = canComplete(type) && isObjectDone(obj, type)
    if (done && !options.showDone) continue

    const date = primaryDateOf(obj, type)
    if (!date) {
      undated.push(obj)
      continue
    }

    const day = localDayOf(date)
    if (day < options.today && !done) {
      overdue.push(obj)
    } else if (options.view === 'month') {
      scheduled.push(obj)
    } else if (date.resolution === 'day') {
      dayOnly.push(obj)
    } else {
      scheduled.push(obj)
    }
  }

  const byStartAsc = (a: ObjectSummary, b: ObjectSummary) => {
    const da = primaryDateOf(a, typesById.get(a.typeId))?.start ?? ''
    const db = primaryDateOf(b, typesById.get(b.typeId))?.start ?? ''
    return da.localeCompare(db) || a.title.localeCompare(b.title)
  }

  overdue.sort(byStartAsc)
  dayOnly.sort(byStartAsc)
  scheduled.sort(byStartAsc)
  undated.sort((a, b) => priorityRank(a) - priorityRank(b) || b.updatedAt.localeCompare(a.updatedAt))

  return {
    overdue,
    unscheduled: options.view === 'month' ? undated : [...dayOnly, ...undated],
    scheduled,
  }
}

/** Shift a date so it starts at `start` (same length; day dates stay day dates). */
export function shiftDateValue(value: DateValue, start: { day: string; minutes?: number }): DateValue {
  if (value.resolution === 'day') {
    const shift = daysBetween(value.start.slice(0, 10), start.day)
    return { ...value, start: `${start.day}T00:00:00.000Z`, ...(value.end ? { end: `${addDays(value.end.slice(0, 10), shift)}T00:00:00.000Z` } : {}) }
  }
  const old = new Date(value.start)
  const minutes = start.minutes ?? old.getHours() * 60 + old.getMinutes()
  const next = localInstantAt(start.day, minutes)
  const length = value.end ? Date.parse(value.end) - Date.parse(value.start) : 0
  return { ...value, start: next, ...(value.end ? { end: new Date(Date.parse(next) + length).toISOString() } : {}) }
}

/** Compute the new DateValue when a sidebar item is dropped on a calendar target. */
export function scheduledDateForDrop(
  current: DateValue | undefined,
  target: { day: string; minutes?: number; allDay?: boolean },
  defaultMinutes = DEFAULT_SCHEDULE_MINUTES
): DateValue {
  if (target.minutes !== undefined) {
    const start = localInstantAt(target.day, target.minutes)
    const duration = durationMinutesOf(current, defaultMinutes)
    const end = new Date(Date.parse(start) + duration * 60_000).toISOString()
    return {
      ...(current?.rrule ? { rrule: current.rrule } : {}),
      ...(current?.timeZone ? { timeZone: current.timeZone } : {}),
      start,
      end,
      resolution: 'time',
    }
  }
  if (target.allDay) {
    return {
      ...(current?.rrule ? { rrule: current.rrule } : {}),
      start: `${target.day}T00:00:00.000Z`,
      resolution: 'day',
    }
  }
  if (current?.resolution === 'time') {
    return shiftDateValue(current, { day: target.day })
  }
  return {
    ...(current?.rrule ? { rrule: current.rrule } : {}),
    start: `${target.day}T00:00:00.000Z`,
    resolution: 'day',
  }
}

/** An entry's times after moving it to a day (and optionally promoting/demoting all-day ↔ timed). */
export function movedEntryTimes(
  entry: CalendarEntry,
  target: { day: string; minutes?: number; allDay?: boolean },
  defaultMinutes = DEFAULT_SCHEDULE_MINUTES
): { start: string; end?: string; resolution?: 'day' | 'time' } {
  if (entry.allDay && target.minutes !== undefined) {
    const start = localInstantAt(target.day, target.minutes)
    const end = new Date(Date.parse(start) + defaultMinutes * 60_000).toISOString()
    return { start, end, resolution: 'time' }
  }
  if (!entry.allDay && target.allDay) {
    return { start: `${target.day}T00:00:00.000Z`, resolution: 'day' }
  }
  const moved = shiftDateValue({ start: entry.start, ...(entry.end ? { end: entry.end } : {}), resolution: entry.allDay ? 'day' : 'time' }, target)
  return { start: moved.start, ...(moved.end ? { end: moved.end } : {}) }
}
