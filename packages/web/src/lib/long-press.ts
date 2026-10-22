// Long press on a touch screen opens the same context menus as a right-click. iOS Safari never
// fires `contextmenu` for touch, so after a still press we dispatch one at the finger; Android
// fires its own, and once one is seen ours stops. Text in the editor keeps the native long press
// (selection, the loupe); on calendar entries a long press starts dragging (lib/calendar-drag.ts).
const DELAY = 550
const SLOP = 10

let nativeSeen = false
let timer: ReturnType<typeof setTimeout> | undefined
let start: { x: number; y: number } | undefined
/** A menu opened from this press: the finger lifting must not also click what is under it. */
let fired = false

function cancel() {
  clearTimeout(timer)
  timer = undefined
  start = undefined
}

function onTouchStart(event: TouchEvent) {
  cancel()
  fired = false
  if (nativeSeen || event.touches.length !== 1) return
  const target = event.target as Element | null
  if (!target || target.closest('[contenteditable="true"], input, textarea, select, [data-calendar-entry]')) return
  const touch = event.touches[0]!
  start = { x: touch.clientX, y: touch.clientY }
  timer = setTimeout(() => {
    timer = undefined
    if (!start || !target.isConnected) return
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: start.x, clientY: start.y, button: 2 })
    // Only presses on something with a menu count; elsewhere nothing happens.
    if (!target.dispatchEvent(menu)) {
      fired = true
      navigator.vibrate?.(10)
    }
  }, DELAY)
}

function onTouchMove(event: TouchEvent) {
  const touch = event.touches[0]
  if (start && touch && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > SLOP) cancel()
}

function onTouchEnd(event: TouchEvent) {
  cancel()
  if (!fired) return
  fired = false
  event.preventDefault()
}

function onContextMenu(event: Event) {
  // A native contextmenu while a press is pending: this browser has its own long press.
  if (event.isTrusted && timer) {
    nativeSeen = true
    cancel()
  }
}

export function installLongPress() {
  window.addEventListener('touchstart', onTouchStart, { passive: true, capture: true })
  window.addEventListener('touchmove', onTouchMove, { passive: true, capture: true })
  window.addEventListener('touchend', onTouchEnd, { passive: false, capture: true })
  window.addEventListener('touchcancel', cancel, { capture: true })
  window.addEventListener('contextmenu', onContextMenu, { capture: true })
}
