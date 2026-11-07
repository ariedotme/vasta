// What the whiteboard canvas computes without touching the page: colors, shape outlines, pen
// strokes (perfect-freehand), simplifying the points a pen sends, snapping a moved selection to
// the edges and middles of other elements, and the board's clipboard format.
import { getStroke } from 'perfect-freehand'
import type { BoardElement, ColorName, ShapeName } from '@vasta/core'

// Colors ------------------------------------------------------------------------------------------

/** The strong tone of each color (Tailwind 600), for strokes, shape outlines and text. */
export const BOARD_COLORS: Record<ColorName, string> = {
  gray: '#57534e', red: '#dc2626', orange: '#ea580c', amber: '#d97706', yellow: '#ca8a04', lime: '#65a30d',
  green: '#16a34a', emerald: '#059669', teal: '#0d9488', cyan: '#0891b2', sky: '#0284c7', blue: '#2563eb',
  indigo: '#4f46e5', violet: '#7c3aed', purple: '#9333ea', fuchsia: '#c026d3', pink: '#db2777', rose: '#e11d48',
}

/** The few colors the selection bar and the pen offer (all of them still read back). */
export const PICKER_COLORS: ColorName[] = ['gray', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'violet', 'pink']

/** A line or outline color; without one, the ink color (follows the theme). */
export const strokeColor = (color?: ColorName) => (color ? BOARD_COLORS[color] : 'var(--color-ink)')

/** A soft fill in the color that reads in light and dark themes alike. */
export const fillColor = (color: ColorName | undefined, strength = 18) =>
  color ? `color-mix(in srgb, ${BOARD_COLORS[color]} ${strength}%, var(--color-surface))` : 'var(--color-surface)'

/** Paper tones for sticky notes (Tailwind 200): pastel in both themes, so their text stays dark. */
const PAPER: Record<ColorName, string> = {
  gray: '#e7e5e4', red: '#fecaca', orange: '#fed7aa', amber: '#fde68a', yellow: '#fef08a', lime: '#d9f99d',
  green: '#bbf7d0', emerald: '#a7f3d0', teal: '#99f6e4', cyan: '#a5f3fc', sky: '#bae6fd', blue: '#bfdbfe',
  indigo: '#c7d2fe', violet: '#ddd6fe', purple: '#e9d5ff', fuchsia: '#f5d0fe', pink: '#fbcfe8', rose: '#fecdd3',
}

/** A sticky note's paper: yellow unless it has a color. */
export const stickyColor = (color?: ColorName) => PAPER[color ?? 'yellow']
/** Text on a sticky note: dark on the pastel paper whatever the theme. */
export const STICKY_INK = '#1f1e1c'

// Shapes ------------------------------------------------------------------------------------------

export const SHAPE_LABELS: Record<ShapeName, string> = {
  rectangle: 'Rectangle', ellipse: 'Ellipse', diamond: 'Diamond', triangle: 'Triangle', parallelogram: 'Parallelogram', star: 'Star', heart: 'Heart',
}
export const SHAPE_ICONS: Record<ShapeName, string> = {
  rectangle: 'ph:square', ellipse: 'ph:circle', diamond: 'ph:diamond', triangle: 'ph:triangle', parallelogram: 'ph:parallelogram', star: 'ph:star', heart: 'ph:heart',
}

/** The SVG path of a shape filling a w × h box, inset by half the line width so it is not clipped. */
export function shapePath(shape: ShapeName, w: number, h: number, inset = 1): string {
  const [l, t, r, b] = [inset, inset, w - inset, h - inset]
  const [cx, cy] = [w / 2, h / 2]
  const f = (n: number) => Math.round(n * 100) / 100
  const poly = (points: [number, number][]) => `M${points.map(([x, y]) => `${f(x)},${f(y)}`).join(' L')} Z`
  switch (shape) {
    case 'ellipse':
      return `M${f(l)},${f(cy)} A${f(cx - l)},${f(cy - t)} 0 1 0 ${f(r)},${f(cy)} A${f(cx - l)},${f(cy - t)} 0 1 0 ${f(l)},${f(cy)} Z`
    case 'diamond':
      return poly([[cx, t], [r, cy], [cx, b], [l, cy]])
    case 'triangle':
      return poly([[cx, t], [r, b], [l, b]])
    case 'parallelogram': {
      const skew = Math.min((r - l) * 0.2, 40)
      return poly([[l + skew, t], [r, t], [r - skew, b], [l, b]])
    }
    case 'star': {
      const points: [number, number][] = []
      for (let i = 0; i < 10; i++) {
        const angle = -Math.PI / 2 + (i * Math.PI) / 5
        const k = i % 2 ? 0.45 : 1
        points.push([cx + Math.cos(angle) * (cx - l) * k, cy + 0.08 * (b - t) + Math.sin(angle) * (cy - t) * k])
      }
      return poly(points)
    }
    case 'heart': {
      const [W, H] = [r - l, b - t]
      const x = (n: number) => f(l + W * n)
      const y = (n: number) => f(t + H * n)
      return `M${x(0.5)},${y(1)} C${x(0.2)},${y(0.78)} ${x(0)},${y(0.55)} ${x(0)},${y(0.3)} C${x(0)},${y(0.1)} ${x(0.15)},${y(0)} ${x(0.28)},${y(0)} C${x(0.4)},${y(0)} ${x(0.5)},${y(0.12)} ${x(0.5)},${y(0.2)} C${x(0.5)},${y(0.12)} ${x(0.6)},${y(0)} ${x(0.72)},${y(0)} C${x(0.85)},${y(0)} ${x(1)},${y(0.1)} ${x(1)},${y(0.3)} C${x(1)},${y(0.55)} ${x(0.8)},${y(0.78)} ${x(0.5)},${y(1)} Z`
    }
    default:
      return `M${f(l)},${f(t)} H${f(r)} V${f(b)} H${f(l)} Z`
  }
}

// Pen strokes -------------------------------------------------------------------------------------

/** Points as perfect-freehand takes them, from a flat x, y, pressure list (scaled to the box). */
function pointTriples(points: number[], sx = 1, sy = 1): [number, number, number][] {
  const out: [number, number, number][] = []
  for (let i = 0; i + 2 < points.length; i += 3) out.push([points[i]! * sx, points[i + 1]! * sy, points[i + 2]!])
  return out
}

/**
 * The outline of a stroke as an SVG path (perfect-freehand draws a filled shape around the line).
 * `pen`: the points have real pressure (a pen), else speed stands in for it.
 */
export function strokePath(points: number[], size: number, options: { sx?: number; sy?: number; pen?: boolean; last?: boolean } = {}): string {
  const outline = getStroke(pointTriples(points, options.sx, options.sy), {
    size,
    // A light touch of a real pen still makes a line a third as wide, never a broken hairline.
    thinning: options.pen ? 0.45 : 0.5,
    easing: options.pen ? (t) => 0.3 + 0.7 * Math.sin((t * Math.PI) / 2) : (t) => t,
    smoothing: 0.6,
    streamline: 0.45,
    simulatePressure: !options.pen,
    last: options.last ?? true,
  })
  if (!outline.length) return ''
  const f = (n: number) => Math.round(n * 100) / 100
  // Quadratic curves through the midpoints, as perfect-freehand's own example does.
  let d = `M${f(outline[0]![0]!)},${f(outline[0]![1]!)} Q`
  for (let i = 0; i < outline.length; i++) {
    const [x0, y0] = outline[i]!
    const [x1, y1] = outline[(i + 1) % outline.length]!
    d += `${f(x0!)},${f(y0!)} ${f((x0! + x1!) / 2)},${f((y0! + y1!) / 2)} `
  }
  return `${d}Z`
}

/** Whether the points carry pressure from a pen (a mouse and fingers report 0.5 or 0 throughout). */
/** A dashed or dotted stroke is drawn as a line through its points (x, y, pressure in turn), scaled by sx, sy. */
export function centerlinePath(points: number[], sx = 1, sy = 1): string {
  const f = (n: number) => Math.round(n * 100) / 100
  let d = ''
  for (let i = 0; i + 1 < points.length; i += 3) d += `${i ? ' L' : 'M'}${f(points[i]! * sx)},${f(points[i + 1]! * sy)}`
  return d
}

export const hasPressure = (points: number[]) => {
  for (let i = 2; i < points.length; i += 3) if (points[i] !== 0.5 && points[i] !== 0) return true
  return false
}

/**
 * Drop points that add nothing to the line (Ramer–Douglas–Peucker over x and y, keeping each
 * kept point's pressure): a pen sends hundreds a second, most of them on a straight run.
 */
export function simplifyPoints(points: number[], tolerance: number): number[] {
  const n = points.length / 3
  if (n <= 2) return [...points]
  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  const x = (i: number) => points[i * 3]!
  const y = (i: number) => points[i * 3 + 1]!
  while (stack.length) {
    const [a, b] = stack.pop()!
    let worst = 0
    let index = -1
    const dx = x(b) - x(a)
    const dy = y(b) - y(a)
    const length = Math.hypot(dx, dy)
    for (let i = a + 1; i < b; i++) {
      const d = length ? Math.abs(dy * x(i) - dx * y(i) + x(b) * y(a) - y(b) * x(a)) / length : Math.hypot(x(i) - x(a), y(i) - y(a))
      if (d > worst) (worst = d), (index = i)
    }
    if (worst > tolerance && index > 0) {
      keep[index] = 1
      stack.push([a, index], [index, b])
    }
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(round(x(i)), round(y(i)), Math.round(points[i * 3 + 2]! * 100) / 100)
  return out
}
const round = (n: number) => Math.round(n * 100) / 100

/**
 * For a pen's points: drop only those closer than `minDistance` to the last one kept (the last
 * point always stays). Unlike simplifyPoints this keeps every change of pressure along the line,
 * so the width never jumps where points were left out.
 */
export function thinPoints(points: number[], minDistance: number): number[] {
  const n = points.length / 3
  if (n <= 2) return [...points]
  const out = [points[0]!, points[1]!, points[2]!]
  for (let i = 1; i < n; i++) {
    const [x, y, p] = [points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!]
    const last = i === n - 1
    if (!last && Math.hypot(x - out[out.length - 3]!, y - out[out.length - 2]!) < minDistance) continue
    out.push(round(x), round(y), Math.round(p * 100) / 100)
  }
  return out
}

/** A stroke drawn in board coordinates, as an element: its box and its points relative to the box's corner. */
export function strokeFromPoints(points: number[], size: number) {
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 2 < points.length; i += 3) {
    left = Math.min(left, points[i]!)
    right = Math.max(right, points[i]!)
    top = Math.min(top, points[i + 1]!)
    bottom = Math.max(bottom, points[i + 1]!)
  }
  // Room for the line's width around the points.
  const pad = size
  const x = Math.floor(left - pad)
  const y = Math.floor(top - pad)
  const relative: number[] = []
  for (let i = 0; i + 2 < points.length; i += 3) relative.push(round(points[i]! - x), round(points[i + 1]! - y), points[i + 2]!)
  const w = Math.ceil(right + pad - x)
  const h = Math.ceil(bottom + pad - y)
  return { x, y, w, h, sw: w, sh: h, points: relative }
}

// Snapping ----------------------------------------------------------------------------------------

export interface Box {
  x: number
  y: number
  w: number
  h: number
  /** Turned this many degrees clockwise around its middle (or around `o`, from its corner). */
  r?: number
  o?: { x: number; y: number }
}

// Turning ----------------------------------------------------------------------------------------

/** `p` turned `deg` degrees clockwise (y pointing down) around `c`. */
export function rotateAround(p: Point, c: Point, deg: number): Point {
  if (!deg) return p
  const a = (deg * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const dx = p.x - c.x
  const dy = p.y - c.y
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
}

/** The box around a turned box (for what is in view, fitting, the selection's bounds). */
export function turnedBounds(b: Box): Box {
  if (!b.r) return b
  const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  const corners = [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y },
    { x: b.x, y: b.y + b.h },
    { x: b.x + b.w, y: b.y + b.h },
  ].map((p) => rotateAround(p, c, b.r!))
  const xs = corners.map((p) => p.x)
  const ys = corners.map((p) => p.y)
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

/** An angle to turn to: whole degrees, held at a multiple of 45 within 4 degrees of it (of 15 with `step`). */
export function snapAngle(deg: number, step = false): number {
  const turn = ((deg % 360) + 360) % 360
  if (step) return (Math.round(turn / 15) * 15) % 360
  const near = Math.round(turn / 45) * 45
  return Math.abs(turn - near) <= 4 ? near % 360 : Math.round(turn)
}

// Lasso ------------------------------------------------------------------------------------------

/** Whether a point lies inside a closed loop of points (even-odd rule). */
export function pointInLoop(p: Point, loop: Point[]): boolean {
  let inside = false
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i]!
    const b = loop[j]!
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y || 1e-9) + a.x) inside = !inside
  }
  return inside
}

/**
 * Whether a lasso takes an element: its middle is inside the loop, or, for a stroke (whose box can
 * reach well past its ink), most of its points are.
 */
export function lassoTakes(loop: Point[], b: Box, points?: Point[]): boolean {
  if (loop.length < 3) return false
  if (points?.length) {
    const step = Math.max(1, Math.floor(points.length / 24))
    let inside = 0
    let total = 0
    for (let i = 0; i < points.length; i += step) (total++, pointInLoop(points[i]!, loop) && inside++)
    return inside / total >= 0.6
  }
  return pointInLoop({ x: b.x + b.w / 2, y: b.y + b.h / 2 }, loop)
}

/** A line to draw while snapped: vertical at x, or horizontal at y, between two points. */
export type Guide = { axis: 'x'; at: number; from: number; to: number } | { axis: 'y'; at: number; from: number; to: number }

/** The box around several boxes. */
export function bounds(boxes: Box[]): Box | undefined {
  if (!boxes.length) return undefined
  const left = Math.min(...boxes.map((b) => b.x))
  const top = Math.min(...boxes.map((b) => b.y))
  const right = Math.max(...boxes.map((b) => b.x + b.w))
  const bottom = Math.max(...boxes.map((b) => b.y + b.h))
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/**
 * Nudge a move so the moved box's left, middle or right lines up with another box's (and the same
 * for top, middle, bottom), when it is within `threshold`. Returns the adjusted move and the
 * guides to draw.
 */
export function snapMove(moving: Box, others: Box[], dx: number, dy: number, threshold: number): { dx: number; dy: number; guides: Guide[] } {
  const xs = (b: Box) => [b.x, b.x + b.w / 2, b.x + b.w]
  const ys = (b: Box) => [b.y, b.y + b.h / 2, b.y + b.h]
  const best = (mine: number[], theirs: (b: Box) => number[]) => {
    let found: { delta: number; at: number } | undefined
    for (const other of others)
      for (const target of theirs(other))
        for (const value of mine) {
          const delta = target - value
          if (Math.abs(delta) <= threshold && (!found || Math.abs(delta) < Math.abs(found.delta))) found = { delta, at: target }
        }
    return found
  }
  const moved = { ...moving, x: moving.x + dx, y: moving.y + dy }
  const sx = best(xs(moved), xs)
  const sy = best(ys(moved), ys)
  const final = { ...moved, x: moved.x + (sx?.delta ?? 0), y: moved.y + (sy?.delta ?? 0) }
  const guides: Guide[] = []
  if (sx) {
    const lined = others.filter((o) => xs(o).some((v) => Math.abs(v - sx.at) < 0.5))
    const all = bounds([final, ...lined])!
    guides.push({ axis: 'x', at: sx.at, from: all.y, to: all.y + all.h })
  }
  if (sy) {
    const lined = others.filter((o) => ys(o).some((v) => Math.abs(v - sy.at) < 0.5))
    const all = bounds([final, ...lined])!
    guides.push({ axis: 'y', at: sy.at, from: all.x, to: all.x + all.w })
  }
  return { dx: dx + (sx?.delta ?? 0), dy: dy + (sy?.delta ?? 0), guides }
}

// Clipboard ---------------------------------------------------------------------------------------

const CLIPBOARD_PREFIX = 'vasta-board:'

/** Elements as clipboard text: pasted into a board they come back as they were. */
export const boardClipboard = (elements: BoardElement[]) => CLIPBOARD_PREFIX + JSON.stringify({ version: 1, elements })

/** Elements from clipboard text, or undefined when the text is something else. */
export function parseBoardClipboard(text: string): BoardElement[] | undefined {
  if (!text.startsWith(CLIPBOARD_PREFIX)) return undefined
  try {
    const data = JSON.parse(text.slice(CLIPBOARD_PREFIX.length)) as { elements?: unknown }
    return Array.isArray(data.elements) ? (data.elements.filter((e) => e && typeof e === 'object' && typeof (e as BoardElement).id === 'string') as BoardElement[]) : undefined
  } catch {
    return undefined
  }
}

// Arrows ------------------------------------------------------------------------------------------

type Point = { x: number; y: number }
const middle = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })

/** Where a line from the middle of `b` towards `p` leaves it (its turned edges, when turned). */
export function edgePoint(b: Box, p: Point): Point {
  const c = middle(b)
  if (b.r) return rotateAround(edgePoint({ ...b, r: 0 }, rotateAround(p, c, -b.r)), c, b.r)
  const dx = p.x - c.x
  const dy = p.y - c.y
  if (!dx && !dy) return c
  const t = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity)
  return { x: c.x + dx * t, y: c.y + dy * t }
}

export type ArrowRoute = { kind: 'line' | 'curve' | 'elbow'; points: Point[]; mid: Point }

/**
 * The course of an arrow between two boxes: a straight line edge to edge, a curve bowing to the
 * left of the way it goes, or right angles from the sides facing each other. `mid` is where its
 * label sits.
 */
export function arrowRoute(a: Box, b: Box, path: 'straight' | 'curved' | 'elbow' = 'straight'): ArrowRoute {
  const ca = middle(a)
  const cb = middle(b)
  if (path === 'elbow') {
    const dx = cb.x - ca.x
    const dy = cb.y - ca.y
    if (Math.abs(dx) >= Math.abs(dy)) {
      const s = { x: dx > 0 ? a.x + a.w : a.x, y: ca.y }
      const e = { x: dx > 0 ? b.x : b.x + b.w, y: cb.y }
      const mx = (s.x + e.x) / 2
      return { kind: 'elbow', points: [s, { x: mx, y: s.y }, { x: mx, y: e.y }, e], mid: { x: mx, y: (s.y + e.y) / 2 } }
    }
    const s = { x: ca.x, y: dy > 0 ? a.y + a.h : a.y }
    const e = { x: cb.x, y: dy > 0 ? b.y : b.y + b.h }
    const my = (s.y + e.y) / 2
    return { kind: 'elbow', points: [s, { x: s.x, y: my }, { x: e.x, y: my }, e], mid: { x: (s.x + e.x) / 2, y: my } }
  }
  if (path === 'curved') {
    const length = Math.hypot(cb.x - ca.x, cb.y - ca.y) || 1
    // Bowed to the left of the way from a to b (on screen, y pointing down), by a quarter of the distance.
    const normal = { x: (cb.y - ca.y) / length, y: (ca.x - cb.x) / length }
    const bend = length * 0.25
    const c = { x: (ca.x + cb.x) / 2 + normal.x * bend, y: (ca.y + cb.y) / 2 + normal.y * bend }
    const s = edgePoint(a, c)
    const e = edgePoint(b, c)
    return { kind: 'curve', points: [s, c, e], mid: { x: 0.25 * s.x + 0.5 * c.x + 0.25 * e.x, y: 0.25 * s.y + 0.5 * c.y + 0.25 * e.y } }
  }
  const s = edgePoint(a, cb)
  const e = edgePoint(b, ca)
  return { kind: 'line', points: [s, e], mid: { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 } }
}

/** An arrow's course as SVG path data, its points mapped (to the screen) first. */
export function routePath(route: ArrowRoute, map: (p: Point) => Point = (p) => p): string {
  return pointsPath(route.kind, route.points.map(map))
}

/** SVG path data through a route's points, already on screen. */
export function pointsPath(kind: ArrowRoute['kind'], pts: Point[]): string {
  const f = (n: number) => Math.round(n * 100) / 100
  const at = (p: Point) => `${f(p.x)},${f(p.y)}`
  if (kind === 'curve') return `M${at(pts[0]!)} Q${at(pts[1]!)} ${at(pts[2]!)}`
  return `M${pts.map(at).join(' L')}`
}

/** How long an arrow's tips are, in line widths. */
const TIP_LENGTH: Record<'sm' | 'md' | 'lg', number> = { sm: 3.5, md: 5, lg: 7 }

export type TipMark = { kind: 'arrow' | 'dot'; d: string }

/**
 * The marks at an arrow's ends (filled triangles or dots, drawn as paths in the line's own color:
 * older Safari has no `context-stroke` for markers), and the course shortened under its arrowheads
 * so the line does not poke through their points. `points` and `width` are on screen.
 */
export function arrowTipMarks(points: Point[], tips: { start: 'arrow' | 'dot' | 'none'; end: 'arrow' | 'dot' | 'none' }, width: number, size: 'sm' | 'md' | 'lg' = 'md'): { points: Point[]; marks: TipMark[] } {
  const pts = points.map((p) => ({ ...p }))
  const marks: TipMark[] = []
  const length = Math.max(6, width * TIP_LENGTH[size])
  const f = (n: number) => Math.round(n * 100) / 100
  const end = (tip: 'arrow' | 'dot' | 'none', at: number, before: number) => {
    const p = pts[at]!
    const q = pts[before]!
    const d = Math.hypot(p.x - q.x, p.y - q.y)
    if (tip === 'none' || !d) return
    const ux = (p.x - q.x) / d
    const uy = (p.y - q.y) / d
    if (tip === 'dot') {
      const r = Math.max(3, width * (size === 'sm' ? 1.4 : size === 'lg' ? 2.6 : 1.9))
      marks.push({ kind: 'dot', d: `M${f(p.x - r)},${f(p.y)} a${f(r)},${f(r)} 0 1,0 ${f(r * 2)},0 a${f(r)},${f(r)} 0 1,0 ${f(-r * 2)},0 Z` })
      return
    }
    const half = length * 0.45
    const bx = p.x - ux * length
    const by = p.y - uy * length
    marks.push({ kind: 'arrow', d: `M${f(p.x)},${f(p.y)} L${f(bx - uy * half)},${f(by + ux * half)} L${f(bx + uy * half)},${f(by - ux * half)} Z` })
    // The line stops inside the head (not at its point), never past the point before it.
    const back = Math.min(length * 0.7, d * 0.9)
    pts[at] = { x: p.x - ux * back, y: p.y - uy * back }
  }
  if (pts.length >= 2) {
    end(tips.end, pts.length - 1, pts.length - 2)
    end(tips.start, 0, 1)
  }
  return { points: pts, marks }
}

/** An SVG dash pattern for a line of this width (dots need round caps). */
export function dashArray(dash: 'dashed' | 'dotted' | undefined, width: number): string | undefined {
  if (dash === 'dashed') return `${width * 4} ${width * 3}`
  if (dash === 'dotted') return `0 ${width * 2.4}`
  return undefined
}

// Snapping a resize -------------------------------------------------------------------------------

/** A new size whose right and bottom edges line up with other boxes' edges or middles, when within `threshold`. */
export function snapResize(box: Box, w: number, h: number, others: Box[], threshold: number): { w: number; h: number; guides: Guide[] } {
  const right = box.x + w
  const bottom = box.y + h
  let best: { x?: { at: number; d: number }; y?: { at: number; d: number } } = {}
  for (const o of others) {
    for (const at of [o.x, o.x + o.w / 2, o.x + o.w]) {
      const d = at - right
      if (Math.abs(d) <= threshold && (!best.x || Math.abs(d) < Math.abs(best.x.d))) best = { ...best, x: { at, d } }
    }
    for (const at of [o.y, o.y + o.h / 2, o.y + o.h]) {
      const d = at - bottom
      if (Math.abs(d) <= threshold && (!best.y || Math.abs(d) < Math.abs(best.y.d))) best = { ...best, y: { at, d } }
    }
  }
  const nw = w + (best.x?.d ?? 0)
  const nh = h + (best.y?.d ?? 0)
  const guides: Guide[] = []
  const span = (lined: Box[]) => bounds([{ ...box, w: nw, h: nh }, ...lined])!
  if (best.x) {
    const lined = others.filter((o) => [o.x, o.x + o.w / 2, o.x + o.w].some((v) => Math.abs(v - best.x!.at) < 0.5))
    const all = span(lined)
    guides.push({ axis: 'x', at: best.x.at, from: all.y, to: all.y + all.h })
  }
  if (best.y) {
    const lined = others.filter((o) => [o.y, o.y + o.h / 2, o.y + o.h].some((v) => Math.abs(v - best.y!.at) < 0.5))
    const all = span(lined)
    guides.push({ axis: 'y', at: best.y.at, from: all.x, to: all.x + all.w })
  }
  return { w: nw, h: nh, guides }
}
