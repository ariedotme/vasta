import { channelIcon, type DateValue, type ObjectSummary, type ObjectType } from '@vasta/core'
import { locale, t, type MessageKey } from './i18n.ts'
import { tagAncestors } from './tags.ts'

interface Formatters {
  day: Intl.DateTimeFormat
  longDay: Intl.DateTimeFormat
  time: Intl.DateTimeFormat
  short: Intl.DateTimeFormat
  clock: Intl.DateTimeFormat
  relative: Intl.RelativeTimeFormat
}

const formatterCache = new Map<string, Formatters>()

function formatters(): Formatters {
  const tag = locale.value
  let entry = formatterCache.get(tag)
  if (!entry) {
    entry = {
      day: new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }),
      longDay: new Intl.DateTimeFormat(tag, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
      time: new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
      short: new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short' }),
      clock: new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit' }),
      relative: new Intl.RelativeTimeFormat(tag, { numeric: 'auto' }),
    }
    formatterCache.set(tag, entry)
  }
  return entry
}

/** Day-resolution dates are stored at midnight UTC, so they are formatted in UTC. */
export function formatDate(value: DateValue): string {
  const f = formatters()
  const format = value.resolution === 'day' ? f.day : f.time
  const start = format.format(new Date(value.start))
  if (!value.end) return start
  // A time range within one day only repeats the clock: "18 Oct 2026, 09:00 – 10:30".
  const sameDay = value.resolution === 'time' && new Date(value.start).toDateString() === new Date(value.end).toDateString()
  return `${start} – ${(sameDay ? f.clock : format).format(new Date(value.end))}`
}

export function formatLongDay(iso: string): string {
  return formatters().longDay.format(new Date(iso))
}

export function formatRelative(iso: string): string {
  const f = formatters()
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.round(diff / 60000)
  if (Math.abs(minutes) < 60) return f.relative.format(-minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return f.relative.format(-hours, 'hour')
  const days = Math.round(hours / 24)
  if (Math.abs(days) < 7) return f.relative.format(-days, 'day')
  return f.short.format(new Date(iso))
}

/**
 * Daily notes and untitled objects still need something readable to show. A nested tag shows its
 * path, "recipe/breakfast" (lib/tags.ts).
 */
export function displayTitle(object: Pick<ObjectSummary, 'title' | 'date'> & Partial<Pick<ObjectSummary, 'media' | 'id' | 'parentId'>> | undefined, type?: ObjectType): string {
  if (!object) return t('common.loading')
  if (object.title.trim() && object.parentId && object.id) return [...tagAncestors({ id: object.id, parentId: object.parentId }).map((tag) => tag.title), object.title].join('/')
  if (object.title.trim()) return object.title
  if (object.media?.file?.name) return object.media.file.name
  if (type?.system === 'daily-note' && object.date) return formatLongDay(object.date.start)
  if (type?.system === 'date' && object.date) return formatDate(object.date)
  return t('common.untitled')
}

/** "08:59" — capture blocks sit in that day's note, so the time is enough. */
export const formatCaptureTime = (iso: string) => formatters().clock.format(new Date(iso))

const CHANNEL_KEYS: Record<string, MessageKey> = {
  telegram: 'channel.telegram',
  api: 'channel.api',
  email: 'channel.email',
  shortcuts: 'channel.shortcuts',
  raycast: 'channel.raycast',
  browser: 'channel.browser',
  desktop: 'channel.desktop',
}

export const formatChannel = (channel: string) => (CHANNEL_KEYS[channel] ? t(CHANNEL_KEYS[channel]) : channel)

/** The icon on the channel's capture callouts. */
export const channelIconName = (channel: string) => channelIcon(channel).value
