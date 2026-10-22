// Vasta service worker: makes the app installable and keeps what was already seen readable offline.
//   pages      network first, falling back to the cached app shell (index.html)
//   /assets/   cache first (file names carry a content hash)
//   /media/    cache first (keys are content hashes)
//   /api/ GET  network first, falling back to the last answer seen (read-only offline)
//   /desktop/  never (the desktop app's downloads and update manifest)
// Changes (POST/PUT/DELETE), logins, the live event stream and sync (the local replica, which
// keeps its own copy and must never take an old answer for a new one) always go to the network.
// The app deletes the API and media caches when the user logs out (lib/session.ts).
const SHELL = 'vasta-shell'
const ASSETS = 'vasta-assets'
const MEDIA = 'vasta-media'
const API = 'vasta-api'
const MAX_ASSETS = 40

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(['/', '/manifest.webmanifest', '/icon.svg'])).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName)
  try {
    const response = await fetch(request)
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
      // Old builds' assets pile up; keys come back in insertion order.
      const keys = await cache.keys()
      for (const key of keys.slice(0, Math.max(0, keys.length - limit))) await cache.delete(key)
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
  if (url.pathname.startsWith('/api/')) return event.respondWith(networkFirst(request, API))
})
