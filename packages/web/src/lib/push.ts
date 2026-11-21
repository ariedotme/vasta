// Reminders as notifications of this browser (Web Push, server/src/push.ts): the service worker
// (public/sw.js) shows them, even with the app closed. iOS and iPadOS take them only in the app
// added to the Home Screen (16.4 and later); Android, macOS, Windows and Linux browsers in a tab too.
import { t } from './i18n.ts'
import { isDesktop } from './platform.ts'

/** Why this browser can't take notifications, or '' when it can. */
export function pushUnsupported(): string {
  if (typeof window === 'undefined') return t('push.notInBrowser')
  if (isDesktop) return t('push.desktopHandles')
  const apple = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const installed = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
  if (apple && !installed) return t('push.iosAddToHome')
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return t('push.unsupported')
  if (!window.isSecureContext) return t('push.httpsOnly')
  return ''
}

async function registration() {
  return (await navigator.serviceWorker.getRegistration('/')) ?? (await navigator.serviceWorker.register('/sw.js'))
}

/** This browser's subscription, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushUnsupported()) return null
  return (await registration()).pushManager.getSubscription()
}

/** Ask for permission (call it from a tap: iOS asks only then) and subscribe with the server's key. */
export async function subscribe(publicKey: string): Promise<PushSubscription> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error(permission === 'denied' ? t('push.blocked') : t('push.notAllowed'))
  const worker = await registration()
  await navigator.serviceWorker.ready
  const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
  const existing = await worker.pushManager.getSubscription()
  // A subscription made with another server key can't be used: start again.
  if (existing && !sameKey(existing.options.applicationServerKey, key)) await existing.unsubscribe()
  return (await worker.pushManager.getSubscription()) ?? worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array) {
  if (!a) return false
  const bytes = new Uint8Array(a)
  return bytes.length === b.length && bytes.every((x, i) => x === b[i])
}

/** A name for this device: "iPhone", "Android · Chrome", "Mac · Firefox". */
export function deviceName(): string {
  const ua = navigator.userAgent
  const device = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : t('push.browserFallback')
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ''
  return device === 'iPhone' || device === 'iPad' || !browser ? device : `${device} · ${browser}`
}
