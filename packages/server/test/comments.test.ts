// Comments: props of the object, written by their authors only (over HTTP and sync pushes alike).
import { describe, expect, it } from 'vitest'
import { SYNC_PROTOCOL, addComment, builtinTypeId, commentsOf, createBuiltinTypes, editComment, mentionedPeople, type ObjectRecord } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../src/app.ts'
import { ChangeFeed } from '../src/events.ts'
import { asUser } from './helpers.ts'

const at = '2026-10-21T12:00:00.000Z'
const json = (body: unknown, method = 'POST') => ({ method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

function setup() {
  const store = new NodeStore(':memory:')
  store.putSpace({ id: 's', name: 'Work', sidebar: [], createdAt: at })
  for (const type of createBuiltinTypes('s', at)) store.putType(type)
  const app = createApp({ store, media: new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-comments-'))), feed: new ChangeFeed() })
  const arie = asUser(app, store, { username: 'arie', spaces: ['s'] })
  const ana = asUser(app, store, { username: 'ana', spaces: ['s'] })
  return { store, arie, ana }
}

describe('comments', () => {
  it('are kept by their authors: others cannot add one in their name, change or delete it', async () => {
    const { store, arie, ana } = setup()
    const task = (await (await arie.request('/api/objects', json({ typeId: builtinTypeId('s', 'task'), title: 'Gate' }))).json()) as ObjectRecord
    const get = async () => (await (await arie.request(`/api/objects/${task.id}`)).json()) as ObjectRecord
    const put = (as: typeof arie, object: ObjectRecord) => as.request(`/api/objects/${task.id}`, json(object, 'PUT'))

    const mine = await get()
    const first = addComment(mine, arie.user.id, 'Paint it green? @ana', '2026-10-21T12:01:00.000Z')
    expect((await put(arie, mine)).status).toBe(200)
    const hers = await get()
    addComment(hers, ana.user.id, 'Yes', '2026-10-21T12:02:00.000Z')
    expect((await put(ana, hers)).status).toBe(200)
    expect(commentsOf(store.getObject(task.id)!).map((c) => c.text)).toEqual(['Paint it green? @ana', 'Yes'])

    // Ana changes Arie's, deletes it, or writes one as Arie: refused, nothing written.
    const forged = await get()
    editComment(forged, first, arie.user.id, 'Paint it red', at)
    const refused = await put(ana, forged)
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'only its author can change or delete a comment' })
    const gone = await get()
    delete gone.props[`comment:${first}`]
    expect((await put(ana, { ...gone, title: 'Renamed too' })).status).toBe(403)
    const asArie = await get()
    addComment(asArie, arie.user.id, 'Not me', at)
    expect((await put(ana, asArie)).status).toBe(403)
    expect(store.getObject(task.id)).toMatchObject({ title: 'Gate' })
    expect(commentsOf(store.getObject(task.id)!).map((c) => c.text)).toEqual(['Paint it green? @ana', 'Yes'])

    // The same through a device's push: refused as a whole, the others still taken.
    const hlc = `${new Date().toISOString()}-0000-device-ana`
    const pushed = (await (
      await ana.request('/api/sync/push', json({
        protocol: SYNC_PROTOCOL,
        changes: [
          { table: 'objects', id: task.id, fields: { [`props.comment:${first}`]: { value: { kind: 'comment', value: { author: arie.user.id, at, text: 'Hacked' } }, hlc } } },
          { table: 'objects', id: task.id, fields: { 'props.comment:new': { value: { kind: 'comment', value: { author: ana.user.id, at: '2026-10-21T12:05:00.000Z', text: 'From my phone' } }, hlc } } },
        ],
      }))
    ).json()) as { changes: { error?: string }[] }
    expect(pushed.changes.map((c) => c.error)).toEqual(['only its author can change or delete a comment', undefined])
    expect(commentsOf(store.getObject(task.id)!).map((c) => c.text)).toEqual(['Paint it green? @ana', 'Yes', 'From my phone'])

    // Arie edits and deletes his own.
    const own = await get()
    editComment(own, first, arie.user.id, 'Paint it blue? @ana', '2026-10-21T13:00:00.000Z')
    expect((await put(arie, own)).status).toBe(200)
    expect(commentsOf(store.getObject(task.id)!)[0]).toMatchObject({ text: 'Paint it blue? @ana', editedAt: '2026-10-21T13:00:00.000Z' })
    const deleted = await get()
    delete deleted.props[`comment:${first}`]
    expect((await put(arie, deleted)).status).toBe(200)
    expect(commentsOf(store.getObject(task.id)!).length).toBe(2)
  })

  it('find the members a text mentions', () => {
    const people = [{ id: '1', username: 'ana', name: 'Ana' }, { id: '2', username: 'bo.k', name: 'Bo' }]
    expect(mentionedPeople('@ana and @bo.k. but not email@ana.com nor @nobody', people).map((p) => p.id)).toEqual(['1', '2'])
  })
})
