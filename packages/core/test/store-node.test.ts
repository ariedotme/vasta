import { describe, expect, it } from 'vitest'
import { createBuiltinTypes, builtinTypeId, type ObjectRecord } from '../src/index.ts'
import { NodeStore } from '../src/store-node.ts'

const at = '2026-01-01T00:00:00.000Z'

const page = (id: string, title: string, extra: Partial<ObjectRecord> = {}): ObjectRecord => ({
  id,
  spaceId: 's',
  typeId: builtinTypeId('s', 'page'),
  title,
  aliases: [],
  tagIds: [],
  collectionIds: [],
  props: {},
  content: {},
  createdAt: at,
  updatedAt: at,
  ...extra,
})

describe('NodeStore', () => {
  it('indexes backlinks and full-text search when objects are written', () => {
    const store = new NodeStore(':memory:')
    store.putSpace({ id: 's', name: 'Space', sidebar: [], createdAt: at })
    for (const type of createBuiltinTypes('s', at)) store.putType(type)
    store.putObject(page('a', 'Coffee'))
    store.putObject(
      page('b', 'Morning routine', {
        tagIds: ['a'],
        content: {
          body: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Brew ' }, { type: 'mention', attrs: { objectId: 'a', label: 'Coffee' } }] },
              { type: 'objectEmbed', attrs: { objectId: 'a', display: 'card' } },
            ],
          },
        },
      })
    )

    const backlinks = store.db.prepare('SELECT from_id, kind FROM links WHERE to_id = ? ORDER BY kind').all('a')
    expect(backlinks).toEqual([
      { from_id: 'b', kind: 'embed' },
      { from_id: 'b', kind: 'mention' },
      { from_id: 'b', kind: 'tag' },
    ])
    const hits = store.db.prepare("SELECT object_id FROM objects_fts WHERE objects_fts MATCH 'brew'").all()
    expect(hits).toEqual([{ object_id: 'b' }])
    expect(store.counts()).toMatchObject({ objects: 2, links: 3 })
    store.close()
  })
})
