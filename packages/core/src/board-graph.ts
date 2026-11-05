// A whiteboard as nodes and edges, for what lives outside the canvas: agents reading and editing a
// board (server agent.ts), JSON Canvas files (the open format Obsidian uses, jsoncanvas.org), and
// Mermaid flowcharts turned into boards. Positions an outsider leaves out are laid out here.
import { SHAPES, isAttached, isPlaced, type BoardElement, type NewBoardElement, type PlacedElement, type ShapeName } from './board.ts'
import { COLOR_NAMES } from './tags.ts'
import type { ColorName, Id } from './model.ts'

// Laying out ---------------------------------------------------------------------------------------

export const NODE_SIZE = { w: 220, h: 100 }
const GAP = { x: 80, y: 60 }

/** The box around placed elements (strokes drawn on another element left out). */
export function boardBounds(elements: BoardElement[]) {
  const placed = elements.filter((e): e is PlacedElement => isPlaced(e) && !isAttached(e))
  if (!placed.length) return undefined
  const left = Math.min(...placed.map((e) => e.x))
  const top = Math.min(...placed.map((e) => e.y))
  return { x: left, y: top, right: Math.max(...placed.map((e) => e.x + e.w)), bottom: Math.max(...placed.map((e) => e.y + e.h)) }
}

/** Where new content goes: to the right of what the board has, lined up with its top (the origin on an empty board). */
export function spotAfter(elements: BoardElement[]) {
  const box = boardBounds(elements)
  return box ? { x: Math.round(box.right + 160), y: Math.round(box.y) } : { x: 0, y: 0 }
}

/** Boxes in a grid of about square proportions, from a corner. */
export function gridBoxes(sizes: { w: number; h: number }[], at: { x: number; y: number }) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(sizes.length)))
  const boxes: { x: number; y: number }[] = []
  let y = at.y
  for (let row = 0; row * columns < sizes.length; row++) {
    const items = sizes.slice(row * columns, row * columns + columns)
    let x = at.x
    for (const size of items) {
      boxes.push({ x, y })
      x += size.w + GAP.x
    }
    y += Math.max(...items.map((s) => s.h)) + GAP.y
  }
  return boxes
}

export type Direction = 'down' | 'right' | 'up' | 'left'

/**
 * Layers for a directed graph: each node one layer past the furthest node pointing at it (cycles
 * broken where they close), nodes in a layer in the order they first appeared. Returns each node's
 * corner, from (0, 0), flowing in `direction`.
 */
export function layeredLayout(ids: string[], edges: { from: string; to: string }[], direction: Direction = 'down', size = NODE_SIZE) {
  // Edges that close a cycle (found walking from the nodes in their order) are left out.
  const out = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const { from, to } of edges) if (out.has(from) && out.has(to) && from !== to) out.get(from)!.push(to)
  const into = new Map<string, string[]>(ids.map((id) => [id, []]))
  const state = new Map<string, 'open' | 'done'>()
  const walk = (id: string) => {
    state.set(id, 'open')
    for (const next of out.get(id)!) {
      if (state.get(next) === 'open') continue // back edge
      into.get(next)!.push(id)
      if (!state.has(next)) walk(next)
    }
    state.set(id, 'done')
  }
  for (const id of ids) if (!state.has(id)) walk(id)
  const layer = new Map<string, number>()
  const depth = (id: string): number => {
    if (layer.has(id)) return layer.get(id)!
    const value = Math.max(-1, ...into.get(id)!.map(depth)) + 1
    layer.set(id, value)
    return value
  }
  ids.forEach(depth)
  const rows = new Map<number, string[]>()
  for (const id of ids) rows.set(layer.get(id)!, [...(rows.get(layer.get(id)!) ?? []), id])
  const widest = Math.max(...[...rows.values()].map((r) => r.length))
  const positions = new Map<string, { x: number; y: number }>()
  const vertical = direction === 'down' || direction === 'up'
  const layers = Math.max(...rows.keys()) + 1
  for (const [index, row] of rows) {
    const along = direction === 'up' || direction === 'left' ? layers - 1 - index : index
    // Centered across the widest layer.
    const offset = (widest - row.length) / 2
    row.forEach((id, i) => {
      const across = offset + i
      positions.set(
        id,
        vertical
          ? { x: Math.round(across * (size.w + GAP.x)), y: Math.round(along * (size.h + GAP.y * 1.5)) }
          : { x: Math.round(along * (size.w + GAP.x * 1.5)), y: Math.round(across * (size.h + GAP.y)) }
      )
    })
  }
  return positions
}

// Mermaid ------------------------------------------------------------------------------------------

export interface GraphNode {
  ref: string
  label: string
  shape: ShapeName
}
export interface GraphEdge {
  from: string
  to: string
  label?: string
}
export interface Graph {
  direction: Direction
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export class MermaidError extends Error {}

const NODE = /^([A-Za-z0-9_\-À-ɏ]+)\s*(\(\(([^)]*)\)\)|\(\[([^\]]*)\]\)|\[\[([^\]]*)\]\]|\{\{([^}]*)\}\}|\[\/([^\]]*)\/\]|\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\}|>([^\]]*)\])?/
// An edge between two nodes: -->, ---, -.->, ==>, with an optional label (|text| or -- text -->).
const EDGE = /^\s*(?:(-{2,}|={2,}|-\.+-?)\s*([^-=|>][^|>]*?)\s*)?(-->|---|-\.->|-\.-|==>|===|--x|--o|<-->)\s*(?:\|([^|]*)\|)?\s*/

const unquote = (text: string) => text.trim().replace(/^"(.*)"$/, '$1').replace(/<br\s*\/?>/gi, '\n').trim()

/**
 * The nodes and edges of a Mermaid flowchart (`graph` or `flowchart`, any direction): node shapes
 * become board shapes ([ ] rectangle, ( ) and ([ ]) rectangle, (( )) ellipse, { } diamond,
 * {{ }} and [/ /] parallelogram, > ] triangle), chains (A --> B --> C) and `&` lists
 * (A & B --> C) are followed, labels on edges kept. Subgraphs, styles, classes and comments are
 * skipped. Throws MermaidError for other diagrams.
 */
export function parseMermaidFlowchart(source: string): Graph {
  const lines = source
    .replace(/%%.*$/gm, '')
    .split(/\n|;/)
    .map((l) => l.trim())
    .filter(Boolean)
  const header = /^(graph|flowchart)\b\s*(TD|TB|BT|LR|RL)?/i.exec(lines[0] ?? '')
  if (!header) throw new MermaidError('only Mermaid flowcharts ("graph" or "flowchart") can become a board')
  const dir = (header[2] ?? 'TD').toUpperCase()
  const direction: Direction = dir === 'LR' ? 'right' : dir === 'RL' ? 'left' : dir === 'BT' ? 'up' : 'down'
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []

  /** One node mention; a label given here names it (the first label given wins). */
  const node = (text: string): { ref: string; rest: string } | undefined => {
    const match = NODE.exec(text)
    if (!match) return undefined
    const ref = match[1]!
    const [, , , circle, stadium, subroutine, hexagon, para, square, round, rhombus, flag] = match
    const label = circle ?? stadium ?? subroutine ?? hexagon ?? para ?? square ?? round ?? rhombus ?? flag
    const shape: ShapeName = circle !== undefined ? 'ellipse' : rhombus !== undefined ? 'diamond' : hexagon !== undefined || para !== undefined ? 'parallelogram' : flag !== undefined ? 'triangle' : 'rectangle'
    const known = nodes.get(ref)
    if (!known) nodes.set(ref, { ref, label: label !== undefined ? unquote(label) : ref, shape })
    else if (label !== undefined && known.label === ref) Object.assign(known, { label: unquote(label), shape })
    return { ref, rest: text.slice(match[0].length) }
  }
  /** "A & B" → [A, B]. */
  const group = (text: string): { refs: string[]; rest: string } | undefined => {
    const refs: string[] = []
    let rest = text
    for (;;) {
      const found = node(rest.trimStart())
      if (!found) return refs.length ? { refs, rest } : undefined
      refs.push(found.ref)
      rest = found.rest
      const and = /^\s*&\s*/.exec(rest)
      if (!and) return { refs, rest }
      rest = rest.slice(and[0].length)
    }
  }

  for (const line of lines.slice(1)) {
    if (/^(subgraph|end$|end\b|style|classDef|class|linkStyle|click|direction)\b/i.test(line)) continue
    let current = group(line)
    if (!current) continue
    let rest = current.rest
    for (;;) {
      const edge = EDGE.exec(rest)
      if (!edge || !edge[0].length) break
      const label = edge[4] ?? edge[2]
      const next = group(rest.slice(edge[0].length))
      if (!next) break
      for (const from of current.refs) for (const to of next.refs) edges.push({ from, to, ...(label?.trim() ? { label: unquote(label) } : {}) })
      current = next
      rest = next.rest
    }
  }
  if (!nodes.size) throw new MermaidError('the flowchart has no nodes')
  return { direction, nodes: [...nodes.values()], edges }
}

/**
 * A graph as board elements from a corner: nodes laid out in layers, each a card when `objectFor`
 * finds an object by its label, else a shape; edges as arrows. Element ids come from `makeId`.
 */
export function graphToElements(graph: Graph, at: { x: number; y: number }, makeId: () => Id, objectFor: (label: string) => Id | undefined = () => undefined): (NewBoardElement & { id: Id })[] {
  const positions = layeredLayout(graph.nodes.map((n) => n.ref), graph.edges, graph.direction)
  const ids = new Map(graph.nodes.map((n) => [n.ref, makeId()]))
  const elements: (NewBoardElement & { id: Id })[] = []
  for (const n of graph.nodes) {
    const p = positions.get(n.ref)!
    const box = { x: at.x + p.x, y: at.y + p.y, ...NODE_SIZE }
    const objectId = objectFor(n.label)
    elements.push(objectId ? { id: ids.get(n.ref)!, kind: 'card', objectId, ...box } : { id: ids.get(n.ref)!, kind: 'shape', shape: n.shape, text: n.label, ...box })
  }
  for (const e of graph.edges) elements.push({ id: makeId(), kind: 'arrow', from: ids.get(e.from)!, to: ids.get(e.to)!, ...(e.label ? { label: e.label } : {}) })
  return elements
}

// JSON Canvas --------------------------------------------------------------------------------------

/** JSON Canvas 1.0 (jsoncanvas.org/spec/1.0). */
export interface JsonCanvas {
  nodes?: JsonCanvasNode[]
  edges?: JsonCanvasEdge[]
}
export interface JsonCanvasNode {
  id: string
  type: 'text' | 'file' | 'link' | 'group'
  x: number
  y: number
  width: number
  height: number
  color?: string
  text?: string
  file?: string
  url?: string
  label?: string
}
export interface JsonCanvasEdge {
  id: string
  fromNode: string
  toNode: string
  fromSide?: string
  toSide?: string
  fromEnd?: 'none' | 'arrow'
  toEnd?: 'none' | 'arrow'
  color?: string
  label?: string
}

/** The canvas's preset colors ("1" to "6") and the board's nearest. */
const CANVAS_PRESETS: Record<string, ColorName> = { '1': 'red', '2': 'orange', '3': 'yellow', '4': 'green', '5': 'cyan', '6': 'purple' }
const PRESET_OF: Partial<Record<ColorName, string>> = { red: '1', rose: '1', pink: '1', orange: '2', amber: '2', yellow: '3', lime: '4', green: '4', emerald: '4', teal: '5', cyan: '5', sky: '5', blue: '5', indigo: '6', violet: '6', purple: '6', fuchsia: '6' }

const round = (n: number) => Math.round(n)

/**
 * A board as a JSON Canvas: cards as text nodes with a link to the object, texts, shapes and notes
 * as text nodes, frames as groups, arrows as edges. Pen strokes have no place in the format and
 * are left out.
 */
export function boardToJsonCanvas(elements: BoardElement[], object: (id: Id) => { title: string; url: string } | undefined): JsonCanvas {
  const nodes: JsonCanvasNode[] = []
  const kept = new Set<Id>()
  for (const e of elements) {
    if (!isPlaced(e) || e.kind === 'stroke') continue
    const base = { id: e.id, x: round(e.x), y: round(e.y), width: round(e.w), height: round(e.h), ...(e.color && PRESET_OF[e.color] ? { color: PRESET_OF[e.color] } : {}) }
    if (e.kind === 'frame') nodes.push({ ...base, type: 'group', ...(e.title ? { label: e.title } : {}) })
    else if (e.kind === 'card') {
      const found = object(e.objectId)
      nodes.push({ ...base, type: 'text', text: found ? `[${found.title.replace(/[[\]]/g, '')}](${found.url})` : '(deleted object)' })
    } else nodes.push({ ...base, type: 'text', text: e.text })
    kept.add(e.id)
  }
  const edges: JsonCanvasEdge[] = elements.flatMap((e) =>
    e.kind === 'arrow' && kept.has(e.from) && kept.has(e.to)
      ? [{ id: e.id, fromNode: e.from, toNode: e.to, ...(e.heads === 'both' ? { fromEnd: 'arrow' as const } : {}), toEnd: e.heads === 'none' ? ('none' as const) : ('arrow' as const), ...(e.label ? { label: e.label } : {}), ...(e.color && PRESET_OF[e.color] ? { color: PRESET_OF[e.color] } : {}) }]
      : []
  )
  return { nodes, edges }
}

export class CanvasError extends Error {}

const canvasColor = (color: unknown): ColorName | undefined => {
  if (typeof color !== 'string') return undefined
  if (CANVAS_PRESETS[color]) return CANVAS_PRESETS[color]
  return (COLOR_NAMES as readonly string[]).includes(color) ? (color as ColorName) : undefined
}

/**
 * Board elements from a JSON Canvas: groups become frames, text nodes sticky notes (plain text,
 * Markdown kept as written), file and link nodes notes naming the file or the address, edges
 * arrows. A text node that is only a link to an object of this app (`objectFromLink`) becomes its
 * card. New ids from `makeId`; moved by (dx, dy).
 */
export function jsonCanvasToElements(canvas: unknown, makeId: () => Id, objectFromLink: (text: string) => Id | undefined = () => undefined, offset = { x: 0, y: 0 }): (NewBoardElement & { id: Id })[] {
  if (!canvas || typeof canvas !== 'object') throw new CanvasError('not a JSON Canvas file')
  const { nodes = [], edges = [] } = canvas as JsonCanvas
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new CanvasError('not a JSON Canvas file')
  const ids = new Map<string, Id>()
  const frames: (NewBoardElement & { id: Id })[] = []
  const others: (NewBoardElement & { id: Id })[] = []
  const number = (n: unknown, fallback: number) => (typeof n === 'number' && Number.isFinite(n) ? n : fallback)
  for (const n of nodes) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string') continue
    const id = makeId()
    ids.set(n.id, id)
    const box = { x: round(number(n.x, 0) + offset.x), y: round(number(n.y, 0) + offset.y), w: Math.max(24, round(number(n.width, 250))), h: Math.max(24, round(number(n.height, 60))) }
    const color = canvasColor(n.color)
    const look = color ? { color } : {}
    if (n.type === 'group') frames.push({ id, kind: 'frame', ...box, ...look, ...(typeof n.label === 'string' && n.label ? { title: n.label } : {}) })
    else {
      const text = n.type === 'file' ? String(n.file ?? '') : n.type === 'link' ? String(n.url ?? '') : String(n.text ?? '')
      const objectId = objectFromLink(text.trim())
      others.push(objectId ? { id, kind: 'card', objectId, ...box } : { id, kind: 'sticky', text, ...box, ...look })
    }
  }
  const arrows: (NewBoardElement & { id: Id })[] = []
  for (const e of edges) {
    if (!e || typeof e !== 'object') continue
    const from = ids.get(e.fromNode)
    const to = ids.get(e.toNode)
    if (!from || !to || from === to) continue
    const color = canvasColor(e.color)
    // JSON Canvas edges end in an arrow unless they say otherwise, and start plain.
    const heads = e.fromEnd === 'arrow' ? 'both' : e.toEnd === 'none' ? 'none' : undefined
    arrows.push({ id: makeId(), kind: 'arrow', from, to, ...(heads ? { heads } : {}), ...(typeof e.label === 'string' && e.label ? { label: e.label } : {}), ...(color ? { color } : {}) })
  }
  return [...frames, ...others, ...arrows]
}

export const isShapeName = (value: unknown): value is ShapeName => SHAPES.includes(value as ShapeName)
