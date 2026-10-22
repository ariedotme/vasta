// iCalendar feeds (RFC 5545) from subscribed calendars: parsed once per fetch, then expanded into
// calendar entries for whatever range is on screen. Recurrence, EXDATE and moved occurrences
// (RECURRENCE-ID) are handled by ical.js; zones it has no VTIMEZONE for fall back to Intl.
import ICAL from 'ical.js'
import type { CalendarEntry, Id } from './model.ts'
import type { DayRange } from './calendar.ts'
import { addDays, instantOf, isValidTimeZone, startOfDay } from './time.ts'
import { spanOf } from './calendar.ts'

export interface ParsedCalendar {
  /** X-WR-CALNAME, which Google and iCloud set to the calendar's name. */
  name?: string
  events: { master: ICAL.Event; exceptions: ICAL.Event[] }[]
}

const MAX_STEPS = 20_000
const DESCRIPTION_LIMIT = 2000

/** Parse iCalendar text. Throws when the text is not iCalendar. */
export function parseCalendar(text: string): ParsedCalendar {
  const root = new ICAL.Component(ICAL.parse(text))
  const calendar = root.name === 'vcalendar' ? root : root.getFirstSubcomponent('vcalendar')
  if (!calendar) throw new Error('not an iCalendar feed (no VCALENDAR)')
  for (const zone of calendar.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(zone)

  const byUid = new Map<string, { master?: ICAL.Event; exceptions: ICAL.Event[] }>()
  for (const component of calendar.getAllSubcomponents('vevent')) {
    const event = new ICAL.Event(component)
    if (!event.startDate) continue
    const uid = event.uid || `${event.summary}:${event.startDate.toString()}`
    const group = byUid.get(uid) ?? { exceptions: [] }
    if (event.isRecurrenceException()) group.exceptions.push(event)
    else group.master = event
    byUid.set(uid, group)
  }
  const events: ParsedCalendar['events'] = []
  for (const group of byUid.values()) {
    if (group.master) {
      for (const exception of group.exceptions) group.master.relateException(exception)
      events.push({ master: group.master, exceptions: group.exceptions })
    } else {
      // Moved occurrences whose series is missing still happened.
      for (const exception of group.exceptions) events.push({ master: exception, exceptions: [] })
    }
  }
  const name = calendar.getFirstPropertyValue('x-wr-calname')
  return { ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}), events }
}

/** The instant of a date-time, in its own zone when known, else in the viewer's. */
function toInstant(time: ICAL.Time, timeZone: string): number {
  const zone = time.zone
  if (zone && zone !== ICAL.Timezone.localTimezone && zone.tzid !== 'floating') return time.toUnixTime() * 1000
  // ical.js keeps the TZID of a zone without a VTIMEZONE here; its types omit it.
  const tzid = (time as ICAL.Time & { timezone?: string }).timezone
  const resolved = tzid && isValidTimeZone(tzid) ? tzid : timeZone
  return instantOf({ year: time.year, month: time.month, day: time.day, hour: time.hour, minute: time.minute, second: time.second }, resolved)
}

const dayOf = (time: ICAL.Time) => time.toString().slice(0, 10)

function entryFor(event: ICAL.Event, start: ICAL.Time, end: ICAL.Time | undefined, sourceId: Id, recurring: boolean, timeZone: string): CalendarEntry {
  const base = {
    kind: 'external' as const,
    sourceId,
    title: event.summary || '(No title)',
    ...(event.location ? { location: event.location } : {}),
    ...(event.description ? { description: event.description.slice(0, DESCRIPTION_LIMIT) } : {}),
    ...(recurring ? { recurring: true } : {}),
  }
  const url = event.component.getFirstPropertyValue('url')
  const withUrl = typeof url === 'string' && /^https?:\/\//i.test(url) ? { url } : {}
  if (start.isDate) {
    const startDay = dayOf(start)
    // DTEND of an all-day event is exclusive.
    const endDay = end && dayOf(end) > startDay ? addDays(dayOf(end), -1) : startDay
    return {
      ...base,
      ...withUrl,
      key: `${sourceId}:${event.uid}:${startDay}`,
      start: `${startDay}T00:00:00.000Z`,
      ...(endDay !== startDay ? { end: `${endDay}T00:00:00.000Z` } : {}),
      allDay: true,
      startDay,
      endDay,
    }
  }
  const startIso = new Date(toInstant(start, timeZone)).toISOString()
  const endMs = end ? toInstant(end, timeZone) : undefined
  const endIso = endMs !== undefined && endMs > Date.parse(startIso) ? new Date(endMs).toISOString() : undefined
  return {
    ...base,
    ...withUrl,
    key: `${sourceId}:${event.uid}:${startIso}`,
    start: startIso,
    ...(endIso ? { end: endIso } : {}),
    allDay: false,
    ...spanOf({ start: startIso, ...(endIso ? { end: endIso } : {}), resolution: 'time' }, timeZone),
  }
}

const cancelled = (event: ICAL.Event) => String(event.component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED'

/** Entries of a parsed feed that touch a range of days in the viewer's zone. */
export function calendarEntries(parsed: ParsedCalendar, sourceId: Id, range: DayRange, timeZone: string): CalendarEntry[] {
  // Margins of a day cover events whose own zone puts them on another day than the viewer's.
  const rangeStart = startOfDay(addDays(range.from, -1), timeZone)
  const rangeEnd = startOfDay(addDays(range.to, 2), timeZone)
  const entries: CalendarEntry[] = []
  const keep = (entry: CalendarEntry) => {
    if (entry.startDay <= range.to && entry.endDay >= range.from) entries.push(entry)
  }

  for (const { master } of parsed.events) {
    if (!master.isRecurring()) {
      if (!cancelled(master)) keep(entryFor(master, master.startDate, master.endDate, sourceId, false, timeZone))
      continue
    }
    const durationMs = master.duration ? master.duration.toSeconds() * 1000 : 0
    const iterator = master.iterator()
    for (let step = 0, next = iterator.next(); next && step < MAX_STEPS; step++, next = iterator.next()) {
      // Stop by the series' own times; a moved occurrence is kept or dropped by its new times below.
      const scheduledMs = next.isDate ? Date.parse(`${dayOf(next)}T00:00:00Z`) : toInstant(next, timeZone)
      if (scheduledMs >= rangeEnd) break
      if (scheduledMs + durationMs < rangeStart && !(master.exceptions as unknown as Record<string, unknown>)[next.toString()]) continue
      const details = master.getOccurrenceDetails(next)
      if (cancelled(details.item)) continue
      keep(entryFor(details.item, details.startDate, details.endDate, sourceId, true, timeZone))
    }
  }
  return entries
}

/** Number of events in a feed, counting a repeating series once. */
export const eventCount = (parsed: ParsedCalendar) => parsed.events.length
