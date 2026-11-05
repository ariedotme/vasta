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
