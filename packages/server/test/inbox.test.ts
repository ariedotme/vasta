import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BODY_PROPERTY_ID, createBuiltinTypes, type CaptureInfo, type ObjectRecord } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { createApp } from '../src/app.ts'
import { CaptureService } from '../src/capture.ts'
import type { InboxItem } from '../src/inbox.ts'
import { asUser } from './helpers.ts'

function setup() {
  const store = new NodeStore(':memory:')
  const clock = { at: '2026-10-01T15:00:00.000Z' }
  for (const id of ['s', 'other']) {
    store.putSpace({ id, name: id, sidebar: [], createdAt: clock.at })
    for (const type of createBuiltinTypes(id, clock.at)) store.putType(type)
  }
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-inbox-')))
  const capture = new CaptureService({ store, media, now: () => clock.at, timeZone: 'UTC', defaultSpaceId: 's' })
  const app = asUser(createApp({ store, media, capture, now: () => clock.at }), store, { spaces: ['s'] })
  return { store, clock, capture, app }
}

type Inbox = { items: InboxItem[]; objects: { id: string; title: string }[] }

describe('inbox', () => {
  it('lists captures of the last days across daily notes, newest first, with their objects', async () => {
    const { app, capture, clock } = setup()
    await capture.note({ text: 'old idea', channel: 'telegram' })
    clock.at = '2026-10-10T09:00:00.000Z'
    await capture.note({ text: 'first', channel: 'telegram' })
    clock.at = '2026-10-11T08:00:00.000Z'
    const task = await capture.task({ line: 'Buy coffee priority:high', channel: 'shortcuts' })

    const inbox = (await (await app.request('/api/spaces/s/inbox?today=2026-10-11&days=7')).json()) as Inbox
    expect(inbox.items.map((i) => [i.day, i.channel, i.done])).toEqual([
      ['2026-10-11', 'shortcuts', false],
      ['2026-10-10', 'telegram', false],
    ])
    expect(inbox.items[1]!.content).toEqual([{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }])
    expect(inbox.items[0]!.objectIds).toEqual([task.objects[0]!.id])
    expect(inbox.objects.map((o) => o.title)).toEqual(['Buy coffee'])
    // A longer window reaches the old one.
    expect(((await (await app.request('/api/spaces/s/inbox?today=2026-10-11&days=30')).json()) as Inbox).items).toHaveLength(3)
  })

  it('marks an item done and back, in its daily note', async () => {
    const { app, capture, store } = setup()
    const result = await capture.note({ text: 'call the bank', channel: 'telegram' })
    const url = `/api/objects/${result.dailyNote.id}/captures/${result.blockId}`
    const put = (done: boolean) => app.request(url, { method: 'PUT', body: JSON.stringify({ done }), headers: { 'content-type': 'application/json' } })
    const captureInNote = () => (store.getObject(result.dailyNote.id)!.content[BODY_PROPERTY_ID]!.content.find((n) => n.type === 'callout')!.attrs!.capture as CaptureInfo)

    expect((await put(true)).status).toBe(200)
    expect(captureInNote().done).toBe(true)
    const inbox = (await (await app.request('/api/spaces/s/inbox?today=2026-10-01')).json()) as Inbox
    expect(inbox.items[0]!.done).toBe(true)
    expect(((await (await put(false)).json()) as ObjectRecord).id).toBe(result.dailyNote.id)
    expect(captureInNote().done).toBeUndefined()

    expect((await app.request(`/api/objects/${result.dailyNote.id}/captures/nope`, { method: 'PUT', body: '{"done":true}' })).status).toBe(404)
  })

  it('answers 404 for another space', async () => {
    const { app, store, capture } = setup()
    const other = await capture.note({ text: 'not yours', spaceId: 'other' })
    expect((await app.request('/api/spaces/other/inbox')).status).toBe(404)
    expect((await app.request(`/api/objects/${other.dailyNote.id}/captures/${other.blockId}`, { method: 'PUT', body: '{"done":true}' })).status).toBe(404)
    expect(store.getObject(other.dailyNote.id)!.content[BODY_PROPERTY_ID]!.content.find((n) => n.type === 'callout')!.attrs!.capture).not.toHaveProperty('done')
  })
})
