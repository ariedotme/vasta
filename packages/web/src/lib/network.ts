// Whether the server can be reached, for the offline banner and for retrying unsaved edits. The
// browser's online flag is not enough (it stays true on a Wi-Fi without internet, or when only the
// server is down), so failed requests and answers the service worker served from its cache
// (marked x-vasta-offline, public/sw.js) count too.
import { computed, reactive } from 'vue'
import { replica } from './replica.ts'

const state = reactive({
  browserOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
  /** The last request failed for lack of a network, or came from the offline cache. */
  unreachable: false,
})

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    state.browserOnline = true
    state.unreachable = false
  })
  window.addEventListener('offline', () => (state.browserOnline = false))
}

export const offline = computed(() => !state.browserOnline || state.unreachable || (replica.active && replica.offline))

export function noteResponse(response: Response) {
  state.unreachable = response.headers.get('x-vasta-offline') === '1'
}

export function noteNetworkError() {
  state.unreachable = true
}

/** Ask the server whether it is back (the banner does this every few seconds while offline). */
export async function probe() {
  try {
    noteResponse(await fetch('/api/health', { cache: 'no-store' }))
  } catch {
    noteNetworkError()
  }
}
