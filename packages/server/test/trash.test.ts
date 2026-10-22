import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { builtinTypeId, createBuiltinTypes, type ObjectRecord, type ObjectSummary, type ObjectType } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { createApp } from '../src/app.ts'
import { purgeExpiredTrash } from '../src/trash.ts'
import { asUser } from './helpers.ts'

function setup() {
  const store = new NodeStore(':memory:')
  const clock = { at: '2026-10-01T12:00:00.000Z' }
  for (const id of ['s', 'other']) {
    store.putSpace({ id, name: id, sidebar: [], createdAt: clock.at })
    for (const type of createBuiltinTypes(id, clock.at)) store.putType(type)
  }
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-trash-')))
  const app = asUser(createApp({ store, media, now: () => clock.at }), store, { spaces: ['s'] })
  return { store, clock, app }
}

const json = (body: unknown, method = 'POST') => ({ method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
type Trash = { types: (ObjectType & { objectCount: number })[]; objects: ObjectSummary[] }

describe('trash', () => {
  it('lists, restores and purges a deleted object; search and backlinks find it again', async () => {
    const { app, clock } = setup()
    const pageType = builtinTypeId('s', 'page')
    const target = (await (await app.request('/api/objects', json({ typeId: pageType, title: 'Coffee notes' }))).json()) as ObjectRecord
    const mention = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { objectId: target.id } }] }] }
    const source = (await (await app.request('/api/objects', json({ typeId: pageType, title: 'Index', content: { body: mention } }))).json()) as ObjectRecord

    clock.at = '2026-10-02T12:00:00.000Z'
    expect((await app.request(`/api/objects/${source.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(await (await app.request(`/api/objects/${target.id}/backlinks`)).json()).toEqual([])
    expect(await (await app.request('/api/spaces/s/search?q=index')).json()).toEqual([])

    const trash = (await (await app.request('/api/spaces/s/trash')).json()) as Trash
    expect(trash.objects.map((o) => [o.title, o.deletedAt])).toEqual([['Index', clock.at]])
    expect(((await (await app.request('/api/spaces/s')).json()) as { trash: number }).trash).toBe(1)

    // Not in the trash: neither restored nor purged.
    expect((await app.request(`/api/objects/${target.id}/restore`, { method: 'POST' })).status).toBe(400)
    expect((await app.request(`/api/objects/${target.id}?forever=1`, { method: 'DELETE' })).status).toBe(400)

    const restored = (await (await app.request(`/api/objects/${source.id}/restore`, { method: 'POST' })).json()) as { object: ObjectRecord }
    expect(restored.object.deletedAt).toBeUndefined()
    expect(((await (await app.request(`/api/objects/${target.id}/backlinks`)).json()) as unknown[]).length).toBe(1)
    expect(((await (await app.request('/api/spaces/s/search?q=index')).json()) as ObjectSummary[]).map((o) => o.id)).toEqual([source.id])

    await app.request(`/api/objects/${source.id}`, { method: 'DELETE' })
    expect((await app.request(`/api/objects/${source.id}?forever=1`, { method: 'DELETE' })).status).toBe(204)
    expect((await app.request(`/api/objects/${source.id}`)).status).toBe(404)
    expect(((await (await app.request('/api/spaces/s/trash')).json()) as Trash).objects).toEqual([])
  })

  it('restores a type with the objects deleted together with it, not ones deleted before', async () => {
    const { app, clock } = setup()
    const type = (await (await app.request('/api/types', json({ spaceId: 's', name: 'Book' }))).json()) as ObjectType
    const dune = (await (await app.request('/api/objects', json({ typeId: type.id, title: 'Dune' }))).json()) as ObjectRecord
    const emma = (await (await app.request('/api/objects', json({ typeId: type.id, title: 'Emma' }))).json()) as ObjectRecord
    clock.at = '2026-10-02T12:00:00.000Z'
    await app.request(`/api/objects/${emma.id}`, { method: 'DELETE' })
    clock.at = '2026-10-03T12:00:00.000Z'
    expect((await app.request(`/api/types/${type.id}`, { method: 'DELETE' })).status).toBe(204)

    const trash = (await (await app.request('/api/spaces/s/trash')).json()) as Trash
    expect(trash.types.map((t) => [t.name, t.objectCount])).toEqual([['Book', 1]])
    // Dune went with its type and is listed under it; Emma was deleted on her own.
    expect(trash.objects.map((o) => o.title)).toEqual(['Emma'])

    const result = (await (await app.request(`/api/types/${type.id}/restore`, { method: 'POST' })).json()) as { objects: ObjectRecord[] }
    expect(result.objects.map((o) => o.id)).toEqual([dune.id])
    const space = (await (await app.request('/api/spaces/s')).json()) as { types: ObjectType[]; counts: Record<string, number>; trash: number }
    expect(space.types.map((t) => t.id)).toContain(type.id)
    expect(space.counts[type.id]).toBe(1)
    expect(space.trash).toBe(1)
  })

  it('brings back the type of an object restored from a deleted type', async () => {
    const { app, store, clock } = setup()
    const type = (await (await app.request('/api/types', json({ spaceId: 's', name: 'Book' }))).json()) as ObjectType
    const dune = (await (await app.request('/api/objects', json({ typeId: type.id, title: 'Dune' }))).json()) as ObjectRecord
    const emma = (await (await app.request('/api/objects', json({ typeId: type.id, title: 'Emma' }))).json()) as ObjectRecord
    clock.at = '2026-10-02T12:00:00.000Z'
    await app.request(`/api/types/${type.id}`, { method: 'DELETE' })

    const result = (await (await app.request(`/api/objects/${dune.id}/restore`, { method: 'POST' })).json()) as { type?: ObjectType }
    expect(result.type?.id).toBe(type.id)
    expect(store.getType(type.id)?.deletedAt).toBeUndefined()
    // Emma stays in the trash, now as an object of her own.
    expect(((await (await app.request('/api/spaces/s/trash')).json()) as Trash).objects.map((o) => o.id)).toEqual([emma.id])
  })

  it('deletes a type forever with all its objects, and empties the trash', async () => {
    const { app, store } = setup()
    const type = (await (await app.request('/api/types', json({ spaceId: 's', name: 'Book' }))).json()) as ObjectType
    const dune = (await (await app.request('/api/objects', json({ typeId: type.id, title: 'Dune' }))).json()) as ObjectRecord
    expect((await app.request(`/api/types/${type.id}?forever=1`, { method: 'DELETE' })).status).toBe(400)
    await app.request(`/api/types/${type.id}`, { method: 'DELETE' })
    expect((await app.request(`/api/types/${type.id}?forever=1`, { method: 'DELETE' })).status).toBe(204)
    expect(store.getType(type.id)).toBeUndefined()
    expect(store.getObject(dune.id)).toBeUndefined()

    const page = (await (await app.request('/api/objects', json({ typeId: builtinTypeId('s', 'page'), title: 'Old' }))).json()) as ObjectRecord
    await app.request(`/api/objects/${page.id}`, { method: 'DELETE' })
    expect(await (await app.request('/api/spaces/s/trash', { method: 'DELETE' })).json()).toEqual({ types: 0, objects: 1 })
    expect(store.getObject(page.id)).toBeUndefined()
  })

  it('purges what has been in the trash for 30 days', async () => {
    const { app, store, clock } = setup()
    const pageType = builtinTypeId('s', 'page')
    const old = (await (await app.request('/api/objects', json({ typeId: pageType, title: 'Old' }))).json()) as ObjectRecord
    const recent = (await (await app.request('/api/objects', json({ typeId: pageType, title: 'Recent' }))).json()) as ObjectRecord
    await app.request(`/api/objects/${old.id}`, { method: 'DELETE' })
    clock.at = '2026-10-20T12:00:00.000Z'
    await app.request(`/api/objects/${recent.id}`, { method: 'DELETE' })

    expect(purgeExpiredTrash(store, '2026-10-31T11:59:59.000Z')).toEqual({ types: 0, objects: 0 })
    expect(purgeExpiredTrash(store, '2026-10-31T12:00:00.000Z')).toEqual({ types: 0, objects: 1 })
    expect(store.getObject(old.id)).toBeUndefined()
    expect(store.getObject(recent.id)?.deletedAt).toBe(clock.at)
  })

  it('answers 404 for the trash of a space the user is not a member of', async () => {
    const { app, store } = setup()
    const page = (await (await app.request('/api/objects', json({ typeId: builtinTypeId('s', 'page'), title: 'Mine' }))).json()) as ObjectRecord
    const outsider = asUser(createApp({ store, media: new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-trash-'))) }), store, { spaces: ['other'] })
    await app.request(`/api/objects/${page.id}`, { method: 'DELETE' })
    expect((await outsider.request('/api/spaces/s/trash')).status).toBe(404)
    expect((await outsider.request('/api/spaces/s/trash', { method: 'DELETE' })).status).toBe(404)
    expect((await outsider.request(`/api/objects/${page.id}/restore`, { method: 'POST' })).status).toBe(404)
    expect((await outsider.request(`/api/objects/${page.id}?forever=1`, { method: 'DELETE' })).status).toBe(404)
    expect(store.getObject(page.id)?.deletedAt).toBeDefined()
  })
})

describe('deleted spaces', () => {
  it('lists the spaces an owner deleted and restores them; editors and outsiders see none', async () => {
    const { app, store } = setup()
    const at = '2026-10-01T12:00:00.000Z'
    store.putSpace({ id: 'home', name: 'Home', sidebar: [], createdAt: at })
    store.putMember({ spaceId: 'home', userId: app.user.id, role: 'owner', createdAt: at })
    const editor = asUser(createApp({ store, media: new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-trash-'))) }), store, { spaces: [] })
    store.putMember({ spaceId: 'home', userId: editor.user.id, role: 'editor', createdAt: at })
    store.setSpaceDeleted('home', at)

    expect(((await (await app.request('/api/deleted-spaces')).json()) as { name: string }[]).map((s) => s.name)).toEqual(['Home'])
    expect(await (await editor.request('/api/deleted-spaces')).json()).toEqual([])
    expect((await editor.request('/api/deleted-spaces/home/restore', { method: 'POST' })).status).toBe(404)
    expect((await app.request('/api/deleted-spaces/home/restore', { method: 'POST' })).status).toBe(200)
    expect(store.getSpace('home')?.name).toBe('Home')
  })
})
