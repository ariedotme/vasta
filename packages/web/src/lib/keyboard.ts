// The caret above the on-screen keyboard. The app scrolls in <main>, not the window, and iOS Safari
// only brings a note's caret above the keyboard when the window scrolls: typing low in a note went
// on behind the keyboard and its toolbar. While the keyboard
// is up, each keystroke or caret move in a note scrolls its scrolling box just enough to keep the
// caret inside the part of the screen the keyboard leaves.

/** Room kept between the caret and the keyboard, in px. */
const MARGIN = 12
/** A visual viewport shorter than its tallest by less than this is browser chrome, not a keyboard. */
const KEYBOARD = 120

/**
 * How far to scroll down so a caret whose bottom is at `caretBottom` (window px) sits above a
 * keyboard that leaves `visibleBottom` (the visual viewport's bottom edge); 0 when it already does.
 */
export function scrollToClear(caretBottom: number, visibleBottom: number, margin = MARGIN): number {
  return Math.max(0, Math.ceil(caretBottom - (visibleBottom - margin)))
}

/** The bottom of the caret in the editor, in window px; undefined when there is none. */
function caretBottom(): number | undefined {
  const selection = document.getSelection()
  if (!selection?.rangeCount || !selection.isCollapsed) return undefined
  const range = selection.getRangeAt(0)
  const rect = range.getBoundingClientRect()
  if (rect.height) return rect.bottom
  // An empty line has no rect of its own: its block's.
  const node = range.startContainer
  return (node instanceof Element ? node : node.parentElement)?.getBoundingClientRect().bottom
}

/** The box the caret scrolls in (<main>, a dialog's body), even one too short to scroll yet. */
function scrollParent(from: Element): HTMLElement | undefined {
  for (let element = from.parentElement; element; element = element.parentElement) {
    const overflow = getComputedStyle(element).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return element
  }
  return undefined
}

/** Start keeping the caret above the keyboard; returns the stop. */
export function keepsCaretAboveKeyboard(): () => void {
  const viewport = typeof window === 'undefined' ? undefined : window.visualViewport
  if (!viewport) return () => {}
  let frame = 0
  // The keyboard's height: how much shorter the visual viewport is than the tallest it has been at
  // this width (window.innerHeight follows Safari's toolbars and page scroll, not the keyboard).
  let width = viewport.width
  let tallest = viewport.height
  // Where the keyboard begins, in the coordinates the caret's rect uses: a fixed marker set at the
  // visual viewport's bottom. (iOS Safari gives rects from the visual viewport's top once it moved
  // down the page, other browsers from the layout viewport's; the marker reads the same as both.)
  let marker: HTMLElement | undefined
  const keyboardTop = () => {
    marker ??= document.body.appendChild(Object.assign(document.createElement('div'), { ariaHidden: 'true' }))
    marker.setAttribute('style', `position:fixed;left:0;width:0;height:0;visibility:hidden;pointer-events:none;top:${viewport.offsetTop + viewport.height}px`)
    return marker.getBoundingClientRect().top
  }
  // A box scrolled for the keyboard gets room below its end while the keyboard is up, as the window
  // does in a browser: else a short note, or one scrolled to its end, has nowhere to scroll to.
  const padded = new Set<HTMLElement>()
  const unpad = () => {
    for (const box of padded) box.style.paddingBottom = ''
    padded.clear()
  }
  const check = () => {
    frame = 0
    if (viewport.width !== width) [width, tallest] = [viewport.width, viewport.height]
    tallest = Math.max(tallest, viewport.height)
    const keyboard = tallest - viewport.height
    // A pinch zoom also shrinks the visual viewport; only a keyboard does it at scale 1.
    if (viewport.scale !== 1 || keyboard < KEYBOARD) return unpad()
    // Only while typing in a note: Safari brings a focused field (input, textarea) into view by
    // itself, also in a scrolling box; it is the caret in the editor it leaves behind the keyboard.
    const active = document.activeElement
    if (!(active instanceof HTMLElement && active.isContentEditable)) return
    const bottom = caretBottom()
    if (bottom === undefined) return
    const by = scrollToClear(bottom, keyboardTop())
    const box = by ? scrollParent(active) : undefined
    if (!box) return
    if (!padded.has(box)) {
      box.style.paddingBottom = `${keyboard}px`
      padded.add(box)
    }
    box.scrollTop += by
  }
  const soon = () => {
    if (!frame) frame = requestAnimationFrame(check)
  }
  // Safari reveals the caret itself a moment after a keystroke, by its own measure (behind the
  // keyboard), and may undo the first scroll: look again twice, then stop.
  let later: ReturnType<typeof setTimeout>[] = []
  const onEdit = () => {
    soon()
    for (const timer of later) clearTimeout(timer)
    later = [150, 400].map((ms) => setTimeout(soon, ms))
  }
  document.addEventListener('selectionchange', onEdit)
  document.addEventListener('input', onEdit, true)
  viewport.addEventListener('resize', soon)
  return () => {
    document.removeEventListener('selectionchange', onEdit)
    document.removeEventListener('input', onEdit, true)
    viewport.removeEventListener('resize', soon)
    if (frame) cancelAnimationFrame(frame)
    for (const timer of later) clearTimeout(timer)
    marker?.remove()
    unpad()
  }
}
