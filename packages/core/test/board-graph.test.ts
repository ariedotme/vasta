import { describe, expect, it } from 'vitest'
import { Y } from '@vasta/editor-schema/yjs'
import { addBoardElements, readBoard } from '../src/board.ts'
import { MermaidError, boardToJsonCanvas, graphToElements, jsonCanvasToElements, layeredLayout, parseMermaidFlowchart, spotAfter } from '../src/board-graph.ts'

const counter = () => {
  let n = 0
  return () => `id${++n}`
}

describe('Mermaid flowcharts', () => {
  it('reads nodes with their shapes, chains, & lists and edge labels', () => {
    const graph = parseMermaidFlowchart(`flowchart LR
      A[Idea] --> B{Worth it?}
      B -->|yes| C((Build)) --> D[Ship]
      B -- no --> E(Drop)
      C & E --> F
      %% a comment
      style A fill:#f9f`)
    expect(graph.direction).toBe('right')
    expect(graph.nodes.map((n) => [n.ref, n.label, n.shape])).toEqual([
      ['A', 'Idea', 'rectangle'],
      ['B', 'Worth it?', 'diamond'],
      ['C', 'Build', 'ellipse'],
      ['D', 'Ship', 'rectangle'],
      ['E', 'Drop', 'rectangle'],
      ['F', 'F', 'rectangle'],
    ])
    expect(graph.edges).toEqual([
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C', label: 'yes' },
      { from: 'C', to: 'D' },
      { from: 'B', to: 'E', label: 'no' },
      { from: 'C', to: 'F' },
      { from: 'E', to: 'F' },
    ])
  })

  it('takes the label given later for a node first named bare, and quoted labels', () => {
    const graph = parseMermaidFlowchart('graph TD\n  A --> B\n  B["Second step"]')
    expect(graph.nodes[1]).toMatchObject({ ref: 'B', label: 'Second step' })
  })

  it('refuses other diagrams', () => {
    expect(() => parseMermaidFlowchart('sequenceDiagram\n A->>B: hi')).toThrow(MermaidError)
  })

  it('lays layers out in the direction asked, a cycle not looping forever', () => {
    const down = layeredLayout(['a', 'b', 'c'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }], 'down')
    expect(down.get('a')!.y).toBeLessThan(down.get('b')!.y)
    expect(down.get('b')!.y).toBeLessThan(down.get('c')!.y)
    const right = layeredLayout(['a', 'b'], [{ from: 'a', to: 'b' }], 'right')
    expect(right.get('a')!.x).toBeLessThan(right.get('b')!.x)
    expect(right.get('a')!.y).toBe(right.get('b')!.y)
  })

  it('becomes shapes and arrows, or cards for nodes named like objects', () => {
    const graph = parseMermaidFlowchart('graph LR\n A[Plan] --> B[Groceries]')
    const elements = graphToElements(graph, { x: 100, y: 50 }, counter(), (label) => (label === 'Groceries' ? 'obj-1' : undefined))
    expect(elements.map((e) => e.kind)).toEqual(['shape', 'card', 'arrow'])
    expect(elements[0]).toMatchObject({ x: 100, y: 50, text: 'Plan' })
    expect(elements[1]).toMatchObject({ objectId: 'obj-1' })
    expect(elements[2]).toMatchObject({ from: 'id1', to: 'id2' })
  })
})

describe('JSON Canvas', () => {
  const board = () => {
    const doc = new Y.Doc()
    const [card, note, frame] = addBoardElements(doc, [
      { kind: 'card', objectId: 'o1', x: 0, y: 0, w: 200, h: 100 },
      { kind: 'sticky', text: 'Hello', x: 300, y: 0, w: 150, h: 150, color: 'blue' },
      { kind: 'frame', title: 'Week', x: -50, y: -50, w: 600, h: 300 },
      { kind: 'stroke', points: [0, 0, 0.5, 5, 5, 0.5], size: 2, sw: 5, sh: 5, x: 0, y: 0, w: 5, h: 5 },
    ])
    addBoardElements(doc, [{ kind: 'arrow', from: card!, to: note!, label: 'then' }])
    return { doc, frame }
  }

  it('writes cards as links, notes as text, frames as groups and arrows as edges, leaving strokes out', () => {
    const canvas = boardToJsonCanvas(readBoard(board().doc), (id) => (id === 'o1' ? { title: 'Plan [draft]', url: 'https://notes.example/o/o1' } : undefined))
    expect(canvas.nodes!.map((n) => [n.type, n.text ?? n.label])).toEqual([
      ['group', 'Week'],
      ['text', '[Plan draft](https://notes.example/o/o1)'],
      ['text', 'Hello'],
    ])
    expect(canvas.nodes![2]!.color).toBe('5')
    expect(canvas.edges).toEqual([expect.objectContaining({ toEnd: 'arrow', label: 'then' })])
  })

  it('reads a canvas back: groups as frames, text as notes, links to objects as cards, edges as arrows', () => {
    const canvas = boardToJsonCanvas(readBoard(board().doc), () => ({ title: 'Plan', url: 'https://notes.example/o/o1' }))
    const elements = jsonCanvasToElements(canvas, counter(), (text) => (text.includes('/o/o1') ? 'o1' : undefined), { x: 1000, y: 0 })
    expect(elements.map((e) => e.kind)).toEqual(['frame', 'card', 'sticky', 'arrow'])
    expect(elements[0]).toMatchObject({ title: 'Week', x: 950 })
    expect(elements[2]).toMatchObject({ text: 'Hello', color: 'cyan' })
    expect(elements[3]).toMatchObject({ from: 'id2', to: 'id3', label: 'then' })
  })

  it('keeps arrow heads through a canvas', () => {
    const doc = new Y.Doc()
    const [a, b] = addBoardElements(doc, [
      { kind: 'sticky', text: 'A', x: 0, y: 0, w: 100, h: 100 },
      { kind: 'sticky', text: 'B', x: 300, y: 0, w: 100, h: 100 },
    ])
    addBoardElements(doc, [{ kind: 'arrow', from: a!, to: b!, heads: 'both' }, { kind: 'arrow', from: b!, to: a!, heads: 'none' }])
    const canvas = boardToJsonCanvas(readBoard(doc), () => undefined)
    expect(canvas.edges!.map((e) => [e.fromEnd ?? 'none', e.toEnd])).toEqual([['arrow', 'arrow'], ['none', 'none']])
    const back = jsonCanvasToElements(canvas, counter()).filter((e) => e.kind === 'arrow')
    expect(back.map((e) => (e as { heads?: string }).heads)).toEqual(['both', 'none'])
  })

  it('refuses what is not a canvas', () => {
    expect(() => jsonCanvasToElements('nope', counter())).toThrow()
    expect(() => jsonCanvasToElements({ nodes: 'x' }, counter())).toThrow()
  })

  it('puts new content to the right of the board', () => {
    expect(spotAfter([])).toEqual({ x: 0, y: 0 })
    expect(spotAfter(readBoard(board().doc))).toEqual({ x: 710, y: -50 })
  })
})
