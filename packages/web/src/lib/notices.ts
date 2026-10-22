// The bell: notifications about others' work (assigned, mentioned, comments; the server keeps
// them). Refreshed when the app starts, comes back to the front, every minute, and soon after a
// change arrives; read from the server (the service worker's last answer while offline).
import { reactive } from 'vue'
import { api, type Notice } from './api.ts'
import { onChange } from './events.ts'

export const notices = reactive({ items: [] as Notice[], unread: 0, loaded: false })

let timer: ReturnType<typeof setTimeout> | undefined
let started = false

export async function refreshNotices() {
  try {
    const answer = await api.notices()
    notices.items = answer.items
    notices.unread = answer.unread
    notices.loaded = true
  } catch {}
}

/** Mark some as read (all without ids). */
export async function readNotices(ids?: number[]) {
  for (const notice of notices.items) if (!ids || ids.includes(notice.id)) notice.read = true
  notices.unread = notices.items.filter((n) => !n.read).length
  try {
    notices.unread = (await api.readNotices(ids)).unread
  } catch {}
}

/** Start keeping the bell up to date (once). */
export function watchNotices() {
  if (started) return
  started = true
  void refreshNotices()
  setInterval(() => document.visibilityState === 'visible' && void refreshNotices(), 60_000)
  window.addEventListener('focus', () => void refreshNotices())
  onChange((event) => {
    if (event.kind !== 'object') return
    clearTimeout(timer)
    timer = setTimeout(() => void refreshNotices(), 1500)
  })
}
