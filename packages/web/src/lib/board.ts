// Boards: dragging cards between columns and lanes and within them, with pointer events so a mouse
// and a finger work alike (a mouse drags once it moves, a finger after a long press; HTML5 drag and
// drop does not work on touch screens), and the write a drop makes: the column's (and lane's)
// value and a place in the manual order (core rank.ts) in one save.
//
// Drop targets are found under the pointer: `data-board-cell="<column>|<lane>"` on each column's
// list of cards, and `data-board-card="<id>"` on the cards in it.
import { reactive } from 'vue'
import { RANK_PROPERTY_ID, rankBetween, rankOf, ranksAfter, type Id, type ObjectRecord, type ObjectSummary } from '@vasta/core'
import { api } from './api.ts'
import { placeInGroup, type Group } from './query.ts'
import { primeFromObject } from './state.ts'

const LONG_PRESS = 400
const SLOP = 6

export interface CardTarget {
  column: string
  lane: string
  /** Where among the cell's other cards it goes. */
  index: number
}

export const boardDrag = reactive({
  active: false,
  cardId: '' as Id,
  target: null as CardTarget | null,
})

let press:
  | { cardId: Id; pointerId: number; x: number; y: number; timer?: ReturnType<typeof setTimeout>; onDrop: (cardId: Id, target: CardTarget) => void }
  | undefined
let lastPoint = { x: 0, y: 0 }
let scrollFrame = 0

/** Start following a press on a card (pointerdown). A press that never becomes a drag stays a click. */
export function pressCard(event: PointerEvent, cardId: Id, onDrop: (cardId: Id, target: CardTarget) => void) {
  if (event.button !== 0 || press) return
  // Controls on the card (a chip's link) keep their own clicks.
  if ((event.target as HTMLElement).closest('button, input, select, textarea')) return
  press = { cardId, pointerId: event.pointerId, x: event.clientX, y: event.clientY, onDrop }
  lastPoint = { x: event.clientX, y: event.clientY }
  if (event.pointerType === 'touch') press.timer = setTimeout(begin, LONG_PRESS)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('touchmove', onTouchMove, { passive: false })
}

function begin() {
  if (!press) return
  clearTimeout(press.timer)
  press.timer = undefined
  boardDrag.active = true
  boardDrag.cardId = press.cardId
  navigator.vibrate?.(10)
  document.documentElement.classList.add('vasta-dragging')
  update(lastPoint.x, lastPoint.y)
}

function onMove(event: PointerEvent) {
  if (!press || event.pointerId !== press.pointerId) return
  lastPoint = { x: event.clientX, y: event.clientY }
  if (!boardDrag.active) {
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) <= SLOP) return
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
  const cell = document.elementsFromPoint(x, y).find((element): element is HTMLElement => element instanceof HTMLElement && element.dataset.boardCell !== undefined)
  if (!cell) {
    boardDrag.target = null
    return
  }
  const [column = '', lane = ''] = cell.dataset.boardCell!.split('|')
  const cards = [...cell.querySelectorAll<HTMLElement>('[data-board-card]')].filter((card) => card.dataset.boardCard !== press!.cardId)
  const index = cards.filter((card) => {
    const box = card.getBoundingClientRect()
    return box.top + box.height / 2 < y
  }).length
  boardDrag.target = { column, lane, index }
}

/** Near the edge of the board (or the page), scroll it while the pointer stays there. */
function autoScroll(x: number, y: number) {
  cancelAnimationFrame(scrollFrame)
  const scrollers = document.elementsFromPoint(x, y).filter((element): element is HTMLElement => element instanceof HTMLElement && element.dataset.dragScroll !== undefined)
  const step = scrollers.flatMap((scroller) => {
    const box = scroller.getBoundingClientRect()
    const edge = 56
    const dx = x < box.left + edge ? -1 : x > box.right - edge ? 1 : 0
    const dy = y < box.top + edge ? -1 : y > box.bottom - edge ? 1 : 0
    return dx || dy ? [{ scroller, dx, dy }] : []
  })
  if (!step.length) return
  scrollFrame = requestAnimationFrame(() => {
    for (const { scroller, dx, dy } of step) scroller.scrollBy(dx * 10, dy * 10)
    if (boardDrag.active) update(lastPoint.x, lastPoint.y)
  })
}

function onUp(event: PointerEvent) {
  if (!press || event.pointerId !== press.pointerId) return
  const done = boardDrag.active && boardDrag.target ? { cardId: press.cardId, target: boardDrag.target, onDrop: press.onDrop } : undefined
  if (boardDrag.active) swallowClick()
  cancel()
  if (done) done.onDrop(done.cardId, done.target)
}

function onKey(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !boardDrag.active) return
  event.preventDefault()
  event.stopPropagation()
  swallowClick()
  cancel()
}

function onTouchMove(event: TouchEvent) {
  if (boardDrag.active) event.preventDefault()
}

/** The click that follows a drop must not open the card. */
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
  boardDrag.active = false
  boardDrag.cardId = ''
  boardDrag.target = null
  document.documentElement.classList.remove('vasta-dragging')
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('pointercancel', cancel)
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('touchmove', onTouchMove)
}

// ---------------------------------------------------------------------------
// Drops

export interface BoardAxis {
  field: string
  groups: Group[]
}

/**
 * Move a card to a cell of the board at `index` among `cell` (the cell's cards in order, the card
 * itself left out): its column's and lane's values change when they differ, and it gets a rank
 * between its new neighbours. When a neighbour has no rank yet, the cell's cards are ranked in
 * the order shown. Returns the objects saved.
 */
export async function moveCard(card: ObjectSummary, target: CardTarget, columns: BoardAxis, lanes: BoardAxis | undefined, cell: ObjectSummary[]): Promise<ObjectRecord[]> {
  const order = cell.filter((o) => o.id !== card.id)
  const ranks = new Map<Id, string>()
  const before = order[target.index - 1]
  const after = order[target.index]
  if ((before && rankOf(before) === undefined) || (after && rankOf(after) === undefined) || (before && after && rankOf(before)! >= rankOf(after)!)) {
    const placed = [...order.slice(0, target.index), card, ...order.slice(target.index)]
    ranksAfter(undefined, placed.length).forEach((rank, i) => ranks.set(placed[i]!.id, rank))
  } else ranks.set(card.id, rankBetween(before && rankOf(before), after && rankOf(after)))

  const saved: ObjectRecord[] = []
  for (const [id, rank] of ranks) {
    const object = await api.object(id)
    let changed = rankOf(object) !== rank
    object.props[RANK_PROPERTY_ID] = { kind: 'rank', value: rank }
    if (id === card.id) {
      const column = columns.groups.find((g) => g.key === target.column)
      if (column && !inGroup(card, columns, column.key) && placeInGroup(object, columns.field, column, columns.groups)) changed = true
      const lane = lanes?.groups.find((g) => g.key === target.lane)
      if (lanes && lane && !inGroup(card, lanes, lane.key) && placeInGroup(object, lanes.field, lane, lanes.groups)) changed = true
    }
    if (!changed) continue
    const result = await api.saveObject(object)
    primeFromObject(result)
    saved.push(result)
  }
  return saved
}

const inGroup = (card: ObjectSummary, axis: BoardAxis, key: string) => axis.groups.find((g) => g.key === key)?.items.some((o) => o.id === card.id) ?? false
