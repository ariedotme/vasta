import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BODY_PROPERTY_ID, createBuiltinTypes } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { createApp } from '../src/app.ts'
import { asUser, texts } from './helpers.ts'

const at = '2026-10-26T12:00:00.000Z'

function setup() {
  const store = new NodeStore(':memory:')
  for (const id of ['s', 'other']) {
    store.putSpace({ id, name: id, sidebar: [], createdAt: at })
    for (const type of createBuiltinTypes(id, at)) store.putType(type)
  }
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-import-')))
  const { request } = asUser(createApp({ store, media, now: () => at }), store, { spaces: ['s'] })
  const post = (spaceId: string, body: unknown) =>
    request(`/api/spaces/${spaceId}/import/capacities`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
  return { store, media, request, post }
}

const file = (fields: string, body = '') => `---\n${fields}\n---\n\n${body}\n`

describe('POST /spaces/:id/import/capacities', () => {
  it('imports an export into a space, attaching the media it has and adding to the daily notes there', async () => {
    const { store, media, post } = setup()
    const own = store.putObject({
      id: 'day',
      spaceId: 's',
      typeId: 'daily-note:s',
      title: '',
      aliases: [],
      tagIds: [],
      collectionIds: [],
      props: {},
      content: { [BODY_PROPERTY_ID]: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'mine' }] }] } },
      date: { start: '2026-05-08T00:00:00.000Z', resolution: 'day' },
      createdAt: at,
      updatedAt: at,
    })
    const stored = await media.put(new Uint8Array([1, 2, 3]), 'Cat.png', 'image/png')

    const response = await post('s', {
      markdown: {
        'Pessoas/Ada.md': file("type: 'Pessoa'\ntitle: Ada\ntags: [Math]"),
        'Images/Cat.md': file("type: 'Image'\ntitle: Cat", 'Media: ![Imagem](./Media/Cat.png)'),
        'Images/Dog.md': file("type: 'Image'\ntitle: Dog", 'Media: ![Imagem](./Media/Dog.png)'),
        'DailyNotes/2026-05-08.md': file("type: 'DailyNote'\ndate: '2026-05-08T00:00:00.000Z'", 'Met [[Ada]].'),
      },
      media: {
        'Images/Media/Cat.png': { key: stored.key, name: 'Cat.png', sizeBytes: 3, mimeType: 'image/png' },
        // Never sent to /import/media: left out.
        'Images/Media/Dog.png': { key: `${'b'.repeat(64)}.png`, name: 'Dog.png', sizeBytes: 3 },
      },
    })
    expect(response.status).toBe(200)
    const report = (await response.json()) as { objects: number; mergedDailyNotes: number; media: { attached: number; missing: string[] }; types: { created: string[] } }
    expect(report).toMatchObject({ objects: 4, mergedDailyNotes: 1, media: { attached: 1, missing: ['Images/Dog.md'] }, types: { created: ['Pessoa'] } })

    const people = store.listTypes('s').find((t) => t.name === 'Pessoa')!
    const ada = store.listObjects(people.id)[0]!
    expect(ada.title).toBe('Ada')
    expect(store.listObjects('tag:s').map((t) => t.title)).toEqual(['Math'])
    expect(store.listObjects('image:s').find((o) => o.title === 'Cat')!.media?.file?.key).toBe(stored.key)
    const day = store.getObject(own.id)!
    expect(texts(day.content[BODY_PROPERTY_ID])).toEqual(['mine', 'Met .'])
    expect(day.content[BODY_PROPERTY_ID]!.content[1]!.content![1]).toEqual({ type: 'mention', attrs: { objectId: ada.id, label: 'Ada' } })
    expect(store.backlinks(ada.id).map((b) => b.object.id)).toContain(own.id)
  })

  it('answers 404 for a space of someone else, and 400 without notes', async () => {
    const { post } = setup()
    expect((await post('other', { markdown: {} })).status).toBe(404)
    expect((await post('s', {})).status).toBe(400)
  })
})
