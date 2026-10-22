import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { builtinTypeId, createBuiltinTypes, type ObjectRecord, type ObjectSummary } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { createApp } from '../src/app.ts'
import { asUser } from './helpers.ts'

const at = '2026-01-01T00:00:00.000Z'

function setup() {
  const store = new NodeStore(':memory:')
  store.putSpace({ id: 's', name: 'Space', sidebar: [], createdAt: at })
  for (const type of createBuiltinTypes('s', at)) store.putType(type)
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-server-')))
  return { store, media, app: asUser(createApp({ store, media, now: () => at }), store) }
}

const json = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

describe('server API', () => {
  it('creates, updates, searches and deletes objects', async () => {
    const { app } = setup()
    const pageType = builtinTypeId('s', 'page')

    const created = (await (await app.request('/api/objects', json({ typeId: pageType, title: 'Coffee notes' }))).json()) as ObjectRecord
    expect(created).toMatchObject({ spaceId: 's', typeId: pageType, title: 'Coffee notes' })

    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Pour over ratio' }] }] }
    const update = await app.request(`/api/objects/${created.id}`, { ...json({ ...created, content: { body: doc } }), method: 'PUT' })
    expect(update.status).toBe(200)

    const byTitle = (await (await app.request('/api/spaces/s/search?q=coff')).json()) as ObjectSummary[]
    const byBody = (await (await app.request('/api/spaces/s/search?q=ratio')).json()) as ObjectSummary[]
    expect(byTitle.map((o) => o.id)).toEqual([created.id])
    expect(byBody[0]).toMatchObject({ id: created.id, preview: 'Pour over ratio' })

    const space = (await (await app.request('/api/spaces/s')).json()) as { counts: Record<string, number> }
    expect(space.counts[pageType]).toBe(1)

    expect((await app.request(`/api/objects/${created.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(await (await app.request(`/api/types/${pageType}/objects`)).json()).toEqual([])
  })

  it('compresses JSON for clients that take it, but not the event stream', async () => {
    const { app } = setup()
    for (let i = 0; i < 20; i++) await app.request('/api/objects', json({ typeId: builtinTypeId('s', 'page'), title: `Note number ${i}` }))
    const gzip = { headers: { 'accept-encoding': 'gzip' } }
    const list = await app.request(`/api/types/${builtinTypeId('s', 'page')}/objects`, gzip)
    expect(list.headers.get('content-encoding')).toBe('gzip')
    const objects = (await new Response(list.body!.pipeThrough(new DecompressionStream('gzip'))).json()) as ObjectSummary[]
    expect(objects).toHaveLength(20)
    expect((await app.request(`/api/types/${builtinTypeId('s', 'page')}/objects`)).headers.get('content-encoding')).toBeNull()
    const events = await app.request('/api/events', gzip)
    expect(events.headers.get('content-type')).toMatch(/^text\/event-stream/)
    expect(events.headers.get('content-encoding')).toBeNull()
    await events.body!.cancel()
  })

  it('writes only what changed since the base copy when a save sends one', async () => {
    const { app, store } = setup()
    const para = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
    const put = async (body: unknown) => (await app.request(`/api/objects/${base.id}`, { ...json(body), method: 'PUT' })).json() as Promise<ObjectRecord>
    const base = (await (await app.request('/api/objects', json({ typeId: builtinTypeId('s', 'page'), title: 'Trip', content: { body: para('Pack') } }))).json()) as ObjectRecord

    // Another device renames the note and edits its text.
    await put({ ...base, title: 'Trip to Rio', aliases: ['Rio'], content: { body: para('Pack sunscreen') } })
    // An editor of the older copy adds a description: the rename and the text stay.
    const saved = await put({ ...base, description: 'In March', base })
    expect([saved.title, saved.aliases, saved.description, saved.content.body?.content[0]?.content?.[0]?.text]).toEqual(['Trip to Rio', ['Rio'], 'In March', 'Pack sunscreen'])
    // Changing the text sends it whole; the title is still left alone.
    const typed = await put({ ...base, content: { body: para('Pack hats') }, base })
    expect([typed.title, typed.description, typed.content.body?.content[0]?.content?.[0]?.text]).toEqual(['Trip to Rio', 'In March', 'Pack hats'])
    // Nothing changed: nothing written.
    const rev = store.currentRev()
    await put({ ...base, base })
    expect(store.currentRev()).toBe(rev)
    // Without a base (apps from before it), the body replaces the object.
    expect((await put({ ...typed, title: 'Trip' })).aliases).toEqual(['Rio'])
    expect((await put({ ...base })).title).toBe('Trip')
  })

  it('does not undo a write that lands while a save’s body arrives', async () => {
    const { app, store } = setup()
    const object = (await (await app.request('/api/objects', json({ typeId: builtinTypeId('s', 'page'), title: 'Trip' }))).json()) as ObjectRecord
    // The body is read only when the route asks for it; a device's push lands just then.
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          store.putObject({ ...store.getObject(object.id)!, description: 'From the phone' })
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ ...object, title: 'Trip to Rio', base: object })))
          controller.close()
        },
      },
      { highWaterMark: 0 }
    )
    const response = await app.request(`/api/objects/${object.id}`, { method: 'PUT', body, headers: { 'content-type': 'application/json' }, duplex: 'half' } as RequestInit)
    expect(response.status).toBe(200)
    expect(store.getObject(object.id)).toMatchObject({ title: 'Trip to Rio', description: 'From the phone' })
  })

  it('reports backlinks', async () => {
    const { app } = setup()
    const typeId = builtinTypeId('s', 'page')
    const target = (await (await app.request('/api/objects', json({ typeId, title: 'Target' }))).json()) as ObjectRecord
    await app.request(
      '/api/objects',
      json({
        typeId,
        title: 'Source',
        content: { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { objectId: target.id, label: 'Target' } }] }] } },
      })
    )
    const backlinks = (await (await app.request(`/api/objects/${target.id}/backlinks`)).json()) as { object: ObjectSummary; kind: string }[]
    expect(backlinks.map((b) => [b.object.title, b.kind])).toEqual([['Source', 'mention']])
  })

  it('trashes a custom type with its objects, keeps built-in types, and unpins it', async () => {
    const { app, store } = setup()
    const type = (await (await app.request('/api/types', json({ spaceId: 's', name: 'Book', pluralName: 'Books' }))).json()) as { id: string }
    await app.request('/api/objects', json({ typeId: type.id, title: 'Dune' }))
    await app.request('/api/spaces/s', { ...json({ sidebar: [{ id: 'pinned', name: 'Pinned', items: [type.id] }] }), method: 'PUT' })

    expect((await app.request(`/api/types/${builtinTypeId('s', 'page')}`, { method: 'DELETE' })).status).toBe(400)
    expect((await app.request(`/api/types/${type.id}`, { method: 'DELETE' })).status).toBe(204)

    const space = (await (await app.request('/api/spaces/s')).json()) as { space: { sidebar: { items: string[] }[] }; types: { id: string }[] }
    expect(space.types.map((t) => t.id)).not.toContain(type.id)
    expect(space.space.sidebar[0]!.items).toEqual([])
    expect(store.counts().objects).toBe(0)
  })

  it('turns food tracking on, changes the meals, and logs and deletes food', async () => {
    const { app, store } = setup()
    const put = (body: unknown) => app.request('/api/spaces/s', { ...json(body), method: 'PUT' })
    const on = (await (await app.request('/api/spaces/s/nutrition', json({ enabled: true }))).json()) as { types: { system: string }[] }
    expect(on.types.map((t) => t.system)).toEqual(['food', 'recipe', 'nutrition-goal', 'habit'])
    await put({ nutrition: { enabled: true, meals: [{ id: 'cafe', name: 'Café', time: '7:00' }, { id: 'jantar', name: 'Jantar', time: '20:00' }] } })
    expect(store.getSpace('s')!.nutrition!.meals).toEqual([{ id: 'cafe', name: 'Café' }, { id: 'jantar', name: 'Jantar', time: '20:00' }])
    // Renaming the space leaves the meals alone.
    await put({ name: 'Home' })
    expect(store.getSpace('s')!.nutrition!.meals).toHaveLength(2)

    const food = (await (await app.request('/api/objects', json({ typeId: builtinTypeId('s', 'food'), title: 'Rice', props: { kcal: { kind: 'number', value: 130 } } }))).json()) as ObjectRecord
    const logged = await app.request('/api/spaces/s/food', json({ sourceId: food.id, amount: '200 g', day: '2026-01-01', meal: 'jantar' }))
    expect(logged.status).toBe(201)
    const { note, entryId, entry } = (await logged.json()) as { note: ObjectRecord; entryId: string; entry: object }
    expect(entry).toMatchObject({ name: 'Rice', grams: 200, meal: 'jantar', nutrients: { kcal: 260 } })
    expect((await app.request('/api/spaces/s/food', json({ sourceId: food.id, amount: '2 cups', day: '2026-01-01' }))).status).toBe(400)
    expect((await app.request('/api/spaces/s/food', json({ sourceId: 'nope', amount: '2', day: '2026-01-01' }))).status).toBe(404)
    expect((await app.request(`/api/objects/${note.id}/food/${entryId}`, { method: 'DELETE' })).status).toBe(200)
    expect(Object.keys(store.getObject(note.id)!.props)).toEqual([])
    expect((await app.request(`/api/objects/${note.id}/food/${entryId}`, { method: 'DELETE' })).status).toBe(404)
  })

  it('serves stored media, whole or a range, and rejects invalid keys', async () => {
    const { app, media } = setup()
    const file = await media.put(new Uint8Array([137, 80, 78, 71]), 'pic.png')
    const response = await app.request(`/media/${file.key}`)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([137, 80, 78, 71])
    const part = await app.request(`/media/${file.key}`, { headers: { range: 'bytes=1-2' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 1-2/4')
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([80, 78])
    const outside = await app.request(`/media/${file.key}`, { headers: { range: 'bytes=9-' } })
    expect(outside.status).toBe(416)
    expect(outside.headers.get('content-range')).toBe('bytes */4')
    expect((await app.request(`/media/${'0'.repeat(64)}.png`)).status).toBe(404)
    expect((await app.request('/media/..%2Fvasta.db')).status).toBe(400)
  })

  it('serves the built web app, with index.html for client-side routes', async () => {
    const store = new NodeStore(':memory:')
    const webDir = mkdtempSync(path.join(tmpdir(), 'vasta-web-'))
    mkdirSync(path.join(webDir, 'assets'))
    writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>Vasta</title>')
    writeFileSync(path.join(webDir, 'assets', 'app-1234.js'), 'console.log(1)\n'.repeat(500))
    const app = createApp({ store, media: new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-m-'))), webDir })

    const index = await app.request('/')
    expect(await index.text()).toContain('<title>Vasta</title>')
    const route = await app.request('/o/some-object')
    expect(route.status).toBe(200)
    expect(route.headers.get('cache-control')).toBe('no-cache')
    expect(await route.text()).toContain('<title>Vasta</title>')
    const asset = await app.request('/assets/app-1234.js')
    expect(asset.headers.get('cache-control')).toContain('immutable')
    const gzipped = await app.request('/assets/app-1234.js', { headers: { 'accept-encoding': 'gzip' } })
    expect(gzipped.headers.get('content-encoding')).toBe('gzip')
    writeFileSync(path.join(webDir, 'sw.js'), '// worker')
    writeFileSync(path.join(webDir, 'manifest.webmanifest'), '{}')
    const worker = await app.request('/sw.js')
    expect(worker.headers.get('content-type')).toMatch(/javascript/)
    expect(worker.headers.get('cache-control')).toBe('no-cache')
    expect((await app.request('/manifest.webmanifest')).headers.get('content-type')).toMatch(/manifest\+json/)
    const missing = await app.request('/assets/missing.js')
    expect(missing.status).toBe(404)
    expect(missing.headers.get('cache-control')).toBeNull()
    expect((await app.request('/api/health')).status).toBe(200)
    // The API never falls back to the page.
    expect((await app.request('/api/nope')).status).toBe(401)
    expect((await asUser(app, store).request('/api/nope')).status).toBe(404)
  })
})
