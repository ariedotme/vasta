import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBuiltinTypes, type CalendarEntry, type Doc, type CalendarSource, type ObjectSummary, type ObjectType } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { createApp } from '../src/app.ts'
import { CalendarService, normalizeCalendarUrl } from '../src/calendars.ts'
import { ChangeFeed } from '../src/events.ts'
import { asUser } from './helpers.ts'

const at = '2026-10-18T12:00:00.000Z'
const ics = readFileSync(new URL('../../core/test/fixtures/sample.ics', import.meta.url), 'utf8')

function setup(respond: (url: string, init?: RequestInit) => Response) {
  const store = new NodeStore(':memory:')
  store.putSpace({ id: 's', name: 'Space', sidebar: [], createdAt: at })
  const event: ObjectType = {
    id: 'event', spaceId: 's', name: 'Event', pluralName: 'Events', views: [], createdAt: at, updatedAt: at,
    properties: [{ id: 'when', kind: 'date', name: 'When', withTime: true }],
  }
  for (const type of [...createBuiltinTypes('s', at), event]) store.putType(type)
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-calendar-')))
  const feed = new ChangeFeed()
  const requests: { url: string; headers: Record<string, string> }[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requests.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    return respond(url, init)
  }) as typeof fetch
  const calendars = new CalendarService({ store, feed, now: () => at, fetch: fetchImpl })
  return { store, requests, app: asUser(createApp({ store, media, feed, calendars, now: () => at }), store) }
}

const send = (method: string, body: unknown) => ({ method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

describe('calendar API', () => {
  it('counts the objects that link to each day in range', async () => {
    const { app, store } = setup(() => new Response(ics))
    const daily = store.listTypes('s').find((t) => t.system === 'daily-note')!
    const page = store.listTypes('s').find((t) => t.system === 'page')!
    const base = { spaceId: 's', aliases: [], tagIds: [], collectionIds: [], props: {}, createdAt: at, updatedAt: at }
    store.putObject({ ...base, id: 'day', typeId: daily.id, title: '', content: {}, date: { start: '2026-10-27T00:00:00.000Z', resolution: 'day' } })
    const mention = (id: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { objectId: id, label: 'Tuesday' } }] }] }) as Doc
    store.putObject({ ...base, id: 'a', typeId: page.id, title: 'A', content: { body: mention('day') } })
    store.putObject({ ...base, id: 'b', typeId: page.id, title: 'B', content: { body: mention('day') } })
    store.putObject({ ...base, id: 'gone', typeId: page.id, title: 'Gone', content: { body: mention('day') }, deletedAt: at })
    // A date object (what mentioning a date makes) counts for its day too, empty or not.
    const date = store.listTypes('s').find((t) => t.system === 'date')!
    store.putObject({ ...base, id: 'friday', typeId: date.id, title: '', content: {}, date: { start: '2026-10-30T00:00:00.000Z', resolution: 'day' } })
    store.putObject({ ...base, id: 'c', typeId: page.id, title: 'C', content: { body: mention('friday') } })

    const range = (await (await app.request('/api/spaces/s/calendar?from=2026-10-26&to=2026-11-01')).json()) as { references: Record<string, number> }
    expect(range.references).toEqual({ '2026-10-27': 2, '2026-10-30': 1 })
  })

  it('lists objects and subscribed events in a range', async () => {
    const { app, store, requests } = setup(() => new Response(ics, { headers: { etag: '"v1"' } }))
    store.putObject({
      id: 'party', spaceId: 's', typeId: 'event', title: 'Party', aliases: [], tagIds: [], collectionIds: [], content: {}, createdAt: at, updatedAt: at,
      props: { when: { kind: 'date', value: { start: '2026-10-30T23:00:00.000Z', resolution: 'time' } } },
    })

    const created = await app.request('/api/spaces/s/calendar-sources', send('POST', { url: 'webcal://user:secret@example.com/cal.ics', name: 'Work' }))
    expect(created.status).toBe(201)
    const source = (await created.json()) as CalendarSource
    expect(source).toMatchObject({ name: 'Work', url: 'https://example.com/cal.ics', username: 'user', hasPassword: true, eventCount: 6 })
    expect(JSON.stringify(source)).not.toContain('secret')
    expect(requests[0]!.headers.authorization).toBe(`Basic ${Buffer.from('user:secret').toString('base64')}`)

    const response = await app.request('/api/spaces/s/calendar?from=2026-10-26&to=2026-11-01&timeZone=America/Sao_Paulo')
    const { entries, objects } = (await response.json()) as { entries: CalendarEntry[]; objects: ObjectSummary[] }
    expect(entries.filter((e) => e.kind === 'external').map((e) => e.title)).toEqual(['Trip', 'Standup', 'Call', 'Unregistered zone', 'Floating'])
    expect(entries.find((e) => e.objectId === 'party')).toMatchObject({ kind: 'property', field: 'when', startDay: '2026-10-30' })
    expect(objects.map((o) => o.id)).toEqual(['party'])

    // A second sync sends the ETag; 304 keeps the stored feed.
    await app.request(`/api/calendar-sources/${source.id}/sync`, { method: 'POST' })
    expect(requests[1]!.headers['if-none-match']).toBe('"v1"')

    // Disabled sources drop out of the calendar.
    await app.request(`/api/calendar-sources/${source.id}`, send('PUT', { enabled: false }))
    const after = (await (await app.request('/api/spaces/s/calendar?from=2026-10-26&to=2026-11-01&timeZone=America/Sao_Paulo')).json()) as { entries: CalendarEntry[] }
    expect(after.entries.some((e) => e.kind === 'external')).toBe(false)
  })

  it('records failures and keeps the previous data', async () => {
    let status = 200
    const { app } = setup(() => (status === 200 ? new Response(ics) : new Response('no', { status })))
    const source = (await (await app.request('/api/spaces/s/calendar-sources', send('POST', { url: 'https://example.com/a.ics' }))).json()) as CalendarSource
    expect(source.name).toBe('Work') // from X-WR-CALNAME
    expect((await app.request('/api/spaces/s/calendar-sources', send('POST', { url: 'https://example.com/a.ics' }))).status).toBe(400)
    status = 401
    const failed = (await (await app.request(`/api/calendar-sources/${source.id}/sync`, { method: 'POST' })).json()) as CalendarSource
    expect(failed.error).toMatch(/refused access/)
    const range = (await (await app.request('/api/spaces/s/calendar?from=2026-10-26&to=2026-10-26')).json()) as { entries: CalendarEntry[] }
    expect(range.entries.some((e) => e.title === 'Standup')).toBe(true)
  })

  it('rejects bad input', async () => {
    const { app } = setup(() => new Response('<html></html>'))
    expect((await app.request('/api/spaces/s/calendar?from=2026-10-05&to=2026-10-01')).status).toBe(400)
    expect((await app.request('/api/spaces/s/calendar?from=2020-01-01&to=2026-10-01')).status).toBe(400)
    expect((await app.request('/api/spaces/s/calendar-sources', send('POST', { url: 'ftp://x' }))).status).toBe(400)
    const notIcs = (await (await app.request('/api/spaces/s/calendar-sources', send('POST', { url: 'https://example.com' }))).json()) as CalendarSource
    expect(notIcs.error).toMatch(/iCalendar/)
    expect(normalizeCalendarUrl('webcals://p.icloud.com/x').url).toBe('https://p.icloud.com/x')
  })
})
