// Whiteboards: a board is an object whose elements (object cards, text, arrows) live in its Y.Doc,
// in the map BOARD_FIELD, one entry per element id, each a Y.Map of its fields. Two devices moving
// different elements, or changing different fields of one, both keep their change, offline too;
// the same field resolves as Yjs does. Stacking order is a rank key per element (rank.ts), so
// bringing one to the front writes only that one.
//
// The object's `content[BOARD_FIELD]` is derived from the map (boardContent): the board as blocks,
// cards as object embeds and text as paragraphs, so search, backlinks and agents read a board as
// they read a page.
import { BOARD_FIELD, Y, normalizeDoc, readContent, type JsonDoc } from '@vasta/editor-schema/yjs'
import { newId } from './ids.ts'
import type { Doc, DocNode, Id, ObjectRecord } from './model.ts'
import { rankBetween } from './rank.ts'
import { textToBlocks } from './text-doc.ts'

export { BOARD_FIELD }

interface Placed {
  id: Id
  /** Stacking order: higher ranks are drawn on top. */
  rank: string
  x: number
  y: number
  w: number
  h: number
}

/** An object of the space, drawn as its card. */
export interface CardElement extends Placed {
  kind: 'card'
  objectId: Id
}

/** Free text that lives only on the board. */
export interface TextElement extends Placed {
  kind: 'text'
  text: string
}

/** A line from one element to another, drawn from edge to edge; the label is optional. */
export interface ArrowElement {
  id: Id
  rank: string
  kind: 'arrow'
  from: Id
  to: Id
  label?: string
}

export type BoardElement = CardElement | TextElement | ArrowElement
export type PlacedElement = CardElement | TextElement

type Distribute<T> = T extends unknown ? Omit<T, 'id' | 'rank'> & { id?: Id } : never
/** An element to add: its id is made when missing, its rank puts it on top. */
export type NewBoardElement = Distribute<BoardElement>

/** What may change in an element (its kind and id never do). */
export type BoardPatch = Partial<Omit<CardElement, 'id' | 'kind'>> & Partial<Omit<TextElement, 'id' | 'kind'>> & Partial<Omit<ArrowElement, 'id' | 'kind'>>

const FIELDS: Record<BoardElement['kind'], Record<string, 'number' | 'string' | 'optional-string'>> = {
  card: { rank: 'string', x: 'number', y: 'number', w: 'number', h: 'number', objectId: 'string' },
  text: { rank: 'string', x: 'number', y: 'number', w: 'number', h: 'number', text: 'string' },
  arrow: { rank: 'string', from: 'string', to: 'string', label: 'optional-string' },
}

export const isPlaced = (element: BoardElement): element is PlacedElement => element.kind !== 'arrow'

const boardMap = (ydoc: Y.Doc) => ydoc.getMap<Y.Map<unknown>>(BOARD_FIELD)

/** Whether a Y.Doc holds a board (an empty one counts once something was ever added). */
export const hasBoard = (ydoc: Y.Doc) => ydoc.share.has(BOARD_FIELD)

/** One element from its Y.Map; undefined when a field is missing or has the wrong shape (a newer device's kind). */
function readElement(id: Id, entry: unknown): BoardElement | undefined {
  if (!(entry instanceof Y.Map)) return undefined
  const kind = entry.get('kind')
  const fields = FIELDS[kind as BoardElement['kind']]
  if (!fields) return undefined
  const element: Record<string, unknown> = { id, kind }
  for (const [name, shape] of Object.entries(fields)) {
    const value = entry.get(name)
    if (shape === 'number' ? typeof value !== 'number' || !Number.isFinite(value) : shape === 'string' ? typeof value !== 'string' : value !== undefined && typeof value !== 'string') return undefined
    if (value !== undefined) element[name] = value
  }
  return element as unknown as BoardElement
}

const byRank = (a: BoardElement, b: BoardElement) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1)

/**
 * The elements of a board, bottom to top. Arrows whose ends are gone (an element deleted on
 * another device while the arrow was drawn) are left out.
 */
export function readBoard(ydoc: Y.Doc): BoardElement[] {
  if (!hasBoard(ydoc)) return []
  const elements: BoardElement[] = []
  for (const [id, entry] of boardMap(ydoc)) {
    const element = readElement(id, entry)
    if (element) elements.push(element)
  }
  const placed = new Set(elements.filter(isPlaced).map((e) => e.id))
  return elements.filter((e) => e.kind !== 'arrow' || (placed.has(e.from) && placed.has(e.to) && e.from !== e.to)).sort(byRank)
}

const topRank = (ydoc: Y.Doc) => {
  let top: string | undefined
  for (const entry of boardMap(ydoc).values()) {
    const rank = entry instanceof Y.Map ? entry.get('rank') : undefined
    if (typeof rank === 'string' && (top === undefined || rank > top)) top = rank
  }
  return top
}

/** Add elements on top of the board, in the order given; returns their ids. */
export function addBoardElements(ydoc: Y.Doc, elements: NewBoardElement[], origin?: unknown): Id[] {
  const ids: Id[] = []
  ydoc.transact(() => {
    const map = boardMap(ydoc)
    let rank = topRank(ydoc)
    for (const { id = newId(), ...fields } of elements) {
      const entry = new Y.Map<unknown>()
      rank = rankBetween(rank)
      for (const [name, value] of Object.entries({ ...fields, rank })) if (value !== undefined) entry.set(name, value)
      map.set(id, entry)
      ids.push(id)
    }
  }, origin)
  return ids
}

/** Change fields of elements, writing only the ones that differ (so a move does not touch the text). */
export function updateBoardElements(ydoc: Y.Doc, patches: Record<Id, BoardPatch>, origin?: unknown) {
  ydoc.transact(() => {
    const map = boardMap(ydoc)
    for (const [id, patch] of Object.entries(patches)) {
      const entry = map.get(id)
      if (!(entry instanceof Y.Map)) continue
      for (const [name, value] of Object.entries(patch)) {
        if (name === 'id' || name === 'kind') continue
        if (value === undefined) entry.delete(name)
        else if (entry.get(name) !== value) entry.set(name, value)
      }
    }
  }, origin)
}

/** Delete elements, and the arrows that start or end at them. */
export function removeBoardElements(ydoc: Y.Doc, ids: Id[], origin?: unknown) {
  const gone = new Set(ids)
  ydoc.transact(() => {
    const map = boardMap(ydoc)
    for (const [id, entry] of map) {
      const from = entry instanceof Y.Map ? entry.get('from') : undefined
      const to = entry instanceof Y.Map ? entry.get('to') : undefined
      if (gone.has(id) || gone.has(from as Id) || gone.has(to as Id)) map.delete(id)
    }
  }, origin)
}

/** Put elements above all others, keeping their order among themselves. */
export function bringToFront(ydoc: Y.Doc, ids: Id[], origin?: unknown) {
  const elements = readBoard(ydoc).filter((e) => ids.includes(e.id))
  ydoc.transact(() => {
    let rank = topRank(ydoc)
    const patches: Record<Id, BoardPatch> = {}
    for (const element of elements) patches[element.id] = { rank: (rank = rankBetween(rank)) }
    updateBoardElements(ydoc, patches)
  }, origin)
}

/** Reading order of placed elements: top to bottom, then left to right (rows of half a card). */
function readingOrder(elements: PlacedElement[]): PlacedElement[] {
  const row = (e: PlacedElement) => Math.round(e.y / 60)
  return [...elements].sort((a, b) => row(a) - row(b) || a.x - b.x || (a.id < b.id ? -1 : 1))
}

/** The board as blocks, in reading order: cards as object embeds, text as paragraphs, arrow labels last. */
export function boardContent(elements: BoardElement[]): Doc | undefined {
  const content: DocNode[] = []
  for (const element of readingOrder(elements.filter(isPlaced))) {
    if (element.kind === 'card') content.push({ type: 'objectEmbed', attrs: { objectId: element.objectId, display: 'card', blockId: null } })
    else content.push(...textToBlocks(element.text))
  }
  for (const element of elements) if (element.kind === 'arrow' && element.label?.trim()) content.push(...textToBlocks(element.label))
  return content.length ? { type: 'doc', content } : undefined
}

/** An object's rich text read from its Y.Doc: the text fields, and a board's blocks when it has one. */
export function contentOfText(ydoc: Y.Doc): ObjectRecord['content'] {
  const content = readContent(ydoc) as ObjectRecord['content']
  const board = hasBoard(ydoc) ? boardContent(readBoard(ydoc)) : undefined
  // As the editor would save it, so comparing it with a stored copy finds no change.
  if (board) content[BOARD_FIELD] = normalizeDoc(board as JsonDoc) as Doc
  return content
}
