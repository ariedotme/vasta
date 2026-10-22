// Calendar arithmetic shared by queries and the calendar. Days are "YYYY-MM-DD" strings; instants
// are ISO timestamps in UTC. Zone conversions use Intl, so any IANA zone works without a tz database.
import type { IsoDateTime } from './model.ts'

export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

const dayFormats = new Map<string, Intl.DateTimeFormat>()
const partFormats = new Map<string, Intl.DateTimeFormat>()

/** The calendar day an instant falls on in a time zone. */
export function dayIn(instant: IsoDateTime | number, timeZone: string): string {
  let format = dayFormats.get(timeZone)
  if (!format) {
    // en-CA formats dates as YYYY-MM-DD.
    format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    dayFormats.set(timeZone, format)
  }
  return format.format(new Date(instant))
}

/** Shift a day by whole days. */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** Whole days from one day to another (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000)
}

export function isValidDay(day: string): boolean {
  if (!DAY_PATTERN.test(day)) return false
  const date = new Date(`${day}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(day)
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone })
    return true
  } catch {
    return false
  }
}

/** Wall-clock time: what a clock in some zone shows. Months are 1-based. */
export interface WallTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

export function wallTimeIn(instant: IsoDateTime | number, timeZone: string): WallTime {
  let format = partFormats.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    })
    partFormats.set(timeZone, format)
  }
  const parts: Record<string, number> = {}
  for (const part of format.formatToParts(new Date(instant))) if (part.type !== 'literal') parts[part.type] = Number(part.value)
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour! % 24, minute: parts.minute!, second: parts.second! }
}

/** Milliseconds the zone is ahead of UTC at an instant. */
function offsetAt(ms: number, timeZone: string): number {
  const w = wallTimeIn(ms, timeZone)
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000
}

/**
 * The instant a wall-clock time happens in a zone. A time skipped by a DST jump moves forward by
 * the jump; a repeated time resolves to its first occurrence.
 */
export function instantOf(wall: WallTime, timeZone: string): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  const first = asUtc - offsetAt(asUtc, timeZone)
  const second = asUtc - offsetAt(first, timeZone)
  if (first === second) return first
  // Around a transition the two guesses differ: prefer the one that shows the requested time.
  const shows = (ms: number) => {
    const w = wallTimeIn(ms, timeZone)
    return w.hour === wall.hour && w.minute === wall.minute
  }
  if (shows(Math.min(first, second))) return Math.min(first, second)
  if (shows(Math.max(first, second))) return Math.max(first, second)
  return Math.max(first, second)
}

/** Midnight at the start of a day in a zone. */
export function startOfDay(day: string, timeZone: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  return instantOf({ year, month, day: date, hour: 0, minute: 0, second: 0 }, timeZone)
}
