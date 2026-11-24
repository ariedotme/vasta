// Where a page was scrolled. The page scrolls in <main>, not the window, so the browser cannot keep
// it: a page opened starts at its top, and Back or Forward (the edge swipe on a phone) comes back to
// where that history entry was left, once its content is tall enough (a list fills in after the
// page shows). Only a change of page counts; a page changing its own query (the calendar's date,
// the side pane) keeps its scroll.
import { nextTick } from 'vue'
import type { Router } from 'vue-router'

/** How long a page coming back may take to grow tall enough for its old position. */
const WAIT = 2000

export function keepsScroll(router: Router, main: () => HTMLElement | null | undefined) {
  const left = new Map<string, number>()
  const entry = () => `${router.options.history.state.position}:${router.currentRoute.value.path}`
  let current = entry()
  let going: 'back' | 'new' = 'new'
  let restoring = 0

  const stopBefore = router.beforeEach((to) => {
    const element = main()
    if (element) left.set(current, element.scrollTop)
    // Back or Forward: the history already holds the entry being gone to (as in router.ts).
    going = router.options.history.state.current === to.fullPath ? 'back' : 'new'
  })
  const stopAfter = router.afterEach((to, from, failure) => {
    if (failure) return
    current = entry()
    if (to.path === from.path) return
    const target = going === 'back' ? (left.get(current) ?? 0) : 0
    const run = ++restoring
    void nextTick(() => restore(target, run))
  })

  function restore(target: number, run: number) {
    const element = main()
    if (!element) return
    element.scrollTop = target
    if (!target) return
    // A finger, the wheel, the scrollbar or a key on the page takes over; so does another page.
    let touched = false
    const take = () => (touched = true)
    element.addEventListener('touchstart', take, { once: true, passive: true })
    element.addEventListener('wheel', take, { once: true, passive: true })
    element.addEventListener('pointerdown', take, { once: true, passive: true })
    window.addEventListener('keydown', take, { once: true })
    const start = performance.now()
    const step = () => {
      if (touched || run !== restoring) return done()
      if (Math.abs(element.scrollTop - target) > 1) element.scrollTop = target
      if (Math.abs(element.scrollTop - target) <= 1 || performance.now() - start > WAIT) return done()
      requestAnimationFrame(step)
    }
    const done = () => {
      element.removeEventListener('touchstart', take)
      element.removeEventListener('wheel', take)
      element.removeEventListener('pointerdown', take)
      window.removeEventListener('keydown', take)
    }
    requestAnimationFrame(step)
  }

  return () => {
    stopBefore()
    stopAfter()
  }
}
