import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Y } from '@vasta/editor-schema/yjs'
import {
  BOARD_FIELD,
  addBoardElements,
  boardContent,
  bringToFront,
  contentOfText,
  readBoard,
  removeBoardElements,
  updateBoardElements,
} from '../src/board.ts'
import { builtinTypeId, createBuiltinTypes } from '../src/builtin-types.ts'
import { docReferences } from '../src/doc.ts'
import type { ObjectRecord } from '../src/model.ts'
import { Store } from '../src/store.ts'

const card = (objectId: string, x = 0, y = 0) => ({ kind: 'card' as const, objectId, x, y, w: 240, h: 120 })

/** Two devices that start from the same board and exchange their updates only later. */
function twoDevices(setup: (doc: Y.Doc) => void) {
  const a = new Y.Doc()
  setup(a)
  const b = new Y.Doc()
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  const sync = () => {
    const fromA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b))
    const fromB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a))
    Y.applyUpdate(b, fromA)
    Y.applyUpdate(a, fromB)
  }
  return { a, b, sync }
}

describe('board elements', () => {
  it('adds elements on top, in order, and reads them back bottom to top', () => {
    const doc = new Y.Doc()
    const [first, second] = addBoardElements(doc, [card('o1'), { kind: 'text', text: 'Hello', x: 10, y: 20, w: 200, h: 40 }])
    const [third] = addBoardElements(doc, [card('o2', 300)])
    expect(readBoard(doc).map((e) => e.id)).toEqual([first, second, third])
    expect(readBoard(doc)[1]).toMatchObject({ kind: 'text', text: 'Hello', x: 10, y: 20 })
  })

  it('brings elements to the front and keeps their order among themselves', () => {
    const doc = new Y.Doc()
    const [a, b, c] = addBoardElements(doc, [card('o1'), card('o2'), card('o3')])
    bringToFront(doc, [b!, a!])
    expect(readBoard(doc).map((e) => e.id)).toEqual([c, a, b])
  })

  it('deletes the arrows of a deleted element, and hides arrows whose end is gone', () => {
    const doc = new Y.Doc()
    const [a, b, c] = addBoardElements(doc, [card('o1'), card('o2'), card('o3')])
    addBoardElements(doc, [{ kind: 'arrow', from: a!, to: b! }, { kind: 'arrow', from: b!, to: c! }])
    removeBoardElements(doc, [a!])
    expect(readBoard(doc).filter((e) => e.kind === 'arrow')).toHaveLength(1)
    // An arrow drawn to an element another device deleted meanwhile.
    doc.getMap<Y.Map<unknown>>(BOARD_FIELD).get(c!)!.delete('x')
    expect(readBoard(doc).filter((e) => e.kind === 'arrow')).toHaveLength(0)
  })

  it('skips elements of kinds it does not know (a newer device)', () => {
    const doc = new Y.Doc()
    addBoardElements(doc, [card('o1')])
    const future = new Y.Map<unknown>()
    future.set('kind', 'hologram')
    future.set('rank', 'z')
    doc.getMap(BOARD_FIELD).set('x', future)
    expect(readBoard(doc).map((e) => e.kind)).toEqual(['card'])
  })
})

describe('board merges', () => {
  it('keeps two devices’ offline moves of different elements, and of different fields of one', () => {
    let ids: string[] = []
    const { a, b, sync } = twoDevices((doc) => (ids = addBoardElements(doc, [card('o1'), { kind: 'text', text: 'Note', x: 0, y: 200, w: 200, h: 40 }])))
    updateBoardElements(a, { [ids[0]!]: { x: 500 } })
    updateBoardElements(b, { [ids[0]!]: { w: 320 }, [ids[1]!]: { text: 'Note, edited' } })
    addBoardElements(b, [card('o2', 900)])
    sync()
    expect(readBoard(a)).toEqual(readBoard(b))
    const [first, text] = readBoard(a)
    expect(first).toMatchObject({ x: 500, w: 320 })
    expect(text).toMatchObject({ text: 'Note, edited' })
    expect(readBoard(a)).toHaveLength(3)
  })

  it('drops an element deleted on one device even when the other moved it', () => {
    let ids: string[] = []
    const { a, b, sync } = twoDevices((doc) => (ids = addBoardElements(doc, [card('o1'), card('o2')])))
    removeBoardElements(a, [ids[0]!])
    updateBoardElements(b, { [ids[0]!]: { x: 50 } })
    sync()
    expect(readBoard(a).map((e) => e.id)).toEqual([ids[1]])
    expect(readBoard(b).map((e) => e.id)).toEqual([ids[1]])
  })
})

describe('board content', () => {
  it('lists cards as embeds and text as paragraphs, in reading order', () => {
    const doc = new Y.Doc()
    const [left, right] = addBoardElements(doc, [card('o-right', 600, 0), card('o-left', 0, 10)])
    addBoardElements(doc, [{ kind: 'text', text: 'Below', x: 0, y: 400, w: 200, h: 40 }, { kind: 'arrow', from: left!, to: right!, label: 'leads to' }])
    const content = boardContent(readBoard(doc))!
    expect(content.content.map((n) => n.type)).toEqual(['objectEmbed', 'objectEmbed', 'paragraph', 'paragraph'])
    expect(docReferences(content).map((r) => r.objectId)).toEqual(['o-left', 'o-right'])
  })

  it('is part of the object’s content, beside its text fields, and never a text field itself', () => {
    const doc = new Y.Doc()
    expect(contentOfText(doc)).toEqual({})
    addBoardElements(doc, [card('o1')])
    expect(Object.keys(contentOfText(doc))).toEqual([BOARD_FIELD])
  })
})

describe('boards in the store', () => {
  const setup = () => {
    const store = new Store(new DatabaseSync(':memory:'))
    const now = '2026-11-05T12:00:00.000Z'
    store.putSpace({ id: 's', name: 'Space', sidebar: [], createdAt: now })
    for (const type of createBuiltinTypes('s', now)) store.putType(type)
    const object = (id: string, title: string, system: 'page' | 'whiteboard'): ObjectRecord => ({ id, spaceId: 's', typeId: builtinTypeId('s', system), title, aliases: [], props: {}, content: {}, tagIds: [], collectionIds: [], createdAt: now, updatedAt: now })
    const page = store.putObject(object('p', 'A page', 'page'))
    const board = store.putObject(object('b', 'Plan', 'whiteboard'))
    return { store, now, page, board }
  }

  it('derives the board’s content from its document, so cards link to their objects', () => {
    const { store, now, board } = setup()
    const doc = store.loadText('b') ?? new Y.Doc()
    addBoardElements(doc, [card('p'), { kind: 'text', text: 'Quarterly plan', x: 0, y: 300, w: 200, h: 40 }])
    store.putObject({ ...board, updatedAt: now }, undefined, doc)
    const saved = store.getObject('b')!
    expect(docReferences(saved.content[BOARD_FIELD]!).map((r) => r.objectId)).toEqual(['p'])
    expect(store.backlinks('p').map((l) => l.object.id)).toContain('b')
    expect(store.search('s', 'quarterly').map((r) => r.id)).toContain('b')
  })

  it('keeps the board when the object changes without its text (a rename)', () => {
    const { store, now, board } = setup()
    const doc = new Y.Doc()
    const [id] = addBoardElements(doc, [card('p')])
    store.putObject({ ...board, updatedAt: now }, undefined, doc)
    const stored = store.getObject('b')!
    store.putObject({ ...stored, title: 'Renamed', updatedAt: now })
    store.putObject({ ...stored, title: 'Renamed', content: {}, updatedAt: now })
    expect(readBoard(store.loadText('b')!).map((e) => e.id)).toEqual([id])
    expect(store.getObject('b')!.content[BOARD_FIELD]).toBeDefined()
  })
})
