<script setup lang="ts">
// A whiteboard: object cards, text, shapes, sticky notes, pen strokes, frames and arrows on an
// endless canvas. The elements live in the board's Y.Doc (core board.ts); this component reads
// them on every change and writes through the board functions, so edits from other devices merge
// in while it is open. Elements are HTML (BoardItem) in a layer moved and scaled by the camera;
// arrows, guides, the marquee and the line being drawn are SVG in screen space, so that layer stays
// the size of the view at any zoom.
//
// Pens (the draw mode, kept on each device): in Auto, once a pen has touched the board it draws
// whatever the tool (select and hand included), and fingers move the view, select with a tap and
// move only what is already selected; in Pencil that holds from the start, in Touch fingers draw
// too. A pen down, a touch the size of a palm, or one just after the pen lifted is ignored. Two
// fingers tapped undo, three redo.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import {
  BOARD_FIELD,
  addBoardElements,
  arrowDashPatch,
  arrowTips,
  arrowTipsPatch,
  bringToFront,
  lineDash,
  attachedTo,
  boardToJsonCanvas,
  spotAfter,
  copyElements,
  insideFrame,
  isAttached,
  isPlaced,
  readBoard,
  removeBoardElements,
  sendToBack,
  updateBoardElements,
  type BoardElement,
  type BoardPatch,
  type CardView,
  type ColorName,
  type Id,
  type NewBoardElement,
  type ObjectSummary,
  type PlacedElement,
  type ShapeName,
} from '@vasta/core'
import { Y, readContent, writeContent, type JsonDoc } from '@vasta/editor-schema/yjs'
import { openText, useReplica } from '../../lib/replica.ts'
import { openRemoteText } from '../../lib/remote-text.ts'
import { api } from '../../lib/api.ts'
import { cachedSummary, lastError, primeSummaries, systemType, typesById, useSummaries } from '../../lib/state.ts'
import { openMenuAt, promptDialog, type MenuItem } from '../../lib/overlays.ts'
import { openObject } from '../../lib/open.ts'
import { displayTitle } from '../../lib/format.ts'
import { canvasElements, isMermaidFlowchart, mermaidElements } from '../../lib/board-actions.ts'
import {
  BOARD_COLORS,
  SHAPE_ICONS,
  SHAPE_LABELS,
  arrowRoute,
  arrowTipMarks,
  dashArray,
  edgePoint,
  pointsPath,
  routePath,
  snapResize,
  boardClipboard,
  bounds,
  lassoTakes,
  parseBoardClipboard,
  rotateAround,
  snapAngle,
  turnedBounds,
  simplifyPoints,
  snapMove,
  thinPoints,
  strokeColor,
  strokeFromPoints,
  strokePath,
  type Box,
  type Guide,
} from '../../lib/whiteboard.ts'
import AppIcon from '../AppIcon.vue'
import ObjectPicker from '../ObjectPicker.vue'
import PopoverMenu from '../PopoverMenu.vue'
import BoardItem from './BoardItem.vue'
import BoardToolbar, { type DrawMode, type Tool } from './BoardToolbar.vue'
import { activePen, pickHighlighter, pickPen, toolSettings } from '../../lib/board-tools.ts'
import SelectionBar from './SelectionBar.vue'

/**
 * `embedded`: a still view inside a note (no tools, no saved camera), showing `focus` (a frame:
 * a scene of the board) or the whole board.
 */
const props = defineProps<{ doc: Y.Doc; boardId: Id; title?: string; readonly?: boolean; embedded?: boolean; focus?: Id | null }>()

/** Origin of this page's writes: what undo covers. */
const LOCAL = 'whiteboard-local'
const SIZES = {
  card: { w: 260, h: 150 },
  shape: { w: 160, h: 100 },
  sticky: { w: 180, h: 180 },
  frame: { w: 640, h: 420 },
  text: { w: 220, h: 40 },
}
const MIN = { w: 24, h: 24 }
const MIN_ZOOM = 0.1
const MAX_ZOOM = 4
const SNAP_PX = 6

// Elements ------------------------------------------------------------------------

const elements = shallowRef<BoardElement[]>([])
let frame = 0
const refresh = () => {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(() => (elements.value = readBoard(props.doc)))
}
const byId = computed(() => new Map(elements.value.map((e) => [e.id, e])))
const placed = computed(() => elements.value.filter(isPlaced))
const arrows = computed(() => elements.value.filter((e) => e.kind === 'arrow'))
const cardIds = computed(() => [...new Set(placed.value.flatMap((e) => (e.kind === 'card' ? [e.objectId] : [])))])
const summaries = useSummaries(cardIds)
const summaryById = computed(() => new Map(summaries.value.map((s) => [s.id, s])))

const undo = new Y.UndoManager(props.doc.getMap(BOARD_FIELD), { trackedOrigins: new Set([LOCAL]), captureTimeout: 300 })
/** Whether there is something to undo or redo (for the buttons). */
const history = reactive({ undo: false, redo: false })
const syncHistory = () => Object.assign(history, { undo: undo.undoStack.length > 0, redo: undo.redoStack.length > 0 })
for (const name of ['stack-item-added', 'stack-item-popped', 'stack-cleared'] as const) undo.on(name, syncHistory)
/** Ids in the page's SVG are global: each board (several embeds on a page) gets its own. */
const gridId = `wb-grid-${Math.random().toString(36).slice(2, 8)}`

/** This page's own writes show at once (a new text gets its editor in the same tick); others' on the next frame. */
const now = () => {
  cancelAnimationFrame(frame)
  elements.value = readBoard(props.doc)
}
const add = (list: NewBoardElement[]) => {
  const ids = addBoardElements(props.doc, list, LOCAL)
  now()
  return ids
}
const update = (patches: Record<Id, BoardPatch>) => (updateBoardElements(props.doc, patches, LOCAL), now())
const remove = (ids: Id[]) => (removeBoardElements(props.doc, ids, LOCAL), now())

// Camera --------------------------------------------------------------------------

const root = ref<HTMLElement | null>(null)
const size = reactive({ w: 0, h: 0 })
const camera = reactive({ x: 0, y: 0, zoom: 1 })
const cameraKey = `vasta.board-camera.${props.boardId}`

/** A point of the view (from its top left) in board coordinates. */
const toWorld = (sx: number, sy: number) => ({ x: (sx - camera.x) / camera.zoom, y: (sy - camera.y) / camera.zoom })
const toScreen = (x: number, y: number) => ({ x: x * camera.zoom + camera.x, y: y * camera.zoom + camera.y })
const local = (event: { clientX: number; clientY: number }) => {
  const rect = root.value!.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}
/** An embedded board shows its scene (a frame) or everything; a little margin either way. */
function fitFocus() {
  const target = props.focus ? byId.value.get(props.focus) : undefined
  if (target && isPlaced(target)) fit([target], 2)
  else fit()
}
watch(
  () => props.focus,
  () => props.embedded && size.w && fitFocus()
)

// Scenes: the board's frames, top to bottom and left to right, picked from a menu always on
// screen (and stepped through with ‹ ›). Moving the view by hand leaves the scene.
const frames = computed(() => {
  const list = placed.value.filter((e) => e.kind === 'frame')
  const row = (e: PlacedElement) => Math.round(e.y / 60)
  return [...list].sort((a, b) => row(a) - row(b) || a.x - b.x)
})
const scene = ref<Id | null>(null)
const frameTitle = (frame: PlacedElement | undefined) => (frame?.kind === 'frame' && frame.title?.trim()) || 'Frame'
function goToScene(id: Id | null) {
  const frame = id ? frames.value.find((f) => f.id === id) : undefined
  if (frame) fit([frame], 2)
  else fit()
  // After fit moved the camera, which would clear it.
  void nextTick(() => (scene.value = frame ? frame.id : null))
}
function stepScene(step: number) {
  const list = frames.value
  if (!list.length) return
  const at = list.findIndex((f) => f.id === scene.value)
  const next = at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length
  goToScene(list[next]!.id)
}
const leaveScene = () => (scene.value = null)

/** The middle of the view, in board coordinates (where new things go). */
const viewCenter = () => toWorld(size.w / 2, size.h / 2)

// Kept as the point in the middle of the view, so the board opens on the same place in a
// narrower window (a phone, the page beside a sidebar).
function loadCamera(): boolean {
  try {
    const saved = JSON.parse(localStorage.getItem(cameraKey) ?? 'null') as { cx: number; cy: number; zoom: number } | null
    if (!saved || ![saved.cx, saved.cy, saved.zoom].every(Number.isFinite)) return false
    camera.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, saved.zoom))
    camera.x = size.w / 2 - saved.cx * camera.zoom
    camera.y = size.h / 2 - saved.cy * camera.zoom
    return true
  } catch {
    return false
  }
}
let saveTimer: ReturnType<typeof setTimeout> | undefined
watch(camera, () => {
  if (props.embedded) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const { x: cx, y: cy } = viewCenter()
    try {
      localStorage.setItem(cameraKey, JSON.stringify({ cx: Math.round(cx), cy: Math.round(cy), zoom: camera.zoom }))
    } catch {}
  }, 300)
})

function zoomAt(sx: number, sy: number, zoom: number) {
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
  const world = toWorld(sx, sy)
  camera.zoom = next
  camera.x = sx - world.x * next
  camera.y = sy - world.y * next
}

/** Show these elements whole, centered (everything when none are given). */
function fit(list: PlacedElement[] = placed.value, maxZoom = 1) {
  const all = bounds(list.map((e) => turnedBounds(box(e))))
  if (!all || !size.w) {
    Object.assign(camera, { x: size.w / 2, y: size.h / 2, zoom: 1 })
    return
  }
  // A small view (an embed in a note) keeps a margin to scale.
  const pad = Math.min(64, Math.min(size.w, size.h) / 12)
  const zoom = Math.min(maxZoom, Math.max(MIN_ZOOM, Math.min((size.w - pad * 2) / Math.max(all.w, 1), (size.h - pad * 2) / Math.max(all.h, 1))))
  camera.zoom = zoom
  camera.x = size.w / 2 - (all.x + all.w / 2) * zoom
  camera.y = size.h / 2 - (all.y + all.h / 2) * zoom
}

// Selection, previews -------------------------------------------------------------

const selection = ref<Set<Id>>(new Set())
const select = (ids: Iterable<Id>) => (selection.value = new Set(ids))
const selected = computed(() => elements.value.filter((e) => selection.value.has(e.id)))
const editing = ref<Id | null>(null)
const draft = ref('')
/**
 * While dragging: how far the moved elements went (the selection, and what lies in a moved
 * frame), the size being given to one element (and its corner, when turned), the angle one is
 * turned to, how much several are scaled, a text's height while typed, strokes being erased.
 */
const preview = reactive<{
  dx: number
  dy: number
  moving: Set<Id>
  resize: { id: Id; w: number; h: number; x?: number; y?: number } | null
  rotate: { id: Id; deg: number } | null
  scale: { ids: Set<Id>; from: Box; kx: number; ky: number } | null
  textH: Record<Id, number>
  erasing: Set<Id>
  guides: Guide[]
}>({
  dx: 0,
  dy: 0,
  moving: new Set(),
  resize: null,
  rotate: null,
  scale: null,
  textH: {},
  erasing: new Set(),
  guides: [],
})

/** Where an element is drawn now, with what is being dragged. */
function box(element: PlacedElement): Box {
  if (isAttached(element)) {
    const parent = byId.value.get(element.parent)
    if (parent && isPlaced(parent) && !isAttached(parent)) {
      const p = box(parent)
      // Moved on its own (not with the element it is drawn on).
      const own = preview.moving.has(element.id) && !preview.moving.has(parent.id)
      const b = { x: p.x + element.x * p.w + (own ? preview.dx : 0), y: p.y + element.y * p.h + (own ? preview.dy : 0), w: element.w * p.w, h: element.h * p.h }
      // Turned with the element it is drawn on, around that one's middle.
      return p.r ? { ...b, r: p.r, o: { x: p.x + p.w / 2 - b.x, y: p.y + p.h / 2 - b.y } } : b
    }
  }
  const moving = preview.moving.has(element.id)
  const resized = preview.resize?.id === element.id ? preview.resize : null
  const scaled = preview.scale?.ids.has(element.id) ? preview.scale : null
  let { x, y, w } = element
  let h = preview.textH[element.id] ?? element.h
  if (scaled) {
    x = scaled.from.x + (x - scaled.from.x) * scaled.kx
    y = scaled.from.y + (y - scaled.from.y) * scaled.ky
    w *= scaled.kx
    h *= scaled.ky
  }
  if (resized) (w = resized.w), (h = resized.h), (x = resized.x ?? x), (y = resized.y ?? y)
  const r = preview.rotate?.id === element.id ? preview.rotate.deg : element.kind === 'frame' ? 0 : element.rotation
  return { x: x + (moving ? preview.dx : 0), y: y + (moving ? preview.dy : 0), w, h, ...(r ? { r } : {}) }
}

const view = computed(() => {
  const margin = 200 / camera.zoom
  const a = toWorld(0, 0)
  const b = toWorld(size.w, size.h)
  return { left: a.x - margin, top: a.y - margin, right: b.x + margin, bottom: b.y + margin }
})
const inView = (b: Box) => b.x < view.value.right && b.x + b.w > view.value.left && b.y < view.value.bottom && b.y + b.h > view.value.top
/** Only what is in view (and what is selected) is drawn, so big boards stay quick. */
const shown = computed(() => {
  // Strokes drawn on an element are drawn right above it, whatever their own rank.
  const children = new Map<Id, PlacedElement[]>()
  for (const e of placed.value) if (isAttached(e)) children.set(e.parent, [...(children.get(e.parent) ?? []), e])
  const ordered: PlacedElement[] = []
  for (const e of placed.value) if (!isAttached(e)) ordered.push(e, ...(children.get(e.id) ?? []))
  return ordered.map((element, index) => ({ element, index, box: box(element) })).filter(({ element, box }) => selection.value.has(element.id) || inView(box))
})
/** The box of the element a stroke is drawn on, relative to the stroke's own box (to clip to it). */
function clipOf(element: PlacedElement, b: Box) {
  if (!isAttached(element)) return undefined
  const parent = byId.value.get(element.parent)
  if (!parent || !isPlaced(parent)) return undefined
  const p = box(parent)
  return { top: p.y - b.y, left: p.x - b.x, right: b.x + b.w - (p.x + p.w), bottom: b.y + b.h - (p.y + p.h) }
}
const lost = computed(() => placed.value.length > 0 && shown.value.length === 0)

const arrowPaths = computed(() =>
  arrows.value.flatMap((arrow) => {
    if (arrow.kind !== 'arrow') return []
    const from = byId.value.get(arrow.from)
    const to = byId.value.get(arrow.to)
    if (!from || !to || !isPlaced(from) || !isPlaced(to)) return []
    const a = box(from)
    const b = box(to)
    if (!inView(a) && !inView(b)) return []
    const route = arrowRoute(a, b, arrow.path)
    const width = lineWidth(arrow.width)
    const { points, marks } = arrowTipMarks(
      route.points.map((p) => toScreen(p.x, p.y)),
      arrowTips(arrow),
      width,
      arrow.tipSize ?? 'md'
    )
    // The full course (for picking it), and the one drawn, stopping inside its heads.
    return [{ arrow, d: routePath(route, (p) => toScreen(p.x, p.y)), line: pointsPath(route.kind, points), marks, width, dash: dashArray(lineDash(arrow), width), mid: route.mid }]
  })
)
const stroke = computed(() => Math.max(1, 1.75 * camera.zoom))
/** A line's width on screen: its own (in board units) or the usual one. */
const lineWidth = (width: number | undefined) => (width ? Math.max(1, width * camera.zoom) : stroke.value)
const arrowColor = (arrow: { id: Id; color?: ColorName }) => (selection.value.has(arrow.id) ? 'var(--color-accent)' : arrow.color ? BOARD_COLORS[arrow.color] : 'var(--color-ink-soft)')

// Tools ---------------------------------------------------------------------------

const tool = ref<Tool>('select')
/** The pen preset in use (a pen or a highlighter), and whether it highlights. */
const pen = computed(() => activePen())
const highlighting = computed(() => pen.value.highlight)
const spaceHeld = ref(false)
/** The element the pen draws on (strokes then move and scale with it), from the selection bar. */
const attach = ref<Id | null>(null)
const attachTarget = computed(() => {
  const target = attach.value ? byId.value.get(attach.value) : undefined
  return target && isPlaced(target) ? target : undefined
})
function drawOn(id: Id) {
  attach.value = id
  tool.value = 'pen'
  select([])
}
const stopDrawingOn = () => {
  attach.value = null
  if (drawing.value) tool.value = 'select'
}
/** How fingers and a pen share the work (see the top of this file), kept on this device. */
const DRAW_MODE_KEY = 'vasta.board-draw-mode'
const DRAW_MODES: { id: DrawMode; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'Once a pen touches the board, the pen draws and fingers move the view' },
  { id: 'pencil', label: 'Pen draws', hint: 'The pen draws with any tool; fingers move the view, select with a tap' },
  { id: 'touch', label: 'Fingers draw', hint: 'Fingers draw with the pen tool, as a pen or mouse does' },
]
const drawMode = ref<DrawMode>(readDrawMode())
function readDrawMode(): DrawMode {
  try {
    const saved = localStorage.getItem(DRAW_MODE_KEY)
    return saved === 'pencil' || saved === 'touch' ? saved : 'auto'
  } catch {
    return 'auto'
  }
}
watch(drawMode, (mode) => {
  try {
    localStorage.setItem(DRAW_MODE_KEY, mode)
  } catch {}
})
/** A pen touched the board (in Auto, it then draws and fingers navigate). */
const penSeen = ref(false)
const pencilOnly = computed(() => drawMode.value === 'pencil' || (drawMode.value === 'auto' && penSeen.value))
/** When the pen last lifted: a touch right after it is the hand landing, not a gesture. */
let penUpAt = -Infinity
const drawing = computed(() => tool.value === 'pen' || tool.value === 'eraser')
const stays = (t: Tool) => t === 'pen' || t === 'eraser' || t === 'hand' || t === 'lasso'

// Gestures ------------------------------------------------------------------------

type Point = { x: number; y: number }
type Gesture =
  /** `tap`: a finger on an element not selected pans, and selects it if it does not move. */
  | { kind: 'pan'; sx: number; sy: number; x: number; y: number; tap?: Id }
  | { kind: 'scroll'; el: HTMLElement; top: number; sy: number }
  | { kind: 'move'; start: Point; moved: boolean; sx: number; sy: number; from: Box | undefined; others: Box[] }
  /** `tl`: a turned element's top left corner, which stays put while its size changes. */
  | { kind: 'resize'; id: Id; start: Point; w: number; h: number; from: Box; others: Box[]; r: number; tl: Point }
  | { kind: 'rotate'; id: Id; center: Point; start: number; from: number }
  | { kind: 'scale'; ids: Set<Id>; start: Point; from: Box; others: Box[]; uniform: boolean }
  | { kind: 'lasso'; points: Point[]; keep: Set<Id> }
  | { kind: 'marquee'; start: Point; end: Point; keep: Set<Id> }
  | { kind: 'connect'; from: Id; end: Point }
  | { kind: 'create'; what: 'shape' | 'sticky' | 'frame'; start: Point; end: Point }
  | { kind: 'draw'; points: number[]; pressure: boolean; smooth: number; continues?: Id }
  | { kind: 'erase' }
  | { kind: 'pinch'; distance: number; zoom: number; mid: Point; cam: Point }
const gesture = shallowRef<Gesture | null>(null)
const pointers = new Map<number, Point & { type: string }>()
/** A tap of several fingers (undo, redo): when it started, the most fingers, whether they moved. */
let tap: { at: number; most: number; moved: boolean; starts: Map<number, Point> } | null = null
let penDown = false

const elementAt = (target: EventTarget | null) => (target as Element | null)?.closest?.<HTMLElement | SVGElement>('[data-element]')?.dataset.element
const arrowAt = (target: EventTarget | null) => (target as Element | null)?.closest?.<SVGElement | HTMLElement>('[data-arrow]')?.dataset.arrow
const handleAt = (target: EventTarget | null) => (target as HTMLElement | null)?.closest?.<HTMLElement>('[data-handle]')?.dataset.handle
const touches = () => [...pointers.values()].filter((p) => p.type === 'touch').length

function pinchState() {
  const [a, b] = [...pointers.values()]
  return { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y), mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 } }
}

function cancelGesture() {
  preview.dx = preview.dy = 0
  preview.moving = new Set()
  preview.resize = null
  preview.rotate = null
  preview.scale = null
  preview.erasing = new Set()
  preview.guides = []
  gesture.value = null
}

/** A pen's pressure; some report 0 on the first event of a line. */
const pressureOf = (e: PointerEvent) => (e.pointerType === 'pen' ? Math.max(e.pressure || 0.5, 0.05) : 0.5)
/** The pen's width is what it looks like on screen at the zoom it draws at, so a zoomed-out board still gets a visible line. */
const penWidth = () => pen.value.size / camera.zoom

const pan = (p: Point): Gesture => ({ kind: 'pan', sx: p.x, sy: p.y, x: camera.x, y: camera.y })

/** Start moving the selection, and what lies inside selected frames. */
function startMove(world: Point, p: Point) {
  const moving = new Set(selection.value)
  for (const element of selected.value) if (element.kind === 'frame') for (const inside of insideFrame(element, elements.value)) moving.add(inside.id)
  preview.moving = moving
  const movingBoxes = placed.value.filter((e) => moving.has(e.id)).map(box)
  const others = shown.value.filter(({ element }) => !moving.has(element.id) && element.kind !== 'stroke').map(({ box }) => box)
  gesture.value = { kind: 'move', start: world, moved: false, sx: p.x, sy: p.y, from: bounds(movingBoxes), others }
}

/** A stroke's points on the board (a sample is enough for the lasso). */
function strokePoints(e: PlacedElement): Point[] {
  if (e.kind !== 'stroke') return []
  const b = box(e)
  const sx = b.w / e.sw
  const sy = b.h / e.sh
  const out: Point[] = []
  for (let i = 0; i + 1 < e.points.length; i += 3) out.push({ x: b.x + e.points[i]! * sx, y: b.y + e.points[i + 1]! * sy })
  return out
}

/** The angle of the line from `c` to `p`, in degrees clockwise from pointing right. */
const angleOf = (c: Point, p: Point) => (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI

/** What a multi-selection's corner handle scales: the selection, and what lies in its frames. */
function scaling() {
  const ids = new Set<Id>()
  for (const element of selected.value) {
    if (!isPlaced(element) || isAttached(element)) continue
    ids.add(element.id)
    if (element.kind === 'frame') for (const inside of insideFrame(element, elements.value)) ids.add(inside.id)
  }
  return ids
}
function startScale(world: Point) {
  const ids = scaling()
  const from = bounds(placed.value.filter((e) => ids.has(e.id)).map((e) => turnedBounds(box(e))))
  if (!from) return
  const others = shown.value.filter(({ element }) => !ids.has(element.id) && element.kind !== 'stroke').map(({ box }) => box)
  // Strokes and turned elements keep their proportions.
  const uniform = placed.value.some((e) => ids.has(e.id) && (e.kind === 'stroke' || !!box(e).r))
  gesture.value = { kind: 'scale', ids, start: world, from, others, uniform }
}

function onPointerDown(event: PointerEvent) {
  if ((event.target as HTMLElement).closest('[data-ui]')) return
  if (editing.value && (event.target as HTMLElement).closest('textarea')) return
  const isTouch = event.pointerType === 'touch'
  // Palm rejection: a hand resting on the screen while the pen writes, landing as it lifts, or a
  // touch as wide as a palm.
  if (isTouch && (penDown || event.timeStamp - penUpAt < 400 || event.width > 75 || event.height > 75)) return
  if (event.pointerType === 'pen') (penSeen.value = true), (penDown = true)
  root.value?.focus({ preventScroll: true })
  const p = local(event)
  pointers.set(event.pointerId, { ...p, type: event.pointerType })
  try {
    root.value?.setPointerCapture(event.pointerId)
  } catch {} // a pointer that is already gone
  if (isTouch) {
    if (touches() === 1) tap = { at: event.timeStamp, most: 1, moved: false, starts: new Map() }
    if (tap) (tap.most = Math.max(tap.most, touches())), tap.starts.set(event.pointerId, p)
  }
  if (pointers.size === 2) {
    if (gesture.value?.kind === 'draw') return // a second finger while drawing with one: keep the line
    cancelGesture()
    const { distance, mid } = pinchState()
    gesture.value = { kind: 'pinch', distance, zoom: camera.zoom, mid, cam: { x: camera.x, y: camera.y } }
    return
  }
  if (pointers.size > 2) return
  if (editing.value) commitText()
  const world = toWorld(p.x, p.y)
  const elementId = elementAt(event.target)
  const handle = handleAt(event.target)
  if (event.button === 1 || spaceHeld.value || (tool.value === 'hand' && event.pointerType !== 'pen')) return void (gesture.value = pan(p))
  // A pen's eraser end (or its eraser button).
  if (event.pointerType === 'pen' && (event.button === 5 || event.buttons & 32) && !props.readonly) return startErase(event)
  if ((event.button !== 0 && event.pointerType === 'mouse') || props.readonly) {
    if (!elementId) gesture.value = pan(p)
    return
  }
  // A finger in a card's contents scrolls them (the board's own touch handling owns every touch).
  const scroller = isTouch ? (event.target as Element).closest?.<HTMLElement>('[data-scroll]') : null
  if (scroller && scroller.scrollHeight > scroller.clientHeight + 1 && !handle) {
    gesture.value = { kind: 'scroll', el: scroller, top: scroller.scrollTop, sy: p.y }
    return
  }
  // With a pen drawing, fingers navigate: they pan, a tap selects, and they move only what is
  // already selected (so a finger meant to move the view never drags a card along).
  if (isTouch && pencilOnly.value && !handle) {
    const select_ = tool.value === 'select' || tool.value === 'hand'
    if (elementId && select_ && selection.value.has(elementId)) return startMove(world, p)
    gesture.value = { ...pan(p), ...(elementId && select_ ? { tap: elementId } : {}) }
    return
  }
  // The pen draws whatever the tool, unless it is on a handle or a tool that makes things.
  const penDraws = event.pointerType === 'pen' && pencilOnly.value && !handle && (tool.value === 'select' || tool.value === 'hand')
  if (handle === 'scale') return startScale(world)
  if (handle && elementId) {
    const element = byId.value.get(elementId)
    if (handle === 'resize' && element && isPlaced(element)) {
      const others = shown.value.filter(({ element: e }) => e.id !== elementId && e.kind !== 'stroke').map(({ box }) => box)
      const from = box(element)
      const r = from.r ?? 0
      const tl = rotateAround({ x: from.x, y: from.y }, { x: from.x + from.w / 2, y: from.y + from.h / 2 }, r)
      gesture.value = { kind: 'resize', id: elementId, start: world, w: element.w, h: element.h, from, others, r, tl }
    } else if (handle === 'rotate' && element && isPlaced(element)) {
      const b = box(element)
      const center = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
      gesture.value = { kind: 'rotate', id: elementId, center, start: angleOf(center, world), from: b.r ?? 0 }
    } else if (handle === 'connect') gesture.value = { kind: 'connect', from: elementId, end: world }
    return
  }
  if (tool.value === 'lasso') {
    const keep = event.shiftKey ? new Set(selection.value) : new Set<Id>()
    select(keep)
    gesture.value = { kind: 'lasso', points: [world], keep }
    return
  }
  if (tool.value === 'pen' || penDraws) {
    // A pen lifted for an instant and put back where it left off goes on with the same line
    // (iPadOS can break a line in two mid-stroke).
    const last = lastLine
    const resumes = last && event.pointerType === 'pen' && event.timeStamp - last.at < 180 && Math.hypot(p.x - last.end.x, p.y - last.end.y) < 14 && byId.value.has(last.id) && last.attach === attach.value
    const smooth = pressureOf(event)
    gesture.value = resumes
      ? { kind: 'draw', points: [...last.points, world.x, world.y, smooth], pressure: true, smooth, continues: last.id }
      : { kind: 'draw', points: [world.x, world.y, smooth], pressure: event.pointerType === 'pen', smooth }
    select([])
    return
  }
  if (tool.value === 'eraser') return startErase(event)
  if (tool.value === 'arrow' && elementId) {
    gesture.value = { kind: 'connect', from: elementId, end: world }
    return
  }
  if (tool.value === 'text' && !elementId) {
    addText(world)
    tool.value = 'select'
    return
  }
  if ((tool.value === 'shape' || tool.value === 'sticky' || tool.value === 'frame') && (!elementId || byId.value.get(elementId)?.kind === 'frame')) {
    gesture.value = { kind: 'create', what: tool.value, start: world, end: world }
    return
  }
  if (elementId) {
    if (event.shiftKey) {
      const next = new Set(selection.value)
      if (next.has(elementId)) next.delete(elementId)
      else next.add(elementId)
      select(next)
    } else if (!selection.value.has(elementId)) select([elementId])
    startMove(world, p)
    return
  }
  const arrowId = arrowAt(event.target)
  if (arrowId) {
    select(event.shiftKey ? [...selection.value, arrowId] : [arrowId])
    return
  }
  // Empty board: a finger pans, a mouse or pen draws a selection box.
  if (isTouch) {
    select([])
    gesture.value = pan(p)
    return
  }
  const keep = event.shiftKey ? new Set(selection.value) : new Set<Id>()
  select(keep)
  gesture.value = { kind: 'marquee', start: world, end: world, keep }
}

function startErase(event: PointerEvent) {
  select([])
  gesture.value = { kind: 'erase' }
  eraseAt(event)
}
/** Strokes under the pointer join what is being erased (removed when the pointer lifts). */
function eraseAt(event: PointerEvent) {
  for (const target of document.elementsFromPoint(event.clientX, event.clientY)) {
    const id = elementAt(target)
    if (id && byId.value.get(id)?.kind === 'stroke' && !preview.erasing.has(id)) preview.erasing = new Set([...preview.erasing, id])
  }
}

function onPointerMove(event: PointerEvent) {
  if (!pointers.has(event.pointerId)) return
  const p = local(event)
  pointers.set(event.pointerId, { ...p, type: event.pointerType })
  const start = tap?.starts.get(event.pointerId)
  if (tap && start && Math.hypot(p.x - start.x, p.y - start.y) > 10) tap.moved = true
  const g = gesture.value
  if (!g) return
  const world = toWorld(p.x, p.y)
  if (g.kind === 'pinch' && pointers.size >= 2) {
    leaveScene()
    const { distance, mid } = pinchState()
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, g.zoom * (distance / g.distance)))
    // The point under the fingers' middle at the start stays under it.
    const anchor = { x: (g.mid.x - g.cam.x) / g.zoom, y: (g.mid.y - g.cam.y) / g.zoom }
    camera.zoom = zoom
    camera.x = mid.x - anchor.x * zoom
    camera.y = mid.y - anchor.y * zoom
  } else if (g.kind === 'scroll') {
    g.el.scrollTop = g.top - (p.y - g.sy)
  } else if (g.kind === 'pan') {
    leaveScene()
    camera.x = g.x + p.x - g.sx
    camera.y = g.y + p.y - g.sy
  } else if (g.kind === 'move') {
    if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) < 4) return
    g.moved = true
    const dx = world.x - g.start.x
    const dy = world.y - g.start.y
    // Lines up with other elements' edges and middles; Alt, Ctrl or ⌘ held moves freely.
    const free = event.altKey || event.ctrlKey || event.metaKey || !g.from
    const snapped = free ? { dx, dy, guides: [] } : snapMove(g.from!, g.others, dx, dy, SNAP_PX / camera.zoom)
    preview.dx = Math.round(snapped.dx)
    preview.dy = Math.round(snapped.dy)
    preview.guides = snapped.guides
  } else if (g.kind === 'resize') {
    // A turned element grows along its own sides (the pointer's move turned back by its angle).
    const d = rotateAround({ x: world.x - g.start.x, y: world.y - g.start.y }, { x: 0, y: 0 }, -g.r)
    let w = Math.max(MIN.w, Math.round(g.w + d.x))
    let h = Math.max(MIN.h, Math.round(g.h + d.y))
    const element = byId.value.get(g.id)
    // Strokes and Shift keep their proportions.
    if (event.shiftKey || element?.kind === 'stroke') {
      const k = Math.max(w / g.w, h / g.h)
      w = Math.max(MIN.w, Math.round(g.w * k))
      h = Math.max(MIN.h, Math.round(g.h * k))
      preview.guides = []
    } else if (!event.altKey && !event.ctrlKey && !event.metaKey && !g.r) {
      // The right and bottom edges line up with other elements, as a move does.
      const snapped = snapResize(g.from, w, h, g.others, SNAP_PX / camera.zoom)
      w = Math.max(MIN.w, Math.round(snapped.w))
      h = Math.max(MIN.h, Math.round(snapped.h))
      preview.guides = snapped.guides
    } else preview.guides = []
    if (g.r) {
      // The top left corner stays where it was: the middle moves half the growth, turned.
      const c = { x: g.tl.x + w / 2, y: g.tl.y + h / 2 }
      const middle = rotateAround(c, g.tl, g.r)
      preview.resize = { id: g.id, w, h, x: Math.round(middle.x - w / 2), y: Math.round(middle.y - h / 2) }
    } else preview.resize = { id: g.id, w, h }
  } else if (g.kind === 'rotate') {
    preview.rotate = { id: g.id, deg: snapAngle(g.from + angleOf(g.center, world) - g.start, event.shiftKey) }
  } else if (g.kind === 'scale') {
    let w = Math.max(MIN.w, g.from.w + world.x - g.start.x)
    let h = Math.max(MIN.h, g.from.h + world.y - g.start.y)
    if (g.uniform || event.shiftKey) {
      const k = Math.max(w / g.from.w, h / g.from.h)
      ;(w = g.from.w * k), (h = g.from.h * k)
      preview.guides = []
    } else if (!event.altKey && !event.ctrlKey && !event.metaKey) {
      const snapped = snapResize(g.from, w, h, g.others, SNAP_PX / camera.zoom)
      ;(w = Math.max(MIN.w, snapped.w)), (h = Math.max(MIN.h, snapped.h))
      preview.guides = snapped.guides
    } else preview.guides = []
    preview.scale = { ids: g.ids, from: g.from, kx: w / g.from.w, ky: h / g.from.h }
  } else if (g.kind === 'lasso') {
    gesture.value = { ...g, points: [...g.points, world] }
    const loop = gesture.value.points
    const taken = placed.value
      .filter((e) => !isAttached(e) && lassoTakes(loop, box(e), e.kind === 'stroke' ? strokePoints(e) : undefined))
      .map((e) => e.id)
    select([...g.keep, ...taken])
  } else if (g.kind === 'marquee') {
    gesture.value = { ...g, end: world }
    const [left, right] = [Math.min(g.start.x, world.x), Math.max(g.start.x, world.x)]
    const [top, bottom] = [Math.min(g.start.y, world.y), Math.max(g.start.y, world.y)]
    // A frame is taken only when the box holds it whole; other elements when it touches them.
    const inside = placed.value
      .filter((e) => {
        const b = box(e)
        return e.kind === 'frame' ? b.x >= left && b.y >= top && b.x + b.w <= right && b.y + b.h <= bottom : b.x < right && b.x + b.w > left && b.y < bottom && b.y + b.h > top
      })
      .map((e) => e.id)
    select([...g.keep, ...inside])
  } else if (g.kind === 'connect' || g.kind === 'create') {
    gesture.value = { ...g, end: world }
  } else if (g.kind === 'draw') {
    // Coalesced events carry the points a pen sent between two frames.
    const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : []
    const points = [...g.points]
    let smooth = g.smooth
    for (const e of events.length ? events : [event]) {
      const w = toWorld(local(e).x, local(e).y)
      // A pen's pressure readings jitter: follow them smoothly so the width does not flicker.
      smooth = g.pressure ? smooth + 0.35 * (pressureOf(e) - smooth) : 0.5
      points.push(Math.round(w.x * 100) / 100, Math.round(w.y * 100) / 100, Math.round(smooth * 1000) / 1000)
    }
    gesture.value = { ...g, points, smooth }
  } else if (g.kind === 'erase') {
    eraseAt(event)
  }
}

function onPointerUp(event: PointerEvent) {
  if (event.pointerType === 'pen') (penDown = false), (penUpAt = event.timeStamp)
  if (!pointers.delete(event.pointerId)) return
  // Fingers that touched and lifted together without moving: two undo, three redo.
  if (event.pointerType === 'touch' && tap && touches() === 0) {
    if (!tap.moved && event.timeStamp - tap.at < 350 && tap.most >= 2 && !props.readonly) {
      if (tap.most === 2) undo.undo()
      else undo.redo()
    }
    tap = null
  }
  const g = gesture.value
  if (g?.kind === 'pinch') {
    // Lifting one finger of two ends the pinch; the other does nothing until it lifts too.
    if (pointers.size === 0) gesture.value = null
    return
  }
  if (!g) return
  // The system took the pointer (a gesture, Scribble): keep what was drawn, drop anything else.
  if (event.type === 'pointercancel' && g.kind === 'draw') {
    finishStroke(g, event)
    return cancelGesture()
  }
  if (event.type === 'pointercancel' && g.kind !== 'pan') return cancelGesture()
  if (g.kind === 'pan' && g.tap && event.type !== 'pointercancel') {
    const p = local(event)
    if (Math.hypot(p.x - g.sx, p.y - g.sy) < 10) select(event.shiftKey ? [...selection.value, g.tap] : [g.tap])
  }
  if (g.kind === 'move' && g.moved && (preview.dx || preview.dy)) {
    const patches: Record<Id, BoardPatch> = {}
    for (const id of preview.moving) {
      const element = byId.value.get(id)
      if (!element || !isPlaced(element)) continue
      if (isAttached(element)) {
        // Moved on its own: its place on the element changes, in fractions of the element's box.
        const parent = byId.value.get(element.parent)
        if (preview.moving.has(element.parent) || !parent || !isPlaced(parent)) continue
        patches[id] = { x: element.x + preview.dx / parent.w, y: element.y + preview.dy / parent.h }
      } else patches[id] = { x: element.x + preview.dx, y: element.y + preview.dy }
    }
    update(patches)
  } else if (g.kind === 'resize' && preview.resize) {
    const { w, h, x, y } = preview.resize
    update({ [g.id]: { w, h, ...(x !== undefined && y !== undefined ? { x, y } : {}) } })
  } else if (g.kind === 'rotate' && preview.rotate) {
    update({ [g.id]: { rotation: preview.rotate.deg || undefined } })
  } else if (g.kind === 'scale' && preview.scale) {
    const patches: Record<Id, BoardPatch> = {}
    for (const id of preview.scale.ids) {
      const element = byId.value.get(id)
      if (!element || !isPlaced(element)) continue
      const b = box(element)
      patches[id] = { x: Math.round(b.x), y: Math.round(b.y), w: Math.max(MIN.w, Math.round(b.w)), h: Math.max(MIN.h, Math.round(b.h)) }
    }
    update(patches)
  } else if (g.kind === 'connect') {
    const target = elementAt(document.elementFromPoint(event.clientX, event.clientY))
    const exists = arrows.value.some((a) => a.kind === 'arrow' && ((a.from === g.from && a.to === target) || (a.from === target && a.to === g.from)))
    if (target && target !== g.from && !exists && byId.value.has(target)) select(add([newArrow(g.from, target)]))
    else if (!target && !props.readonly) connectMenu(g.from, event)
    if (!stays(tool.value)) tool.value = 'select'
  } else if (g.kind === 'create') {
    createAt(g)
  } else if (g.kind === 'draw') {
    finishStroke(g, event)
  } else if (g.kind === 'erase' && preview.erasing.size) {
    remove([...preview.erasing])
  }
  cancelGesture()
}

function onWheel(event: WheelEvent) {
  // A card showing its contents scrolls them, until they reach an end.
  const scroller = (event.target as Element | null)?.closest?.<HTMLElement>('[data-scroll]')
  if (scroller && !event.ctrlKey && !event.metaKey && scroller.scrollHeight > scroller.clientHeight + 1) {
    const atTop = scroller.scrollTop <= 0 && event.deltaY < 0
    const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1 && event.deltaY > 0
    if (!atTop && !atBottom) return
  }
  event.preventDefault()
  leaveScene()
  const p = local(event)
  // A trackpad pinch arrives as a wheel with Ctrl held, as does Ctrl or ⌘ with the wheel.
  if (event.ctrlKey || event.metaKey) zoomAt(p.x, p.y, camera.zoom * Math.exp(-event.deltaY * (event.deltaMode ? 0.05 : 0.01)))
  else {
    const unit = event.deltaMode === 1 ? 16 : 1
    camera.x -= (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit
    camera.y -= (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * unit
  }
}

function onStylusTouch(event: TouchEvent) {
  const touches = [...event.changedTouches] as (Touch & { touchType?: string })[]
  if (touches.some((t) => t.touchType === 'stylus')) event.preventDefault()
}

// Safari on a Mac pinches with gesture events instead of wheels.
let gestureZoom = 1
function onGestureStart(event: Event) {
  event.preventDefault()
  gestureZoom = camera.zoom
}
function onGestureChange(event: Event) {
  event.preventDefault()
  leaveScene()
  const e = event as Event & { scale: number; clientX: number; clientY: number }
  const p = local(e)
  zoomAt(p.x, p.y, gestureZoom * e.scale)
}

function onDoubleClick(event: MouseEvent) {
  if (props.readonly || (event.target as HTMLElement).closest('[data-ui]') || drawing.value) return
  const elementId = elementAt(event.target)
  const element = elementId ? byId.value.get(elementId) : undefined
  if (element?.kind === 'card') void openObject(element.objectId)
  else if (element?.kind === 'frame') void renameFrame(element.id)
  else if (element && 'text' in element) startEditing(element.id)
  else if (!element) {
    const arrowId = arrowAt(event.target)
    if (arrowId) void labelArrow(arrowId)
    else addText(toWorld(local(event).x, local(event).y))
  }
}

// Adding --------------------------------------------------------------------------

/** Where a new element goes: the point asked for, moved down and right past elements that start there. */
function freeSpot(x: number, y: number) {
  const taken = (px: number, py: number) => placed.value.some((e) => !isAttached(e) && Math.abs(e.x - px) < 12 && Math.abs(e.y - py) < 12)
  while (taken(x, y)) (x += 24), (y += 24)
  return { x, y }
}

function addCards(objectIds: Id[], at = viewCenter()) {
  let spot = { x: Math.round(at.x - SIZES.card.w / 2), y: Math.round(at.y - SIZES.card.h / 2) }
  const list = objectIds.map((objectId) => {
    spot = freeSpot(spot.x, spot.y)
    const card = { kind: 'card' as const, objectId, ...spot, ...SIZES.card }
    spot = { x: spot.x + 24, y: spot.y + 24 }
    return card
  })
  select(add(list))
}

function addText(at: Point, text = '') {
  const [id] = add([{ kind: 'text', text, x: Math.round(at.x), y: Math.round(at.y - 18), ...SIZES.text }])
  select([id!])
  if (!text) startEditing(id!)
  return id!
}

/** A shape, note or frame: the box dragged, or its usual size around the point clicked. */
/** What the tools make, from their settings (lib/board-tools.ts); defaults are left out. */
const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
const newShape = () => {
  const { kind, ...look } = toolSettings.shape
  return { shape: kind, ...defined(look) }
}
const newSticky = () => defined({ ...toolSettings.sticky })
function newArrow(from: Id, to: Id): NewBoardElement {
  const { start, end, path, dash, width, color } = toolSettings.arrow
  return { kind: 'arrow', from, to, ...defined({ path, width, color, ...arrowTipsPatch(start, end), ...arrowDashPatch(dash) }) } as NewBoardElement
}
function createAt(g: Extract<Gesture, { kind: 'create' }>) {
  const dragged = Math.abs(g.end.x - g.start.x) * camera.zoom > 8 || Math.abs(g.end.y - g.start.y) * camera.zoom > 8
  const usual = SIZES[g.what]
  const rect = dragged
    ? { x: Math.min(g.start.x, g.end.x), y: Math.min(g.start.y, g.end.y), w: Math.abs(g.end.x - g.start.x), h: Math.abs(g.end.y - g.start.y) }
    : { x: g.start.x - usual.w / 2, y: g.start.y - usual.h / 2, ...usual }
  const at = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.max(MIN.w, Math.round(rect.w)), h: Math.max(MIN.h, Math.round(rect.h)) }
  const element: NewBoardElement =
    g.what === 'shape' ? { kind: 'shape', text: '', ...newShape(), ...at } : g.what === 'sticky' ? { kind: 'sticky', text: '', ...newSticky(), ...at } : { kind: 'frame', ...at }
  const [id] = add([element])
  // A frame goes under what is already there.
  if (g.what === 'frame') sendToBack(props.doc, [id!], LOCAL), now()
  select([id!])
  tool.value = 'select'
  if (g.what === 'sticky') startEditing(id!)
}

/** The last line a pen drew: a pen put back down where it lifted, right away, continues it. */
let lastLine: { id: Id; at: number; end: Point; points: number[]; attach: Id | null } | null = null

function finishStroke(g: Extract<Gesture, { kind: 'draw' }>, event: PointerEvent) {
  const highlight = highlighting.value
  const size = Math.round(penWidth() * 100) / 100
  // A pen's points only thin out by distance (each keeps its pressure); a mouse's or finger's,
  // at an even width, simplify to the corners. A quarter of a screen pixel either way.
  const points = g.pressure ? thinPoints(g.points, 0.5 / camera.zoom) : simplifyPoints(g.points, 0.25 / camera.zoom)
  // A dot: a tap with the pen.
  if (points.length === 3) points.push(points[0]! + 0.5, points[1]! + 0.5, points[2]!)
  const placedStroke = strokeFromPoints(points, size)
  const target = attachTarget.value
  // On an element: the box in fractions of the element's, so it follows the element.
  const where = target
    ? (() => {
        const p = box(target)
        return { x: (placedStroke.x - p.x) / p.w, y: (placedStroke.y - p.y) / p.h, w: placedStroke.w / p.w, h: placedStroke.h / p.h, parent: target.id }
      })()
    : {}
  const stroke = { kind: 'stroke' as const, size, ...placedStroke, ...where, ...(pen.value.color ? { color: pen.value.color } : {}), ...(highlight ? { highlight: true } : {}), ...(pen.value.dash && !highlight ? { dash: pen.value.dash } : {}) }
  let id = g.continues
  if (id && byId.value.has(id)) {
    const { kind: _kind, ...fields } = stroke
    update({ [id]: fields })
  } else id = add([stroke])[0]!
  lastLine = event.pointerType === 'pen' ? { id, at: event.timeStamp, end: local(event), points: g.points, attach: attach.value } : null
}

// An arrow let go over empty space offers what to put there, joined to where it started.
const connectPick = ref<{ from: Id; at: Point; x: number; y: number } | null>(null)
const pointAnchor = ref<HTMLElement | null>(null)
function connectMenu(from: Id, event: PointerEvent) {
  const p = local(event)
  const at = toWorld(p.x, p.y)
  const make = (element: NewBoardElement, edit: boolean) => () => {
    const [id] = add([element])
    add([newArrow(from, id!)])
    select([id!])
    if (edit) startEditing(id!)
  }
  const centered = (w: number, h: number) => ({ x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2), w, h })
  openMenuAt(event.clientX, event.clientY, [
    { kind: 'heading', label: 'Connect to a new' },
    { label: 'Sticky note', icon: 'ph:note-blank', run: make({ kind: 'sticky', text: '', ...centered(SIZES.sticky.w, SIZES.sticky.h) }, true) },
    { label: 'Text', icon: 'ph:text-t', run: make({ kind: 'text', text: '', ...centered(SIZES.text.w, SIZES.text.h) }, true) },
    { label: SHAPE_LABELS[toolSettings.shape.kind], icon: SHAPE_ICONS[toolSettings.shape.kind], run: make({ kind: 'shape', text: '', ...newShape(), ...centered(SIZES.shape.w, SIZES.shape.h) }, true) },
    { label: 'Object…', icon: 'ph:cards', hint: '@', run: () => void nextTick(() => ((connectPick.value = { from, at, x: p.x, y: p.y }), (pickerOpen.value = true))) },
  ])
}

const pickerOpen = ref(false)
watch(pickerOpen, (open) => {
  if (!open) setTimeout(() => (connectPick.value = null), 0)
})
const pickerAnchor = ref<HTMLElement | null>(null)
/** A card for an object picked: in the middle of the view, or where an arrow was let go (joined to it). */
function placeCard(objectId: Id) {
  const link = connectPick.value
  if (!link) return addCards([objectId])
  const [id] = add([{ kind: 'card', objectId, x: Math.round(link.at.x - SIZES.card.w / 2), y: Math.round(link.at.y - SIZES.card.h / 2), ...SIZES.card }])
  add([{ kind: 'arrow', from: link.from, to: id! }])
  select([id!])
}
function picked(object: ObjectSummary) {
  primeSummaries([object])
  placeCard(object.id)
  pickerOpen.value = false
}
async function created(title: string) {
  const type = systemType('page')
  if (!type) return (pickerOpen.value = false)
  const object = await api.createObject({ typeId: type.id, title })
  placeCard(object.id)
  pickerOpen.value = false
}

/** An object's link (from the sidebar, a list, another page). */
function linkedObject(text: string): Id | null {
  const first = text.trim().split('\n')[0]!
  // Only a link: an address of this app, or a path from its root (plain words would resolve as a path too).
  if (!/^(https?:\/\/\S+|\/o\/\S+)$/.test(first)) return null
  try {
    const url = new URL(first, location.href)
    const match = /^\/o\/([^/]+)$/.exec(url.pathname)
    if (match && url.origin === location.origin) return decodeURIComponent(match[1]!)
  } catch {}
  return null
}
function onDragOver(event: DragEvent) {
  if (props.readonly || !event.dataTransfer?.types.includes('text/uri-list')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
}
function onDrop(event: DragEvent) {
  const data = event.dataTransfer
  const id = data && (linkedObject(data.getData('text/uri-list')) ?? linkedObject(data.getData('text/plain')))
  if (!id || id === props.boardId || props.readonly) return
  event.preventDefault()
  const p = local(event)
  addCards([id], toWorld(p.x, p.y))
}

// Clipboard, duplicate, order ------------------------------------------------------

/** The selection with the arrows between selected elements, and what lies in selected frames. */
function chosenForCopy(): BoardElement[] {
  const ids = new Set(selection.value)
  for (const element of selected.value) if (element.kind === 'frame') for (const inside of insideFrame(element, elements.value)) ids.add(inside.id)
  for (const id of [...ids]) for (const stroke of attachedTo(id, elements.value)) ids.add(stroke.id)
  for (const arrow of arrows.value) if (arrow.kind === 'arrow' && ids.has(arrow.from) && ids.has(arrow.to)) ids.add(arrow.id)
  return elements.value.filter((e) => ids.has(e.id))
}

function placeCopies(source: BoardElement[]) {
  const all = bounds(source.filter(isPlaced))
  if (!all) return
  // Beside the originals when they are in view, else in the middle of the view.
  const c = viewCenter()
  const visible = inView(all)
  const [dx, dy] = visible ? [24, 24] : [Math.round(c.x - all.x - all.w / 2), Math.round(c.y - all.y - all.h / 2)]
  const copies = copyElements(source, dx, dy)
  // Frames first, so they stay under what they hold.
  copies.sort((a, b) => Number(b.kind === 'frame') - Number(a.kind === 'frame'))
  const ids = add(copies)
  select(ids.filter((id) => copies.find((e) => e.id === id)?.kind !== 'arrow'))
}

function duplicate() {
  const source = chosenForCopy()
  if (source.length) placeCopies(source)
}

function onCopy(event: ClipboardEvent, cut = false) {
  if (editing.value || !selection.value.size || !event.clipboardData) return
  event.preventDefault()
  event.clipboardData.setData('text/plain', boardClipboard(chosenForCopy()))
  if (cut && !props.readonly) (remove([...selection.value]), select([]))
}

function onPaste(event: ClipboardEvent) {
  if (editing.value || props.readonly || !event.clipboardData) return
  const text = event.clipboardData.getData('text/plain')
  const elementsPasted = parseBoardClipboard(text)
  event.preventDefault()
  if (elementsPasted?.length) return placeCopies(elementsPasted)
  if (isMermaidFlowchart(text)) return void addFlowchart(text)
  if (/^\s*\{[\s\S]*"nodes"[\s\S]*\}\s*$/.test(text)) {
    try {
      return addCanvas(JSON.parse(text))
    } catch {} // not a canvas after all: pasted as text
  }
  const id = linkedObject(text)
  if (id && id !== props.boardId) return addCards([id])
  if (text.trim()) addText(viewCenter(), text.trim())
}

/** New elements (a flowchart, a canvas) are selected and brought into view. */
function addLaidOut(list: NewBoardElement[]) {
  const ids = add(list)
  const added = ids.flatMap((id) => {
    const element = byId.value.get(id)
    return element && isPlaced(element) ? [element] : []
  })
  select(added.map((e) => e.id))
  fit(added)
}
/** Where pasted or imported content goes: to the right of what the board has, clear of it. */
const layoutCorner = () => spotAfter(elements.value)
async function addFlowchart(source: string) {
  try {
    addLaidOut(await mermaidElements(source, layoutCorner(), props.boardId))
  } catch (error) {
    lastError.value = (error as Error).message
  }
}
function addCanvas(canvas: unknown) {
  try {
    const list = canvasElements(canvas, layoutCorner())
    // Frames first, so they stay under what they hold.
    addLaidOut(list.sort((a, b) => Number(b.kind === 'frame') - Number(a.kind === 'frame')))
  } catch (error) {
    lastError.value = `Not a JSON Canvas file: ${(error as Error).message}`
  }
}

// Board menu: JSON Canvas out and in, a flowchart in.
const fileInput = ref<HTMLInputElement | null>(null)
function exportCanvas() {
  const canvas = boardToJsonCanvas(elements.value, (id) => {
    const summary = cachedSummary(id)
    return summary ? { title: summary.title, url: `${location.origin}/o/${id}` } : undefined
  })
  const blob = new Blob([JSON.stringify(canvas, null, 2)], { type: 'application/json' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `${(props.title || 'Whiteboard').replace(/[\\/:*?"<>|]/g, '-')}.canvas`
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 1000)
}
async function importCanvas(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  ;(event.target as HTMLInputElement).value = ''
  if (!file) return
  try {
    addCanvas(JSON.parse(await file.text()))
  } catch {
    lastError.value = 'Not a JSON Canvas file.'
  }
}
async function askFlowchart() {
  const source = await promptDialog({ title: 'Add a Mermaid flowchart', placeholder: 'graph LR; A[Idea] --> B{Choose}', confirmLabel: 'Add' })
  if (source?.trim()) await addFlowchart(source.replace(/;\s*/g, '\n'))
}
function boardMenu(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  openMenuAt(rect.left, rect.bottom + 6, [
    { label: 'Export as JSON Canvas', icon: 'ph:download-simple', run: exportCanvas },
    ...(props.readonly
      ? []
      : [
          { label: 'Import a JSON Canvas…', icon: 'ph:upload-simple', run: () => fileInput.value?.click() },
          { label: 'Add a Mermaid flowchart…', icon: 'ph:flow-arrow', hint: 'or paste one', run: askFlowchart },
        ]),
    { kind: 'submenu', label: 'Pen and fingers', icon: 'ph:pencil-simple', items: drawModeItems() },
  ])
}
const drawModeItems = (): MenuItem[] => DRAW_MODES.map((m) => ({ label: m.label, hint: m.hint, checked: drawMode.value === m.id, run: () => (drawMode.value = m.id) }))

// Card views ----------------------------------------------------------------------

const VIEW_SIZES: Record<CardView, { w: number; h: number }> = { card: SIZES.card, compact: { w: 240, h: 44 }, embed: { w: 420, h: 320 }, properties: { w: 280, h: 200 } }
function setView(view: CardView) {
  const patches: Record<Id, BoardPatch> = {}
  for (const element of selected.value) if (element.kind === 'card') patches[element.id] = { view: view === 'card' ? undefined : view, ...VIEW_SIZES[view] }
  update(patches)
}

// Arrows as relations ---------------------------------------------------------------
// An arrow between two cards can write the second card's object into a relation property of the
// first's, so the link shows in backlinks and queries; the arrow remembers which property.

/** The two objects an arrow joins, when it joins two cards. */
function arrowObjects(arrow: BoardElement | undefined) {
  if (arrow?.kind !== 'arrow') return undefined
  const from = byId.value.get(arrow.from)
  const to = byId.value.get(arrow.to)
  if (from?.kind !== 'card' || to?.kind !== 'card') return undefined
  const a = summaryById.value.get(from.objectId)
  const b = summaryById.value.get(to.objectId)
  return a && b ? { arrow, a, b, typeA: typesById.value.get(a.typeId), typeB: typesById.value.get(b.typeId) } : undefined
}
const linkable = computed(() => (selected.value.length === 1 ? arrowObjects(selected.value[0]) : undefined))
function relationName(arrow: { relation?: string; from: Id }) {
  const from = byId.value.get(arrow.from)
  const type = from?.kind === 'card' ? typesById.value.get(summaryById.value.get(from.objectId)?.typeId ?? '') : undefined
  return type?.properties.find((p) => p.id === arrow.relation)?.name ?? 'Linked'
}

async function setRelation(arrowId: Id, propertyId: string, add: boolean) {
  const joined = arrowObjects(byId.value.get(arrowId))
  if (!joined) return
  const def = joined.typeA?.properties.find((p) => p.id === propertyId)
  if (def?.kind !== 'relation') return
  try {
    const object = await api.object(joined.a.id)
    const value = object.props[def.id]
    const ids = value?.kind === 'relation' ? value.value : []
    const next = add ? (def.multiple ? [...new Set([...ids, joined.b.id])] : [joined.b.id]) : ids.filter((id) => id !== joined.b.id)
    const props = { ...object.props }
    if (next.length) props[def.id] = { kind: 'relation', value: next }
    else delete props[def.id]
    const saved = await api.saveObject({ ...object, props }, object)
    primeSummaries([{ ...saved, preview: joined.a.preview }])
    update({ [arrowId]: { relation: add ? def.id : undefined } })
  } catch (error) {
    lastError.value = (error as Error).message
  }
}

/** The second card's object mentioned at the end of the first's text (its first text field), as a new line. */
async function mentionInText(arrowId: Id) {
  const joined = arrowObjects(byId.value.get(arrowId))
  const field = joined?.typeA?.properties.find((p) => p.kind === 'rich-text')?.id
  if (!joined || !field) return
  try {
    const session = useReplica() ? await openText(joined.a.id) : await openRemoteText(joined.a.id)
    try {
      const current = (readContent(session.doc)[field] as JsonDoc | undefined) ?? { type: 'doc', content: [] }
      const line = { type: 'paragraph', content: [{ type: 'mention', attrs: { objectId: joined.b.id, label: joined.b.title } }] }
      writeContent(session.doc, { [field]: { ...current, content: [...current.content, line] } }, undefined, [field])
    } finally {
      session.release()
    }
    update({ [arrowId]: { mentioned: true } })
  } catch (error) {
    lastError.value = (error as Error).message
  }
}

/** The relation properties that can hold the arrow's target, to pick one (or to undo the link). */
function linkMenu(event: MouseEvent) {
  const joined = linkable.value
  if (!joined) return
  const { arrow, typeA, typeB, a, b } = joined
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const options = (typeA?.properties ?? []).filter((p) => p.kind === 'relation' && (!p.targetTypeIds.length || p.targetTypeIds.includes(b.typeId)))
  const items: MenuItem[] = [{ kind: 'heading', label: `${displayTitle(a, typeA)} → ${displayTitle(b, typeB)}` }]
  if (arrow.kind === 'arrow' && arrow.relation) items.push({ label: `Unlink (remove from ${relationName(arrow)})`, icon: 'ph:link-break', run: () => setRelation(arrow.id, arrow.relation!, false) })
  else if (options.length) for (const p of options) items.push({ label: `Add to “${p.name}”`, icon: 'ph:link-simple', run: () => setRelation(arrow.id, p.id, true) })
  else items.push({ label: `${typeA?.name ?? 'This type'} has no relation property that takes ${typeB?.pluralName ?? 'these'}`, disabled: true, run: () => {} })
  // Or a mention in the text, for any two objects (the type needs a text field).
  if (arrow.kind === 'arrow' && typeA?.properties.some((p) => p.kind === 'rich-text')) {
    items.push({ kind: 'separator' })
    items.push(
      arrow.mentioned
        ? { label: `Mentioned in ${displayTitle(a, typeA)}’s text`, icon: 'ph:at', disabled: true, run: () => {} }
        : { label: `Mention it in ${displayTitle(a, typeA)}’s text`, icon: 'ph:at', run: () => mentionInText(arrow.id) }
    )
  }
  openMenuAt(rect.left, rect.bottom + 6, items)
}

function setArrowStyle(patch: BoardPatch) {
  const patches: Record<Id, BoardPatch> = {}
  for (const element of selected.value) if (element.kind === 'arrow') patches[element.id] = patch
  update(patches)
}

function setColor(color: ColorName | undefined) {
  const patches: Record<Id, BoardPatch> = {}
  for (const element of selected.value) if (element.kind !== 'card') patches[element.id] = { color }
  update(patches)
}
function setShape(shape: ShapeName) {
  toolSettings.shape.kind = shape
  const patches: Record<Id, BoardPatch> = {}
  for (const element of selected.value) if (element.kind === 'shape') patches[element.id] = { shape }
  update(patches)
}
const toFront = () => (bringToFront(props.doc, [...selection.value], LOCAL), now())
const toBack = () => (sendToBack(props.doc, [...selection.value], LOCAL), now())
function openSelected() {
  const element = selected.value[0]
  if (element?.kind === 'card') void openObject(element.objectId)
}
function removeSelection() {
  if (selection.value.size) remove([...selection.value])
  select([])
}

// Text ----------------------------------------------------------------------------

// A plain variable set by the item's function ref: one textarea at a time.
let editor: HTMLTextAreaElement | null = null
const setEditor = (el: HTMLTextAreaElement | null) => (editor = el)
function startEditing(id: Id) {
  const element = byId.value.get(id) ?? readBoard(props.doc).find((e) => e.id === id)
  editing.value = id
  draft.value = element && 'text' in element ? element.text : ''
  void nextTick(() => {
    editor?.focus()
    editor?.select()
    fitText()
  })
}
/** Text elements grow with what is typed; shapes and notes keep their box. */
function fitText() {
  const el = editor
  const id = editing.value
  if (!el || !id || byId.value.get(id)?.kind !== 'text') return
  el.style.height = 'auto'
  preview.textH = { [id]: Math.max(MIN.h, Math.ceil(el.scrollHeight) + 4) }
  el.style.height = ''
}
function commitText() {
  const id = editing.value
  if (!id) return
  editing.value = null
  const element = byId.value.get(id)
  const h = preview.textH[id]
  preview.textH = {}
  if (element?.kind === 'text' && !draft.value.trim()) remove([id])
  else if (element && 'text' in element && (draft.value !== element.text || h)) update({ [id]: { text: draft.value, ...(h ? { h } : {}) } })
  root.value?.focus({ preventScroll: true })
}

async function labelArrow(id: Id) {
  const arrow = byId.value.get(id)
  if (arrow?.kind !== 'arrow') return
  const label = await promptDialog({ title: 'Arrow label', value: arrow.label ?? '', placeholder: 'What links them', optional: true, confirmLabel: 'Save' })
  if (label !== null) update({ [id]: { label: label.trim() || undefined } })
}
async function renameFrame(id: Id) {
  const element = byId.value.get(id)
  if (element?.kind !== 'frame') return
  const title = await promptDialog({ title: 'Frame title', value: element.title ?? '', placeholder: 'Frame', optional: true, confirmLabel: 'Save' })
  if (title !== null) update({ [id]: { title: title.trim() || undefined } })
}

// Keyboard ------------------------------------------------------------------------

const TOOL_KEYS: Record<string, Tool> = { v: 'select', q: 'lasso', h: 'hand', t: 'text', s: 'sticky', p: 'pen', m: 'pen', e: 'eraser', f: 'frame', l: 'arrow', a: 'arrow' }
const SHAPE_KEYS: Record<string, ShapeName> = { r: 'rectangle', o: 'ellipse', d: 'diamond' }

function onKeyDown(event: KeyboardEvent) {
  if (editing.value) {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      commitText()
    }
    return
  }
  if ((event.target as HTMLElement).closest('[data-ui]')) return
  const mod = event.metaKey || event.ctrlKey
  const key = event.key.toLowerCase()
  if (key === ' ') {
    event.preventDefault()
    spaceHeld.value = true
    return
  }
  if (mod && key === 'z') {
    event.preventDefault()
    if (props.readonly) return
    if (event.shiftKey) undo.redo()
    else undo.undo()
    return
  }
  if (mod && key === 'y') return (event.preventDefault(), void (!props.readonly && undo.redo()))
  if (mod && key === 'a') return (event.preventDefault(), select(elements.value.map((e) => e.id)))
  if (mod && key === 'd') return (event.preventDefault(), void (!props.readonly && duplicate()))
  if (mod && key === '0') return (event.preventDefault(), zoomAt(size.w / 2, size.h / 2, 1))
  if (mod || event.altKey) return
  if (event.shiftKey && (event.code === 'Digit1' || key === '!')) return (event.preventDefault(), fit())
  if (event.shiftKey && event.code === 'Digit2') {
    event.preventDefault()
    const chosen = placed.value.filter((e) => selection.value.has(e.id))
    return fit(chosen.length ? chosen : placed.value, 2)
  }
  if (event.shiftKey && event.code === 'Digit0') return (event.preventDefault(), zoomAt(size.w / 2, size.h / 2, 1))
  if (key === 'escape') {
    // Steps out in layers: the selection and the tool first, then whatever holds the board (full screen).
    if (!selection.value.size && tool.value === 'select' && !attach.value) return
    event.stopPropagation()
    select([])
    tool.value = 'select'
    attach.value = null
    return
  }
  if (event.key === '@') return (event.preventDefault(), void (!props.readonly && (pickerOpen.value = true)))
  if (props.readonly) return
  if (key === 'delete' || key === 'backspace') {
    event.preventDefault()
    removeSelection()
  } else if (key === 'enter' && selection.value.size === 1) {
    const element = selected.value[0]
    event.preventDefault()
    if (element?.kind === 'arrow') void labelArrow(element.id)
    else if (element?.kind === 'frame') void renameFrame(element.id)
    else if (element?.kind === 'card') void openObject(element.objectId)
    else if (element && 'text' in element) startEditing(element.id)
  } else if (key.startsWith('arrow') && selection.value.size) {
    event.preventDefault()
    const step = event.shiftKey ? 10 : 1
    const [dx, dy] = key === 'arrowleft' ? [-step, 0] : key === 'arrowright' ? [step, 0] : key === 'arrowup' ? [0, -step] : [0, step]
    const patches: Record<Id, BoardPatch> = {}
    for (const element of selected.value) if (isPlaced(element) && !isAttached(element)) patches[element.id] = { x: element.x + dx, y: element.y + dy }
    update(patches)
  } else if (key === ']') toFront()
  else if (key === '[') toBack()
  else if (SHAPE_KEYS[key]) (toolSettings.shape.kind = SHAPE_KEYS[key]!), (tool.value = 'shape')
  else if (TOOL_KEYS[key]) {
    if (key === 'm') pickHighlighter()
    else if (key === 'p') pickPen()
    tool.value = TOOL_KEYS[key]!
  }
}
function onKeyUp(event: KeyboardEvent) {
  if (event.key === ' ') spaceHeld.value = false
}

// Lifecycle -----------------------------------------------------------------------

let observer: ResizeObserver | undefined
onMounted(() => {
  elements.value = readBoard(props.doc)
  props.doc.on('update', refresh)
  observer = new ResizeObserver(([entry]) => {
    const first = !size.w
    size.w = entry!.contentRect.width
    size.h = entry!.contentRect.height
    if (first && (props.embedded || !loadCamera())) fitFocus()
  })
  observer.observe(root.value!)
  // iPadOS Scribble and text selection take a Pencil's touches (breaking a line in the middle)
  // unless they are cancelled; fingers keep their touches for the browser.
  root.value!.addEventListener('touchstart', onStylusTouch, { passive: false })
  root.value!.addEventListener('touchmove', onStylusTouch, { passive: false })
  root.value!.addEventListener('gesturestart', onGestureStart)
  root.value!.addEventListener('gesturechange', onGestureChange)
})
onBeforeUnmount(() => {
  if (editing.value) commitText()
  props.doc.off('update', refresh)
  cancelAnimationFrame(frame)
  observer?.disconnect()
  undo.destroy()
})
// Elements another device deleted leave the selection.
watch(elements, (list) => {
  const ids = new Set(list.map((e) => e.id))
  if ([...selection.value].some((id) => !ids.has(id))) select([...selection.value].filter((id) => ids.has(id)))
  if (editing.value && !ids.has(editing.value)) editing.value = null
})
watch(tool, (t) => {
  if (t !== 'select' && t !== 'hand' && t !== 'lasso') select([])
  // Drawing on an element ends with a tool that does not draw.
  if (t !== 'pen' && t !== 'eraser' && t !== 'hand') attach.value = null
})
watch(attachTarget, (target) => {
  if (!target) attach.value = null
})

// What is drawn over the board ---------------------------------------------------------

const quiet = computed(() => !!gesture.value && gesture.value.kind !== 'marquee')
const selectedOne = computed(() => {
  if (selection.value.size !== 1 || quiet.value) return undefined
  const element = byId.value.get([...selection.value][0]!)
  return element && isPlaced(element) ? element : undefined
})

/** Several placed elements selected: the box around them (where the scale handle goes). */
const selectionBox = computed(() => {
  if (quiet.value && gesture.value?.kind !== 'scale') return null
  const list = selected.value.filter((e): e is PlacedElement => isPlaced(e) && !isAttached(e))
  if (list.length < 2) return null
  return bounds(list.map((e) => turnedBounds(box(e))))
})
/** The lasso's loop, on screen. */
const lassoPath = computed(() => {
  const g = gesture.value
  if (g?.kind !== 'lasso' || g.points.length < 2) return null
  return g.points.map((p, i) => `${i ? 'L' : 'M'}${toScreen(p.x, p.y).x},${toScreen(p.x, p.y).y}`).join(' ') + ' Z'
})

/** The bar sits above the selection (below it near the top of the view). */
const bar = computed(() => {
  if (!selection.value.size || quiet.value || editing.value || props.readonly) return null
  const boxes = selected.value.flatMap((e) => {
    if (isPlaced(e)) return [turnedBounds(box(e))]
    const path = arrowPaths.value.find((p) => p.arrow.id === e.id)
    return path ? [{ x: path.mid.x, y: path.mid.y, w: 0, h: 0 }] : []
  })
  const all = bounds(boxes)
  if (!all) return null
  const top = toScreen(all.x + all.w / 2, all.y)
  const bottom = toScreen(all.x, all.y + all.h)
  const below = top.y < 64
  return { x: Math.min(Math.max(top.x, 140), size.w - 140), y: below ? Math.min(bottom.y + 16, size.h - 120) : top.y - 14, below }
})

/** The board's own width decides the layout (a narrow board beside the sidebar on a wide screen too). */
const narrow = computed(() => size.w < 720)

/**
 * The dot grid follows the camera exactly: an SVG pattern in board units. (A CSS background rounds
 * its tile to whole pixels in Safari, so far from the origin the dots drifted away from the
 * elements while zooming.)
 */
const grid = computed(() => {
  // Zoomed far out, every other dot goes, so they never crowd into a grey wash.
  let step = 24
  while (step * camera.zoom < 12) step *= 2
  return { step, transform: `translate(${camera.x} ${camera.y}) scale(${camera.zoom})`, r: 1 / camera.zoom }
})
const marquee = computed(() => {
  const g = gesture.value
  if (g?.kind !== 'marquee' && g?.kind !== 'create') return null
  const a = toScreen(g.start.x, g.start.y)
  const b = toScreen(g.end.x, g.end.y)
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y), dashed: g.kind === 'create' }
})
const connecting = computed(() => {
  const g = gesture.value
  if (g?.kind !== 'connect') return null
  const from = byId.value.get(g.from)
  if (!from || !isPlaced(from)) return null
  const start = edgePoint(box(from), g.end)
  const { points, marks } = arrowTipMarks([toScreen(start.x, start.y), toScreen(g.end.x, g.end.y)], { start: 'none', end: 'arrow' }, stroke.value)
  return { s: points[0]!, e: points[1]!, marks }
})
/** The line being drawn, in board coordinates (inside the camera's layer). */
const ink = computed(() => {
  const g = gesture.value
  if (g?.kind !== 'draw') return null
  const highlight = highlighting.value
  return {
    d: strokePath(g.points, penWidth(), { pen: g.pressure, last: false }),
    fill: strokeColor(pen.value.color ?? (highlight ? 'yellow' : undefined)),
    opacity: highlight ? 0.4 : 1,
  }
})
/** The focused frame of an embedded scene, on screen. */
const sceneBox = computed(() => {
  const frame = props.focus ? byId.value.get(props.focus) : undefined
  if (!frame || !isPlaced(frame)) return null
  const b = box(frame)
  const a = toScreen(b.x, b.y)
  return { x: a.x, y: a.y, w: b.w * camera.zoom, h: b.h * camera.zoom }
})
const guideLines = computed(() =>
  preview.guides.map((g) => {
    const a = g.axis === 'x' ? toScreen(g.at, g.from) : toScreen(g.from, g.at)
    const b = g.axis === 'x' ? toScreen(g.at, g.to) : toScreen(g.to, g.at)
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y }
  })
)
const cursor = computed(() => {
  const g = gesture.value
  if (g?.kind === 'pan') return 'grabbing'
  if (spaceHeld.value || tool.value === 'hand') return 'grab'
  if (tool.value === 'text') return 'text'
  if (tool.value === 'select') return 'default'
  return 'crosshair'
})
</script>

<template>
  <div
    ref="root"
    tabindex="0"
    class="whiteboard relative h-full w-full touch-none select-none overflow-hidden bg-canvas outline-none"
    :style="{ cursor }"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @wheel="onWheel"
    @dblclick="onDoubleClick"
    @keydown="onKeyDown"
    @keyup="onKeyUp"
    @blur="spaceHeld = false"
    @dragover="onDragOver"
    @drop="onDrop"
    @copy="onCopy($event)"
    @cut="onCopy($event, true)"
    @paste="onPaste"
  >
    <svg class="pointer-events-none absolute inset-0 h-full w-full">
      <defs>
        <pattern :id="gridId" :width="grid.step" :height="grid.step" patternUnits="userSpaceOnUse" :patternTransform="grid.transform">
          <circle :cx="grid.step / 2" :cy="grid.step / 2" :r="grid.r" fill="var(--color-line-strong)" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" :fill="`url(#${gridId})`" />
    </svg>
    <svg class="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      <g v-for="path in arrowPaths" :key="path.arrow.id" :data-arrow="path.arrow.id">
        <path :d="path.d" fill="none" stroke="transparent" :stroke-width="14" style="pointer-events: stroke" />
        <path
          :d="path.line"
          fill="none"
          :stroke="arrowColor(path.arrow)"
          :stroke-width="path.width"
          :stroke-dasharray="path.dash"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
        <path v-for="(mark, i) in path.marks" :key="i" :d="mark.d" :fill="arrowColor(path.arrow)" :stroke="arrowColor(path.arrow)" :stroke-width="mark.kind === 'arrow' ? path.width * 0.6 : 0" stroke-linejoin="round" />
      </g>
    </svg>

    <div class="absolute left-0 top-0 origin-top-left" :style="{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }">
      <BoardItem
        v-for="{ element, index, box: b } in shown"
        :key="element.id"
        v-model:draft="draft"
        :element="element"
        :box="b"
        :zoom="camera.zoom"
        :selected="selection.has(element.id)"
        :editing="editing === element.id"
        :faded="preview.erasing.has(element.id)"
        :clip="clipOf(element, b)"
        :board-id="boardId"
        :summary="element.kind === 'card' ? summaryById.get(element.objectId) : undefined"
        :type="element.kind === 'card' ? typesById.get(summaryById.get(element.objectId)?.typeId ?? '') : undefined"
        :style="{ zIndex: index + 1 }"
        @input="fitText"
        @commit="commitText"
        @editor="setEditor"
      />

      <div
        v-for="path in arrowPaths.filter((p) => p.arrow.kind === 'arrow' && (p.arrow.label || p.arrow.relation || p.arrow.mentioned))"
        :key="`label-${path.arrow.id}`"
        :data-arrow="path.arrow.id"
        class="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-md border border-line bg-surface px-1.5 py-0.5 text-xs text-ink-soft shadow-sm"
        :class="selection.has(path.arrow.id) ? 'border-accent text-ink' : ''"
        :style="{ left: `${path.mid.x}px`, top: `${path.mid.y}px`, zIndex: placed.length + 1 }"
      >
        <AppIcon v-if="path.arrow.kind === 'arrow' && path.arrow.relation" fallback="ph:link-simple" :size="11" class="-mt-px mr-0.5 inline text-accent" />
        <AppIcon v-else-if="path.arrow.kind === 'arrow' && path.arrow.mentioned" fallback="ph:at" :size="11" class="-mt-px mr-0.5 inline text-accent" />{{
          path.arrow.kind === 'arrow' ? path.arrow.label || (path.arrow.relation ? relationName(path.arrow) : 'Mentioned') : ''
        }}
      </div>

      <svg v-if="ink" class="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1" :style="{ zIndex: placed.length + 3 }">
        <path :d="ink.d" :fill="ink.fill" :fill-opacity="ink.opacity" />
      </svg>

      <!-- Handles of the one selected element: drag the dot to draw an arrow, the corner to resize,
           the knob above to turn it. They turn with the element. -->
      <div
        v-if="selectedOne && !readonly && editing !== selectedOne.id && !isAttached(selectedOne)"
        class="pointer-events-none absolute"
        :style="{
          left: `${box(selectedOne).x}px`,
          top: `${box(selectedOne).y}px`,
          width: `${box(selectedOne).w}px`,
          height: `${box(selectedOne).h}px`,
          transform: box(selectedOne).r ? `rotate(${box(selectedOne).r}deg)` : undefined,
          zIndex: placed.length + 2,
        }"
      >
        <div
          :data-element="selectedOne.id"
          data-handle="connect"
          title="Drag to another element to draw an arrow"
          class="pointer-events-auto absolute rounded-full border-accent bg-surface"
          :style="{ left: `calc(100% + ${16 / camera.zoom}px)`, top: '50%', width: `${14 / camera.zoom}px`, height: `${14 / camera.zoom}px`, borderWidth: `${2 / camera.zoom}px`, transform: 'translate(-50%, -50%)', cursor: 'crosshair' }"
        />
        <div
          :data-element="selectedOne.id"
          data-handle="resize"
          class="pointer-events-auto absolute rounded-sm border-accent bg-surface"
          :style="{ left: `calc(100% + ${4 / camera.zoom}px)`, top: `calc(100% + ${4 / camera.zoom}px)`, width: `${12 / camera.zoom}px`, height: `${12 / camera.zoom}px`, borderWidth: `${2 / camera.zoom}px`, transform: 'translate(-50%, -50%)', cursor: 'nwse-resize' }"
        />
        <template v-if="selectedOne.kind !== 'frame'">
          <div class="absolute left-1/2 bg-accent" :style="{ top: `${-22 / camera.zoom}px`, width: `${1.5 / camera.zoom}px`, height: `${18 / camera.zoom}px`, transform: 'translateX(-50%)' }" />
          <div
            :data-element="selectedOne.id"
            data-handle="rotate"
            title="Drag to turn (Shift: in steps of 15°)"
            class="pointer-events-auto absolute left-1/2 rounded-full border-accent bg-surface"
            :style="{ top: `${-26 / camera.zoom}px`, width: `${12 / camera.zoom}px`, height: `${12 / camera.zoom}px`, borderWidth: `${2 / camera.zoom}px`, transform: 'translate(-50%, -50%)', cursor: 'grab' }"
          />
        </template>
      </div>

      <!-- Several selected: their box, and its corner to scale them together -->
      <template v-if="selectionBox && !readonly">
        <div
          class="pointer-events-none absolute rounded-md border border-dashed border-accent/70"
          :style="{ left: `${selectionBox.x - 6 / camera.zoom}px`, top: `${selectionBox.y - 6 / camera.zoom}px`, width: `${selectionBox.w + 12 / camera.zoom}px`, height: `${selectionBox.h + 12 / camera.zoom}px`, borderWidth: `${1 / camera.zoom}px`, zIndex: placed.length + 2 }"
        />
        <div
          data-element="__selection"
          data-handle="scale"
          title="Drag to scale the selection (Shift keeps its proportions)"
          class="absolute rounded-sm border-accent bg-surface"
          :style="{
            left: `${selectionBox.x + selectionBox.w + 6 / camera.zoom}px`,
            top: `${selectionBox.y + selectionBox.h + 6 / camera.zoom}px`,
            width: `${12 / camera.zoom}px`,
            height: `${12 / camera.zoom}px`,
            borderWidth: `${2 / camera.zoom}px`,
            transform: 'translate(-50%, -50%)',
            zIndex: placed.length + 2,
            cursor: 'nwse-resize',
          }"
        />
      </template>
    </div>

    <svg class="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      <line v-for="(g, i) in guideLines" :key="i" v-bind="g" stroke="#e5484d" stroke-width="1" stroke-dasharray="4 3" />
      <template v-if="connecting">
        <line :x1="connecting.s.x" :y1="connecting.s.y" :x2="connecting.e.x" :y2="connecting.e.y" stroke="var(--color-accent)" :stroke-width="stroke" stroke-dasharray="6 4" />
        <path v-for="(mark, i) in connecting.marks" :key="i" :d="mark.d" fill="var(--color-accent)" />
      </template>
      <path v-if="lassoPath" :d="lassoPath" fill="color-mix(in srgb, var(--color-accent) 8%, transparent)" stroke="var(--color-accent)" stroke-width="1.5" stroke-dasharray="5 4" stroke-linejoin="round" />
      <rect
        v-if="marquee"
        :x="marquee.x"
        :y="marquee.y"
        :width="marquee.w"
        :height="marquee.h"
        :fill="marquee.dashed ? 'none' : 'color-mix(in srgb, var(--color-accent) 8%, transparent)'"
        stroke="var(--color-accent)"
        stroke-width="1"
        :stroke-dasharray="marquee.dashed ? '5 4' : undefined"
      />
    </svg>

    <SelectionBar
      v-if="bar"
      :elements="selected"
      :x="bar.x"
      :y="bar.y"
      :below="bar.below"
      @color="setColor"
      @shape="setShape"
      @front="toFront"
      @back="toBack"
      @duplicate="duplicate"
      @remove="removeSelection"
      @label="selected[0] && labelArrow(selected[0].id)"
      @rename="selected[0] && renameFrame(selected[0].id)"
      @open="openSelected"
      @view="setView"
      @arrow-style="setArrowStyle"
      @link="linkMenu"
      :linkable="!!linkable"
      @draw-on="selected[0] && drawOn(selected[0].id)"
    />

    <!-- Drawing on an element: its outline, and how to stop -->
    <template v-if="attachTarget">
      <div
        class="pointer-events-none absolute rounded-xl border-2 border-dashed border-accent"
        :style="{
          left: `${toScreen(box(attachTarget).x, 0).x - 4}px`,
          top: `${toScreen(0, box(attachTarget).y).y - 4}px`,
          width: `${box(attachTarget).w * camera.zoom + 8}px`,
          height: `${box(attachTarget).h * camera.zoom + 8}px`,
        }"
      />
      <div data-ui class="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full border border-line bg-surface py-1 pl-3 pr-1 text-sm shadow-md">
        <AppIcon fallback="ph:pen-nib" :size="15" class="text-accent" />
        <span class="text-ink-soft">Drawing on this {{ attachTarget.kind === 'card' ? 'card' : attachTarget.kind === 'frame' ? 'frame' : attachTarget.kind === 'sticky' ? 'note' : 'element' }}</span>
        <button class="rounded-full bg-accent px-3 py-1 text-sm font-medium text-white" @click="stopDrawingOn">Done</button>
      </div>
    </template>

    <div v-if="!placed.length && !gesture" class="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center text-sm text-ink-faint">
      <p>{{ readonly || embedded ? 'This board is empty.' : 'Drag objects here from the sidebar, add one with @, draw with P, or double-click to write.' }}</p>
    </div>
    <button v-if="lost && !embedded" data-ui class="absolute left-1/2 top-4 -translate-x-1/2 rounded-full border border-line bg-surface px-3 py-1.5 text-sm shadow-sm hover:bg-hover" @click="fit()">
      Back to content
    </button>

    <BoardToolbar
      v-if="!embedded && !readonly"
      v-model:tool="tool"
      v-model:draw-mode="drawMode"
      :draw-modes="DRAW_MODES"
      :narrow="size.w < 1040"
      @object="(anchor) => ((pickerAnchor = anchor), (pickerOpen = !pickerOpen))"
    />
    <div v-else-if="!embedded" data-ui class="absolute bottom-[calc(0.75rem+env(safe-area-inset-bottom))] left-3 rounded-xl border border-line bg-surface px-3 py-2 text-xs text-ink-faint shadow-md">Read only</div>

    <!-- Zoom -->
    <div v-if="!embedded" data-ui class="absolute bottom-[calc(0.75rem+env(safe-area-inset-bottom))] right-3 flex items-center gap-0.5 rounded-xl border border-line bg-surface p-1 text-sm shadow-md">
      <!-- Undo and redo (also ⌘Z, ⇧⌘Z, and two- and three-finger taps) -->
      <template v-if="!readonly">
        <button class="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-hover hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent" title="Undo (⌘Z)" aria-label="Undo" :disabled="!history.undo" @click="undo.undo()">
          <AppIcon fallback="ph:arrow-counter-clockwise" :size="16" />
        </button>
        <button class="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-hover hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent" title="Redo (⇧⌘Z)" aria-label="Redo" :disabled="!history.redo" @click="undo.redo()">
          <AppIcon fallback="ph:arrow-clockwise" :size="16" />
        </button>
        <span class="mx-0.5 h-5 w-px bg-line" :class="narrow ? 'hidden' : ''" />
      </template>
      <button class="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-hover" :class="narrow ? 'hidden' : ''" title="Zoom out" aria-label="Zoom out" @click="zoomAt(size.w / 2, size.h / 2, camera.zoom / 1.25)">
        <AppIcon fallback="ph:minus" :size="16" />
      </button>
      <button class="h-8 w-14 rounded-lg tabular-nums text-ink-soft hover:bg-hover" :class="narrow ? 'hidden' : ''" title="Zoom to 100% (⇧0)" @click="zoomAt(size.w / 2, size.h / 2, 1)">{{ Math.round(camera.zoom * 100) }}%</button>
      <button class="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-hover" :class="narrow ? 'hidden' : ''" title="Zoom in" aria-label="Zoom in" @click="zoomAt(size.w / 2, size.h / 2, camera.zoom * 1.25)">
        <AppIcon fallback="ph:plus" :size="16" />
      </button>
      <button class="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-hover" title="Fit everything (⇧1)" aria-label="Fit everything" @click="fit()">
        <AppIcon fallback="ph:frame-corners" :size="16" />
      </button>
    </div>

    <!-- Scenes: the board's frames, always at hand -->
    <div
      v-if="!embedded && frames.length"
      data-ui
      class="absolute left-3 top-3 flex max-w-[calc(100%-7.5rem)] items-center rounded-lg border border-line bg-surface text-sm shadow-sm"
    >
      <button class="grid h-8 w-7 shrink-0 place-items-center rounded-l-lg text-ink-soft hover:bg-hover hover:text-ink" title="Previous frame" aria-label="Previous frame" @click="stepScene(-1)">
        <AppIcon fallback="ph:caret-left" :size="14" />
      </button>
      <label class="relative flex w-40 min-w-0 items-center gap-1.5 border-x border-line px-2 py-1.5 hover:bg-hover max-sm:w-32">
        <AppIcon fallback="ph:frame-corners" :size="14" class="shrink-0 text-ink-soft" />
        <span class="truncate" :class="scene ? 'text-ink' : 'text-ink-soft'">{{ scene ? frameTitle(frames.find((f) => f.id === scene)) : 'Whole board' }}</span>
        <AppIcon fallback="ph:caret-down" :size="11" class="ml-auto shrink-0 text-ink-faint" />
        <!-- The native list: on a touch screen it opens as the system picker. -->
        <select class="absolute inset-0 cursor-pointer opacity-0" aria-label="Go to a frame" :value="scene ?? ''" @change="goToScene(($event.target as HTMLSelectElement).value || null)">
          <option value="">Whole board</option>
          <option v-for="f in frames" :key="f.id" :value="f.id">{{ frameTitle(f) }}</option>
        </select>
      </label>
      <button class="grid h-8 w-7 shrink-0 place-items-center rounded-r-lg text-ink-soft hover:bg-hover hover:text-ink" title="Next frame" aria-label="Next frame" @click="stepScene(1)">
        <AppIcon fallback="ph:caret-right" :size="14" />
      </button>
    </div>

    <!-- An embedded scene: what lies outside its frame fades into the background -->
    <svg v-if="embedded && sceneBox" class="pointer-events-none absolute inset-0 h-full w-full">
      <path
        :d="`M0,0 H${size.w} V${size.h} H0 Z M${sceneBox.x},${sceneBox.y} v${sceneBox.h} h${sceneBox.w} v${-sceneBox.h} Z`"
        fill="var(--color-canvas)"
        fill-opacity="0.88"
        fill-rule="evenodd"
      />
    </svg>

    <!-- Board menu -->
    <button
      v-if="!embedded"
      data-ui
      class="absolute right-[3.25rem] top-3 grid h-8 w-8 place-items-center rounded-lg border border-line bg-surface text-ink-soft shadow-sm hover:bg-hover hover:text-ink"
      title="Board"
      aria-label="Board menu"
      @click="boardMenu"
    >
      <AppIcon fallback="ph:dots-three" :size="16" />
    </button>
    <input ref="fileInput" type="file" accept=".canvas,application/json" class="hidden" @change="importCanvas" />

    <div v-if="connectPick" ref="pointAnchor" class="pointer-events-none absolute h-px w-px" :style="{ left: `${connectPick.x}px`, top: `${connectPick.y}px` }" />
    <PopoverMenu v-model:open="pickerOpen" :anchor="connectPick ? pointAnchor : pickerAnchor" :placement="connectPick ? 'bottom-start' : 'top'" width="20rem">
      <div data-ui @keydown.stop>
        <ObjectPicker :exclude="[boardId]" create-label="New page" @pick="picked" @create="created" />
      </div>
    </PopoverMenu>
  </div>
</template>

<style scoped>
.whiteboard {
  -webkit-touch-callout: none;
}
</style>
