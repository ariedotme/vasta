import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { addBoardElements, builtinTypeId, createBuiltinTypes, newType, type ObjectRecord, type ObjectType } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { Y, readContent, writeContent } from '@vasta/editor-schema/yjs'
import { createApp } from '../src/app.ts'
import type { ExportJson } from '../src/export.ts'
import { importRows } from '../src/transfer.ts'
import { asUser, paragraphs } from './helpers.ts'

const AT = '2026-11-05T12:00:00.000Z'

async function setup() {
  const store = new NodeStore(':memory:')
  for (const [id, name] of [['s', 'Notes'], ['x', 'Not mine']] as const) {
    store.putSpace({ id, name, sidebar: [], createdAt: AT })
    for (const type of createBuiltinTypes(id, AT)) store.putType(type)
  }
  const book: ObjectType = {
    ...newType('s', { name: 'Book', pluralName: 'Books' }, 'book', AT),
    properties: [
      { id: 'body', kind: 'rich-text', name: 'Notes' },
      { id: 'author', kind: 'relation', name: 'Author', targetTypeIds: [], multiple: false },
      { id: 'genre', kind: 'select', name: 'Genre', multiple: false, options: [{ id: 'g1', label: 'Sci-fi' }] },
      { id: 'rating', kind: 'number', name: 'Rating' },
      { id: 'title2', kind: 'text', name: 'Title' },
    ],
  }
  store.putType(book)
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-export-')))
  const app = createApp({ store, media, now: () => AT })
  const me = asUser(app, store, { username: 'arie', spaces: ['s'] })
  const object = (id: string, title: string, typeId: string, extra: Partial<ObjectRecord> = {}): ObjectRecord => ({
    id, spaceId: 's', typeId, title, aliases: [], props: {}, content: {}, tagIds: [], collectionIds: [], createdAt: AT, updatedAt: AT, ...extra,
  })
  return { store, media, app, me, book, object }
}

describe('space export', () => {
  it('writes Markdown with front matter and relative links, the media, a canvas per board, and vasta.json', async () => {
    const { store, media, me, book, object } = await setup()
    const photo = await media.put(new Uint8Array([137, 80, 78, 71]), 'cover photo.png')
    store.putObject(object('img', 'Cover photo', builtinTypeId('s', 'image'), { media: { file: { key: photo.key, name: 'cover photo.png', sizeBytes: 4 } } }))
    store.putObject(object('tag', 'sci fi', builtinTypeId('s', 'tag')))
    store.putObject(object('herbert', 'Frank Herbert', builtinTypeId('s', 'page')))
    store.putObject(
      object('dune', 'Dune: a novel', book.id, {
        tagIds: ['tag'],
        props: { author: { kind: 'relation', value: ['herbert'] }, genre: { kind: 'select', value: ['g1'] }, rating: { kind: 'number', value: 5 }, title2: { kind: 'text', value: 'Duna' } },
        content: {
          body: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'By ' }, { type: 'mention', attrs: { objectId: 'herbert', label: 'Frank Herbert' } }] },
              { type: 'objectEmbed', attrs: { objectId: 'img', display: 'image' } },
              { type: 'paragraph', content: [{ type: 'text', text: 'See ' }, { type: 'mention', attrs: { objectId: 'gone', label: 'In the trash' } }] },
            ],
          },
        },
      })
    )
    store.putObject(object('day', '', builtinTypeId('s', 'daily-note'), { date: { start: '2026-11-04T00:00:00.000Z', resolution: 'day' }, content: { body: paragraphs('Read Dune') as never } }))
    store.putObject(object('gone', 'In the trash', builtinTypeId('s', 'page'), { deletedAt: AT }))
    store.putObject(object('same', 'Frank Herbert', builtinTypeId('s', 'page')))
    const board = object('board', 'Reading plan', builtinTypeId('s', 'whiteboard'))
    const ydoc = new Y.Doc()
    addBoardElements(ydoc, [{ kind: 'card', objectId: 'dune', x: 0, y: 0, w: 200, h: 100 }, { kind: 'sticky', text: 'Next: Messiah', x: 300, y: 0, w: 150, h: 150 }])
    store.putObject(board, undefined, ydoc)
    // Another space's object never shows.
    store.putObject({ ...object('other', 'Secret', builtinTypeId('x', 'page')), spaceId: 'x' })

    const response = await me.request('/api/spaces/s/export')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''Notes%202026-11-05.zip")
    const zip = unzipSync(new Uint8Array(await response.arrayBuffer()))
    const names = Object.keys(zip).sort()
    expect(names).toEqual(
      [
        'Books/Dune- a novel.md',
        'Daily notes/2026-11-04.md',
        'Images/Cover photo.md',
        'Pages/Frank Herbert (2).md',
        'Pages/Frank Herbert.md',
        'README.md',
        'Tags/sci fi.md',
        'Whiteboards/Reading plan.canvas',
        'Whiteboards/Reading plan.md',
        `media/${photo.key}`,
        'vasta.json',
      ].sort()
    )
    expect([...zip[`media/${photo.key}`]!]).toEqual([137, 80, 78, 71])

    const dune = strFromU8(zip['Books/Dune- a novel.md']!)
    expect(dune).toContain('id: "dune"')
    expect(dune).toContain('title: "Dune: a novel"')
    expect(dune).toContain('tags: ["sci-fi"]')
    expect(dune).toContain('Author: "[[Frank Herbert]]"')
    expect(dune).toContain('Genre: "Sci-fi"')
    expect(dune).toContain('Rating: 5')
    expect(dune).toContain('"Title (property)": "Duna"')
    expect(dune).toContain('By [@Frank Herbert](../Pages/Frank%20Herbert.md)')
    expect(dune).toContain(`![Cover photo](../media/${photo.key})`)
    expect(dune).toContain('See @In the trash')
    expect(dune).not.toContain('vasta://')
    expect(strFromU8(zip['Images/Cover photo.md']!)).toContain(`![cover photo.png](../media/${photo.key})`)
    expect(strFromU8(zip['Daily notes/2026-11-04.md']!)).toContain('Read Dune')
    expect(strFromU8(zip['Whiteboards/Reading plan.md']!)).toContain('[Open the board](Reading%20plan.canvas)')
    const canvas = JSON.parse(strFromU8(zip['Whiteboards/Reading plan.canvas']!))
    expect(canvas.nodes.map((n: { text: string }) => n.text)).toEqual(['[Dune: a novel](Books/Dune- a novel.md)', 'Next: Messiah'])

    const json = JSON.parse(strFromU8(zip['vasta.json']!)) as ExportJson
    expect(json).toMatchObject({ format: 'vasta-export', version: 1, space: { id: 's', name: 'Notes' } })
    expect(json.rows.filter((r) => r.table === 'objects').map((r) => r.id).sort()).toEqual(['board', 'day', 'dune', 'gone', 'herbert', 'img', 'same', 'tag'])
    expect(json.rows.some((r) => r.table === 'types' && r.id === book.id)).toBe(true)
    expect(Object.keys(json.texts)).toEqual(expect.arrayContaining(['board', 'day', 'dune']))
  })

  it('reads back into another server from vasta.json: the rows, the text and the board', async () => {
    const { store, me, object } = await setup()
    store.putObject(object('p', 'Plan', builtinTypeId('s', 'page'), { content: { body: paragraphs('First', 'Second') as never } }))
    const ydoc = new Y.Doc()
    addBoardElements(ydoc, [{ kind: 'sticky', text: 'Hi', x: 0, y: 0, w: 100, h: 100 }])
    store.putObject(object('b', 'Board', builtinTypeId('s', 'whiteboard')), undefined, ydoc)
    const zip = unzipSync(new Uint8Array(await (await me.request('/api/spaces/s/export?media=0')).arrayBuffer()))
    const json = JSON.parse(strFromU8(zip['vasta.json']!)) as ExportJson

    const there = new NodeStore(':memory:')
    there.putUser({ id: 'u', username: 'u', name: 'U', createdAt: AT }, 'x')
    importRows(there, 'u', { rows: json.rows, texts: json.texts }, AT)
    expect(there.getSpace('s')?.name).toBe('Notes')
    expect(readContent(there.loadText('p')!).body!.content.length).toBe(2)
    expect(there.getObject('b')!.content.whiteboard).toBeDefined()
    // Text written later merges onto the imported document.
    const copy = there.loadText('p')!
    writeContent(copy, { body: paragraphs('First', 'Second', 'Third') }, undefined, ['body'])
    expect(readContent(copy).body!.content.length).toBe(3)
  })

  it('is only for members of the space', async () => {
    const { me } = await setup()
    expect((await me.request('/api/spaces/x/export')).status).toBe(404)
  })
})
