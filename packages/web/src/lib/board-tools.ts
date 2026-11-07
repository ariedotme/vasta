// What the whiteboard's tools make, kept on this device: the pen's presets (pens and highlighters,
// each with its color, width and pattern), and the look of new shapes, sticky notes and arrows.
// The toolbar (components/whiteboard/BoardToolbar.vue) changes them; the canvas reads them when it
// makes something. Elements already on a board change through the selection bar instead.
import { reactive, watch } from 'vue'
import type { ArrowPath, ArrowTip, ColorName, Dash, Fill, FontSize, ShapeName } from '@vasta/core'

export interface PenPreset {
  highlight: boolean
  /** Left out: ink for a pen, yellow for a highlighter. */
  color?: ColorName
  /** Width on screen, in pixels (a zoomed-out board still gets the line it shows). */
  size: number
  dash?: Dash
}

export const PEN_SIZES = [1, 2, 4, 8]
export const HIGHLIGHT_SIZES = [10, 18, 28]

export interface ToolSettings {
  pens: PenPreset[]
  /** The preset the pen tool draws with. */
  pen: number
  shape: { kind: ShapeName; color?: ColorName; fill?: Fill; border?: number; dash?: Dash }
  sticky: { color?: ColorName; fontSize?: FontSize }
  arrow: { path?: ArrowPath; start: ArrowTip; end: ArrowTip; dash?: Dash; width?: number; color?: ColorName }
}

const DEFAULTS = (): ToolSettings => ({
  pens: [
    { highlight: false, size: 2 },
    { highlight: false, size: 4, color: 'blue' },
    { highlight: false, size: 2, color: 'red' },
    { highlight: true, size: 18 },
  ],
  pen: 0,
  shape: { kind: 'rectangle' },
  sticky: {},
  arrow: { start: 'none', end: 'arrow' },
})

const KEY = 'vasta.board-tools'

function load(): ToolSettings {
  const defaults = DEFAULTS()
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<ToolSettings> | null
    if (!saved || typeof saved !== 'object') return defaults
    const pens = Array.isArray(saved.pens) && saved.pens.length ? saved.pens.filter((p) => p && typeof p.size === 'number').slice(0, 6) : defaults.pens
    return {
      pens: pens.length ? pens : defaults.pens,
      pen: typeof saved.pen === 'number' && saved.pen >= 0 && saved.pen < pens.length ? saved.pen : 0,
      shape: { ...defaults.shape, ...saved.shape },
      sticky: { ...defaults.sticky, ...saved.sticky },
      arrow: { ...defaults.arrow, ...saved.arrow },
    }
  } catch {
    return defaults
  }
}

/** One copy for every board on the page, saved as it changes. */
export const toolSettings = reactive<ToolSettings>(load())
watch(
  toolSettings,
  (settings) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings))
    } catch {}
  },
  { deep: true }
)

export const activePen = () => toolSettings.pens[toolSettings.pen] ?? toolSettings.pens[0]!

/** Pick the first highlighter preset (the M key), adding one when there is none. */
export function pickHighlighter() {
  let index = toolSettings.pens.findIndex((p) => p.highlight)
  if (index < 0) index = toolSettings.pens.push({ highlight: true, size: 18 }) - 1
  toolSettings.pen = index
}
/** Pick the first pen preset (the P key, when the highlighter was in use). */
export function pickPen() {
  if (!activePen().highlight) return
  const index = toolSettings.pens.findIndex((p) => !p.highlight)
  if (index >= 0) toolSettings.pen = index
}
