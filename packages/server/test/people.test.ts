// People in a space: who made and last changed an object (recorded where a user's write is
// applied: the app's routes, sync pushes, captures), person properties set by username, and the
// `me` variable in queries.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SYNC_PROTOCOL, builtinTypeId, createBuiltinTypes, ensureBuiltinTypes, type ObjectRecord, type ObjectSummary, type QueryDef } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { AccountService } from '../src/accounts.ts'
import { createApp } from '../src/app.ts'
import { CaptureService } from '../src/capture.ts'
import { ChangeFeed } from '../src/events.ts'

const start = '2026-10-21T12:00:00.000Z'
const PASSWORD = 'correct horse'
const APP = { 'x-requested-with': 'vasta', 'content-type': 'application/json' }
const TASK = builtinTypeId('home', 'task')

async function setup() {
  const store = new NodeStore(':memory:')
  store.putSpace({ id: 'home', name: 'Home', sidebar: [], createdAt: start })
  for (const type of createBuiltinTypes('home', start)) store.putType(type)
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-people-')))
  const now = () => start
  const feed = new ChangeFeed()
  const capture = new CaptureService({ store, media, feed, now, timeZone: 'UTC' })
  const accounts = new AccountService({ store, now, capture })
  const app = createApp({ store, media, feed, capture, accounts, now })
  const arie = await accounts.createUser({ username: 'arie', name: 'Arie', password: PASSWORD })
  const ana = await accounts.createUser({ username: 'ana', name: 'Ana Lima', password: PASSWORD })
  accounts.share('home', ana.id, 'editor')
  return { store, app, arie, ana }
}

async function browser(app: Awaited<ReturnType<typeof setup>>['app'], username: string) {
  const login = await app.request('/api/auth/login', { method: 'POST', headers: APP, body: JSON.stringify({ username, password: PASSWORD }) })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!
  return async <T>(url: string, method = 'GET', body?: unknown): Promise<T> => {
    const response = await app.request(url, { method, headers: { ...APP, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    expect(response.status, `${method} ${url}`).toBeLessThan(300)
    return (await response.json()) as T
  }
}

describe('people', () => {
  it('records who made an object and who changed it last', async () => {
    const { store, app, arie, ana } = await setup()
    const asArie = await browser(app, 'arie')
    const asAna = await browser(app, 'ana')
    const made = await asArie<ObjectRecord>('/api/objects', 'POST', { typeId: TASK, title: 'Fix the gate', createdBy: ana.id })
    // A client cannot claim someone else made it.
    expect(made).toMatchObject({ createdBy: arie.id, updatedBy: arie.id })

    const edited = await asAna<ObjectRecord>(`/api/objects/${made.id}`, 'PUT', { ...made, title: 'Fix the garden gate', updatedBy: arie.id })
    expect(edited).toMatchObject({ createdBy: arie.id, updatedBy: ana.id })

    // Saving without a change leaves the last editor alone.
    const same = await asArie<ObjectRecord>(`/api/objects/${made.id}`, 'PUT', edited)
    expect(same.updatedBy).toBe(ana.id)

    // The server's own writes (no user) keep them too.
    store.putObject({ ...store.getObject(made.id)!, title: 'Fixed by a job' })
    expect(store.getObject(made.id)).toMatchObject({ createdBy: arie.id, updatedBy: ana.id })
  })

  it('records the pushing user for changes that arrive through sync', async () => {
    const { store, app, ana } = await setup()
    const asAna = await browser(app, 'ana')
    const hlc = `${start}-0000-device-ana`
    const pushed = await asAna<{ changes: { error?: string }[] }>('/api/sync/push', 'POST', {
      protocol: SYNC_PROTOCOL,
      changes: [{ table: 'objects', id: 'offline-task', spaceId: 'home', fields: { typeId: { value: TASK, hlc }, title: { value: 'Made offline', hlc } } }],
    })
    expect(pushed.changes[0]!.error).toBeUndefined()
    expect(store.getObject('offline-task')).toMatchObject({ createdBy: ana.id, updatedBy: ana.id })
    const pulled = await asAna<{ rows: { id: string; record: ObjectRecord }[] }>(`/api/sync/pull?protocol=${SYNC_PROTOCOL}&since=0&limit=1000`)
    expect(pulled.rows.find((r) => r.id === 'offline-task')!.record).toMatchObject({ createdBy: ana.id })
  })

  it('sets person properties by username or name, and "me", from a typed line', async () => {
    const { store, app, arie, ana } = await setup()
    const asArie = await browser(app, 'arie')
    const forAna = await asArie<ObjectRecord>('/api/objects', 'POST', { typeId: TASK, line: 'Buy paint assignee:ana' })
    expect(forAna.title).toBe('Buy paint')
    expect(forAna.props.assignee).toEqual({ kind: 'person', value: [ana.id] })
    const byName = await asArie<ObjectRecord>('/api/objects', 'POST', { typeId: TASK, line: 'Call the plumber assignee:"Ana Lima"' })
    expect(byName.props.assignee).toEqual({ kind: 'person', value: [ana.id] })
    const mine = await asArie<ObjectRecord>('/api/objects', 'POST', { typeId: TASK, line: 'Mow the lawn assignee:me' })
    expect(mine.props.assignee).toEqual({ kind: 'person', value: [arie.id] })
    // Someone who is not a member stays in the title.
    const stranger = await asArie<ObjectRecord>('/api/objects', 'POST', { typeId: TASK, line: 'Paint assignee:bob' })
    expect(stranger.props.assignee).toBeUndefined()
    expect(stranger.title).toContain('assignee:bob')
    expect(store.people('home').map((p) => p.username)).toEqual(['arie', 'ana'])
  })

  it('filters by "me" and by who made something', async () => {
    const { app, arie, ana } = await setup()
    const asArie = await browser(app, 'arie')
    const asAna = await browser(app, 'ana')
    await asArie('/api/objects', 'POST', { typeId: TASK, line: 'For Ana assignee:ana' })
    await asArie('/api/objects', 'POST', { typeId: TASK, line: 'For Arie assignee:arie' })
    await asAna('/api/objects', 'POST', { typeId: TASK, title: 'Ana made this' })
    const assignedToMe: QueryDef = { typeIds: [TASK], filter: { kind: 'group', operator: 'and', items: [{ kind: 'filter', field: 'assignee', operator: 'contains', value: { kind: 'variable', name: 'me' } }] } }
    const titles = (rows: ObjectSummary[]) => rows.map((o) => o.title).sort()
    expect(titles(await asArie<ObjectSummary[]>('/api/spaces/home/query', 'POST', { query: assignedToMe }))).toEqual(['For Arie'])
    expect(titles(await asAna<ObjectSummary[]>('/api/spaces/home/query', 'POST', { query: assignedToMe }))).toEqual(['For Ana'])
    const madeByAna: QueryDef = { typeIds: [TASK], filter: { kind: 'group', operator: 'and', items: [{ kind: 'filter', field: 'createdBy', operator: 'is', value: { kind: 'literal', value: [ana.id] } }] } }
    expect(titles(await asArie<ObjectSummary[]>('/api/spaces/home/query', 'POST', { query: madeByAna }))).toEqual(['Ana made this'])
    // Sorting by a person sorts by name: Ana Lima before Arie.
    const sorted = await asArie<ObjectSummary[]>('/api/spaces/home/query', 'POST', { query: { typeIds: [TASK], filter: { kind: 'group', operator: 'and', items: [{ kind: 'filter', field: 'assignee', operator: 'is-not-empty' }] }, sort: [{ field: 'assignee', direction: 'asc' }] } })
    expect(sorted.map((o) => o.title)).toEqual(['For Ana', 'For Arie'])
    expect(arie.id).not.toBe(ana.id)
  })

  it('gives older spaces the Assignee property once, after Due', () => {
    const store = new NodeStore(':memory:')
    store.putSpace({ id: 'old', name: 'Old', sidebar: [], createdAt: start })
    const types = createBuiltinTypes('old', start).map((t) => (t.system === 'task' ? { ...t, properties: t.properties.filter((p) => p.id !== 'assignee') } : t))
    for (const type of types) store.putType(type)
    ensureBuiltinTypes(store, start)
    const task = () => store.getType(builtinTypeId('old', 'task'))!
    expect(task().properties.map((p) => p.id)).toEqual(['body', 'status', 'due', 'assignee', 'priority', 'blocked'])
    // Deleted by the user: it stays deleted.
    store.putType({ ...task(), properties: task().properties.filter((p) => p.id !== 'assignee') })
    ensureBuiltinTypes(store, start)
    expect(task().properties.some((p) => p.id === 'assignee')).toBe(false)
  })
})
