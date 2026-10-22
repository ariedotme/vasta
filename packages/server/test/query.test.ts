import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { builtinTypeId, createBuiltinTypes, type ObjectRecord, type ObjectSummary } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { createApp } from '../src/app.ts'
import { asUser } from './helpers.ts'

const at = '2026-10-18T12:00:00.000Z'
const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

function setup(store = new NodeStore(':memory:')) {
  store.putSpace({ id: 's', name: 'Space', sidebar: [], createdAt: at })
  for (const type of createBuiltinTypes('s', at)) store.putType(type)
  return { store, app: asUser(createApp({ store, media: new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-q-'))), now: () => at }), store) }
}

describe('query endpoint', () => {
  it('runs a query with the parent variable and never lists the parent itself', async () => {
    const { app } = setup()
    const page = builtinTypeId('s', 'page')
    const create = async (data: Partial<ObjectRecord>) => (await (await app.request('/api/objects', post({ typeId: page, ...data }))).json()) as ObjectRecord
    const hub = await create({ title: 'Hub' })
    await create({ title: 'Linked', content: { body: { type: 'doc', content: [] } }, tagIds: [hub.id] })
    await create({ title: 'Other' })

    const run = async (body: unknown) => ((await (await app.request('/api/spaces/s/query', post(body))).json()) as ObjectSummary[]).map((o) => o.title)
    const byParent = { typeIds: [page], filter: { kind: 'group', operator: 'and', items: [{ kind: 'filter', field: 'tags', operator: 'contains', value: { kind: 'variable', name: 'parent' } }] } }
    expect(await run({ query: byParent, parentId: hub.id, today: '2026-10-18', timeZone: 'UTC' })).toEqual(['Linked'])
    expect(await run({ query: { typeIds: [], sort: [{ field: 'title', direction: 'asc' }] }, parentId: hub.id })).toEqual(['Linked', 'Other'])
    expect((await app.request('/api/spaces/s/query', post({}))).status).toBe(400)
  })
})

describe('task status fix', () => {
  it('rewrites Capacities status ids in tasks and query filters once', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vasta-fix-'))
    const file = path.join(dir, 'vasta.db')
    const { store } = setup(new NodeStore(file))
    const base = { spaceId: 's', aliases: [], tagIds: [], collectionIds: [], content: {}, createdAt: at, updatedAt: at }
    store.putObject({ ...base, id: 't', typeId: builtinTypeId('s', 'task'), title: 'Task', props: { status: { kind: 'select', value: ['not-started'] } } })
    store.putObject({
      ...base, id: 'q', typeId: builtinTypeId('s', 'query'), title: 'TO-DO', props: {},
      query: { typeIds: [], filter: { kind: 'group', operator: 'and', items: [{ kind: 'filter', field: 'status', operator: 'contains', value: { kind: 'literal', value: ['in-progress'] } }] } },
    })
    store.db.prepare("DELETE FROM meta WHERE key = 'fix.task-status-ids'").run()
    store.close()

    const reopened = new NodeStore(file)
    expect(reopened.getObject('t')?.props.status).toEqual({ kind: 'select', value: ['todo'] })
    expect(reopened.getObject('q')?.query?.filter?.items[0]).toMatchObject({ value: { kind: 'literal', value: ['doing'] } })
    expect(reopened.getObject('t')?.updatedAt).toBe(at)
    reopened.close()
  })
})
