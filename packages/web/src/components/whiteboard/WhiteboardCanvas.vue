<script setup lang="ts">
// A whiteboard: object cards, text, shapes, sticky notes, pen strokes, frames and arrows on an
// endless canvas. The elements live in the board's Y.Doc (core board.ts); this component reads
// them on every change and writes through the board functions, so edits from other devices merge
// in while it is open. Elements are HTML (BoardItem) in a layer moved and scaled by the camera;
// arrows, guides, the marquee and the line being drawn are SVG in screen space, so that layer stays
// the size of the view at any zoom.
//
// Pens: once a pen has touched the board, fingers only move the view (palm rejection) and a pen
// down makes the board ignore touches; two fingers tapped undo, three redo.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  BOARD_FIELD,
  addBoardElements,
  bringToFront,
  copyElements,
  insideFrame,
  isPlaced,
  readBoard,
  removeBoardElements,
  sendToBack,
  updateBoardElements,
  type BoardElement,
  type BoardPatch,
  type ColorName,
  type Id,
  type NewBoardElement,
  type ObjectSummary,
  type PlacedElement,
  type ShapeName,
} from '@vasta/core'
import { Y } from '@vasta/editor-schema/yjs'
import { api } from '../../lib/api.ts'
import { primeSummaries, systemType, typesById, useSummaries } from '../../lib/state.ts'
import { promptDialog } from '../../lib/overlays.ts'
import {
  BOARD_COLORS,
  PICKER_COLORS,
  SHAPE_ICONS,
  boardClipboard,
  bounds,
  parseBoardClipboard,
  simplifyPoints,
  snapMove,
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
import SelectionBar from './SelectionBar.vue'

const props = defineProps<{ doc: Y.Doc; boardId: Id; readonly?: boolean }>()
const router = useRouter()

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
const PEN_SIZES = [2, 4, 8]

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
  const all = bounds(list.map(box))
  if (!all || !size.w) {
    Object.assign(camera, { x: size.w / 2, y: size.h / 2, zoom: 1 })
    return
  }
  const pad = 64
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
 * frame), the size being given to one element, a text's height while typed, strokes being erased.
 */
const preview = reactive<{ dx: number; dy: number; moving: Set<Id>; resize: { id: Id; w: number; h: number } | null; textH: Record<Id, number>; erasing: Set<Id>; guides: Guide[] }>({
  dx: 0,
  dy: 0,
  moving: new Set(),
  resize: null,
  textH: {},
  erasing: new Set(),
  guides: [],
})

/** Where an element is drawn now, with what is being dragged. */
function box(element: PlacedElement): Box {
  const moving = preview.moving.has(element.id)
  const resized = preview.resize?.id === element.id ? preview.resize : null
  return {
    x: element.x + (moving ? preview.dx : 0),
    y: element.y + (moving ? preview.dy : 0),
    w: resized?.w ?? element.w,
    h: resized?.h ?? preview.textH[element.id] ?? element.h,
  }
}

const view = computed(() => {
  const margin = 200 / camera.zoom
  const a = toWorld(0, 0)
  const b = toWorld(size.w, size.h)
  return { left: a.x - margin, top: a.y - margin, right: b.x + margin, bottom: b.y + margin }
})
const inView = (b: Box) => b.x < view.value.right && b.x + b.w > view.value.left && b.y < view.value.bottom && b.y + b.h > view.value.top
/** Only what is in view (and what is selected) is drawn, so big boards stay quick. */
const shown = computed(() => placed.value.map((element, index) => ({ element, index, box: box(element) })).filter(({ element, box }) => selection.value.has(element.id) || inView(box)))
const lost = computed(() => placed.value.length > 0 && shown.value.length === 0)

/** Where a line from the middle of `b` towards (px, py) leaves it. */
function edgePoint(b: Box, px: number, py: number) {
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  const dx = px - cx
  const dy = py - cy
  if (!dx && !dy) return { x: cx, y: cy }
  const t = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity)
  return { x: cx + dx * t, y: cy + dy * t }
}
const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })

const arrowPaths = computed(() =>
  arrows.value.flatMap((arrow) => {
    if (arrow.kind !== 'arrow') return []
    const from = byId.value.get(arrow.from)
    const to = byId.value.get(arrow.to)
    if (!from || !to || !isPlaced(from) || !isPlaced(to)) return []
    const a = box(from)
    const b = box(to)
    if (!inView(a) && !inView(b)) return []
    const start = edgePoint(a, center(b).x, center(b).y)
    const end = edgePoint(b, center(a).x, center(a).y)
    return [{ arrow, s: toScreen(start.x, start.y), e: toScreen(end.x, end.y), mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } }]
  })
)
const stroke = computed(() => Math.max(1, 1.75 * camera.zoom))

// Tools ---------------------------------------------------------------------------

type Tool = 'select' | 'hand' | 'text' | 'shape' | 'sticky' | 'pen' | 'highlighter' | 'eraser' | 'frame' | 'arrow'
const tool = ref<Tool>('select')
const shapeKind = ref<ShapeName>('rectangle')
const pen = reactive<{ color: ColorName | undefined; size: number }>({ color: undefined, size: 4 })
const spaceHeld = ref(false)
/** A pen touched the board: fingers now only move the view. */
const penSeen = ref(false)
const drawing = computed(() => tool.value === 'pen' || tool.value === 'highlighter' || tool.value === 'eraser')
const stays = (t: Tool) => t === 'pen' || t === 'highlighter' || t === 'eraser' || t === 'hand'

// Gestures ------------------------------------------------------------------------

type Point = { x: number; y: number }
type Gesture =
  | { kind: 'pan'; sx: number; sy: number; x: number; y: number }
  | { kind: 'move'; start: Point; moved: boolean; sx: number; sy: number; from: Box | undefined; others: Box[] }
  | { kind: 'resize'; id: Id; start: Point; w: number; h: number }
  | { kind: 'marquee'; start: Point; end: Point; keep: Set<Id> }
  | { kind: 'connect'; from: Id; end: Point }
  | { kind: 'create'; what: 'shape' | 'sticky' | 'frame'; start: Point; end: Point }
  | { kind: 'draw'; points: number[]; pressure: boolean }
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
  preview.erasing = new Set()
  preview.guides = []
  gesture.value = null
}

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

function onPointerDown(event: PointerEvent) {
  if ((event.target as HTMLElement).closest('[data-ui]')) return
  if (editing.value && (event.target as HTMLElement).closest('textarea')) return
  const isTouch = event.pointerType === 'touch'
  // Palm rejection: a hand resting on the screen while the pen writes.
  if (isTouch && penDown) return
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
  if (event.button === 1 || spaceHeld.value || tool.value === 'hand') return void (gesture.value = pan(p))
  // A pen's eraser end (or its eraser button).
  if (event.pointerType === 'pen' && (event.button === 5 || event.buttons & 32) && !props.readonly) return startErase(event)
  if ((event.button !== 0 && event.pointerType === 'mouse') || props.readonly) {
    if (!elementId) gesture.value = pan(p)
    return
  }
  // With a pen around, fingers navigate.
  if (isTouch && penSeen.value && !handle) {
    gesture.value = pan(p)
    return
  }
  if (handle && elementId) {
    const element = byId.value.get(elementId)
    if (handle === 'resize' && element && isPlaced(element)) gesture.value = { kind: 'resize', id: elementId, start: world, w: element.w, h: element.h }
    else if (handle === 'connect') gesture.value = { kind: 'connect', from: elementId, end: world }
    return
  }
  if (tool.value === 'pen' || tool.value === 'highlighter') {
    gesture.value = { kind: 'draw', points: [world.x, world.y, event.pointerType === 'pen' ? event.pressure : 0.5], pressure: event.pointerType === 'pen' }
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
    const { distance, mid } = pinchState()
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, g.zoom * (distance / g.distance)))
    // The point under the fingers' middle at the start stays under it.
    const anchor = { x: (g.mid.x - g.cam.x) / g.zoom, y: (g.mid.y - g.cam.y) / g.zoom }
    camera.zoom = zoom
    camera.x = mid.x - anchor.x * zoom
    camera.y = mid.y - anchor.y * zoom
  } else if (g.kind === 'pan') {
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
    let w = Math.max(MIN.w, Math.round(g.w + world.x - g.start.x))
    let h = Math.max(MIN.h, Math.round(g.h + world.y - g.start.y))
    const element = byId.value.get(g.id)
    // Strokes and Shift keep their proportions.
    if (event.shiftKey || element?.kind === 'stroke') {
      const k = Math.max(w / g.w, h / g.h)
      w = Math.max(MIN.w, Math.round(g.w * k))
      h = Math.max(MIN.h, Math.round(g.h * k))
    }
    preview.resize = { id: g.id, w, h }
  } else if (g.kind === 'marquee') {
    gesture.value = { ...g, end: world }
    const [left, right] = [Math.min(g.start.x, world.x), Math.max(g.start.x, world.x)]
    const [top, bottom] = [Math.min(g.start.y, world.y), Math.max(g.start.y, world.y)]
    // A frame is taken only when the box holds it whole; other elements when it touches them.
    const inside = placed.value
      .filter((e) => (e.kind === 'frame' ? e.x >= left && e.y >= top && e.x + e.w <= right && e.y + e.h <= bottom : e.x < right && e.x + e.w > left && e.y < bottom && e.y + e.h > top))
      .map((e) => e.id)
    select([...g.keep, ...inside])
  } else if (g.kind === 'connect' || g.kind === 'create') {
    gesture.value = { ...g, end: world }
  } else if (g.kind === 'draw') {
    // Coalesced events carry the points a pen sent between two frames.
    const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : []
    const points = [...g.points]
    for (const e of events.length ? events : [event]) {
      const w = toWorld(local(e).x, local(e).y)
      points.push(Math.round(w.x * 10) / 10, Math.round(w.y * 10) / 10, g.pressure ? e.pressure : 0.5)
    }
    gesture.value = { ...g, points }
  } else if (g.kind === 'erase') {
    eraseAt(event)
  }
}

function onPointerUp(event: PointerEvent) {
  if (event.pointerType === 'pen') penDown = false
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
  if (event.type === 'pointercancel' && g.kind !== 'pan') return cancelGesture()
  if (g.kind === 'move' && g.moved && (preview.dx || preview.dy)) {
    const patches: Record<Id, BoardPatch> = {}
    for (const id of preview.moving) {
      const element = byId.value.get(id)
      if (element && isPlaced(element)) patches[id] = { x: element.x + preview.dx, y: element.y + preview.dy }
    }
    update(patches)
  } else if (g.kind === 'resize' && preview.resize) {
    update({ [g.id]: { w: preview.resize.w, h: preview.resize.h } })
  } else if (g.kind === 'connect') {
    const target = elementAt(document.elementFromPoint(event.clientX, event.clientY))
    const exists = arrows.value.some((a) => a.kind === 'arrow' && ((a.from === g.from && a.to === target) || (a.from === target && a.to === g.from)))
    if (target && target !== g.from && !exists) select(add([{ kind: 'arrow', from: g.from, to: target }]))
    if (!stays(tool.value)) tool.value = 'select'
  } else if (g.kind === 'create') {
    createAt(g)
  } else if (g.kind === 'draw') {
    finishStroke(g)
  } else if (g.kind === 'erase' && preview.erasing.size) {
    remove([...preview.erasing])
  }
  cancelGesture()
}

function onWheel(event: WheelEvent) {
  event.preventDefault()
  const p = local(event)
  // A trackpad pinch arrives as a wheel with Ctrl held, as does Ctrl or ⌘ with the wheel.
  if (event.ctrlKey || event.metaKey) zoomAt(p.x, p.y, camera.zoom * Math.exp(-event.deltaY * (event.deltaMode ? 0.05 : 0.01)))
  else {
    const unit = event.deltaMode === 1 ? 16 : 1
    camera.x -= (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit
    camera.y -= (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * unit
  }
}

// Safari on a Mac pinches with gesture events instead of wheels.
let gestureZoom = 1
function onGestureStart(event: Event) {
  event.preventDefault()
  gestureZoom = camera.zoom
}
function onGestureChange(event: Event) {
  event.preventDefault()
  const e = event as Event & { scale: number; clientX: number; clientY: number }
  const p = local(e)
  zoomAt(p.x, p.y, gestureZoom * e.scale)
}

function onDoubleClick(event: MouseEvent) {
  if (props.readonly || (event.target as HTMLElement).closest('[data-ui]') || drawing.value) return
  const elementId = elementAt(event.target)
  const element = elementId ? byId.value.get(elementId) : undefined
  if (element?.kind === 'card') void router.push(`/o/${element.objectId}`)
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
  const taken = (px: number, py: number) => placed.value.some((e) => Math.abs(e.x - px) < 12 && Math.abs(e.y - py) < 12)
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
function createAt(g: Extract<Gesture, { kind: 'create' }>) {
  const dragged = Math.abs(g.end.x - g.start.x) * camera.zoom > 8 || Math.abs(g.end.y - g.start.y) * camera.zoom > 8
  const usual = SIZES[g.what]
  const rect = dragged
    ? { x: Math.min(g.start.x, g.end.x), y: Math.min(g.start.y, g.end.y), w: Math.abs(g.end.x - g.start.x), h: Math.abs(g.end.y - g.start.y) }
    : { x: g.start.x - usual.w / 2, y: g.start.y - usual.h / 2, ...usual }
  const at = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.max(MIN.w, Math.round(rect.w)), h: Math.max(MIN.h, Math.round(rect.h)) }
  const element: NewBoardElement =
    g.what === 'shape' ? { kind: 'shape', shape: shapeKind.value, text: '', ...at } : g.what === 'sticky' ? { kind: 'sticky', text: '', ...at } : { kind: 'frame', ...at }
  const [id] = add([element])
  // A frame goes under what is already there.
  if (g.what === 'frame') sendToBack(props.doc, [id!], LOCAL), now()
  select([id!])
  tool.value = 'select'
  if (g.what === 'sticky') startEditing(id!)
}

function finishStroke(g: Extract<Gesture, { kind: 'draw' }>) {
  const highlight = tool.value === 'highlighter'
  const size = highlight ? 18 : pen.size
  const points = simplifyPoints(g.points, 0.6 / camera.zoom)
  // A dot: a tap with the pen.
  if (points.length === 3) points.push(points[0]! + 0.5, points[1]! + 0.5, points[2]!)
  add([{ kind: 'stroke', size, ...strokeFromPoints(points, size), ...(pen.color && !highlight ? { color: pen.color } : {}), ...(highlight ? { highlight: true } : {}) }])
}

const pickerOpen = ref(false)
const pickerAnchor = ref<HTMLElement | null>(null)
function picked(object: ObjectSummary) {
  pickerOpen.value = false
  primeSummaries([object])
  addCards([object.id])
}
async function created(title: string) {
  pickerOpen.value = false
  const type = systemType('page')
  if (!type) return
  const object = await api.createObject({ typeId: type.id, title })
  addCards([object.id])
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
  const id = linkedObject(text)
  if (id && id !== props.boardId) return addCards([id])
  if (text.trim()) addText(viewCenter(), text.trim())
}

function setColor(color: ColorName | undefined) {
  const patches: Record<Id, BoardPatch> = {}
  for (const element of selected.value) if (element.kind !== 'card') patches[element.id] = { color }
  update(patches)
}
function setShape(shape: ShapeName) {
  shapeKind.value = shape
  const patches: Record<Id, BoardPatch> = {}
  for (const element of selected.value) if (element.kind === 'shape') patches[element.id] = { shape }
  update(patches)
}
const toFront = () => (bringToFront(props.doc, [...selection.value], LOCAL), now())
const toBack = () => (sendToBack(props.doc, [...selection.value], LOCAL), now())
function openSelected() {
  const element = selected.value[0]
  if (element?.kind === 'card') void router.push(`/o/${element.objectId}`)
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

const TOOL_KEYS: Record<string, Tool> = { v: 'select', h: 'hand', t: 'text', s: 'sticky', p: 'pen', m: 'highlighter', e: 'eraser', f: 'frame', l: 'arrow', a: 'arrow' }
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
    if (!selection.value.size && tool.value === 'select') return
    event.stopPropagation()
    select([])
    tool.value = 'select'
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
    else if (element?.kind === 'card') void router.push(`/o/${element.objectId}`)
    else if (element && 'text' in element) startEditing(element.id)
  } else if (key.startsWith('arrow') && selection.value.size) {
    event.preventDefault()
    const step = event.shiftKey ? 10 : 1
    const [dx, dy] = key === 'arrowleft' ? [-step, 0] : key === 'arrowright' ? [step, 0] : key === 'arrowup' ? [0, -step] : [0, step]
    const patches: Record<Id, BoardPatch> = {}
    for (const element of selected.value) if (isPlaced(element)) patches[element.id] = { x: element.x + dx, y: element.y + dy }
    update(patches)
  } else if (key === ']') toFront()
  else if (key === '[') toBack()
  else if (SHAPE_KEYS[key]) (shapeKind.value = SHAPE_KEYS[key]!), (tool.value = 'shape')
  else if (TOOL_KEYS[key]) tool.value = TOOL_KEYS[key]!
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
    if (first && !loadCamera()) fit()
  })
  observer.observe(root.value!)
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
  if (t !== 'select' && t !== 'hand') select([])
})

// What is drawn over the board ---------------------------------------------------------

const quiet = computed(() => !!gesture.value && gesture.value.kind !== 'marquee')
const selectedOne = computed(() => {
  if (selection.value.size !== 1 || quiet.value) return undefined
  const element = byId.value.get([...selection.value][0]!)
  return element && isPlaced(element) ? element : undefined
})

/** The bar sits above the selection (below it near the top of the view). */
const bar = computed(() => {
  if (!selection.value.size || quiet.value || editing.value || props.readonly) return null
  const boxes = selected.value.flatMap((e) => {
    if (isPlaced(e)) return [box(e)]
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

const tools: { id: Tool; icon: string; label: string; key: string }[] = [
  { id: 'select', icon: 'ph:cursor', label: 'Select', key: 'V' },
  { id: 'hand', icon: 'ph:hand', label: 'Hand', key: 'H' },
  { id: 'pen', icon: 'ph:pen-nib', label: 'Pen', key: 'P' },
  { id: 'highlighter', icon: 'ph:highlighter', label: 'Highlighter', key: 'M' },
  { id: 'eraser', icon: 'ph:eraser', label: 'Eraser', key: 'E' },
  { id: 'text', icon: 'ph:text-t', label: 'Text', key: 'T' },
  { id: 'sticky', icon: 'ph:note-blank', label: 'Sticky note', key: 'S' },
  { id: 'shape', icon: 'ph:square', label: 'Shape', key: 'R, O, D' },
  { id: 'frame', icon: 'ph:frame-corners', label: 'Frame', key: 'F' },
  { id: 'arrow', icon: 'ph:arrow-up-right', label: 'Arrow', key: 'L' },
]
const toolIcon = (t: (typeof tools)[number]) => (t.id === 'shape' ? SHAPE_ICONS[shapeKind.value] : t.icon)

const background = computed(() => {
  const step = 24 * camera.zoom
  return { backgroundSize: `${step}px ${step}px`, backgroundPosition: `${camera.x}px ${camera.y}px` }
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
  const start = edgePoint(box(from), g.end.x, g.end.y)
  return { s: toScreen(start.x, start.y), e: toScreen(g.end.x, g.end.y) }
})
/** The line being drawn, in board coordinates (inside the camera's layer). */
const ink = computed(() => {
  const g = gesture.value
  if (g?.kind !== 'draw') return null
  const highlight = tool.value === 'highlighter'
  return {
    d: strokePath(g.points, highlight ? 18 : pen.size, { pen: g.pressure, last: false }),
    fill: strokeColor(highlight ? 'yellow' : pen.color),
    opacity: highlight ? 0.4 : 1,
  }
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
    :style="{ ...background, cursor }"
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
    <svg class="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      <defs>
        <marker id="wb-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse" markerUnits="strokeWidth">
          <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
        </marker>
      </defs>
      <g v-for="path in arrowPaths" :key="path.arrow.id" :data-arrow="path.arrow.id">
        <line :x1="path.s.x" :y1="path.s.y" :x2="path.e.x" :y2="path.e.y" stroke="transparent" :stroke-width="14" style="pointer-events: stroke" />
        <line
          :x1="path.s.x"
          :y1="path.s.y"
          :x2="path.e.x"
          :y2="path.e.y"
          :stroke="selection.has(path.arrow.id) ? 'var(--color-accent)' : path.arrow.kind === 'arrow' && path.arrow.color ? BOARD_COLORS[path.arrow.color] : 'var(--color-ink-soft)'"
          :stroke-width="stroke"
          stroke-linecap="round"
          marker-end="url(#wb-head)"
        />
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
        :summary="element.kind === 'card' ? summaryById.get(element.objectId) : undefined"
        :type="element.kind === 'card' ? typesById.get(summaryById.get(element.objectId)?.typeId ?? '') : undefined"
        :style="{ zIndex: index + 1 }"
        @input="fitText"
        @commit="commitText"
        @editor="setEditor"
      />

      <div
        v-for="path in arrowPaths.filter((p) => p.arrow.kind === 'arrow' && p.arrow.label)"
        :key="`label-${path.arrow.id}`"
        :data-arrow="path.arrow.id"
        class="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-md border border-line bg-surface px-1.5 py-0.5 text-xs text-ink-soft shadow-sm"
        :class="selection.has(path.arrow.id) ? 'border-accent text-ink' : ''"
        :style="{ left: `${path.mid.x}px`, top: `${path.mid.y}px`, zIndex: placed.length + 1 }"
      >
        {{ path.arrow.kind === 'arrow' ? path.arrow.label : '' }}
      </div>

      <svg v-if="ink" class="pointer-events-none absolute left-0 top-0 overflow-visible" width="1" height="1" :style="{ zIndex: placed.length + 3 }">
        <path :d="ink.d" :fill="ink.fill" :fill-opacity="ink.opacity" />
      </svg>

      <!-- Handles of the one selected element: drag the dot to draw an arrow, the corner to resize. -->
      <template v-if="selectedOne && !readonly && editing !== selectedOne.id">
        <div
          :data-element="selectedOne.id"
          data-handle="connect"
          title="Drag to another element to draw an arrow"
          class="absolute grid place-items-center rounded-full border-2 border-accent bg-surface"
          :style="{
            left: `${box(selectedOne).x + box(selectedOne).w + 16 / camera.zoom}px`,
            top: `${box(selectedOne).y + box(selectedOne).h / 2}px`,
            width: `${14 / camera.zoom}px`,
            height: `${14 / camera.zoom}px`,
            borderWidth: `${2 / camera.zoom}px`,
            transform: 'translate(-50%, -50%)',
            zIndex: placed.length + 2,
            cursor: 'crosshair',
          }"
        />
        <div
          :data-element="selectedOne.id"
          data-handle="resize"
          class="absolute rounded-sm border-accent bg-surface"
          :style="{
            left: `${box(selectedOne).x + box(selectedOne).w + 4 / camera.zoom}px`,
            top: `${box(selectedOne).y + box(selectedOne).h + 4 / camera.zoom}px`,
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
      <line v-if="connecting" :x1="connecting.s.x" :y1="connecting.s.y" :x2="connecting.e.x" :y2="connecting.e.y" stroke="var(--color-accent)" :stroke-width="stroke" stroke-dasharray="6 4" marker-end="url(#wb-head)" />
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
    />

    <div v-if="!placed.length && !gesture" class="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center text-sm text-ink-faint">
      <p>{{ readonly ? 'This board is empty.' : 'Drag objects here from the sidebar, add one with @, draw with P, or double-click to write.' }}</p>
    </div>
    <button v-if="lost" data-ui class="absolute left-1/2 top-4 -translate-x-1/2 rounded-full border border-line bg-surface px-3 py-1.5 text-sm shadow-sm hover:bg-hover" @click="fit()">
      Back to content
    </button>

    <!-- Pen options -->
    <div
      v-if="!readonly && (tool === 'pen' || tool === 'highlighter')"
      data-ui
      class="absolute bottom-[3.75rem] left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border border-line bg-surface p-1 shadow-md"
    >
      <template v-if="tool === 'pen'">
        <button
          v-for="c in [undefined, ...PICKER_COLORS.slice(1, 7)]"
          :key="c ?? 'ink'"
          class="grid h-7 w-7 place-items-center rounded-md hover:bg-hover"
          :title="c ?? 'Ink'"
          @click="pen.color = c"
        >
          <span class="h-4 w-4 rounded-full" :class="pen.color === c ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface' : ''" :style="{ background: strokeColor(c) }" />
        </button>
        <span class="mx-1 h-5 w-px bg-line" />
        <button v-for="s in PEN_SIZES" :key="s" class="grid h-7 w-7 place-items-center rounded-md hover:bg-hover" :class="pen.size === s ? 'bg-hover' : ''" :title="`Size ${s}`" @click="pen.size = s">
          <span class="rounded-full bg-ink" :style="{ width: `${s + 2}px`, height: `${s + 2}px` }" />
        </button>
      </template>
      <span v-else class="px-2 text-xs text-ink-soft">Highlighter</span>
    </div>

    <!-- Tools -->
    <div data-ui class="absolute bottom-3 left-1/2 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-xl border border-line bg-surface p-1 shadow-md max-sm:left-3 max-sm:max-w-[calc(100%-4.5rem)] max-sm:translate-x-0">
      <template v-if="!readonly">
        <button
          v-for="t in tools"
          :key="t.id"
          class="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
          :class="tool === t.id ? 'bg-accent/15 text-accent' : 'text-ink-soft hover:bg-hover hover:text-ink'"
          :title="`${t.label} (${t.key})`"
          :aria-label="t.label"
          :aria-pressed="tool === t.id"
          @click="tool = t.id"
        >
          <AppIcon :fallback="toolIcon(t)" :size="18" />
        </button>
        <span class="mx-1 h-5 w-px shrink-0 bg-line" />
        <button
          ref="pickerAnchor"
          class="flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm text-ink-soft hover:bg-hover hover:text-ink"
          title="Add an object (@)"
          @click="pickerOpen = !pickerOpen"
        >
          <AppIcon fallback="ph:cards" :size="18" /><span class="max-lg:hidden">Object</span>
        </button>
      </template>
      <template v-else>
        <span class="px-2 text-xs text-ink-faint">Read only</span>
      </template>
    </div>

    <!-- Zoom -->
    <div data-ui class="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-xl border border-line bg-surface p-1 text-sm shadow-md">
      <button class="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-hover max-md:hidden" title="Zoom out" aria-label="Zoom out" @click="zoomAt(size.w / 2, size.h / 2, camera.zoom / 1.25)">
        <AppIcon fallback="ph:minus" :size="16" />
      </button>
      <button class="h-8 w-14 rounded-lg tabular-nums text-ink-soft hover:bg-hover max-md:hidden" title="Zoom to 100% (⇧0)" @click="zoomAt(size.w / 2, size.h / 2, 1)">{{ Math.round(camera.zoom * 100) }}%</button>
      <button class="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-hover max-md:hidden" title="Zoom in" aria-label="Zoom in" @click="zoomAt(size.w / 2, size.h / 2, camera.zoom * 1.25)">
        <AppIcon fallback="ph:plus" :size="16" />
      </button>
      <button class="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-hover" title="Fit everything (⇧1)" aria-label="Fit everything" @click="fit()">
        <AppIcon fallback="ph:frame-corners" :size="16" />
      </button>
    </div>

    <PopoverMenu v-model:open="pickerOpen" :anchor="pickerAnchor" placement="top" width="20rem">
      <div data-ui @keydown.stop>
        <ObjectPicker :exclude="[boardId]" create-label="New page" @pick="picked" @create="created" />
      </div>
    </PopoverMenu>
  </div>
</template>

<style scoped>
.whiteboard {
  background-image: radial-gradient(circle, var(--color-line-strong) 1px, transparent 1.2px);
}
</style>
