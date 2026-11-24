// Screen size and input kind, as reactive flags. "Phone" is below Tailwind's `md` breakpoint,
// where the sidebar becomes a drawer; "touch" is a device without hover (phones, tablets).
import { ref } from 'vue'

function mediaFlag(query: string) {
  const flag = ref(false)
  if (typeof window === 'undefined' || !window.matchMedia) return flag
  const list = window.matchMedia(query)
  flag.value = list.matches
  list.addEventListener('change', (event) => (flag.value = event.matches))
  return flag
}

export const isPhone = mediaFlag('(max-width: 767px)')
export const isTouch = mediaFlag('(hover: none)')

/** The page runs as an installed Home Screen app (no browser bar), not in a browser tab. */
export function isInstalledApp() {
  if (typeof window === 'undefined') return false
  return window.matchMedia?.('(display-mode: standalone)').matches === true || (navigator as { standalone?: boolean }).standalone === true
}

/**
 * Whether a touch starting at `x` may open the sidebar drawer: only at the screen's left edge, and
 * only in the installed app. In a browser tab that swipe is the browser's own Back (iPhone Safari),
 * which would also open the drawer under it.
 */
export function startsDrawerSwipe(x: number, installed: boolean) {
  return installed && x < 24
}
