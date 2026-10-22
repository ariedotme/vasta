// Moving and resizing calendar entries with pointer events, the same way for a mouse and a
// finger: a mouse drags as soon as it moves, a finger after a long press (a short swipe still
// scrolls). HTML5 drag and drop does not work on touch screens.
//
// Drop targets are found under the pointer by their data attributes: `data-day` on day cells and
// columns, plus `data-timed` on the hour columns, where the pointer's height gives the time.
import { reactive, type InjectionKey } from 'vue'
import type { CalendarEntry } from '@vasta/core'
import { HOUR_HEIGHT, minutesInto } from './calendar.ts'

const LONG_PRESS = 400
const SLOP = 8
const SNAP = 15

/** Where a moved entry would start, or (resizing) where it would end on its first day. */
export interface DropTarget {
  day: string
  /** Minutes after midnight, over an hour column; absent over a day cell (the time stays). */
  minutes?: number
}

export const drag = reactive({
  active: false,
  mode: 'move' as 'move' | 'resize',
  entry: null as CalendarEntry | null,
  target: null as DropTarget | null,
})

export type DropHandler = (entry: CalendarEntry, mode: 'move' | 'resize', target: DropTarget) => void

/** What the calendar page gives its entries: which can move or be resized, and what a drop does. */
export interface EntryDragging {
  movable: (entry: CalendarEntry) => boolean
  resizable: (entry: CalendarEntry) => boolean
  drop: DropHandler
}
export const ENTRY_DRAGGING: InjectionKey<EntryDragging> = Symbol('entry-dragging')

let press:
  | {
      entry: CalendarEntry
      mode: 'move' | 'resize'
      pointerId: number
      x: number
      y: number
      /** Pointer height inside the grabbed block, so a drop keeps it under the same spot. */
      offsetY: number
      /** Days between the entry's first day and the day grabbed (multi-day entries). */
      dayOffset: number
      timer?: ReturnType<typeof setTimeout>
      onDrop: DropHandler
    }
  | undefined
let scrollFrame = 0
let lastPoint = { x: 0, y: 0 }

const snap = (minutes: number, max = 1440 - SNAP) => Math.min(max, Math.max(0, Math.round(minutes / SNAP) * SNAP))

function cellAt(x: number, y: number): HTMLElement | undefined {
  return document.elementsFromPoint(x, y).find((element): element is HTMLElement => element instanceof HTMLElement && !!element.dataset.day)
}

/** Start following a press on an entry (pointerdown). Clicks that never become a drag go on as clicks. */
export function pressEntry(event: PointerEvent, entry: CalendarEntry, mode: 'move' | 'resize', onDrop: DropHandler) {
  if (event.button !== 0 || press) return
  const block = (event.currentTarget as HTMLElement).closest<HTMLElement>('.vasta-entry') ?? (event.currentTarget as HTMLElement)
  const cell = cellAt(event.clientX, event.clientY)
  press = {
    entry,
    mode,
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    offsetY: event.clientY - block.getBoundingClientRect().top,
    dayOffset: cell?.dataset.day && cell.dataset.day > entry.startDay ? daysFrom(entry.startDay, cell.dataset.day) : 0,
    onDrop,
  }
  lastPoint = { x: event.clientX, y: event.clientY }
  if (mode === 'resize') event.stopPropagation()
  if (event.pointerType === 'touch') press.timer = setTimeout(begin, LONG_PRESS)
  else if (mode === 'resize') begin()
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', onKey, true)
  // Once a finger drags, the page must not scroll under it.
  window.addEventListener('touchmove', onTouchMove, { passive: false })
}

const daysFrom = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

function begin() {
  if (!press) return
  clearTimeout(press.timer)
  press.timer = undefined
  drag.active = true
  drag.mode = press.mode
  drag.entry = press.entry
  navigator.vibrate?.(10)
  document.documentElement.classList.add(press.mode === 'resize' ? 'vasta-resizing' : 'vasta-dragging')
  update(lastPoint.x, lastPoint.y)
}

function onMove(event: PointerEvent) {
  if (!press || event.pointerId !== press.pointerId) return
  lastPoint = { x: event.clientX, y: event.clientY }
  const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y) > SLOP
  if (!drag.active) {
    if (!moved) return
    // A finger that moves before the long press scrolls instead.
    if (press.timer) return cancel()
    begin()
    return
  }
  update(event.clientX, event.clientY)
}

function update(x: number, y: number) {
  if (!press) return
  autoScroll(x, y)
  const entry = press.entry
  if (press.mode === 'resize') {
    const column = document.querySelector<HTMLElement>(`[data-timed][data-day="${entry.startDay}"]`)
    if (!column) return
    const start = minutesInto(entry.startDay, entry.start)
    const minutes = snap(((y - column.getBoundingClientRect().top) / HOUR_HEIGHT) * 60, 1440)
    drag.target = { day: entry.startDay, minutes: Math.max(start + SNAP, minutes) }
    return
  }
  const cell = cellAt(x, y)
  const day = cell?.dataset.day
  if (!cell || !day) {
    drag.target = null
    return
  }
  // All-day entries stay all-day: over the hours they go to that day.
  if (cell.dataset.timed !== undefined && !entry.allDay) {
    drag.target = { day, minutes: snap(((y - press.offsetY - cell.getBoundingClientRect().top) / HOUR_HEIGHT) * 60) }
  } else {
    drag.target = { day: shiftDay(day, -press.dayOffset) }
  }
}

const shiftDay = (day: string, days: number) => {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** Near the edge of a scrolling area (the hour grid), scroll it while the pointer stays there. */
function autoScroll(x: number, y: number) {
  cancelAnimationFrame(scrollFrame)
  const scroller = document.elementsFromPoint(x, y).find((element) => element instanceof HTMLElement && element.dataset.dragScroll !== undefined) as HTMLElement | undefined
  if (!scroller) return
  const box = scroller.getBoundingClientRect()
  const edge = 48
  const dy = y < box.top + edge ? -1 : y > box.bottom - edge ? 1 : 0
  const dx = x < box.left + edge ? -1 : x > box.right - edge ? 1 : 0
  if (!dx && !dy) return
  scrollFrame = requestAnimationFrame(() => {
    scroller.scrollBy(dx * 8, dy * 8)
    if (drag.active) update(lastPoint.x, lastPoint.y)
  })
}

function onUp(event: PointerEvent) {
  if (!press || event.pointerId !== press.pointerId) return
  const done = drag.active && drag.target ? { entry: press.entry, mode: press.mode, target: drag.target, onDrop: press.onDrop } : undefined
  if (drag.active) swallowClick()
  cancel()
  if (done) done.onDrop(done.entry, done.mode, done.target)
}

function onKey(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !drag.active) return
  event.preventDefault()
  event.stopPropagation()
  swallowClick()
  cancel()
}

function onTouchMove(event: TouchEvent) {
  if (drag.active) event.preventDefault()
}

/**
 * The click that follows a drop must not open the entry or create something where it landed. A
 * finger's drag makes no click, so a new press ends the wait (a tap on the question that follows).
 */
function swallowClick() {
  const swallow = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
    stop()
  }
  const stop = () => {
    window.removeEventListener('click', swallow, { capture: true })
    window.removeEventListener('pointerdown', stop, { capture: true })
  }
  window.addEventListener('click', swallow, { capture: true })
  setTimeout(() => window.addEventListener('pointerdown', stop, { capture: true }))
  setTimeout(stop, 300)
}

function cancel() {
  clearTimeout(press?.timer)
  cancelAnimationFrame(scrollFrame)
  press = undefined
  drag.active = false
  drag.entry = null
  drag.target = null
  document.documentElement.classList.remove('vasta-dragging', 'vasta-resizing')
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('pointercancel', cancel)
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('touchmove', onTouchMove)
}
