// Activity: what members did to objects, recorded where their writes are applied, read over HTTP,
// and deleted after the space's retention.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SYNC_PROTOCOL, builtinTypeId, createBuiltinTypes, type ActivityEntry, type ObjectRecord } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { AccountService } from '../src/accounts.ts'
import { createApp } from '../src/app.ts'
import { CaptureService } from '../src/capture.ts'
import { ChangeFeed } from '../src/events.ts'

const PASSWORD = 'correct horse'
const APP = { 'x-requested-with': 'vasta', 'content-type': 'application/json' }
const TASK = builtinTypeId('home', 'task')
const DAY = 86_400_000

async function setup() {
  const at = new Date().toISOString()
  const store = new NodeStore(':memory:')
  store.putSpace({ id: 'home', name: 'Home', sidebar: [], createdAt: at })
  for (const type of createBuiltinTypes('home', at)) store.putType(type)
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-activity-')))
  const now = () => new Date().toISOString()
  const feed = new ChangeFeed()
  const capture = new CaptureService({ store, media, feed, now, timeZone: 'UTC' })
  const accounts = new AccountService({ store, now, capture })
  const app = createApp({ store, media, feed, capture, accounts, now })
  const arie = await accounts.createUser({ username: 'arie', name: 'Arie', password: PASSWORD })
  const ana = await accounts.createUser({ username: 'ana', name: 'Ana', password: PASSWORD })
  accounts.share('home', ana.id, 'editor')
  return { store, app, arie, ana }
}

async function browser(app: Awaited<ReturnType<typeof setup>>['app'], username: string) {
  const login = await app.request('/api/auth/login', { method: 'POST', headers: APP, body: JSON.stringify({ username, password: PASSWORD }) })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  const call = async (url: string, method = 'GET', body?: unknown) => app.request(url, { method, headers: { ...APP, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return async <T>(url: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await call(url, method, body)
    expect(response.status, `${method} ${url}`).toBeLessThan(300)
    return (response.status === 204 ? undefined : await response.json()) as T
  }
}

/** The entries as "who kind field: before → after", oldest first. */
const story = (entries: ActivityEntry[], names: Record<string, string>) =>
  [...entries].reverse().map((e) => {
    const value = (v: unknown) => (v === undefined ? '∅' : typeof v === 'string' ? v : JSON.stringify((v as { value: unknown }).value ?? v))
    return `${names[e.actor ?? ''] ?? '?'} ${e.kind}${e.field ? ` ${e.field}: ${value(e.before)} → ${value(e.after)}` : ''}`
  })

describe('activity', () => {
  it('records who created, changed, trashed and restored an object', async () => {
    const { app, arie, ana } = await setup()
    const names = { [arie.id]: 'arie', [ana.id]: 'ana' }
    const asArie = await browser(app, 'arie')
    const asAna = await browser(app, 'ana')
    const task = await asArie<ObjectRecord>('/api/objects', 'POST', { typeId: TASK, line: 'Fix the gate' })
    const put = async (as: typeof asArie, change: (o: ObjectRecord) => ObjectRecord) => as<ObjectRecord>(`/api/objects/${task.id}`, 'PUT', change(await as<ObjectRecord>(`/api/objects/${task.id}`)))
    await put(asAna, (o) => ({ ...o, props: { ...o.props, status: { kind: 'select', value: ['doing'] }, assignee: { kind: 'person', value: [ana.id] } } }))
    // Typing a title saves it several times: one change from the first title to the last.
    await put(asArie, (o) => ({ ...o, title: 'Fix the g' }))
    await put(asArie, (o) => ({ ...o, title: 'Fix the garden gate' }))
    await put(asAna, (o) => ({ ...o, props: { ...o.props, status: { kind: 'select', value: ['done'] } } }))
    await asAna(`/api/objects/${task.id}`, 'DELETE')
    await asAna(`/api/objects/${task.id}/restore`, 'POST')
    const entries = await asArie<ActivityEntry[]>(`/api/objects/${task.id}/activity`)
    expect(story(entries, names)).toEqual([
      'arie created',
      'ana changed status: ["todo"] → ["doing"]',
      `ana changed assignee: ∅ → ["${ana.id}"]`,
      'arie changed title: Fix the gate → Fix the garden gate',
      'ana changed status: ["doing"] → ["done"]',
      'ana trashed',
      'ana restored',
    ])
    // A title typed back to where it was leaves nothing.
    await put(asArie, (o) => ({ ...o, title: 'Fix it' }))
    await put(asArie, (o) => ({ ...o, title: 'Fix the garden gate' }))
    expect((await asArie<ActivityEntry[]>(`/api/objects/${task.id}/activity`)).length).toBe(entries.length)
  })

  it('records nothing for writes nobody made, and the device’s time for pushed changes', async () => {
    const { store, app, ana } = await setup()
    const asAna = await browser(app, 'ana')
    const before = store.spaceActivity('home').length
    // The server's own jobs and imports.
    store.putObject({ id: 'imported', spaceId: 'home', typeId: TASK, title: 'Imported', aliases: [], tagIds: [], collectionIds: [], props: {}, content: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
    store.putObject({ ...store.getObject('imported')!, title: 'Renamed by a job' })
    expect(store.spaceActivity('home').length).toBe(before)

    // Made offline yesterday, pushed now.
    const yesterday = new Date(Date.now() - DAY).toISOString()
    const hlc = `${yesterday}-0000-device-ana`
    await asAna('/api/sync/push', 'POST', {
      protocol: SYNC_PROTOCOL,
      changes: [{ table: 'objects', id: 'imported', fields: { 'props.status': { value: { kind: 'select', value: ['done'] }, hlc } } }],
    })
    const [entry] = store.objectActivity('imported')
    expect(entry).toMatchObject({ actor: ana.id, kind: 'changed', field: 'status', at: yesterday, after: { kind: 'select', value: ['done'] } })
  })

  it('keeps activity for the space’s retention: 3 months unless an owner changes it', async () => {
    const { store, app } = await setup()
    const asArie = await browser(app, 'arie')
    const asAna = await browser(app, 'ana')
    const task = await asArie<ObjectRecord>('/api/objects', 'POST', { typeId: TASK, title: 'Old news' })
    expect(await asAna('/api/spaces/home/activity-settings')).toEqual({ retentionDays: 90 })
    // Only owners change it, to one of the choices.
    expect((await app.request('/api/spaces/home/activity-settings', { method: 'PUT', headers: APP, body: '{}' })).status).toBe(401)
    await expect(asAna('/api/spaces/home/activity-settings', 'PUT', { retentionDays: 30 })).rejects.toThrow()
    await expect(asArie('/api/spaces/home/activity-settings', 'PUT', { retentionDays: 12 })).rejects.toThrow()

    expect(store.purgeActivity(new Date(Date.now() + 89 * DAY).toISOString())).toBe(0)
    expect(store.purgeActivity(new Date(Date.now() + 91 * DAY).toISOString())).toBe(1)
    await asArie<ObjectRecord>(`/api/objects/${task.id}`, 'PUT', { ...task, title: 'Kept forever' })
    expect(await asArie('/api/spaces/home/activity-settings', 'PUT', { retentionDays: 0 })).toEqual({ retentionDays: 0 })
    expect(store.purgeActivity(new Date(Date.now() + 3650 * DAY).toISOString())).toBe(0)
    await asArie('/api/spaces/home/activity-settings', 'PUT', { retentionDays: 30 })
    expect(store.purgeActivity(new Date(Date.now() + 31 * DAY).toISOString())).toBe(1)

    // An object deleted for good takes its activity along.
    await asArie<ObjectRecord>(`/api/objects/${task.id}`, 'PUT', { ...(await asArie<ObjectRecord>(`/api/objects/${task.id}`)), title: 'Gone' })
    expect(store.objectActivity(task.id).length).toBe(1)
    store.purgeObject(task.id)
    expect(store.objectActivity(task.id)).toEqual([])
  })

  it('measures the flow of a status type from its activity', async () => {
    const { app } = await setup()
    const asArie = await browser(app, 'arie')
    const task = await asArie<ObjectRecord>('/api/objects', 'POST', { typeId: TASK, line: 'Measure me' })
    const set = async (value: string) => {
      const object = await asArie<ObjectRecord>(`/api/objects/${task.id}`)
      await asArie(`/api/objects/${task.id}`, 'PUT', { ...object, props: { ...object.props, status: { kind: 'select', value: [value] } } })
    }
    await set('doing')
    await set('done')
    const metrics = await asArie<{ items: { id: string; category: string; leadDays?: number; cycleDays?: number }[]; throughput: { done: number }[]; flow: unknown[]; lead: { count: number }; retentionDays: number }>(`/api/types/${TASK}/metrics?timeZone=UTC`)
    expect(metrics.items).toEqual([expect.objectContaining({ id: task.id, category: 'done', leadDays: expect.any(Number), cycleDays: expect.any(Number) })])
    expect(metrics.lead.count).toBe(1)
    expect(metrics.throughput.reduce((sum, w) => sum + w.done, 0)).toBe(1)
    expect(metrics.flow.length).toBe(30)
    expect(metrics.retentionDays).toBe(90)
    const page = await app.request(`/api/types/${builtinTypeId('home', 'page')}/metrics`, { headers: APP })
    expect(page.status).toBe(401)
    await expect(asArie(`/api/types/${builtinTypeId('home', 'page')}/metrics`)).rejects.toThrow()
  })

  it('lists a space’s activity, oldest first, only to its members', async () => {
    const { store, app } = await setup()
    const asArie = await browser(app, 'arie')
    await asArie<ObjectRecord>('/api/objects', 'POST', { typeId: TASK, title: 'One' })
    await asArie<ObjectRecord>('/api/objects', 'POST', { typeId: TASK, title: 'Two' })
    const listed = await asArie<ActivityEntry[]>('/api/spaces/home/activity')
    expect(listed.map((e) => e.kind)).toEqual(['created', 'created'])
    expect(listed.map((e) => store.getObject(e.objectId)?.title)).toEqual(['One', 'Two'])
    // Someone without the space.
    const outsider = await browser(app, 'arie')
    store.removeMember('home', (await outsider<{ id: string }>('/api/auth/me')).id)
    expect((await app.request('/api/spaces/home/activity', { headers: APP })).status).toBe(401)
    await expect(outsider('/api/spaces/home/activity')).rejects.toThrow()
  })
})
