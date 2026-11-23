// Calendar page helpers: visible ranges per view, the week's first day, repeat rules, and the
// edits the calendar makes to objects (move a date, tick a task, create something on a day).
import type { CalendarEntry, DateValue, Id, ObjectType, PropertyDef } from '@vasta/core'
import { addDays, daysBetween, statusProperty } from '@vasta/core'
import type { OccurrenceScope } from '@vasta/core/calendar'
import { api } from './api.ts'
import { dayKey, setProperty } from './actions.ts'
import { movedEntryTimes } from './calendar-tasks.ts'
import { locale, t, tc } from './i18n.ts'
import { choiceDialog } from './overlays.ts'
import { primeFromObject } from './state.ts'

export type CalendarView = 'month' | 'week' | 'three-days' | 'day'

export const CALENDAR_VIEWS: { id: CalendarView; readonly label: string; short: string; readonly phoneLabel?: string }[] = [
  { id: 'month', get label() { return t('calendar.view.month') }, short: 'M' },
  { id: 'week', get label() { return t('calendar.view.week') }, short: 'W' },
  { id: 'three-days', get label() { return t('calendar.view.threeDays') }, short: '3', get phoneLabel() { return t('calendar.view.threeDaysShort') } },
  { id: 'day', get label() { return t('calendar.view.day') }, short: 'D' },
]

export const viewerTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

function firstWeekdayFor(loc: string): number {
  try {
    const info = new Intl.Locale(loc) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } }
    const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay
    if (firstDay) return firstDay % 7
  } catch {}
  return 0
}

/** 0 = Sunday … 6 = Saturday, from the locale when the browser knows it. */
export const firstWeekday: number = firstWeekdayFor(typeof navigator !== 'undefined' ? navigator.language : 'en')

/** Weekday of a day, 0 = Sunday. */
export const weekdayOf = (day: string) => new Date(`${day}T00:00:00.000Z`).getUTCDay()

export function startOfWeek(day: string): string {
  return addDays(day, -((weekdayOf(day) - firstWeekdayFor(locale.value) + 7) % 7))
}

export const monthOf = (day: string) => day.slice(0, 7)

/** Days shown by a view around an anchor day. The month view shows whole weeks. */
export function visibleDays(view: CalendarView, anchor: string): string[] {
  let from = anchor
  let count = 1
  if (view === 'month') {
    from = startOfWeek(`${monthOf(anchor)}-01`)
    const lastOfMonth = addDays(`${monthOf(addDays(`${monthOf(anchor)}-01`, 31))}-01`, -1)
    count = Math.ceil((daysBetween(from, lastOfMonth) + 1) / 7) * 7
  } else if (view === 'week') {
    from = startOfWeek(anchor)
    count = 7
  } else if (view === 'three-days') {
    count = 3
  }
  return Array.from({ length: count }, (_, i) => addDays(from, i))
}

/** The anchor after moving one page back or forward. */
export function stepAnchor(view: CalendarView, anchor: string, delta: number): string {
  if (view === 'month') {
    const [year, month] = anchor.split('-').map(Number) as [number, number]
    const date = new Date(Date.UTC(year, month - 1 + delta, 1))
    return date.toISOString().slice(0, 10)
  }
  return addDays(anchor, delta * (view === 'week' ? 7 : view === 'three-days' ? 3 : 1))
}

interface CalendarFormatters {
  titleMonth: Intl.DateTimeFormat
  titleDay: Intl.DateTimeFormat
  shortDay: Intl.DateTimeFormat
  weekdayShort: Intl.DateTimeFormat
  timeShort: Intl.DateTimeFormat
}
const formatterCache = new Map<string, CalendarFormatters>()
function formatters(): CalendarFormatters {
  const loc = locale.value
  let entry = formatterCache.get(loc)
  if (!entry) {
    entry = {
      titleMonth: new Intl.DateTimeFormat(loc, { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      titleDay: new Intl.DateTimeFormat(loc, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
      shortDay: new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', timeZone: 'UTC' }),
      weekdayShort: new Intl.DateTimeFormat(loc, { weekday: 'short', timeZone: 'UTC' }),
      timeShort: new Intl.DateTimeFormat(loc, { hour: 'numeric', minute: '2-digit' }),
    }
    formatterCache.set(loc, entry)
  }
  return entry
}

const utc = (day: string) => new Date(`${day}T00:00:00.000Z`)

export function viewTitle(view: CalendarView, days: string[], anchor: string): string {
  const f = formatters()
  if (view === 'month') return f.titleMonth.format(utc(anchor))
  if (view === 'day') return f.titleDay.format(utc(anchor))
  const first = days[0]!
  const last = days.at(-1)!
  return monthOf(first) === monthOf(last) ? f.titleMonth.format(utc(first)) : `${f.shortDay.format(utc(first))} – ${f.shortDay.format(utc(last))}`
}

export const formatWeekday = (day: string) => formatters().weekdayShort.format(utc(day))
export const formatDayShort = (day: string) => formatters().shortDay.format(utc(day))
export const formatClock = (iso: string) => formatters().timeShort.format(new Date(iso))
export const isToday = (day: string) => day === dayKey()

/** "9:00 – 10:30", or "" for all-day entries. */
export function entryTime(entry: CalendarEntry): string {
  if (entry.allDay) return ''
  return entry.end ? `${formatClock(entry.start)} – ${formatClock(entry.end)}` : formatClock(entry.start)
}

/** Minutes since local midnight of `day` (negative or past 1440 when the instant is on another day). */
export function minutesInto(day: string, iso: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  const midnight = new Date(year, month - 1, date).getTime()
  const at = new Date(iso)
  // Count wall-clock minutes so DST days still line up with the hour grid.
  const dayDiff = Math.round((new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() - midnight) / 86_400_000)
  return dayDiff * 1440 + at.getHours() * 60 + at.getMinutes()
}

/** A local wall-clock time on a day, as an ISO instant. */
export function instantAt(day: string, minutes: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  return new Date(year, month - 1, date, Math.floor(minutes / 60), minutes % 60).toISOString()
}

// ---------------------------------------------------------------------------
// Laying out timed entries in a day column

export interface PlacedEntry {
  entry: CalendarEntry
  top: number
  height: number
  column: number
  columns: number
}

/** Position timed entries in minutes from midnight; overlapping entries share the width. */
export function layoutDay(day: string, entries: CalendarEntry[], minHeight = 20): PlacedEntry[] {
  const items = entries
    .map((entry) => {
      const start = Math.max(0, minutesInto(day, entry.start))
      const end = Math.min(1440, entry.end ? minutesInto(day, entry.end) : start + 30)
      return { entry, top: start, height: Math.max(minHeight, end - start), column: 0, columns: 1 }
    })
    .sort((a, b) => a.top - b.top || b.height - a.height)

  // Clusters of transitively overlapping entries share a column count.
  let cluster: PlacedEntry[] = []
  let clusterEnd = -1
  const columnEnds: number[] = []
  const close = () => {
    for (const item of cluster) item.columns = columnEnds.length
    cluster = []
    columnEnds.length = 0
  }
  for (const item of items) {
    if (item.top >= clusterEnd) close()
    let column = columnEnds.findIndex((end) => end <= item.top)
    if (column < 0) column = columnEnds.push(0) - 1
    columnEnds[column] = item.top + item.height
    item.column = column
    cluster.push(item)
    clusterEnd = Math.max(clusterEnd, item.top + item.height)
  }
  close()
  return items
}

/** An entry over a row of days (a week in the month view, the all-day row): its columns and lane. */
export interface PlacedBar {
  entry: CalendarEntry
  column: number
  span: number
  lane: number
  /** It began before the row's first day, or goes on after its last. */
  continued: boolean
  continues: boolean
}

/** Entries over a row of days as bars, each in the first lane free over its days; longer ones first. */
export function layoutBars(days: string[], entries: CalendarEntry[]): PlacedBar[] {
  const first = days[0]!
  const last = days.at(-1)!
  const bars = entries
    .filter((entry) => entry.startDay <= last && entry.endDay >= first)
    .map((entry) => {
      const column = daysBetween(first, entry.startDay < first ? first : entry.startDay)
      const span = daysBetween(first, entry.endDay > last ? last : entry.endDay) - column + 1
      return { entry, column, span, lane: 0, continued: entry.startDay < first, continues: entry.endDay > last }
    })
    .sort((a, b) => a.column - b.column || b.span - a.span)
  const laneEnds: number[] = []
  for (const bar of bars) {
    let lane = laneEnds.findIndex((end) => end <= bar.column)
    if (lane < 0) lane = laneEnds.push(0) - 1
    laneEnds[lane] = bar.column + bar.span
    bar.lane = lane
  }
  return bars
}

// ---------------------------------------------------------------------------
// Repeat rules (the subset the date editor writes; other rules are kept as they are)

export type RepeatFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
export const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

export interface RepeatRule {
  freq: RepeatFreq
  interval: number
  /** Weekly rules: the weekdays, as RRULE codes. */
  byDay: string[]
  until?: string
  count?: number
}

/** Read a rule the editor can show; undefined when it uses parts the editor does not offer. */
export function parseRepeat(rrule: string | undefined): RepeatRule | undefined {
  if (!rrule) return undefined
  const parts = new Map(rrule.replace(/^RRULE:/i, '').split(';').filter(Boolean).map((part) => part.split('=') as [string, string]))
  const freq = parts.get('FREQ') as RepeatFreq | undefined
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return undefined
  for (const key of parts.keys()) if (!['FREQ', 'INTERVAL', 'BYDAY', 'UNTIL', 'COUNT', 'WKST'].includes(key)) return undefined
  const byDay = parts.get('BYDAY')?.split(',') ?? []
  if (byDay.some((code) => !(WEEKDAY_CODES as readonly string[]).includes(code)) || (byDay.length && freq !== 'WEEKLY')) return undefined
  const until = parts.get('UNTIL')
  const count = Number(parts.get('COUNT'))
  return {
    freq,
    interval: Math.max(1, Number(parts.get('INTERVAL')) || 1),
    byDay,
    ...(until ? { until: `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` } : {}),
    ...(count > 0 ? { count } : {}),
  }
}

export function buildRepeat(rule: RepeatRule): string {
  const parts = [`FREQ=${rule.freq}`]
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`)
  if (rule.freq === 'WEEKLY' && rule.byDay.length) parts.push(`BYDAY=${rule.byDay.join(',')}`)
  if (rule.until) parts.push(`UNTIL=${rule.until.replaceAll('-', '')}T235959`)
  else if (rule.count) parts.push(`COUNT=${rule.count}`)
  return parts.join(';')
}

const WORD_KEY: Record<RepeatFreq, 'dateEditor.daily' | 'dateEditor.weekly' | 'dateEditor.monthly' | 'dateEditor.yearly'> = {
  DAILY: 'dateEditor.daily',
  WEEKLY: 'dateEditor.weekly',
  MONTHLY: 'dateEditor.monthly',
  YEARLY: 'dateEditor.yearly',
}
const UNIT_KEY: Record<RepeatFreq, 'dateEditor.unit.DAILY.other' | 'dateEditor.unit.WEEKLY.other' | 'dateEditor.unit.MONTHLY.other' | 'dateEditor.unit.YEARLY.other'> = {
  DAILY: 'dateEditor.unit.DAILY.other',
  WEEKLY: 'dateEditor.unit.WEEKLY.other',
  MONTHLY: 'dateEditor.unit.MONTHLY.other',
  YEARLY: 'dateEditor.unit.YEARLY.other',
}
const weekdayName = (code: string) => formatWeekday(addDays('2026-10-18', WEEKDAY_CODES.indexOf(code as (typeof WEEKDAY_CODES)[number]))) // 2026-10-18 is a Sunday

/** "Weekly on Mon, Wed", "Every 2 months, 5 times"… */
export function describeRepeat(rrule: string | undefined): string {
  if (!rrule) return ''
  const rule = parseRepeat(rrule)
  if (!rule) return t('calendar.repeats')
  let text = rule.interval > 1 ? t('calendar.repeatEvery', { interval: rule.interval, unit: t(UNIT_KEY[rule.freq]) }) : t(WORD_KEY[rule.freq])
  if (rule.byDay.length) text = t('calendar.repeatOn', { base: text, days: rule.byDay.map(weekdayName).join(', ') })
  if (rule.until) text = t('calendar.repeatUntil', { base: text, date: formatDayShort(rule.until) })
  else if (rule.count) text = t('calendar.repeatTimes', { base: text, count: rule.count })
  return text
}

// ---------------------------------------------------------------------------
// Editing objects from the calendar

/** Date properties of a type, in order; tasks put their due date first. */
export const dateProperties = (type: ObjectType | undefined) => (type?.properties ?? []).filter((p): p is Extract<PropertyDef, { kind: 'date' }> => p.kind === 'date')

/** Height of an hour in the week and day views, in pixels. */
export const HOUR_HEIGHT = 48

/** Shift a date so it starts at `start` (same length; day dates stay day dates). */
export function moveDate(value: DateValue, start: { day: string; minutes?: number }): DateValue {
  if (value.resolution === 'day') {
    const shift = daysBetween(value.start.slice(0, 10), start.day)
    return { ...value, start: `${start.day}T00:00:00.000Z`, ...(value.end ? { end: `${addDays(value.end.slice(0, 10), shift)}T00:00:00.000Z` } : {}) }
  }
  const old = new Date(value.start)
  const minutes = start.minutes ?? old.getHours() * 60 + old.getMinutes()
  const next = instantAt(start.day, minutes)
  const length = value.end ? Date.parse(value.end) - Date.parse(value.start) : 0
  return { ...value, start: next, ...(value.end ? { end: new Date(Date.parse(next) + length).toISOString() } : {}) }
}

/** An entry's times after moving it to a day (and a time, over the hour grid), keeping its length. */
export const movedTimes = movedEntryTimes

/** Ask which occurrences of a repeating date a change is for; null when cancelled. */
export function askScope(action: 'change' | 'delete') {
  return choiceDialog<OccurrenceScope>({
    title: action === 'delete' ? t('calendar.deleteRepeatTitle') : t('calendar.changeRepeatTitle'),
    ...(action === 'delete' ? { message: t('calendar.deleteRepeatMessage') } : {}),
    choices: [
      { value: 'this', label: t('calendar.scopeThis'), danger: action === 'delete' },
      { value: 'following', label: t('calendar.scopeFollowing'), danger: action === 'delete' },
      { value: 'all', label: t('calendar.scopeAll'), danger: action === 'delete' },
    ],
  })
}

/**
 * Give an entry new times: a single date changes; for an occurrence of a repeating one, the user
 * picks this one, this and the following, or all. False when they cancelled.
 */
export async function changeEntryTimes(
  entry: CalendarEntry,
  times: { start: string; end?: string; resolution?: 'day' | 'time' } | { cancelled: true }
): Promise<boolean> {
  if (!entry.objectId || !entry.field) return false
  if (entry.recurring && entry.occurrence) {
    const scope = await askScope('cancelled' in times ? 'delete' : 'change')
    if (!scope) return false
    const result = await api.changeOccurrence({ objectId: entry.objectId, field: entry.field, occurrence: entry.occurrence, scope, change: times }, viewerTimeZone())
    primeFromObject(result.object)
    if (result.created) primeFromObject(result.created)
    return true
  }
  if ('cancelled' in times) return false
  await updateEntryDate(entry, (value) => {
    const { end: _end, ...rest } = value
    return { ...rest, ...(times.resolution ? { resolution: times.resolution } : {}), start: times.start, ...(times.end ? { end: times.end } : {}) }
  })
  return true
}

/** Set or clear a date property on an object (used when scheduling or unscheduling from the sidebar). */
export async function setObjectSchedule(objectId: Id, field: Id, value: DateValue | undefined) {
  await setProperty(objectId, field, value ? { kind: 'date', value } : undefined)
}

/** Clear the date property of a calendar entry (unscheduling it from the calendar). */
export async function clearEntryDate(entry: CalendarEntry): Promise<boolean> {
  if (!entry.objectId || !entry.field || entry.kind !== 'property') return false
  await setObjectSchedule(entry.objectId, entry.field, undefined)
  return true
}

/** Load an object, change one of its dates and save it. */
export async function updateEntryDate(entry: CalendarEntry, change: (value: DateValue) => DateValue) {
  if (!entry.objectId || !entry.field) return
  const object = await api.object(entry.objectId)
  if (entry.field === 'date') {
    if (!object.date) return
    object.date = change(object.date)
  } else {
    const current = object.props[entry.field]
    if (current?.kind !== 'date') return
    object.props[entry.field] = { kind: 'date', value: change(current.value) }
  }
  primeFromObject(await api.saveObject(object))
}

/** The status option of a type's status property that means done or to-do. */
function statusOption(type: ObjectType | undefined, status: 'todo' | 'done'): { field: Id; option: Id } | undefined {
  const def = statusProperty(type)
  const option = def?.options.find((o) => o.status === status)?.id
  return def && option ? { field: def.id, option } : undefined
}

export function isDone(type: ObjectType | undefined, statusIds: Id[] | undefined): boolean {
  const def = statusProperty(type)
  return !!def && !!statusIds?.some((id) => def.options.find((o) => o.id === id)?.status === 'done')
}

export async function setTaskDone(objectId: Id, type: ObjectType | undefined, done: boolean) {
  const target = statusOption(type, done ? 'done' : 'todo')
  if (!target) return
  await setProperty(objectId, target.field, { kind: 'select', value: [target.option] })
}

/** What a day holds, for the dots of the small month calendar. */
export interface DayMarks {
  /** A daily note with something written in it. */
  note?: boolean
  tasks?: number
  /** Objects dated that day (date properties and objects' own dates), tasks aside. */
  dated?: number
  /** Objects that link to the day's note. */
  references?: number
  /** Events of subscribed calendars. */
  events?: number
}

export const DAY_MARKS: { key: keyof DayMarks; readonly label: string; dot: string }[] = [
  { key: 'note', get label() { return t('builtin.type.daily-note.one') }, dot: 'bg-ink-soft' },
  { key: 'tasks', get label() { return t('builtin.type.task.other') }, dot: 'bg-emerald-500' },
  { key: 'dated', get label() { return t('calendar.datedObjects') }, dot: 'bg-violet-500' },
  { key: 'references', get label() { return t('calendar.mark.references') }, dot: 'bg-amber-500' },
  { key: 'events', get label() { return t('calendar.mark.events') }, dot: 'bg-sky-500' },
]

/** "Daily note · 2 tasks · 1 reference", for a day's tooltip. */
export function describeMarks(marks: DayMarks | undefined): string {
  if (!marks) return ''
  return [
    marks.note ? t('builtin.type.daily-note.one') : '',
    marks.tasks ? tc(marks.tasks, 'calendar.mark.task.one', 'calendar.mark.task.other') : '',
    marks.dated ? tc(marks.dated, 'calendar.mark.dated.one', 'calendar.mark.dated.other') : '',
    marks.references ? tc(marks.references, 'calendar.mark.reference.one', 'calendar.mark.reference.other') : '',
    marks.events ? tc(marks.events, 'calendar.mark.event.one', 'calendar.mark.event.other') : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

/** The ISO week number (weeks start on Monday; week 1 holds the year's first Thursday). */
export function isoWeek(day: string): number {
  const date = utc(day)
  const weekday = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - weekday + 3)
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4))
  return 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
}
