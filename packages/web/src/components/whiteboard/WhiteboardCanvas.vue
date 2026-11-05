<script setup lang="ts">
// A whiteboard: object cards, text and arrows on an endless canvas. The elements live in the
// board's Y.Doc (core board.ts); this component reads them on every change and writes through
// the board functions, so edits from other devices merge in while it is open. Cards and text are
// HTML in a layer moved and scaled by the camera; arrows, the marquee and the line being drawn are
// SVG in screen space, so the layer stays the size of the view at any zoom.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  BOARD_FIELD,
  addBoardElements,
  isPlaced,
  readBoard,
  removeBoardElements,
  updateBoardElements,
  type BoardElement,
  type BoardPatch,
  type Id,
  type ObjectSummary,
  type PlacedElement,
} from '@vasta/core'
import { Y } from '@vasta/editor-schema/yjs'
import { api } from '../../lib/api.ts'
import { primeSummaries, systemType, typesById, useSummaries } from '../../lib/state.ts'
import { promptDialog } from '../../lib/overlays.ts'
import AppIcon from '../AppIcon.vue'
import ObjectCard from '../ObjectCard.vue'
import ObjectPicker from '../ObjectPicker.vue'
import PopoverMenu from '../PopoverMenu.vue'

const props = defineProps<{ doc: Y.Doc; boardId: Id; readonly?: boolean }>()
const router = useRouter()

/** Origin of this page's writes: what undo covers. */
const LOCAL = 'whiteboard-local'
const CARD = { w: 260, h: 150 }
const MIN = { w: 80, h: 36 }
const MIN_ZOOM = 0.1
const MAX_ZOOM = 4

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
const add = (list: Parameters<typeof addBoardElements>[1]) => {
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

/** A point of the view (from its top left) in board coordinates. */
const toWorld = (sx: number, sy: number) => ({ x: (sx - camera.x) / camera.zoom, y: (sy - camera.y) / camera.zoom })
const toScreen = (x: number, y: number) => ({ x: x * camera.zoom + camera.x, y: y * camera.zoom + camera.y })
const local = (event: { clientX: number; clientY: number }) => {
  const rect = root.value!.getBoundingClientRect()
  return { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

function zoomAt(sx: number, sy: number, zoom: number) {
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
  const world = toWorld(sx, sy)
  camera.zoom = next
  camera.x = sx - world.x * next
  camera.y = sy - world.y * next
}

/** Show these elements whole, centered (everything when none are given). */
function fit(list: PlacedElement[] = placed.value, maxZoom = 1) {
  if (!list.length || !size.w) {
    Object.assign(camera, { x: size.w / 2, y: size.h / 2, zoom: 1 })
    return
  }
  const boxes = list.map(box)
  const left = Math.min(...boxes.map((b) => b.x))
  const top = Math.min(...boxes.map((b) => b.y))
  const right = Math.max(...boxes.map((b) => b.x + b.w))
  const bottom = Math.max(...boxes.map((b) => b.y + b.h))
  const pad = 64
  const zoom = Math.min(maxZoom, Math.max(MIN_ZOOM, Math.min((size.w - pad * 2) / Math.max(right - left, 1), (size.h - pad * 2) / Math.max(bottom - top, 1))))
  camera.zoom = zoom
  camera.x = size.w / 2 - ((left + right) / 2) * zoom
  camera.y = size.h / 2 - ((top + bottom) / 2) * zoom
}

/** The middle of the view, in board coordinates (where new things go). */
const viewCenter = () => toWorld(size.w / 2, size.h / 2)

// Selection, previews -------------------------------------------------------------

const selection = ref<Set<Id>>(new Set())
const select = (ids: Iterable<Id>) => (selection.value = new Set(ids))
const editing = ref<Id | null>(null)
const draft = ref('')
/** While dragging: how far the selection moved, or the size being given to one element. */
const preview = reactive<{ dx: number; dy: number; resize: { id: Id; w: number; h: number } | null; textH: Record<Id, number> }>({ dx: 0, dy: 0, resize: null, textH: {} })

/** Where an element is drawn now, with what is being dragged. */
function box(element: PlacedElement) {
  const moving = selection.value.has(element.id) && (preview.dx || preview.dy)
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
const inView = (b: { x: number; y: number; w: number; h: number }) => b.x < view.value.right && b.x + b.w > view.value.left && b.y < view.value.bottom && b.y + b.h > view.value.top
/** Only what is in view (and what is selected) is drawn, so big boards stay quick. */
const shown = computed(() => placed.value.map((element, index) => ({ element, index, box: box(element) })).filter(({ element, box }) => selection.value.has(element.id) || inView(box)))
const lost = computed(() => placed.value.length > 0 && shown.value.length === 0)

/** Where a line from the middle of `b` towards (px, py) leaves it. */
function edgePoint(b: { x: number; y: number; w: number; h: number }, px: number, py: number) {
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  const dx = px - cx
  const dy = py - cy
  if (!dx && !dy) return { x: cx, y: cy }
  const t = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity)
  return { x: cx + dx * t, y: cy + dy * t }
}
const center = (b: { x: number; y: number; w: number; h: number }) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })

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
    const s = toScreen(start.x, start.y)
    const e = toScreen(end.x, end.y)
    return [{ arrow, s, e, mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } }]
  })
)
const stroke = computed(() => Math.max(1, 1.75 * camera.zoom))

// Tools and gestures --------------------------------------------------------------

type Tool = 'select' | 'hand' | 'text' | 'arrow'
const tool = ref<Tool>('select')
const spaceHeld = ref(false)

type Gesture =
  | { kind: 'pan'; sx: number; sy: number; x: number; y: number }
  | { kind: 'move'; start: { x: number; y: number }; moved: boolean; sx: number; sy: number }
  | { kind: 'resize'; id: Id; start: { x: number; y: number }; w: number; h: number }
  | { kind: 'marquee'; start: { x: number; y: number }; end: { x: number; y: number }; keep: Set<Id> }
  | { kind: 'connect'; from: Id; end: { x: number; y: number } }
  | { kind: 'pinch'; distance: number; zoom: number; mid: { x: number; y: number }; cam: { x: number; y: number } }
const gesture = shallowRef<Gesture | null>(null)
const pointers = new Map<number, { x: number; y: number }>()

const elementAt = (target: EventTarget | null) => (target as HTMLElement | null)?.closest?.<HTMLElement>('[data-element]')?.dataset.element
const arrowAt = (target: EventTarget | null) => (target as Element | null)?.closest?.<SVGElement | HTMLElement>('[data-arrow]')?.dataset.arrow
const handleAt = (target: EventTarget | null) => (target as HTMLElement | null)?.closest?.<HTMLElement>('[data-handle]')?.dataset.handle

function pinchState() {
  const [a, b] = [...pointers.values()]
  return { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y), mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 } }
}

function cancelGesture() {
  preview.dx = preview.dy = 0
  preview.resize = null
  gesture.value = null
}

function onPointerDown(event: PointerEvent) {
  if ((event.target as HTMLElement).closest('[data-ui]')) return
  if (editing.value && (event.target as HTMLElement).closest('textarea')) return
  root.value?.focus({ preventScroll: true })
  const p = local(event)
  pointers.set(event.pointerId, p)
  try {
    root.value?.setPointerCapture(event.pointerId)
  } catch {} // a pointer that is already gone
  if (pointers.size === 2) {
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
  if (event.button === 1 || spaceHeld.value || tool.value === 'hand') {
    gesture.value = { kind: 'pan', sx: p.x, sy: p.y, x: camera.x, y: camera.y }
    return
  }
  if (event.button !== 0 || props.readonly) {
    if (!elementId) gesture.value = { kind: 'pan', sx: p.x, sy: p.y, x: camera.x, y: camera.y }
    return
  }
  if (handle && elementId) {
    const element = byId.value.get(elementId)
    if (handle === 'resize' && element && isPlaced(element)) gesture.value = { kind: 'resize', id: elementId, start: world, w: element.w, h: element.h }
    else if (handle === 'connect') gesture.value = { kind: 'connect', from: elementId, end: world }
    return
  }
  if (tool.value === 'arrow' && elementId) {
    gesture.value = { kind: 'connect', from: elementId, end: world }
    return
  }
  if (tool.value === 'text' && !elementId) {
    addText(world)
    tool.value = 'select'
    return
  }
  if (elementId) {
    if (event.shiftKey) {
      const next = new Set(selection.value)
      if (next.has(elementId)) next.delete(elementId)
      else next.add(elementId)
      select(next)
    } else if (!selection.value.has(elementId)) select([elementId])
    gesture.value = { kind: 'move', start: world, moved: false, sx: p.x, sy: p.y }
    return
  }
  const arrowId = arrowAt(event.target)
  if (arrowId) {
    select(event.shiftKey ? [...selection.value, arrowId] : [arrowId])
    return
  }
  // Empty board: a finger pans, a mouse or pen draws a selection box.
  if (event.pointerType === 'touch') {
    select([])
    gesture.value = { kind: 'pan', sx: p.x, sy: p.y, x: camera.x, y: camera.y }
    return
  }
  const keep = event.shiftKey ? new Set(selection.value) : new Set<Id>()
  select(keep)
  gesture.value = { kind: 'marquee', start: world, end: world, keep }
}

function onPointerMove(event: PointerEvent) {
  if (!pointers.has(event.pointerId)) return
  const p = local(event)
  pointers.set(event.pointerId, p)
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
    preview.dx = Math.round(world.x - g.start.x)
    preview.dy = Math.round(world.y - g.start.y)
  } else if (g.kind === 'resize') {
    preview.resize = { id: g.id, w: Math.max(MIN.w, Math.round(g.w + world.x - g.start.x)), h: Math.max(MIN.h, Math.round(g.h + world.y - g.start.y)) }
  } else if (g.kind === 'marquee') {
    gesture.value = { ...g, end: world }
    const [left, right] = [Math.min(g.start.x, world.x), Math.max(g.start.x, world.x)]
    const [top, bottom] = [Math.min(g.start.y, world.y), Math.max(g.start.y, world.y)]
    const inside = placed.value.filter((e) => e.x < right && e.x + e.w > left && e.y < bottom && e.y + e.h > top).map((e) => e.id)
    select([...g.keep, ...inside])
  } else if (g.kind === 'connect') {
    gesture.value = { ...g, end: world }
  }
}

function onPointerUp(event: PointerEvent) {
  if (!pointers.delete(event.pointerId)) return
  const g = gesture.value
  if (g?.kind === 'pinch') {
    // Lifting one finger of two ends the pinch; the other does nothing until it lifts too.
    if (pointers.size === 0) gesture.value = null
    return
  }
  if (!g) return
  if (g.kind === 'move' && g.moved && (preview.dx || preview.dy)) {
    const patches: Record<Id, BoardPatch> = {}
    for (const id of selection.value) {
      const element = byId.value.get(id)
      if (element && isPlaced(element)) patches[id] = { x: element.x + preview.dx, y: element.y + preview.dy }
    }
    update(patches)
  } else if (g.kind === 'resize' && preview.resize) {
    update({ [g.id]: { w: preview.resize.w, h: preview.resize.h } })
  } else if (g.kind === 'connect' && event.type === 'pointerup') {
    const target = elementAt(document.elementFromPoint(event.clientX, event.clientY))
    const exists = arrows.value.some((a) => a.kind === 'arrow' && ((a.from === g.from && a.to === target) || (a.from === target && a.to === g.from)))
    if (target && target !== g.from && !exists) select(add([{ kind: 'arrow', from: g.from, to: target }]))
    tool.value = 'select'
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
  if (props.readonly || (event.target as HTMLElement).closest('[data-ui]')) return
  const elementId = elementAt(event.target)
  const element = elementId ? byId.value.get(elementId) : undefined
  if (element?.kind === 'card') void router.push(`/o/${element.objectId}`)
  else if (element?.kind === 'text') startEditing(element.id)
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
  let spot = { x: Math.round(at.x - CARD.w / 2), y: Math.round(at.y - CARD.h / 2) }
  const list = objectIds.map((objectId) => {
    spot = freeSpot(spot.x, spot.y)
    const card = { kind: 'card' as const, objectId, ...spot, ...CARD }
    spot = { x: spot.x + 24, y: spot.y + 24 }
    return card
  })
  select(add(list))
}

function addText(at: { x: number; y: number }) {
  const [id] = add([{ kind: 'text', text: '', x: Math.round(at.x), y: Math.round(at.y - 18), w: 220, h: 40 }])
  select([id!])
  startEditing(id!)
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

/** An object's link dropped on the board (from the sidebar, a list, another page). */
function droppedId(data: DataTransfer): Id | null {
  for (const text of [data.getData('text/uri-list'), data.getData('text/plain')]) {
    try {
      const match = /^\/o\/([^/]+)$/.exec(new URL(text.trim().split('\n')[0]!, location.href).pathname)
      if (match) return decodeURIComponent(match[1]!)
    } catch {}
  }
  return null
}
function onDragOver(event: DragEvent) {
  if (props.readonly || !event.dataTransfer?.types.includes('text/uri-list')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
}
function onDrop(event: DragEvent) {
  const id = event.dataTransfer && droppedId(event.dataTransfer)
  if (!id || id === props.boardId || props.readonly) return
  event.preventDefault()
  const p = local(event)
  addCards([id], toWorld(p.x, p.y))
}

// Text ----------------------------------------------------------------------------

// A plain variable set by a function ref: a ref inside v-for would collect an array.
let editor: HTMLTextAreaElement | null = null
const setEditor = (el: unknown) => (editor = el as HTMLTextAreaElement | null)
function startEditing(id: Id) {
  const element = byId.value.get(id) ?? readBoard(props.doc).find((e) => e.id === id)
  editing.value = id
  draft.value = element?.kind === 'text' ? element.text : ''
  void nextTick(() => {
    editor?.focus()
    fitText()
  })
}
function fitText() {
  const el = editor
  if (!el || !editing.value) return
  el.style.height = 'auto'
  preview.textH = { [editing.value]: Math.max(MIN.h, Math.ceil(el.scrollHeight / camera.zoom) + 4) }
  el.style.height = ''
}
function commitText() {
  const id = editing.value
  if (!id) return
  editing.value = null
  const h = preview.textH[id]
  preview.textH = {}
  if (!draft.value.trim()) remove([id])
  else update({ [id]: { text: draft.value, ...(h ? { h } : {}) } })
  root.value?.focus({ preventScroll: true })
}

async function labelArrow(id: Id) {
  const arrow = byId.value.get(id)
  if (arrow?.kind !== 'arrow') return
  const label = await promptDialog({ title: 'Arrow label', value: arrow.label ?? '', placeholder: 'What links them', optional: true, confirmLabel: 'Save' })
  if (label !== null) update({ [id]: { label: label.trim() || undefined } })
}

// Keyboard ------------------------------------------------------------------------

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
  if (mod && key === '0') return (event.preventDefault(), zoomAt(size.w / 2, size.h / 2, 1))
  if (mod || event.altKey) return
  if (event.shiftKey && (event.code === 'Digit1' || key === '!')) return (event.preventDefault(), fit())
  if (event.shiftKey && (event.code === 'Digit2' || key === '@')) {
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
  if (props.readonly) return
  if (key === 'delete' || key === 'backspace') {
    event.preventDefault()
    if (selection.value.size) remove([...selection.value])
    select([])
  } else if (key === 'enter' && selection.value.size === 1) {
    const element = byId.value.get([...selection.value][0]!)
    if (element?.kind === 'text') (event.preventDefault(), startEditing(element.id))
    else if (element?.kind === 'arrow') (event.preventDefault(), void labelArrow(element.id))
  } else if (key.startsWith('arrow') && selection.value.size) {
    event.preventDefault()
    const step = event.shiftKey ? 10 : 1
    const [dx, dy] = key === 'arrowleft' ? [-step, 0] : key === 'arrowright' ? [step, 0] : key === 'arrowup' ? [0, -step] : [0, step]
    const patches: Record<Id, BoardPatch> = {}
    for (const id of selection.value) {
      const element = byId.value.get(id)
      if (element && isPlaced(element)) patches[id] = { x: element.x + dx, y: element.y + dy }
    }
    update(patches)
  } else if (key === 'v') tool.value = 'select'
  else if (key === 'h') tool.value = 'hand'
  else if (key === 't') tool.value = 'text'
  else if (key === 'l' || key === 'a') tool.value = 'arrow'
  else if (key === 'o' || event.key === '@') {
    event.preventDefault()
    pickerOpen.value = true
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

const selectedOne = computed(() => {
  if (selection.value.size !== 1 || gesture.value?.kind === 'move') return undefined
  const element = byId.value.get([...selection.value][0]!)
  return element && isPlaced(element) ? element : undefined
})

const tools: { id: Tool; icon: string; label: string; key: string }[] = [
  { id: 'select', icon: 'ph:cursor', label: 'Select', key: 'V' },
  { id: 'hand', icon: 'ph:hand', label: 'Hand', key: 'H' },
  { id: 'text', icon: 'ph:text-t', label: 'Text', key: 'T' },
  { id: 'arrow', icon: 'ph:arrow-up-right', label: 'Arrow', key: 'L' },
]

const background = computed(() => {
  const step = 24 * camera.zoom
  return { backgroundSize: `${step}px ${step}px`, backgroundPosition: `${camera.x}px ${camera.y}px` }
})
const marquee = computed(() => {
  const g = gesture.value
  if (g?.kind !== 'marquee') return null
  const a = toScreen(g.start.x, g.start.y)
  const b = toScreen(g.end.x, g.end.y)
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }
})
const drawing = computed(() => {
  const g = gesture.value
  if (g?.kind !== 'connect') return null
  const from = byId.value.get(g.from)
  if (!from || !isPlaced(from)) return null
  const start = edgePoint(box(from), g.end.x, g.end.y)
  return { s: toScreen(start.x, start.y), e: toScreen(g.end.x, g.end.y) }
})
const cursor = computed(() => {
  const g = gesture.value
  if (g?.kind === 'pan') return 'grabbing'
  if (spaceHeld.value || tool.value === 'hand') return 'grab'
  if (tool.value === 'text') return 'text'
  if (tool.value === 'arrow') return 'crosshair'
  return 'default'
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
          :stroke="selection.has(path.arrow.id) ? 'var(--color-accent)' : 'var(--color-ink-soft)'"
          :stroke-width="stroke"
          stroke-linecap="round"
          marker-end="url(#wb-head)"
        />
      </g>
      <line v-if="drawing" :x1="drawing.s.x" :y1="drawing.s.y" :x2="drawing.e.x" :y2="drawing.e.y" stroke="var(--color-accent)" :stroke-width="stroke" stroke-dasharray="6 4" marker-end="url(#wb-head)" />
      <rect v-if="marquee" :x="marquee.x" :y="marquee.y" :width="marquee.w" :height="marquee.h" fill="color-mix(in srgb, var(--color-accent) 8%, transparent)" stroke="var(--color-accent)" stroke-width="1" />
    </svg>

    <div class="absolute left-0 top-0 origin-top-left" :style="{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }">
      <div
        v-for="{ element, index, box: b } in shown"
        :key="element.id"
        :data-element="element.id"
        class="absolute"
        :style="{ left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px`, zIndex: index + 1 }"
        @click.capture.prevent
        @dragstart.prevent
      >
        <template v-if="element.kind === 'card'">
          <ObjectCard
            v-if="summaryById.get(element.objectId)"
            :object="summaryById.get(element.objectId)!"
            :type="typesById.get(summaryById.get(element.objectId)!.typeId)"
            variant="grid"
            class="pointer-events-none h-full"
          />
          <div v-else class="grid h-full place-items-center rounded-xl border border-dashed border-line-strong bg-surface text-sm text-ink-faint">Loading…</div>
        </template>
        <template v-else>
          <textarea
            v-if="editing === element.id"
            :ref="setEditor"
            v-model="draft"
            class="h-full w-full resize-none overflow-hidden bg-transparent p-1 text-[15px] leading-snug text-ink outline-none"
            placeholder="Text"
            @input="fitText"
            @blur="commitText"
          />
          <div v-else class="h-full w-full whitespace-pre-wrap break-words p-1 text-[15px] leading-snug text-ink">{{ element.text }}</div>
        </template>
        <div
          v-if="selection.has(element.id)"
          class="pointer-events-none absolute -inset-1 rounded-[14px] border-2 border-accent"
          :style="{ borderWidth: `${2 / camera.zoom}px` }"
        />
      </div>

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

      <!-- Handles of the one selected element: drag the dot to draw an arrow, the corner to resize. -->
      <template v-if="selectedOne && !readonly && editing !== selectedOne.id">
        <div
          :data-element="selectedOne.id"
          data-handle="connect"
          title="Drag to another element to draw an arrow"
          class="absolute grid place-items-center rounded-full border-2 border-accent bg-surface"
          :style="{
            left: `${box(selectedOne).x + box(selectedOne).w + 14 / camera.zoom}px`,
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
            left: `${box(selectedOne).x + box(selectedOne).w}px`,
            top: `${box(selectedOne).y + box(selectedOne).h}px`,
            width: `${10 / camera.zoom}px`,
            height: `${10 / camera.zoom}px`,
            borderWidth: `${2 / camera.zoom}px`,
            transform: 'translate(-50%, -50%)',
            zIndex: placed.length + 2,
            cursor: 'nwse-resize',
          }"
        />
      </template>
    </div>

    <div v-if="!placed.length" class="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center text-sm text-ink-faint">
      <p>{{ readonly ? 'This board is empty.' : 'Drag objects here from the sidebar, add one with @, or double-click to write.' }}</p>
    </div>
    <button v-if="lost" data-ui class="absolute left-1/2 top-4 -translate-x-1/2 rounded-full border border-line bg-surface px-3 py-1.5 text-sm shadow-sm hover:bg-hover" @click="fit()">
      Back to content
    </button>

    <!-- Tools -->
    <div data-ui class="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-xl border border-line bg-surface p-1 shadow-md">
      <template v-if="!readonly">
        <button
          v-for="t in tools"
          :key="t.id"
          class="grid h-9 w-9 place-items-center rounded-lg"
          :class="tool === t.id ? 'bg-accent/15 text-accent' : 'text-ink-soft hover:bg-hover hover:text-ink'"
          :title="`${t.label} (${t.key})`"
          :aria-label="t.label"
          :aria-pressed="tool === t.id"
          @click="tool = t.id"
        >
          <AppIcon :fallback="t.icon" :size="18" />
        </button>
        <span class="mx-1 h-5 w-px bg-line" />
        <button
          ref="pickerAnchor"
          class="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-ink-soft hover:bg-hover hover:text-ink"
          title="Add an object (@)"
          @click="pickerOpen = !pickerOpen"
        >
          <AppIcon fallback="ph:cards" :size="18" /><span class="max-sm:hidden">Object</span>
        </button>
      </template>
      <template v-else>
        <span class="px-2 text-xs text-ink-faint">Read only</span>
      </template>
    </div>

    <!-- Zoom -->
    <div data-ui class="absolute bottom-3 right-3 flex items-center gap-0.5 rounded-xl border border-line bg-surface p-1 text-sm shadow-md">
      <button class="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-hover max-sm:hidden" title="Zoom out" aria-label="Zoom out" @click="zoomAt(size.w / 2, size.h / 2, camera.zoom / 1.25)">
        <AppIcon fallback="ph:minus" :size="16" />
      </button>
      <button class="h-8 w-14 rounded-lg tabular-nums max-sm:hidden text-ink-soft hover:bg-hover" title="Zoom to 100% (⇧0)" @click="zoomAt(size.w / 2, size.h / 2, 1)">{{ Math.round(camera.zoom * 100) }}%</button>
      <button class="grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-hover max-sm:hidden" title="Zoom in" aria-label="Zoom in" @click="zoomAt(size.w / 2, size.h / 2, camera.zoom * 1.25)">
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
