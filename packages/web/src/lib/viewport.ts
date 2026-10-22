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
