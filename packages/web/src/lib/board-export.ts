// A whiteboard as a picture: an SVG drawn with the canvas's own outlines (shapes, pen strokes,
// arrows and their tips), in the light theme's colors so it reads anywhere; a PNG is that SVG
// rasterized. Cards show their object's title and type, text wraps by an estimate of its width
// (an SVG has no text layout, and a foreignObject would keep a PNG from being made in Safari).
import { arrowTips, attachedTo, isAttached, isPlaced, lineDash, type BoardElement, type PlacedElement } from '@vasta/core'
import {
  BOARD_COLORS,
  STICKY_INK,
  arrowRoute,
  arrowTipMarks,
  centerlinePath,
  dashArray,
  hasPressure,
  pointsPath,
  shapePath,
  stickyColor,
  strokePath,
  turnedBounds,
  type Box,
} from './whiteboard.ts'

const INK = '#1f1e1c'
const INK_SOFT = '#5f5c57'
const LINE = '#d6d3cc'
const PAPER = '#ffffff'
const CANVAS = '#f7f6f3'

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const color = (name: keyof typeof BOARD_COLORS | undefined, fallback = INK) => (name ? BOARD_COLORS[name] : fallback)
const tint = (name: keyof typeof BOARD_COLORS | undefined) => (name ? `${BOARD_COLORS[name]}2e` : PAPER)

/** Lines of text that fit a width, by an estimate of the font's average character width. */
function wrap(text: string, width: number, size: number): string[] {
  const perLine = Math.max(4, Math.floor(width / (size * 0.55)))
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/)) {
      if (!line) line = word
      else if ((line + ' ' + word).length <= perLine) line += ' ' + word
      else (lines.push(line), (line = word))
    }
    lines.push(line)
  }
  return lines
}
function textBlock(lines: string[], x: number, y: number, size: number, fill: string, anchor: 'start' | 'middle' = 'start', weight = 400) {
  return lines
    .map((line, i) => `<text x="${x}" y="${y + i * size * 1.3}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${escape(line)}</text>`)
    .join('')
}

export interface ExportOptions {
  /** A card's object: its title and its type's name. */
  card: (objectId: string) => { title: string; type?: string } | undefined
  padding?: number
}

/** The board (or the elements given) as a standalone SVG. */
export function boardSvg(elements: BoardElement[], options: ExportOptions): { svg: string; width: number; height: number } {
  const pad = options.padding ?? 40
  const placed = elements.filter(isPlaced)
  const byId = new Map(elements.map((e) => [e.id, e]))
  /** An element's box on the board (a stroke drawn on another is placed in that one's box). */
  const boxOf = (e: PlacedElement): Box => {
    if (isAttached(e)) {
      const parent = byId.get(e.parent)
      if (parent && isPlaced(parent)) return { x: parent.x + e.x * parent.w, y: parent.y + e.y * parent.h, w: e.w * parent.w, h: e.h * parent.h, r: parent.kind === 'frame' ? 0 : parent.rotation }
    }
    return { x: e.x, y: e.y, w: e.w, h: e.h, r: e.kind === 'frame' ? 0 : e.rotation }
  }
  const all = placed.map((e) => turnedBounds(boxOf(e)))
  const left = all.length ? Math.min(...all.map((b) => b.x)) : 0
  const top = all.length ? Math.min(...all.map((b) => b.y)) : 0
  const right = all.length ? Math.max(...all.map((b) => b.x + b.w)) : 400
  const bottom = all.length ? Math.max(...all.map((b) => b.y + b.h)) : 300
  const x0 = Math.floor(left - pad)
  const y0 = Math.floor(top - pad)
  const width = Math.ceil(right - left + pad * 2)
  const height = Math.ceil(bottom - top + pad * 2)

  const parts: string[] = []
  const element = (e: PlacedElement) => {
    const b = boxOf(e)
    const turn = b.r ? ` transform="rotate(${b.r} ${b.x + b.w / 2} ${b.y + b.h / 2})"` : ''
    const at = (inner: string) => `<g${turn}><g transform="translate(${b.x} ${b.y})">${inner}</g></g>`
    switch (e.kind) {
      case 'frame':
        return at(
          `<rect width="${b.w}" height="${b.h}" rx="12" fill="${e.color ? `${BOARD_COLORS[e.color]}14` : '#ffffff73'}" stroke="${LINE}" />` +
            `<text x="0" y="-6" font-size="13" fill="${INK_SOFT}">${escape(e.title?.trim() || 'Frame')}</text>`
        )
      case 'card': {
        const card = options.card(e.objectId)
        const title = card?.title || 'Untitled'
        const compact = e.view === 'compact'
        return at(
          `<rect width="${b.w}" height="${b.h}" rx="${compact ? 8 : 12}" fill="${PAPER}" stroke="${LINE}" />` +
            (compact
              ? textBlock([title], 12, b.h / 2 + 5, 14, INK, 'start', 600)
              : (card?.type ? textBlock([card.type], 14, 24, 11, INK_SOFT) : '') + textBlock(wrap(title, b.w - 28, 15).slice(0, 4), 14, card?.type ? 46 : 28, 15, INK, 'start', 600))
        )
      }
      case 'sticky': {
        const size = e.fontSize === 'sm' ? 13 : e.fontSize === 'lg' ? 20 : e.fontSize === 'xl' ? 28 : 15
        return at(`<rect width="${b.w}" height="${b.h}" rx="3" fill="${stickyColor(e.color)}" />` + textBlock(wrap(e.text, b.w - 24, size), 12, 12 + size, size, STICKY_INK))
      }
      case 'text':
        return at(textBlock(wrap(e.text, b.w - 8, 15), 4, 19, 15, color(e.color)))
      case 'shape': {
        const outline = e.border ?? 1.5
        const fill = e.fill === 'none' ? 'none' : e.fill === 'white' ? PAPER : e.fill === 'solid' ? color(e.color) : tint(e.color)
        const ink = e.fill === 'solid' ? PAPER : color(e.color)
        const lines = wrap(e.text, b.w - 24, 15)
        return at(
          `<path d="${shapePath(e.shape, b.w, b.h, outline)}" fill="${fill}" stroke="${color(e.color)}" stroke-width="${outline}" stroke-linejoin="round"${e.dash ? ` stroke-dasharray="${dashArray(e.dash, outline)}"` : ''} />` +
            textBlock(lines, b.w / 2, b.h / 2 - ((lines.length - 1) * 15 * 1.3) / 2 + 5, 15, ink, 'middle')
        )
      }
      case 'stroke': {
        const sx = b.w / e.sw
        const sy = b.h / e.sh
        if (e.dash && !e.highlight)
          return at(`<path d="${centerlinePath(e.points, sx, sy)}" fill="none" stroke="${color(e.color)}" stroke-width="${e.size}" stroke-dasharray="${dashArray(e.dash, e.size)}" stroke-linecap="round" stroke-linejoin="round" />`)
        const fill = color(e.color ?? (e.highlight ? 'yellow' : undefined))
        return at(`<path d="${strokePath(e.points, e.size, { sx, sy, pen: hasPressure(e.points) })}" fill="${fill}"${e.highlight ? ' fill-opacity="0.4"' : ''} />`)
      }
    }
  }

  // Frames under everything, then arrows, then the rest in their order (strokes drawn on an
  // element right above it), arrow labels on top.
  for (const e of placed) if (e.kind === 'frame') parts.push(element(e), ...attachedTo(e.id, placed).map(element))
  const labels: string[] = []
  for (const e of elements) {
    if (e.kind !== 'arrow') continue
    const from = byId.get(e.from)
    const to = byId.get(e.to)
    if (!from || !to || !isPlaced(from) || !isPlaced(to)) continue
    const route = arrowRoute(boxOf(from), boxOf(to), e.path, { from: e.fromSide, to: e.toSide, bend: e.bend })
    const width = e.width ?? 1.75
    const { points, marks } = arrowTipMarks(route.points, arrowTips(e), width, e.tipSize ?? 'md')
    const ink = color(e.color, INK_SOFT)
    const dash = dashArray(lineDash(e), width)
    parts.push(
      `<path d="${pointsPath(route.kind, points)}" fill="none" stroke="${ink}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ''} />`,
      ...marks.map((m) => `<path d="${m.d}" fill="${ink}" stroke="${ink}" stroke-width="${m.kind === 'arrow' ? width * 0.6 : 0}" stroke-linejoin="round" />`)
    )
    const label = e.label?.trim()
    if (label) {
      const w = label.length * 6.6 + 14
      labels.push(`<rect x="${route.mid.x - w / 2}" y="${route.mid.y - 10}" width="${w}" height="20" rx="5" fill="${PAPER}" stroke="${LINE}" />`, textBlock([label], route.mid.x, route.mid.y + 4, 12, INK_SOFT, 'middle'))
    }
  }
  for (const e of placed) if (e.kind !== 'frame' && !isAttached(e)) parts.push(element(e), ...attachedTo(e.id, placed).map(element))
  parts.push(...labels)

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${width} ${height}" width="${width}" height="${height}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif">` +
    `<rect x="${x0}" y="${y0}" width="${width}" height="${height}" fill="${CANVAS}" />${parts.join('')}</svg>`
  return { svg, width, height }
}

/** The SVG as a PNG, `scale` times its size (capped so a huge board still fits a canvas). */
export async function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  const k = Math.min(scale, 16000 / Math.max(width, height))
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const image = new Image()
    image.decoding = 'async'
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('the picture of the board could not be drawn'))
      image.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * k)
    canvas.height = Math.round(height * k)
    const context = canvas.getContext('2d')!
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('no PNG'))), 'image/png'))
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Save a file the browser makes (a download). */
export function download(blob: Blob, name: string) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 1000)
}
