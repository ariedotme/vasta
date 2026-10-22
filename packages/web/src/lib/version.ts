// Whether a newer build of the app is out. An installed app on iOS is resumed, not reloaded, so it
// can keep running an old build for days: when it comes back to the foreground, compare the main
// script the server's page names with the one running here.
import { ref } from 'vue'

export const updateAvailable = ref(false)

const running = () => document.querySelector<HTMLScriptElement>('script[type=module][src*="/assets/index-"]')?.getAttribute('src') ?? ''

export async function checkForUpdate() {
  const current = running()
  if (!current || !navigator.onLine) return
  try {
    const response = await fetch('/', { cache: 'no-store' })
    if (!response.ok || response.headers.get('x-vasta-offline')) return
    const latest = /<script[^>]+src="(\/assets\/index-[^"]+\.js)"/.exec(await response.text())?.[1]
    if (latest && latest !== current) updateAvailable.value = true
  } catch {}
}

export function watchForUpdates() {
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void checkForUpdate())
  window.addEventListener('online', () => void checkForUpdate())
  setInterval(() => void checkForUpdate(), 30 * 60_000)
  void checkForUpdate()
}
