// Subscribed calendars: fetches each iCalendar feed (Google's "secret address in iCal format",
// iCloud public links, CalDAV/Nextcloud export URLs…), keeps the last good copy in the store and
// serves its events as calendar entries. Read-only: nothing is ever written back.
import type { CalendarEntry, Id } from '@vasta/core'
import { calendarEntries, eventCount, parseCalendar, type ParsedCalendar } from '@vasta/core/ics'
import type { DayRange } from '@vasta/core/calendar'
import type { NodeStore } from '@vasta/core/node'
import type { ChangeFeed } from './events.ts'
import { safeFetch } from './safe-fetch.ts'

const TIMEOUT_MS = 20_000
const MAX_BYTES = 20 * 1024 * 1024

export class CalendarSyncError extends Error {}

/** Accept http(s) and webcal(s) links; webcal is plain https for our purposes. Credentials in the URL move to basic auth. */
export function normalizeCalendarUrl(raw: string): { url: string; username?: string; password?: string } {
  let url: URL
  try {
    url = new URL(raw.trim().replace(/^webcals?:\/\//i, 'https://'))
  } catch {
    throw new CalendarSyncError('enter a valid calendar URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new CalendarSyncError('the calendar URL must start with https://, http:// or webcal://')
  const username = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  url.username = ''
  url.password = ''
  return { url: url.toString(), ...(username ? { username } : {}), ...(password ? { password } : {}) }
}

export interface CalendarServiceOptions {
  store: NodeStore
  feed: ChangeFeed
  now: () => string
  /** Defaults to safeFetch, which refuses private networks. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
}

export class CalendarService {
  private store: NodeStore
  private feed: ChangeFeed
  private now: () => string
  private fetch: (url: string, init?: RequestInit) => Promise<Response>
  /** Parsed feeds, keyed by source id, valid while the stored data has the same sync time. */
  private parsed = new Map<Id, { syncedAt: string; calendar: ParsedCalendar }>()
  private running = new Map<Id, Promise<void>>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor({ store, feed, now, fetch: fetchImpl = safeFetch }: CalendarServiceOptions) {
    this.store = store
    this.feed = feed
    this.now = now
    this.fetch = fetchImpl
  }

  /** Sync every enabled source now and then every `intervalMs`. */
  start(intervalMs = 15 * 60_000) {
    const all = () => {
      for (const source of this.store.listCalendarSources()) if (source.enabled) void this.sync(source.id).catch(() => {})
    }
    all()
    this.timer = setInterval(all, intervalMs)
    this.timer.unref?.()
  }

  stop() {
    clearInterval(this.timer)
  }

  /** Fetch a source. Failures are recorded on the source (and thrown); the last good data stays. */
  sync(id: Id): Promise<void> {
    const current = this.running.get(id)
    if (current) return current
    const run = this.fetchSource(id).finally(() => this.running.delete(id))
    this.running.set(id, run)
    return run
  }

  private async fetchSource(id: Id) {
    const info = this.store.calendarFetchInfo(id)
    const spaceId = this.store.getCalendarSource(id)?.spaceId
    if (!info || !spaceId) throw new CalendarSyncError('calendar not found')
    const at = this.now()
    try {
      const headers: Record<string, string> = { accept: 'text/calendar, */*;q=0.5', 'user-agent': 'Vasta calendar sync' }
      if (info.username || info.password) headers.authorization = `Basic ${Buffer.from(`${info.username ?? ''}:${info.password ?? ''}`).toString('base64')}`
      if (info.etag && this.store.calendarData(id)) headers['if-none-match'] = info.etag
      const response = await this.fetch(info.url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (response.status === 304) {
        this.store.recordCalendarSync(id, { at })
      } else {
        if (response.status === 401 || response.status === 403) throw new CalendarSyncError(`the server refused access (${response.status}); check the username and password`)
        if (!response.ok) throw new CalendarSyncError(`the server answered ${response.status}`)
        const length = Number(response.headers.get('content-length') ?? 0)
        if (length > MAX_BYTES) throw new CalendarSyncError('the calendar is larger than 20 MB')
        const text = await response.text()
        if (text.length > MAX_BYTES) throw new CalendarSyncError('the calendar is larger than 20 MB')
        let calendar: ParsedCalendar
        try {
          calendar = parseCalendar(text)
        } catch {
          throw new CalendarSyncError('the URL did not return an iCalendar feed')
        }
        const etag = response.headers.get('etag')
        this.store.recordCalendarSync(id, { at, data: text, eventCount: eventCount(calendar), ...(etag ? { etag } : {}) })
        this.parsed.set(id, { syncedAt: at, calendar })
      }
    } catch (error) {
      const message =
        error instanceof CalendarSyncError ? error.message : error instanceof Error && error.name === 'TimeoutError' ? 'the server took too long to answer' : `could not fetch the calendar (${(error as Error).message})`
      this.store.recordCalendarSync(id, { at, error: message })
      this.feed.emit({ kind: 'calendar', sourceId: id, spaceId })
      throw new CalendarSyncError(message)
    }
    this.feed.emit({ kind: 'calendar', sourceId: id, spaceId })
  }

  private parsedFeed(id: Id): ParsedCalendar | undefined {
    const stored = this.store.calendarData(id)
    if (!stored) return undefined
    const cached = this.parsed.get(id)
    if (cached?.syncedAt === stored.syncedAt) return cached.calendar
    try {
      const calendar = parseCalendar(stored.data)
      this.parsed.set(id, { syncedAt: stored.syncedAt, calendar })
      return calendar
    } catch {
      return undefined
    }
  }

  /** Events of a space's enabled sources in a range. */
  entries(spaceId: Id, range: DayRange, timeZone: string): CalendarEntry[] {
    const entries: CalendarEntry[] = []
    for (const source of this.store.listCalendarSources(spaceId)) {
      if (!source.enabled) continue
      const calendar = this.parsedFeed(source.id)
      if (calendar) entries.push(...calendarEntries(calendar, source.id, range, timeZone))
    }
    return entries
  }

  /** The name a feed gives itself (X-WR-CALNAME), once fetched. */
  feedName(id: Id): string | undefined {
    return this.parsedFeed(id)?.name
  }

  forget(id: Id) {
    this.parsed.delete(id)
  }
}
