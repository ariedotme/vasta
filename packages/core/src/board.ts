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
  /** Turned this many degrees clockwise around its middle; left out when upright. */
  rotation?: number
}

/** A line's pattern (left out: solid). */
export const DASHES = ['dashed', 'dotted'] as const
export type Dash = (typeof DASHES)[number]

export const CARD_VIEWS = ['card', 'compact', 'embed', 'properties'] as const
/**
 * How a card shows its object: the card (default), one line, what it holds (a query's live
 * results, a page's text, a picture), or its title with the properties in `fields`.
 */
export type CardView = (typeof CARD_VIEWS)[number]

/** An object of the space, drawn as its card. */
export interface CardElement extends Placed {
  kind: 'card'
  objectId: Id
  view?: CardView
  /** The properties (ids) a "properties" card lists, in order. */
  fields?: string[]
}

/** Free text that lives only on the board. */
export interface TextElement extends Placed {
  kind: 'text'
  text: string
}

export const SHAPES = ['rectangle', 'ellipse', 'diamond', 'triangle', 'parallelogram', 'star', 'heart'] as const
export type ShapeName = (typeof SHAPES)[number]
/** A shape's inside: none, white, or its color solid (left out: a tint of its color). */
export const FILLS = ['none', 'white', 'solid'] as const
export type Fill = (typeof FILLS)[number]

/** A shape that can hold text, centered in it. */
export interface ShapeElement extends Placed {
  kind: 'shape'
  shape: ShapeName
  text: string
  fill?: Fill
  /** The outline's width in board units (left out: the usual one). */
  border?: number
  dash?: Dash
}

export const FONT_SIZES = ['sm', 'lg', 'xl'] as const
/** A note's text size (left out: medium). */
export type FontSize = (typeof FONT_SIZES)[number]

/** A sticky note: a colored square of text. */
export interface StickyElement extends Placed {
  kind: 'sticky'
  text: string
  fontSize?: FontSize
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
  dash?: Dash
  /**
   * Drawn on another element (a card, a frame…): then `x`, `y`, `w` and `h` are fractions of that
   * element's box, so the stroke moves and scales with it, and goes when it goes.
   */
  parent?: Id
}

/** A named region; moving it moves what lies inside. */
export interface FrameElement extends Placed {
  kind: 'frame'
  title?: string
  /** The board's default scene: where it opens, and what its previews show. One frame at most. */
  cover?: boolean
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
  /**
   * Between two cards: the relation property (of the "from" card's object) that this arrow wrote
   * the "to" card's object into, so the link shows in backlinks and queries too.
   */
  relation?: string
  /** Its course: straight (default), a curve, or right angles. */
  path?: ArrowPath
  /** Which ends have a head: the end (default), both, or none (a plain line). */
  heads?: ArrowHeads
  dashed?: boolean
  /** Between two cards: the "to" object was mentioned in the "from" object's text. */
  mentioned?: boolean
  /**
   * What each end has, when set: these win over `heads` (which older devices read, so writing
   * tips writes the nearest `heads` too, see arrowTipsPatch).
   */
  startTip?: ArrowTip
  endTip?: ArrowTip
  /** The side of each element the line leaves from and arrives at (left out: the facing sides). */
  fromSide?: Side
  toSide?: Side
  /** A right-angled line's middle segment, moved this far from halfway (board units). */
  bend?: number
  /** The line's width in board units (left out: the usual one). */
  width?: number
  tipSize?: TipSize
  /** Wins over `dashed` (kept for older devices: a dotted line is dashed there). */
  dash?: Dash
}

export const ARROW_PATHS = ['straight', 'curved', 'elbow'] as const
export type ArrowPath = (typeof ARROW_PATHS)[number]
export const ARROW_HEADS = ['end', 'both', 'none'] as const
export type ArrowHeads = (typeof ARROW_HEADS)[number]
export const ARROW_TIPS = ['arrow', 'dot', 'none'] as const
export type ArrowTip = (typeof ARROW_TIPS)[number]
export const SIDES = ['top', 'right', 'bottom', 'left'] as const
export type Side = (typeof SIDES)[number]
export const TIP_SIZES = ['sm', 'lg'] as const
/** An arrow's tips' size (left out: medium). */
export type TipSize = (typeof TIP_SIZES)[number]

/** What each end of an arrow has: its tips, else what `heads` says. */
export function arrowTips(arrow: Pick<ArrowElement, 'heads' | 'startTip' | 'endTip'>): { start: ArrowTip; end: ArrowTip } {
  const heads = arrow.heads ?? 'end'
  return { start: arrow.startTip ?? (heads === 'both' ? 'arrow' : 'none'), end: arrow.endTip ?? (heads === 'none' ? 'none' : 'arrow') }
}

/** The fields that give an arrow these tips: the tips, and the nearest `heads` for older devices. */
export function arrowTipsPatch(start: ArrowTip, end: ArrowTip): BoardPatch {
  const plain = start !== 'dot' && end !== 'dot'
  const heads: ArrowHeads = start === 'arrow' ? 'both' : end === 'none' ? 'none' : 'end'
  return { startTip: plain ? undefined : start, endTip: plain ? undefined : end, heads: heads === 'end' ? undefined : heads }
}

/** An arrow's or a stroke's pattern: `dash`, else `dashed`. */
export const lineDash = (element: { dash?: Dash; dashed?: boolean }): Dash | undefined => element.dash ?? (element.dashed ? 'dashed' : undefined)

/** The fields that give an arrow this pattern (a dotted one is dashed on older devices). */
export const arrowDashPatch = (dash: Dash | undefined): BoardPatch => ({ dash: dash === 'dotted' ? 'dotted' : undefined, dashed: dash ? true : undefined })

export type PlacedElement = CardElement | TextElement | ShapeElement | StickyElement | StrokeElement | FrameElement
export type BoardElement = PlacedElement | ArrowElement

type Distribute<T> = T extends unknown ? Omit<T, 'id' | 'rank'> & { id?: Id } : never
/** An element to add: its id is made when missing, its rank puts it on top. */
export type NewBoardElement = Distribute<BoardElement>

type UnionKeys<T> = T extends unknown ? keyof T : never
type FieldOf<K extends PropertyKey> = BoardElement extends infer E ? (E extends Record<K, infer V> ? V : E extends Partial<Record<K, infer V>> ? V : never) : never
/** What may change in an element (its kind and id never do); undefined removes an optional field. */
export type BoardPatch = { [K in Exclude<UnionKeys<BoardElement>, 'id' | 'kind'>]?: FieldOf<K> | undefined }

type Shape = 'number' | 'string' | 'optional-string' | 'optional-boolean' | 'optional-number' | 'numbers' | 'optional-strings'
const PLACED: Record<string, Shape> = { rank: 'string', x: 'number', y: 'number', w: 'number', h: 'number', color: 'optional-string', rotation: 'optional-number' }
const FIELDS: Record<BoardElement['kind'], Record<string, Shape>> = {
  card: { ...PLACED, objectId: 'string', view: 'optional-string', fields: 'optional-strings' },
  text: { ...PLACED, text: 'string' },
  shape: { ...PLACED, shape: 'string', text: 'string', fill: 'optional-string', border: 'optional-number', dash: 'optional-string' },
  sticky: { ...PLACED, text: 'string', fontSize: 'optional-string' },
  stroke: { ...PLACED, points: 'numbers', size: 'number', sw: 'number', sh: 'number', highlight: 'optional-boolean', parent: 'optional-string', dash: 'optional-string' },
  frame: { ...PLACED, title: 'optional-string', cover: 'optional-boolean' },
  arrow: {
    rank: 'string', from: 'string', to: 'string', label: 'optional-string', color: 'optional-string', relation: 'optional-string', path: 'optional-string', heads: 'optional-string', dashed: 'optional-boolean', mentioned: 'optional-boolean',
    startTip: 'optional-string', endTip: 'optional-string', fromSide: 'optional-string', toSide: 'optional-string', bend: 'optional-number', width: 'optional-number', tipSize: 'optional-string', dash: 'optional-string',
  },
}

/** Fields whose value must be one of a list; another value (a newer device's) is dropped as if unset. */
const CHOICES: Record<string, readonly string[]> = {
  view: CARD_VIEWS, path: ARROW_PATHS, heads: ARROW_HEADS, fill: FILLS, dash: DASHES, fontSize: FONT_SIZES,
  startTip: ARROW_TIPS, endTip: ARROW_TIPS, fromSide: SIDES, toSide: SIDES, tipSize: TIP_SIZES,
}

const fits = (shape: Shape, value: unknown) => {
  if (shape === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (shape === 'string') return typeof value === 'string'
  if (shape === 'optional-string') return value === undefined || typeof value === 'string'
  if (shape === 'optional-boolean') return value === undefined || typeof value === 'boolean'
  if (shape === 'optional-number') return value === undefined || (typeof value === 'number' && Number.isFinite(value))
  if (shape === 'optional-strings') return value === undefined || (Array.isArray(value) && value.every((v) => typeof v === 'string'))
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
    if (!fits(shape, value)) {
      // A wrong optional field is dropped; a wrong required one drops the element.
      if (shape.startsWith('optional-')) continue
      return undefined
    }
    if (value === undefined) continue
    if (CHOICES[name] && !CHOICES[name].includes(value as string)) continue
    element[name] = value
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
  // A stroke drawn on an element needs it (and the element must not be a stroke itself).
  const holders = new Set(elements.filter((e) => isPlaced(e) && e.kind !== 'stroke').map((e) => e.id))
  const kept = elements.filter((e) => e.kind !== 'stroke' || !e.parent || holders.has(e.parent))
  const placed = new Set(kept.filter(isPlaced).map((e) => e.id))
  return kept.filter((e) => e.kind !== 'arrow' || (placed.has(e.from) && placed.has(e.to) && e.from !== e.to)).sort((a, b) => Number(b.kind === 'frame') - Number(a.kind === 'frame') || byRank(a, b))
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

/** Delete elements, the arrows that start or end at them and the strokes drawn on them. */
export function removeBoardElements(ydoc: Y.Doc, ids: Id[], origin?: unknown) {
  const gone = new Set(ids)
  ydoc.transact(() => {
    const map = boardMap(ydoc)
    for (const [id, entry] of map) {
      const field = (name: string) => (entry instanceof Y.Map ? (entry.get(name) as Id | undefined) : undefined)
      if (gone.has(id) || [field('from'), field('to'), field('parent')].some((other) => other !== undefined && gone.has(other))) map.delete(id)
    }
  }, origin)
}

/** Whether an element is a stroke drawn on another element (its box is in fractions of that one's). */
export const isAttached = (element: BoardElement): element is StrokeElement & { parent: Id } => element.kind === 'stroke' && !!element.parent

/** The strokes drawn on an element. */
export const attachedTo = (id: Id, elements: BoardElement[]) => elements.filter((e): e is StrokeElement => e.kind === 'stroke' && e.parent === id)

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
 * only when both their ends do, strokes drawn on an element only with it (they keep their place
 * on it).
 */
export function copyElements(elements: BoardElement[], dx: number, dy: number, makeId: () => Id = newId): (NewBoardElement & { id: Id })[] {
  const ids = new Map(elements.map((e) => [e.id, makeId()]))
  const copies: (NewBoardElement & { id: Id })[] = []
  for (const { id, rank: _rank, ...element } of elements) {
    if (element.kind === 'arrow') {
      const from = ids.get(element.from)
      const to = ids.get(element.to)
      if (from && to) copies.push({ ...element, id: ids.get(id)!, from, to })
    } else if (element.kind === 'stroke' && element.parent) {
      const parent = ids.get(element.parent)
      if (parent) copies.push({ ...element, id: ids.get(id)!, parent, points: [...element.points] })
    } else copies.push({ ...element, id: ids.get(id)!, x: element.x + dx, y: element.y + dy, ...(element.kind === 'stroke' ? { points: [...element.points] } : {}) })
  }
  return copies
}

/** Make a frame the board's default scene (null: none), clearing the mark on the others. */
export function setCover(ydoc: Y.Doc, frameId: Id | null, origin?: unknown) {
  const patches: Record<Id, BoardPatch> = {}
  for (const element of readBoard(ydoc)) {
    if (element.kind !== 'frame') continue
    const cover = element.id === frameId
    if (!!element.cover !== cover) patches[element.id] = { cover: cover || undefined }
  }
  updateBoardElements(ydoc, patches, origin)
}

/** The board's default scene: the frame marked as such, if any. */
export const coverFrame = (elements: BoardElement[]): FrameElement | undefined => elements.find((e): e is FrameElement => e.kind === 'frame' && !!e.cover)

/** Elements whose box lies wholly inside a frame's (what moves with it). */
export function insideFrame(frame: FrameElement, elements: BoardElement[]): PlacedElement[] {
  return elements.filter(
    (e): e is PlacedElement => isPlaced(e) && !isAttached(e) && e.id !== frame.id && e.x >= frame.x && e.y >= frame.y && e.x + e.w <= frame.x + frame.w && e.y + e.h <= frame.y + frame.h
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
