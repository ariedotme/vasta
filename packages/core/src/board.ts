// Whiteboards: a board is an object whose elements (object cards, text, shapes, sticky notes,
// pen strokes, frames, arrows) live in its Y.Doc,
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
import type { ColorName, Doc, DocNode, Id, ObjectRecord } from './model.ts'
import { rankBetween } from './rank.ts'
import { textToBlocks } from './text-doc.ts'

export { BOARD_FIELD }

interface Placed {
  id: Id
  /** Stacking order: higher ranks are drawn on top (frames are always drawn under the rest). */
  rank: string
  x: number
  y: number
  w: number
  h: number
  /** Left out: the kind's own color (ink, a yellow note). */
  color?: ColorName
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

export const SHAPES = ['rectangle', 'ellipse', 'diamond', 'triangle', 'parallelogram', 'star', 'heart'] as const
export type ShapeName = (typeof SHAPES)[number]

/** A shape that can hold text, centered in it. */
export interface ShapeElement extends Placed {
  kind: 'shape'
  shape: ShapeName
  text: string
}

/** A sticky note: a colored square of text. */
export interface StickyElement extends Placed {
  kind: 'sticky'
  text: string
}

/**
 * A pen stroke. `points` are x, y and pressure (0–1) in turn, relative to the element's corner,
 * already simplified; `size` is the pen's width in board units. Resizing scales the points with
 * the box (the stored points fill `w` × `h` as they were drawn: `sw`, `sh`).
 */
export interface StrokeElement extends Placed {
  kind: 'stroke'
  points: number[]
  size: number
  /** The box the points were drawn in, so a resized stroke scales them. */
  sw: number
  sh: number
  /** A highlighter: drawn wide and see-through. */
  highlight?: boolean
}

/** A named region; moving it moves what lies inside. */
export interface FrameElement extends Placed {
  kind: 'frame'
  title?: string
}

/** A line from one element to another, drawn from edge to edge; the label is optional. */
export interface ArrowElement {
  id: Id
  rank: string
  kind: 'arrow'
  from: Id
  to: Id
  label?: string
  color?: ColorName
}

export type PlacedElement = CardElement | TextElement | ShapeElement | StickyElement | StrokeElement | FrameElement
export type BoardElement = PlacedElement | ArrowElement

type Distribute<T> = T extends unknown ? Omit<T, 'id' | 'rank'> & { id?: Id } : never
/** An element to add: its id is made when missing, its rank puts it on top. */
export type NewBoardElement = Distribute<BoardElement>

type UnionKeys<T> = T extends unknown ? keyof T : never
type FieldOf<K extends PropertyKey> = BoardElement extends infer E ? (E extends Record<K, infer V> ? V : E extends Partial<Record<K, infer V>> ? V : never) : never
/** What may change in an element (its kind and id never do); undefined removes an optional field. */
export type BoardPatch = { [K in Exclude<UnionKeys<BoardElement>, 'id' | 'kind'>]?: FieldOf<K> | undefined }

type Shape = 'number' | 'string' | 'optional-string' | 'optional-boolean' | 'numbers'
const PLACED: Record<string, Shape> = { rank: 'string', x: 'number', y: 'number', w: 'number', h: 'number', color: 'optional-string' }
const FIELDS: Record<BoardElement['kind'], Record<string, Shape>> = {
  card: { ...PLACED, objectId: 'string' },
  text: { ...PLACED, text: 'string' },
  shape: { ...PLACED, shape: 'string', text: 'string' },
  sticky: { ...PLACED, text: 'string' },
  stroke: { ...PLACED, points: 'numbers', size: 'number', sw: 'number', sh: 'number', highlight: 'optional-boolean' },
  frame: { ...PLACED, title: 'optional-string' },
  arrow: { rank: 'string', from: 'string', to: 'string', label: 'optional-string', color: 'optional-string' },
}

const fits = (shape: Shape, value: unknown) => {
  if (shape === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (shape === 'string') return typeof value === 'string'
  if (shape === 'optional-string') return value === undefined || typeof value === 'string'
  if (shape === 'optional-boolean') return value === undefined || typeof value === 'boolean'
  return Array.isArray(value) && value.every((n) => typeof n === 'number' && Number.isFinite(n))
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
    if (!fits(shape, value)) return undefined
    if (value !== undefined) element[name] = value
  }
  if (element.kind === 'shape' && !SHAPES.includes(element.shape as ShapeName)) element.shape = 'rectangle'
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
  return elements.filter((e) => e.kind !== 'arrow' || (placed.has(e.from) && placed.has(e.to) && e.from !== e.to)).sort((a, b) => Number(b.kind === 'frame') - Number(a.kind === 'frame') || byRank(a, b))
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

/** Put elements under all others, keeping their order among themselves. */
export function sendToBack(ydoc: Y.Doc, ids: Id[], origin?: unknown) {
  const all = readBoard(ydoc)
  const elements = all.filter((e) => ids.includes(e.id))
  let bottom = all.find((e) => !ids.includes(e.id))?.rank
  ydoc.transact(() => {
    const patches: Record<Id, BoardPatch> = {}
    for (const element of [...elements].reverse()) patches[element.id] = { rank: (bottom = rankBetween(undefined, bottom)) }
    updateBoardElements(ydoc, patches)
  }, origin)
}

/**
 * Copies of elements, for pasting or duplicating: new ids, moved by (dx, dy). Arrows come along
 * only when both their ends do.
 */
export function copyElements(elements: BoardElement[], dx: number, dy: number, makeId: () => Id = newId): (NewBoardElement & { id: Id })[] {
  const ids = new Map(elements.map((e) => [e.id, makeId()]))
  const copies: (NewBoardElement & { id: Id })[] = []
  for (const { id, rank: _rank, ...element } of elements) {
    if (element.kind === 'arrow') {
      const from = ids.get(element.from)
      const to = ids.get(element.to)
      if (from && to) copies.push({ ...element, id: ids.get(id)!, from, to })
    } else copies.push({ ...element, id: ids.get(id)!, x: element.x + dx, y: element.y + dy, ...(element.kind === 'stroke' ? { points: [...element.points] } : {}) })
  }
  return copies
}

/** Elements whose box lies wholly inside a frame's (what moves with it). */
export function insideFrame(frame: FrameElement, elements: BoardElement[]): PlacedElement[] {
  return elements.filter(
    (e): e is PlacedElement => isPlaced(e) && e.id !== frame.id && e.x >= frame.x && e.y >= frame.y && e.x + e.w <= frame.x + frame.w && e.y + e.h <= frame.y + frame.h
  )
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

/**
 * The board as blocks, in reading order: each frame's title as a heading followed by what is in
 * it, then what is outside frames; cards as object embeds, text of text, shapes and notes as
 * paragraphs (strokes have none), arrow labels last.
 */
export function boardContent(elements: BoardElement[]): Doc | undefined {
  const content: DocNode[] = []
  const placed = elements.filter(isPlaced)
  const frames = readingOrder(placed.filter((e) => e.kind === 'frame'))
  const listed = new Set<Id>()
  const blocks = (list: PlacedElement[]) => {
    for (const element of readingOrder(list)) {
      if (listed.has(element.id) || element.kind === 'frame' || element.kind === 'stroke') continue
      listed.add(element.id)
      if (element.kind === 'card') content.push({ type: 'objectEmbed', attrs: { objectId: element.objectId, display: 'card', blockId: null } })
      else content.push(...textToBlocks(element.text))
    }
  }
  for (const frame of frames) {
    if (frame.kind !== 'frame') continue
    if (frame.title?.trim()) content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: frame.title.trim() }] })
    blocks(insideFrame(frame, placed))
  }
  blocks(placed)
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
