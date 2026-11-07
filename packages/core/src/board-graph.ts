// A whiteboard as nodes and edges, for what lives outside the canvas: agents reading and editing a
// board (server agent.ts), JSON Canvas files (the open format Obsidian uses, jsoncanvas.org),
// Mermaid flowcharts in and out, and laying out a board's elements. Positions an outsider leaves out
// are laid out here.
import {
  SHAPES,
  arrowTips,
  insideFrame,
  isAttached,
  isPlaced,
  lineDash,
  type ArrowHeads,
  type BoardElement,
  type FrameElement,
  type NewBoardElement,
  type PlacedElement,
  type ShapeName,
} from './board.ts'
import type { ColorName, Id } from './model.ts'
import { COLOR_NAMES } from './tags.ts'

// Laying out ---------------------------------------------------------------------------------------

export const NODE_SIZE = { w: 220, h: 100 }
export const CARD_SIZE = { w: 260, h: 160 }
const GAP = { x: 96, y: 84 }

/** The box around placed elements (strokes drawn on another element left out). */
export function boardBounds(elements: BoardElement[]) {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const e of elements) {
    if (!isPlaced(e) || isAttached(e)) continue
    if (e.x < left) left = e.x
    if (e.y < top) top = e.y
    if (e.x + e.w > right) right = e.x + e.w
    if (e.y + e.h > bottom) bottom = e.y + e.h
  }
  return Number.isFinite(left) ? { x: left, y: top, right, bottom } : undefined
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

function layoutSingleComponent(
  ids: string[],
  edges: { from: string; to: string }[],
  direction: Direction,
  sizeOf: (id: string) => { w: number; h: number }
): { positions: Map<string, { x: number; y: number }>; width: number; height: number } {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const { from, to } of edges) {
    if (out.has(from) && out.has(to) && from !== to) out.get(from)!.push(to)
  }

  // 1. Cycle breaking via DFS in node declaration order
  const into = new Map<string, string[]>(ids.map((id) => [id, []]))
  const dagOut = new Map<string, string[]>(ids.map((id) => [id, []]))
  const state = new Map<string, 'open' | 'done'>()
  const walk = (id: string) => {
    state.set(id, 'open')
    for (const next of out.get(id)!) {
      if (state.get(next) === 'open') continue // back edge closing a cycle
      into.get(next)!.push(id)
      dagOut.get(id)!.push(next)
      if (!state.has(next)) walk(next)
    }
    state.set(id, 'done')
  }
  for (const id of ids) if (!state.has(id)) walk(id)

  // 2. Longest-path layer assignment
  const layer = new Map<string, number>()
  const depth = (id: string): number => {
    if (layer.has(id)) return layer.get(id)!
    const value = Math.max(-1, ...into.get(id)!.map(depth)) + 1
    layer.set(id, value)
    return value
  }
  ids.forEach(depth)

  // Tighten root nodes that only feed into deeper layers (layer >= 2)
  for (const id of ids) {
    if (into.get(id)!.length === 0 && dagOut.get(id)!.length > 0) {
      const minTargetLayer = Math.min(...dagOut.get(id)!.map((t) => layer.get(t)!))
      if (minTargetLayer > 1) layer.set(id, minTargetLayer - 1)
    }
  }

  const rows = new Map<number, string[]>()
  for (const id of ids) {
    const l = layer.get(id)!
    rows.set(l, [...(rows.get(l) ?? []), id])
  }
  const layerKeys = [...rows.keys()].sort((a, b) => a - b)

  // 3. Barycenter crossing minimization (4 alternating sweeps)
  const initialIndex = new Map(ids.map((id, i) => [id, i]))
  for (let pass = 0; pass < 4; pass++) {
    if (pass % 2 === 0) {
      // Forward sweep (top-down)
      for (let li = 1; li < layerKeys.length; li++) {
        const prevRow = rows.get(layerKeys[li - 1]!)!
        const prevPos = new Map(prevRow.map((id, idx) => [id, idx]))
        const row = rows.get(layerKeys[li]!)!
        const bary = new Map<string, number>()
        row.forEach((id, idx) => {
          const preds = into.get(id)!.filter((p) => prevPos.has(p))
          bary.set(id, preds.length ? preds.reduce((sum, p) => sum + prevPos.get(p)!, 0) / preds.length : idx)
        })
        row.sort((a, b) => bary.get(a)! - bary.get(b)! || initialIndex.get(a)! - initialIndex.get(b)!)
      }
    } else {
      // Backward sweep (bottom-up)
      for (let li = layerKeys.length - 2; li >= 0; li--) {
        const nextRow = rows.get(layerKeys[li + 1]!)!
        const nextPos = new Map(nextRow.map((id, idx) => [id, idx]))
        const row = rows.get(layerKeys[li]!)!
        const bary = new Map<string, number>()
        row.forEach((id, idx) => {
          const succs = dagOut.get(id)!.filter((s) => nextPos.has(s))
          bary.set(id, succs.length ? succs.reduce((sum, s) => sum + nextPos.get(s)!, 0) / succs.length : idx)
        })
        row.sort((a, b) => bary.get(a)! - bary.get(b)! || initialIndex.get(a)! - initialIndex.get(b)!)
      }
    }
  }

  // 4. Coordinate assignment with variable node dimensions and centered layers
  const vertical = direction === 'down' || direction === 'up'
  const orderedLayers = direction === 'up' || direction === 'left' ? [...layerKeys].reverse() : layerKeys
  const gapAcross = vertical ? GAP.x : GAP.y
  const gapAlong = vertical ? GAP.y * 1.5 : GAP.x * 1.5

  const layerSpans = new Map<number, number>()
  const layerThickness = new Map<number, number>()
  for (const lk of orderedLayers) {
    const row = rows.get(lk)!
    const span = row.reduce((sum, id) => sum + (vertical ? sizeOf(id).w : sizeOf(id).h), 0) + Math.max(0, row.length - 1) * gapAcross
    const thick = Math.max(...row.map((id) => (vertical ? sizeOf(id).h : sizeOf(id).w)))
    layerSpans.set(lk, span)
    layerThickness.set(lk, thick)
  }

  const maxSpan = Math.max(0, ...layerSpans.values())
  const positions = new Map<string, { x: number; y: number }>()
  let alongCursor = 0

  for (const lk of orderedLayers) {
    const row = rows.get(lk)!
    const span = layerSpans.get(lk)!
    const thick = layerThickness.get(lk)!
    let acrossCursor = (maxSpan - span) / 2

    for (const id of row) {
      const sz = sizeOf(id)
      // Center node along the layer's thickness if nodes in the same layer have different heights/widths
      const alongOffset = (thick - (vertical ? sz.h : sz.w)) / 2
      positions.set(
        id,
        vertical
          ? { x: Math.round(acrossCursor), y: Math.round(alongCursor + alongOffset) }
          : { x: Math.round(alongCursor + alongOffset), y: Math.round(acrossCursor) }
      )
      acrossCursor += (vertical ? sz.w : sz.h) + gapAcross
    }
    alongCursor += thick + gapAlong
  }

  const totalAlong = Math.max(0, alongCursor - gapAlong)
  return {
    positions,
    width: vertical ? maxSpan : totalAlong,
    height: vertical ? totalAlong : maxSpan,
  }
}

/**
 * Layers for a directed graph: each node one layer past the furthest node pointing at it (cycles
 * broken where they close), crossing-minimized via barycenter sweeps, with disconnected components
 * stacked cleanly. Returns each node's corner, from (0, 0), flowing in `direction`.
 */
export function layeredLayout(
  ids: string[],
  edges: { from: string; to: string }[],
  direction: Direction = 'down',
  size: { w: number; h: number } | Map<string, { w: number; h: number }> = NODE_SIZE
) {
  if (!ids.length) return new Map<string, { x: number; y: number }>()
  const sizeOf = (id: string) => (size instanceof Map ? (size.get(id) ?? NODE_SIZE) : size)

  // Find weakly connected components while preserving input order
  const adj = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]))
  for (const { from, to } of edges) {
    if (adj.has(from) && adj.has(to) && from !== to) {
      adj.get(from)!.add(to)
      adj.get(to)!.add(from)
    }
  }

  const visited = new Set<string>()
  const components: string[][] = []
  for (const id of ids) {
    if (visited.has(id)) continue
    const comp: string[] = []
    const queue = [id]
    visited.add(id)
    while (queue.length) {
      const cur = queue.shift()!
      comp.push(cur)
      for (const nb of adj.get(cur)!) {
        if (!visited.has(nb)) {
          visited.add(nb)
          queue.push(nb)
        }
      }
    }
    const order = new Set(comp)
    components.push(ids.filter((x) => order.has(x)))
  }

  if (components.length === 1) {
    return layoutSingleComponent(ids, edges, direction, sizeOf).positions
  }

  // Separate multi-node connected components from isolated singletons
  const connectedComps = components.filter((c) => c.length > 1)
  const isolatedIds = components.filter((c) => c.length === 1).map((c) => c[0]!)

  const positions = new Map<string, { x: number; y: number }>()
  const vertical = direction === 'down' || direction === 'up'
  let offsetX = 0
  let offsetY = 0
  let maxMainW = 0
  let maxMainH = 0

  for (const comp of connectedComps) {
    const compSet = new Set(comp)
    const compEdges = edges.filter((e) => compSet.has(e.from) && compSet.has(e.to))
    const laid = layoutSingleComponent(comp, compEdges, direction, sizeOf)
    for (const [id, pos] of laid.positions) {
      positions.set(id, { x: pos.x + offsetX, y: pos.y + offsetY })
    }
    if (vertical) {
      offsetX += laid.width + GAP.x * 1.5
      maxMainW = Math.max(maxMainW, offsetX - GAP.x * 1.5)
      maxMainH = Math.max(maxMainH, laid.height)
    } else {
      offsetY += laid.height + GAP.y * 1.5
      maxMainW = Math.max(maxMainW, laid.width)
      maxMainH = Math.max(maxMainH, offsetY - GAP.y * 1.5)
    }
  }

  if (isolatedIds.length) {
    // If all nodes were isolated, lay them out in a single row/column as before
    if (connectedComps.length === 0) {
      return layoutSingleComponent(isolatedIds, [], direction, sizeOf).positions
    }
    const startAt = vertical ? { x: 0, y: Math.round(maxMainH + GAP.y * 2) } : { x: Math.round(maxMainW + GAP.x * 2), y: 0 }
    const boxes = gridBoxes(
      isolatedIds.map((id) => sizeOf(id)),
      startAt
    )
    isolatedIds.forEach((id, idx) => positions.set(id, boxes[idx]!))
  }

  return positions
}

/**
 * Computes tidy `{ x, y }` coordinates for existing board elements in the given flow direction
 * (or `'grid'`), respecting each element's actual width and height and updating frames that enclose
 * laid-out elements.
 */
export function layoutBoardElements(
  elements: BoardElement[],
  direction: Direction | 'grid' = 'down',
  at?: { x: number; y: number }
): Record<Id, { x: number; y: number; w?: number; h?: number }> {
  const nodes = elements.filter((e): e is PlacedElement => isPlaced(e) && !isAttached(e) && e.kind !== 'frame' && e.kind !== 'stroke' && e.kind !== 'line')
  if (!nodes.length) return {}

  const frames = elements.filter((e): e is FrameElement => e.kind === 'frame')
  const frameMembers = new Map<Id, Id[]>()
  for (const frame of frames) {
    const inside = insideFrame(frame, nodes).map((n) => n.id)
    if (inside.length) frameMembers.set(frame.id, inside)
  }

  const origin = at ?? {
    x: Math.round(Math.min(...nodes.map((n) => n.x))),
    y: Math.round(Math.min(...nodes.map((n) => n.y))),
  }

  const patches: Record<Id, { x: number; y: number; w?: number; h?: number }> = {}
  const sizeMap = new Map(nodes.map((n) => [n.id, { w: n.w, h: n.h }]))

  if (direction === 'grid') {
    const spots = gridBoxes(
      nodes.map((n) => ({ w: n.w, h: n.h })),
      origin
    )
    nodes.forEach((n, i) => {
      patches[n.id] = { x: Math.round(spots[i]!.x), y: Math.round(spots[i]!.y) }
    })
  } else {
    const arrows = elements.filter((e): e is Extract<BoardElement, { kind: 'arrow' }> => e.kind === 'arrow')
    const positions = layeredLayout(
      nodes.map((n) => n.id),
      arrows.map((a) => ({ from: a.from, to: a.to })),
      direction,
      sizeMap
    )
    for (const n of nodes) {
      const p = positions.get(n.id)
      if (p) patches[n.id] = { x: Math.round(origin.x + p.x), y: Math.round(origin.y + p.y) }
    }
  }

  // Refit any frames around the updated positions of their member nodes
  const pad = 40
  const topHeader = 48
  for (const [frameId, memberIds] of frameMembers) {
    const boxes = memberIds
      .map((id) => {
        const pos = patches[id]
        const sz = sizeMap.get(id)
        return pos && sz ? { x: pos.x, y: pos.y, right: pos.x + sz.w, bottom: pos.y + sz.h } : undefined
      })
      .filter((b): b is { x: number; y: number; right: number; bottom: number } => !!b)
    if (!boxes.length) continue
    const left = Math.min(...boxes.map((b) => b.x)) - pad
    const top = Math.min(...boxes.map((b) => b.y)) - topHeader
    const right = Math.max(...boxes.map((b) => b.right)) + pad
    const bottom = Math.max(...boxes.map((b) => b.bottom)) + pad
    patches[frameId] = {
      x: Math.round(left),
      y: Math.round(top),
      w: Math.round(right - left),
      h: Math.round(bottom - top),
    }
  }

  return patches
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
  dashed?: boolean
  heads?: ArrowHeads
}
export interface GraphSubgraph {
  id: string
  title: string
  nodeRefs: string[]
}
export interface Graph {
  direction: Direction
  nodes: GraphNode[]
  edges: GraphEdge[]
  subgraphs?: GraphSubgraph[]
}

export class MermaidError extends Error {}

const NODE = /^([A-Za-z0-9_\-À-ɏ]+)\s*(\(\(([^)]*)\)\)|\(\[([^\]]*)\]\)|\[\[([^\]]*)\]\]|\{\{([^}]*)\}\}|\[\/([^\]]*)\/\]|\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\}|>([^\]]*)\])?/
// An edge between two nodes: -->, ---, -.->, ==>, with an optional label (|text| or -- text -->).
const EDGE = /^\s*(?:(-{2,}|={2,}|-\.+-?)\s*([^-=|>][^|>]*?)\s*)?(-->|---|-\.->|-\.-|==>|===|--x|--o|<-->)\s*(?:\|([^|]*)\|)?\s*/

const unquote = (text: string) => text.trim().replace(/^"(.*)"$/, '$1').replace(/<br\s*\/?>/gi, '\n').trim()

/**
 * The nodes, edges, and subgraphs of a Mermaid flowchart (`graph` or `flowchart`, any direction):
 * node shapes become board shapes ([ ] rectangle, ( ) and ([ ]) rectangle, (( )) ellipse, { } diamond,
 * {{ }} and [/ /] parallelogram, > ] triangle), chains (A --> B --> C) and `&` lists
 * (A & B --> C) are followed, labels and styles on edges kept, `subgraph ... end` blocks recorded.
 * Throws MermaidError for other diagrams.
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
  const subgraphs: GraphSubgraph[] = []
  const subgraphStack: GraphSubgraph[] = []
  const subgraphIds = new Set<string>()

  const recordInSubgraphs = (ref: string) => {
    for (const sg of subgraphStack) {
      if (!sg.nodeRefs.includes(ref)) sg.nodeRefs.push(ref)
    }
  }

  /** One node mention; a label given here names it (the first label given wins). */
  const node = (text: string): { ref: string; rest: string } | undefined => {
    const match = NODE.exec(text)
    if (!match) return undefined
    const ref = match[1]!
    const [, , , circle, stadium, subroutine, hexagon, para, square, round, rhombus, flag] = match
    const label = circle ?? stadium ?? subroutine ?? hexagon ?? para ?? square ?? round ?? rhombus ?? flag
    const shape: ShapeName =
      circle !== undefined
        ? 'ellipse'
        : rhombus !== undefined
          ? 'diamond'
          : hexagon !== undefined || para !== undefined
            ? 'parallelogram'
            : flag !== undefined
              ? 'triangle'
              : 'rectangle'
    const known = nodes.get(ref)
    if (!known) nodes.set(ref, { ref, label: label !== undefined ? unquote(label) : ref, shape })
    else if (label !== undefined && known.label === ref) Object.assign(known, { label: unquote(label), shape })
    recordInSubgraphs(ref)
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
    const sgMatch = /^subgraph\s+(?:([A-Za-z0-9_\-]+)\s*\[\s*([^\]]+)\s*\]|"?([^"]+)"?)$/i.exec(line)
    if (sgMatch) {
      const sgId = sgMatch[1] ?? `sg_${subgraphs.length + 1}`
      const sgTitle = unquote(sgMatch[2] ?? sgMatch[3] ?? sgId)
      const sg: GraphSubgraph = { id: sgId, title: sgTitle, nodeRefs: [] }
      subgraphs.push(sg)
      subgraphStack.push(sg)
      subgraphIds.add(sgId)
      continue
    }
    if (/^end\b/i.test(line)) {
      subgraphStack.pop()
      continue
    }
    if (/^(style|classDef|class|linkStyle|click|direction)\b/i.test(line)) continue
    let current = group(line)
    if (!current) continue
    let rest = current.rest
    for (;;) {
      const edge = EDGE.exec(rest)
      if (!edge || !edge[0].length) break
      const preToken = edge[1] ?? ''
      const label = edge[4] ?? edge[2]
      const arrowToken = edge[3] ?? '-->'
      const dashed = arrowToken.includes('-.') || preToken.includes('-.')
      const heads: ArrowHeads | undefined =
        arrowToken === '<-->' ? 'both' : arrowToken === '---' || arrowToken === '-.-' || arrowToken === '===' ? 'none' : undefined
      const next = group(rest.slice(edge[0].length))
      if (!next) break
      for (const from of current.refs) {
        for (const to of next.refs) {
          edges.push({
            from,
            to,
            ...(label?.trim() ? { label: unquote(label) } : {}),
            ...(dashed ? { dashed: true } : {}),
            ...(heads ? { heads } : {}),
          })
        }
      }
      current = next
      rest = next.rest
    }
  }
  // Remove any accidental node entries that were actually subgraph identifiers without shape definitions
  for (const sgId of subgraphIds) {
    const n = nodes.get(sgId)
    if (n && n.label === sgId && !edges.some((e) => e.from === sgId || e.to === sgId)) {
      nodes.delete(sgId)
    }
  }
  if (!nodes.size) throw new MermaidError('the flowchart has no nodes')
  const validSubgraphs = subgraphs.filter((sg) => sg.nodeRefs.some((r) => nodes.has(r)))
  return {
    direction,
    nodes: [...nodes.values()],
    edges,
    ...(validSubgraphs.length ? { subgraphs: validSubgraphs } : {}),
  }
}

/**
 * A graph as board elements from a corner: nodes laid out in layers, each a card when `objectFor`
 * finds an object by its label, else a shape; subgraphs as frames; edges as arrows. Element ids come from `makeId`.
 */
export function graphToElements(
  graph: Graph,
  at: { x: number; y: number },
  makeId: () => Id,
  objectFor: (label: string) => Id | undefined = () => undefined
): (NewBoardElement & { id: Id })[] {
  const resolvedObjects = new Map<string, Id | undefined>()
  const sizeMap = new Map<string, { w: number; h: number }>()
  for (const n of graph.nodes) {
    const objId = objectFor(n.label)
    resolvedObjects.set(n.ref, objId)
    sizeMap.set(n.ref, objId ? CARD_SIZE : NODE_SIZE)
  }
  const positions = layeredLayout(
    graph.nodes.map((n) => n.ref),
    graph.edges,
    graph.direction,
    sizeMap
  )
  const ids = new Map(graph.nodes.map((n) => [n.ref, makeId()]))
  const nodeBoxes = new Map<string, { x: number; y: number; w: number; h: number }>()
  const nodeElements: (NewBoardElement & { id: Id })[] = []
  for (const n of graph.nodes) {
    const p = positions.get(n.ref)!
    const sz = sizeMap.get(n.ref)!
    const box = { x: at.x + p.x, y: at.y + p.y, w: sz.w, h: sz.h }
    nodeBoxes.set(n.ref, box)
    const objectId = resolvedObjects.get(n.ref)
    nodeElements.push(
      objectId ? { id: ids.get(n.ref)!, kind: 'card', objectId, ...box } : { id: ids.get(n.ref)!, kind: 'shape', shape: n.shape, text: n.label, ...box }
    )
  }

  const arrowElements: (NewBoardElement & { id: Id })[] = []
  for (const e of graph.edges) {
    arrowElements.push({
      id: makeId(),
      kind: 'arrow',
      from: ids.get(e.from)!,
      to: ids.get(e.to)!,
      ...(e.label ? { label: e.label } : {}),
      ...(e.dashed ? { dashed: true } : {}),
      ...(e.heads ? { heads: e.heads } : {}),
    })
  }

  const frameElements: (NewBoardElement & { id: Id })[] = []
  for (const sg of graph.subgraphs ?? []) {
    const boxes = sg.nodeRefs.map((ref) => nodeBoxes.get(ref)).filter((b): b is { x: number; y: number; w: number; h: number } => !!b)
    if (!boxes.length) continue
    const pad = 32
    const topPad = 44
    const left = Math.min(...boxes.map((b) => b.x)) - pad
    const top = Math.min(...boxes.map((b) => b.y)) - topPad
    const right = Math.max(...boxes.map((b) => b.x + b.w)) + pad
    const bottom = Math.max(...boxes.map((b) => b.y + b.h)) + pad
    frameElements.push({
      id: makeId(),
      kind: 'frame',
      title: sg.title,
      x: Math.round(left),
      y: Math.round(top),
      w: Math.round(right - left),
      h: Math.round(bottom - top),
    })
  }

  return [...frameElements, ...nodeElements, ...arrowElements]
}

/**
 * Converts a board's elements and arrows into a Mermaid `flowchart` diagram.
 */
export function boardToMermaid(
  elements: BoardElement[],
  objectTitle: (id: Id) => string | undefined = () => undefined,
  direction?: Direction
): string {
  const nodes = elements.filter((e): e is PlacedElement => isPlaced(e) && !isAttached(e) && e.kind !== 'frame' && e.kind !== 'stroke' && e.kind !== 'line')
  const frames = elements.filter((e): e is FrameElement => e.kind === 'frame')
  const arrows = elements.filter((e): e is Extract<BoardElement, { kind: 'arrow' }> => e.kind === 'arrow')

  // Infer natural flow direction from arrow vectors if not explicitly given
  let dir = direction
  if (!dir) {
    const byId = new Map(nodes.map((n) => [n.id, n]))
    let sumDx = 0
    let sumDy = 0
    for (const a of arrows) {
      const f = byId.get(a.from)
      const t = byId.get(a.to)
      if (f && t) {
        sumDx += Math.abs(t.x - f.x)
        sumDy += Math.abs(t.y - f.y)
      }
    }
    dir = sumDx > sumDy * 1.25 ? 'right' : 'down'
  }

  const mermaidDir = dir === 'right' ? 'LR' : dir === 'left' ? 'RL' : dir === 'up' ? 'BT' : 'TD'
  const lines: string[] = [`flowchart ${mermaidDir}`]

  const refMap = new Map<Id, string>()
  nodes.forEach((n, idx) => refMap.set(n.id, `N${idx + 1}`))

  const escapeLabel = (raw: string) => raw.replace(/"/g, "'").replace(/\r?\n/g, '<br/>').trim() || 'Item'

  const formatNode = (n: PlacedElement): string => {
    const ref = refMap.get(n.id)!
    if (n.kind === 'card') {
      const label = escapeLabel(objectTitle(n.objectId) ?? n.objectId)
      return `${ref}["${label}"]`
    }
    if (n.kind === 'sticky') {
      const label = escapeLabel(n.text)
      return `${ref}(["${label}"])`
    }
    if (n.kind === 'text') {
      const label = escapeLabel(n.text)
      return `${ref}["${label}"]`
    }
    if (n.kind === 'shape') {
      const label = escapeLabel(n.text || n.shape)
      if (n.shape === 'ellipse') return `${ref}(("${label}"))`
      if (n.shape === 'diamond') return `${ref}{"${label}"}`
      if (n.shape === 'parallelogram') return `${ref}[/"${label}"/]`
      if (n.shape === 'triangle') return `${ref}>"${label}"]`
      return `${ref}["${label}"]`
    }
    return `${ref}["Node"]`
  }

  const emittedNodes = new Set<Id>()
  frames.forEach((frame, fIdx) => {
    const members = insideFrame(frame, nodes).filter((n) => !emittedNodes.has(n.id))
    if (!members.length) return
    const title = escapeLabel(frame.title || `Scene ${fIdx + 1}`)
    lines.push(`  subgraph SG${fIdx + 1} ["${title}"]`)
    for (const m of members) {
      lines.push(`    ${formatNode(m)}`)
      emittedNodes.add(m.id)
    }
    lines.push('  end')
  })

  for (const n of nodes) {
    if (emittedNodes.has(n.id)) continue
    lines.push(`  ${formatNode(n)}`)
  }

  for (const a of arrows) {
    const fromRef = refMap.get(a.from)
    const toRef = refMap.get(a.to)
    if (!fromRef || !toRef) continue
    const tips = arrowTips(a)
    const connector = lineDash(a) ? (tips.end === 'none' ? '-.-' : '-.->') : tips.start === 'arrow' && tips.end === 'arrow' ? '<-->' : tips.end === 'none' ? '---' : '-->'
    const labelText = a.label?.trim() || a.relation?.trim()
    if (labelText) {
      lines.push(`  ${fromRef} ${connector}|"${escapeLabel(labelText).replace(/\|/g, '/')}"| ${toRef}`)
    } else {
      lines.push(`  ${fromRef} ${connector} ${toRef}`)
    }
  }

  return lines.join('\n')
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
 * as text nodes, frames as groups, arrows as edges. Pen strokes and loose arrows have no place in
 * the format and are left out.
 */
export function boardToJsonCanvas(elements: BoardElement[], object: (id: Id) => { title: string; url: string } | undefined): JsonCanvas {
  const nodes: JsonCanvasNode[] = []
  const kept = new Set<Id>()
  for (const e of elements) {
    // Pen strokes and loose arrows (lines between points) have no node in the format.
    if (!isPlaced(e) || e.kind === 'stroke' || e.kind === 'line') continue
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
      ? [{ id: e.id, fromNode: e.from, toNode: e.to, ...(arrowTips(e).start === 'arrow' ? { fromEnd: 'arrow' as const } : {}), toEnd: arrowTips(e).end === 'arrow' ? ('arrow' as const) : ('none' as const), ...(e.label ? { label: e.label } : {}), ...(e.color && PRESET_OF[e.color] ? { color: PRESET_OF[e.color] } : {}) }]
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
