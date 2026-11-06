// Vasta service worker: makes the app installable and keeps what was already seen readable offline.
//   pages      network first, falling back to the cached app shell (index.html)
//   /assets/   cache first (file names carry a content hash)
//   /media/    cache first (keys are content hashes)
//   /api/ GET  network first, falling back to the last answer seen (read-only offline)
//   /desktop/  never (the desktop app's downloads and update manifest)
// Changes (POST/PUT/DELETE), logins, the live event stream and sync (the local replica, which
// keeps its own copy and must never take an old answer for a new one) always go to the network.
// The app deletes the API and media caches when the user logs out (lib/session.ts).
// Reminders sent by Web Push (server/src/push.ts) are shown here, with the app closed too; a tap
// opens the reminder's page in an open window of the app, or a new one.
const SHELL = 'vasta-shell'
const ASSETS = 'vasta-assets'
const MEDIA = 'vasta-media'
const API = 'vasta-api'
// A build has some 85 assets (the app fetches them all for offline use), so this keeps a few builds.
const MAX_ASSETS = 300

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(['/', '/manifest.webmanifest', '/icon.svg', '/favicon.svg'])).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName)
  try {
    // Pages past the browser's HTTP cache: an old index.html names assets a new version lacks.
    const response = await fetch(request, fallbackUrl ? { cache: 'no-cache' } : undefined)
    // The shell must stay the app: a page opened from /media/ or a download is not one.
    const keep = !fallbackUrl || response.headers.get('content-type')?.startsWith('text/html')
    if (response.ok && keep) await cache.put(fallbackUrl ?? request, response.clone())
    return response
  } catch (error) {
    const cached = await cache.match(fallbackUrl ?? request)
    if (!cached) throw error
    if (cacheName !== API) return cached
    // Tell the app this answer is an offline copy (lib/network.ts shows the offline banner).
    const headers = new Headers(cached.headers)
    headers.set('x-vasta-offline', '1')
    return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers })
  }
}

async function cacheFirst(request, cacheName, limit) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) {
    await cache.put(request, response.clone())
    if (limit) {
      // Old builds' assets pile up; keys come back in insertion order. The ones the cached app
      // shell loads stay: without them it opens blank offline.
      const keys = await cache.keys()
      let extra = keys.length - limit
      if (extra > 0) {
        const shell = await (await caches.open(SHELL)).match('/')
        const html = shell ? await shell.text() : ''
        for (const key of keys) {
          if (extra <= 0) break
          if (html.includes(new URL(key.url).pathname)) continue
          await cache.delete(key)
          extra--
        }
      }
    }
  }
  return response
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/desktop/')) return
  if (request.mode === 'navigate') return event.respondWith(networkFirst(request, SHELL, '/'))
  if (url.pathname.startsWith('/assets/')) return event.respondWith(cacheFirst(request, ASSETS, MAX_ASSETS))
  if (url.pathname.startsWith('/media/')) return event.respondWith(cacheFirst(request, MEDIA))
  if (url.pathname === '/api/events' || url.pathname.startsWith('/api/auth/login') || url.pathname.startsWith('/api/sync/')) return
  // A space's export (a ZIP of everything) goes straight to the network, never into the cache.
  if (/^\/api\/spaces\/[^/]+\/export$/.test(url.pathname)) return
  if (url.pathname.startsWith('/api/')) return event.respondWith(networkFirst(request, API))
})

self.addEventListener('push', (event) => {
  let message = {}
  try {
    message = event.data ? event.data.json() : {}
  } catch {
    message = { title: 'Vasta', body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(
    self.registration.showNotification(message.title || 'Vasta', {
      body: message.body || '',
      icon: '/icon-192.png',
      ...(message.tag ? { tag: message.tag } : {}),
      data: { url: message.url || '/' },
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  // Only pages of this app: an event of a subscribed calendar may carry its own link.
  const target = new URL(event.notification.data?.url || '/', self.location.origin)
  const url = target.origin === self.location.origin ? target.href : self.location.origin + '/'
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin)
      if (open) {
        await open.focus()
        return open.navigate(url).catch(() => self.clients.openWindow(url))
      }
      return self.clients.openWindow(url)
    })()
  )
})
