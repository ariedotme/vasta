import { describe, expect, it } from 'vitest'
import { arrowRoute, routePath, snapResize, boardClipboard, parseBoardClipboard, shapePath, simplifyPoints, snapMove, strokeFromPoints, strokePath, thinPoints } from './whiteboard.ts'

describe('pen strokes', () => {
  it('drops the points of a straight run and keeps the corners', () => {
    const points: number[] = []
    for (let i = 0; i <= 10; i++) points.push(i * 10, 0, 0.5)
    for (let i = 1; i <= 10; i++) points.push(100, i * 10, 0.5)
    expect(simplifyPoints(points, 0.5)).toEqual([0, 0, 0.5, 100, 0, 0.5, 100, 100, 0.5])
  })

  it('keeps a wobble larger than the tolerance', () => {
    expect(simplifyPoints([0, 0, 0.5, 50, 4, 0.5, 100, 0, 0.5], 1).length).toBe(9)
    expect(simplifyPoints([0, 0, 0.5, 50, 0.4, 0.5, 100, 0, 0.5], 1).length).toBe(6)
  })

  it('thins a pen line by distance only, keeping its pressure changes and its last point', () => {
    const points = [0, 0, 0.2, 0.1, 0, 0.3, 1, 0, 0.4, 2, 0, 0.9, 2.1, 0, 0.5]
    expect(thinPoints(points, 0.5)).toEqual([0, 0, 0.2, 1, 0, 0.4, 2, 0, 0.9, 2.1, 0, 0.5])
  })

  it('puts a stroke in a box with room for its width, points relative to the corner', () => {
    const stroke = strokeFromPoints([100, 200, 0.5, 140, 230, 0.5], 4)
    expect(stroke).toMatchObject({ x: 96, y: 196, w: 48, h: 38, sw: 48, sh: 38 })
    expect(stroke.points).toEqual([4, 4, 0.5, 44, 34, 0.5])
  })

  it('draws an outline path', () => {
    expect(strokePath([0, 0, 0.5, 20, 20, 0.5, 40, 0, 0.5], 4)).toMatch(/^M[\d.,-]+ Q.*Z$/)
    expect(strokePath([], 4)).toBe('')
  })
})

describe('shapes', () => {
  it('draws every shape inside its box', () => {
    for (const shape of ['rectangle', 'ellipse', 'diamond', 'triangle', 'parallelogram', 'star', 'heart'] as const) {
      const numbers = shapePath(shape, 100, 60).match(/-?\d+(\.\d+)?/g)!.map(Number)
      expect(Math.min(...numbers)).toBeGreaterThanOrEqual(0)
      expect(Math.max(...numbers)).toBeLessThanOrEqual(100)
    }
  })
})

describe('snapping', () => {
  const other = { x: 300, y: 100, w: 200, h: 100 }

  it('lines up left edges within the threshold and draws a guide', () => {
    const moved = snapMove({ x: 0, y: 400, w: 100, h: 50 }, [other], 297, 0, 6)
    expect(moved.dx).toBe(300)
    expect(moved.dy).toBe(0)
    expect(moved.guides).toEqual([{ axis: 'x', at: 300, from: 100, to: 450 }])
  })

  it('lines up middles, and leaves a move alone past the threshold', () => {
    expect(snapMove({ x: 0, y: 0, w: 100, h: 50 }, [other], 352, 0, 6).dx).toBe(350)
    expect(snapMove({ x: 0, y: 0, w: 100, h: 50 }, [other], 230, 0, 6)).toEqual({ dx: 230, dy: 0, guides: [] })
  })
})

describe('clipboard', () => {
  it('round-trips elements and ignores other text', () => {
    const elements = [{ id: 'a', rank: 'a', kind: 'text' as const, text: 'Hi', x: 0, y: 0, w: 10, h: 10 }]
    expect(parseBoardClipboard(boardClipboard(elements))).toEqual(elements)
    expect(parseBoardClipboard('hello')).toBeUndefined()
    expect(parseBoardClipboard('vasta-board:{nope')).toBeUndefined()
  })
})

describe('arrows', () => {
  const a = { x: 0, y: 0, w: 100, h: 50 }
  const b = { x: 300, y: 200, w: 100, h: 50 }

  it('runs straight from edge to edge', () => {
    const route = arrowRoute(a, { x: 300, y: 0, w: 100, h: 50 })
    expect(route.points).toEqual([{ x: 100, y: 25 }, { x: 300, y: 25 }])
    expect(routePath(route)).toBe('M100,25 L300,25')
  })

  it('turns at right angles from the facing sides, wider apart than tall', () => {
    const route = arrowRoute(a, b, 'elbow')
    expect(route.points).toEqual([{ x: 100, y: 25 }, { x: 200, y: 25 }, { x: 200, y: 225 }, { x: 300, y: 225 }])
    expect(route.mid).toEqual({ x: 200, y: 125 })
  })

  it('bows a curve to one side, its label on the curve', () => {
    const route = arrowRoute(a, { x: 300, y: 0, w: 100, h: 50 }, 'curved')
    expect(route.kind).toBe('curve')
    expect(route.points[1]!.y).toBeLessThan(25)
    expect(route.mid.y).toBeLessThan(25)
    expect(routePath(route, (p) => ({ x: p.x * 2, y: p.y * 2 }))).toMatch(/^M\S+ Q\S+ \S+$/)
  })
})

describe('snapping a resize', () => {
  it('lines the right edge up with a neighbor', () => {
    const out = snapResize({ x: 0, y: 0, w: 100, h: 100 }, 196, 100, [{ x: 0, y: 200, w: 200, h: 50 }], 6)
    expect(out.w).toBe(200)
    expect(out.guides[0]).toMatchObject({ axis: 'x', at: 200 })
  })
})
