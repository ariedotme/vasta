// Moving, resizing and scheduling calendar entries with pointer events, the same way for a mouse
// and a finger: a mouse drags as soon as it moves, a finger after a long press (a short swipe
// still scrolls). HTML5 drag and drop does not work on touch screens.
//
// Drop targets are found under the pointer by their data attributes:
// - `data-day` on day cells and columns
// - `data-timed` on hour columns, where the pointer's height gives the time
// - `data-allday` on the TimeGrid's all-day cells (explicitly sets a day-only date)
// - `data-unschedule-drop` on the tasks sidebar (clears a dropped entry's date)
import { reactive, type InjectionKey } from 'vue'
import type { CalendarEntry, ColorName, DateValue, Icon, Id } from '@vasta/core'
import { HOUR_HEIGHT, minutesInto } from './calendar.ts'

const LONG_PRESS = 400
const SLOP = 8
const SNAP = 15

/** Where a moved/scheduled item would land, or (resizing) where it would end on its first day. */
export type DropTarget =
  | {
      day: string
      /** Minutes after midnight, over an hour column; absent over a day cell. */
      minutes?: number
      /** Explicitly over the TimeGrid's all-day row. */
      allDay?: boolean
      unschedule?: false
    }
  | {
      unschedule: true
      day?: undefined
      minutes?: undefined
      allDay?: undefined
    }

/** An object dragged from the calendar's scheduling sidebar onto the grid. */
export interface ScheduleDragItem {
  objectId: Id
  field: Id
  title: string
  color?: ColorName | undefined
  icon?: Icon | undefined
  fallbackIcon?: string | undefined
  currentDate?: DateValue | undefined
  durationMinutes: number
}

export const drag = reactive({
  active: false,
  mode: 'move' as 'move' | 'resize' | 'schedule',
  entry: null as CalendarEntry | null,
  scheduleItem: null as ScheduleDragItem | null,
  target: null as DropTarget | null,
  x: 0,
  y: 0,
})

export type DropHandler = (entry: CalendarEntry, mode: 'move' | 'resize', target: DropTarget) => void
export type ScheduleDropHandler = (item: ScheduleDragItem, target: Extract<DropTarget, { day: string }>) => void

/** What the calendar page gives its entries: which can move or be resized, and what a drop does. */
export interface EntryDragging {
  movable: (entry: CalendarEntry) => boolean
  resizable: (entry: CalendarEntry) => boolean
  drop: DropHandler
}
export const ENTRY_DRAGGING: InjectionKey<EntryDragging> = Symbol('entry-dragging')

type PressState =
  | {
      kind: 'entry'
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
  | {
      kind: 'schedule'
      item: ScheduleDragItem
      pointerId: number
      x: number
      y: number
      timer?: ReturnType<typeof setTimeout>
      onDrop: ScheduleDropHandler
    }

let press: PressState | undefined
let scrollFrame = 0
let lastPoint = { x: 0, y: 0 }

const snap = (minutes: number, max = 1440 - SNAP) => Math.min(max, Math.max(0, Math.round(minutes / SNAP) * SNAP))

function cellAt(x: number, y: number): HTMLElement | undefined {
  return document.elementsFromPoint(x, y).find((element): element is HTMLElement => element instanceof HTMLElement && !!element.dataset.day)
}

function unscheduleZoneAt(x: number, y: number): boolean {
  return document.elementsFromPoint(x, y).some((element) => element instanceof HTMLElement && element.dataset.unscheduleDrop !== undefined)
}

function attachListeners() {
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', onKey, true)
  // Once a finger drags, the page must not scroll under it.
  window.addEventListener('touchmove', onTouchMove, { passive: false })
}

/** Start following a press on an entry (pointerdown). Clicks that never become a drag go on as clicks. */
export function pressEntry(event: PointerEvent, entry: CalendarEntry, mode: 'move' | 'resize', onDrop: DropHandler) {
  if (event.button !== 0 || press) return
  const block = (event.currentTarget as HTMLElement).closest<HTMLElement>('.vasta-entry') ?? (event.currentTarget as HTMLElement)
  const cell = cellAt(event.clientX, event.clientY)
  press = {
    kind: 'entry',
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
  attachListeners()
}

/** Start following a press on a sidebar task/object to schedule it onto the calendar. */
export function pressScheduleItem(event: PointerEvent, item: ScheduleDragItem, onDrop: ScheduleDropHandler) {
  if (event.button !== 0 || press) return
  press = {
    kind: 'schedule',
    item,
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    onDrop,
  }
  lastPoint = { x: event.clientX, y: event.clientY }
  if (event.pointerType === 'touch') press.timer = setTimeout(begin, LONG_PRESS)
  attachListeners()
}

const daysFrom = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

function begin() {
  if (!press) return
  clearTimeout(press.timer)
  press.timer = undefined
  drag.active = true
  drag.x = lastPoint.x
  drag.y = lastPoint.y
  if (press.kind === 'schedule') {
    drag.mode = 'schedule'
    drag.entry = null
    drag.scheduleItem = press.item
    document.documentElement.classList.add('vasta-dragging')
  } else {
    drag.mode = press.mode
    drag.entry = press.entry
    drag.scheduleItem = null
    document.documentElement.classList.add(press.mode === 'resize' ? 'vasta-resizing' : 'vasta-dragging')
  }
  navigator.vibrate?.(10)
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
  drag.x = event.clientX
  drag.y = event.clientY
  update(event.clientX, event.clientY)
}

function update(x: number, y: number) {
  if (!press) return
  autoScroll(x, y)

  if (press.kind === 'schedule') {
    const cell = cellAt(x, y)
    const day = cell?.dataset.day
    if (!cell || !day) {
      drag.target = null
      return
    }
    if (cell.dataset.timed !== undefined) {
      const maxStart = Math.max(0, 1440 - press.item.durationMinutes)
      drag.target = { day, minutes: snap(((y - cell.getBoundingClientRect().top) / HOUR_HEIGHT) * 60, maxStart) }
    } else if (cell.dataset.allday !== undefined) {
      drag.target = { day, allDay: true }
    } else {
      drag.target = { day }
    }
    return
  }

  const entry = press.entry
  if (press.mode === 'resize') {
    const column = document.querySelector<HTMLElement>(`[data-timed][data-day="${entry.startDay}"]`)
    if (!column) return
    const start = minutesInto(entry.startDay, entry.start)
    const minutes = snap(((y - column.getBoundingClientRect().top) / HOUR_HEIGHT) * 60, 1440)
    drag.target = { day: entry.startDay, minutes: Math.max(start + SNAP, minutes) }
    return
  }

  // Dragging a non-recurring property entry back onto the tasks sidebar unschedules it.
  if (entry.kind === 'property' && !entry.recurring && unscheduleZoneAt(x, y)) {
    drag.target = { unschedule: true }
    return
  }

  const cell = cellAt(x, y)
  const day = cell?.dataset.day
  if (!cell || !day) {
    drag.target = null
    return
  }
  if (cell.dataset.timed !== undefined) {
    if (!entry.allDay) {
      drag.target = { day, minutes: snap(((y - press.offsetY - cell.getBoundingClientRect().top) / HOUR_HEIGHT) * 60) }
    } else if (entry.startDay === entry.endDay && !entry.recurring) {
      // Single-day all-day entry dragged onto an hour column promotes to a timed block.
      drag.target = { day, minutes: snap(((y - cell.getBoundingClientRect().top) / HOUR_HEIGHT) * 60, 1440 - 60) }
    } else {
      drag.target = { day: shiftDay(day, -press.dayOffset) }
    }
  } else if (cell.dataset.allday !== undefined && !entry.allDay && !entry.recurring) {
    drag.target = { day, allDay: true }
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
  const active = drag.active
  const target = drag.target
  const current = press
  if (active) swallowClick()
  cancel()
  if (!active || !target) return
  if (current.kind === 'schedule') {
    if (!target.unschedule) current.onDrop(current.item, target)
  } else {
    current.onDrop(current.entry, current.mode, target)
  }
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
  drag.scheduleItem = null
  drag.target = null
  document.documentElement.classList.remove('vasta-dragging', 'vasta-resizing')
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('pointercancel', cancel)
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('touchmove', onTouchMove)
}
