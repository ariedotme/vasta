import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Y } from '@vasta/editor-schema/yjs'
import {
  BOARD_FIELD,
  addBoardElements,
  boardContent,
  bringToFront,
  copyElements,
  insideFrame,
  sendToBack,
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

describe('drawing elements', () => {
  const stroke = { kind: 'stroke' as const, points: [0, 0, 0.5, 10, 10, 0.5], size: 4, sw: 10, sh: 10, x: 5, y: 5, w: 10, h: 10 }

  it('reads shapes, notes, strokes and frames back, frames under everything', () => {
    const doc = new Y.Doc()
    addBoardElements(doc, [
      { kind: 'shape', shape: 'diamond', text: 'Decide', x: 0, y: 0, w: 120, h: 80, color: 'blue' },
      { kind: 'sticky', text: 'Remember', x: 200, y: 0, w: 160, h: 160 },
      stroke,
    ])
    const [frameId] = addBoardElements(doc, [{ kind: 'frame', title: 'Week', x: -20, y: -20, w: 600, h: 400 }])
    const read = readBoard(doc)
    expect(read.map((e) => e.kind)).toEqual(['frame', 'shape', 'sticky', 'stroke'])
    expect(read[0]!.id).toBe(frameId)
    expect(read[1]).toMatchObject({ shape: 'diamond', color: 'blue' })
    expect(read[3]).toMatchObject({ points: stroke.points, size: 4 })
  })

  it('takes an unknown shape as a rectangle, and drops a stroke with bad points', () => {
    const doc = new Y.Doc()
    const [shape, bad] = addBoardElements(doc, [
      { kind: 'shape', shape: 'rectangle', text: '', x: 0, y: 0, w: 10, h: 10 },
      { ...stroke, points: [1, 2] },
    ])
    doc.getMap<Y.Map<unknown>>(BOARD_FIELD).get(shape!)!.set('shape', 'hexagon')
    doc.getMap<Y.Map<unknown>>(BOARD_FIELD).get(bad!)!.set('points', ['x'])
    expect(readBoard(doc).map((e) => [e.kind, 'shape' in e ? e.shape : undefined])).toEqual([['shape', 'rectangle']])
  })

  it('sends elements to the back, keeping their order', () => {
    const doc = new Y.Doc()
    const [a, b, c] = addBoardElements(doc, [card('o1'), card('o2'), card('o3')])
    sendToBack(doc, [c!, b!])
    expect(readBoard(doc).map((e) => e.id)).toEqual([b, c, a])
  })

  it('copies elements with new ids, and arrows only with both ends', () => {
    const doc = new Y.Doc()
    const [a, b, c] = addBoardElements(doc, [card('o1'), card('o2', 300), card('o3', 600)])
    addBoardElements(doc, [{ kind: 'arrow', from: a!, to: b! }, { kind: 'arrow', from: b!, to: c! }])
    const chosen = readBoard(doc).filter((e) => e.id !== c)
    let n = 0
    const copies = copyElements(chosen, 24, 24, () => `copy-${++n}`)
    expect(copies.map((e) => e.kind)).toEqual(['card', 'card', 'arrow'])
    expect(copies[0]).toMatchObject({ id: 'copy-1', x: 24, y: 24 })
    expect(copies[2]).toMatchObject({ from: 'copy-1', to: 'copy-2' })
  })

  it('finds what lies wholly inside a frame', () => {
    const doc = new Y.Doc()
    const [frame] = addBoardElements(doc, [{ kind: 'frame', x: 0, y: 0, w: 500, h: 500 }])
    const [inside] = addBoardElements(doc, [card('o1', 10, 10), card('o2', 400, 10)])
    const read = readBoard(doc)
    const f = read.find((e) => e.id === frame)!
    expect(insideFrame(f as never, read).map((e) => e.id)).toEqual([inside])
  })

  it('lists a frame as a heading followed by what is in it, and leaves strokes out', () => {
    const doc = new Y.Doc()
    addBoardElements(doc, [
      { kind: 'sticky', text: 'Outside', x: 0, y: 0, w: 100, h: 100 },
      { kind: 'frame', title: 'Ideas', x: 0, y: 500, w: 600, h: 400 },
      { kind: 'shape', shape: 'ellipse', text: 'Inside', x: 20, y: 520, w: 100, h: 60 },
      { ...stroke, x: 30, y: 600 },
    ])
    const content = boardContent(readBoard(doc))!
    expect(content.content.map((n) => (n.type === 'heading' ? `# ${n.content![0]!.text}` : n.content![0]!.text))).toEqual(['# Ideas', 'Inside', 'Outside'])
  })
})

describe('card views and linked arrows', () => {
  it('keeps a card’s view and an arrow’s relation, and drops a view it does not know', () => {
    const doc = new Y.Doc()
    const [a, b] = addBoardElements(doc, [{ ...card('o1'), view: 'embed' }, card('o2', 400)])
    const [arrow] = addBoardElements(doc, [{ kind: 'arrow', from: a!, to: b!, relation: 'author' }])
    doc.getMap<Y.Map<unknown>>(BOARD_FIELD).get(b!)!.set('view', 'hologram')
    const read = readBoard(doc)
    expect(read.find((e) => e.id === a)).toMatchObject({ view: 'embed' })
    expect(read.find((e) => e.id === b)).not.toHaveProperty('view')
    expect(read.find((e) => e.id === arrow)).toMatchObject({ relation: 'author' })
    const [styled] = addBoardElements(doc, [{ kind: 'arrow', from: a!, to: b!, path: 'curved', heads: 'both', dashed: true, mentioned: true }])
    expect(readBoard(doc).find((e) => e.id === styled)).toMatchObject({ path: 'curved', heads: 'both', dashed: true, mentioned: true })
    doc.getMap<Y.Map<unknown>>(BOARD_FIELD).get(styled!)!.set('path', 'zigzag')
    expect(readBoard(doc).find((e) => e.id === styled)).not.toHaveProperty('path')
  })
})

describe('strokes drawn on an element', () => {
  const onCard = (parent: string) => ({ kind: 'stroke' as const, parent, points: [0, 0, 0.5, 10, 10, 0.5], size: 2, sw: 10, sh: 10, x: 0.1, y: 0.1, w: 0.5, h: 0.5 })

  it('go with the element, and are dropped when it is gone elsewhere', () => {
    const doc = new Y.Doc()
    const [a, b] = addBoardElements(doc, [card('o1'), card('o2', 400)])
    addBoardElements(doc, [onCard(a!), onCard(b!)])
    removeBoardElements(doc, [a!])
    expect(readBoard(doc).filter((e) => e.kind === 'stroke').map((e) => (e as { parent: string }).parent)).toEqual([b])
    // Deleted on another device while this one drew on it.
    doc.getMap<Y.Map<unknown>>(BOARD_FIELD).get(b!)!.delete('objectId')
    expect(readBoard(doc).filter((e) => e.kind === 'stroke')).toHaveLength(0)
  })

  it('are copied only with their element, onto the copy', () => {
    const doc = new Y.Doc()
    const [a] = addBoardElements(doc, [card('o1')])
    addBoardElements(doc, [onCard(a!)])
    const all = readBoard(doc)
    let n = 0
    const copies = copyElements(all, 24, 24, () => `c${++n}`)
    expect(copies[1]).toMatchObject({ kind: 'stroke', parent: 'c1', x: 0.1 })
    expect(copyElements(all.filter((e) => e.kind === 'stroke'), 24, 24)).toEqual([])
  })

  it('do not count as lying inside a frame (they go with their element)', () => {
    const doc = new Y.Doc()
    const [frame, a] = addBoardElements(doc, [{ kind: 'frame', x: 0, y: 0, w: 1000, h: 1000 }, card('o1', 10, 10)])
    addBoardElements(doc, [onCard(a!)])
    const read = readBoard(doc)
    expect(insideFrame(read.find((e) => e.id === frame) as never, read).map((e) => e.kind)).toEqual(['card'])
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
