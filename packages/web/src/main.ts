import { createApp } from 'vue'
import App from './App.vue'
import './lib/icons.ts'
import { installLongPress } from './lib/long-press.ts'
import { installTheme } from './lib/theme.ts'
import { router, warmRoutes } from './router.ts'
import { watchForUpdates } from './lib/version.ts'
import './style.css'

installTheme()

// Installed on the home screen it should feel like an app: no pinch or double-tap zoom. iOS ignores
// user-scalable=no in Safari tabs but not here; the gesture events and touch-action cover the rest.
// In a browser tab the page stays zoomable.
const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
if (standalone) {
  document.documentElement.classList.add('standalone')
  document.querySelector('meta[name=viewport]')?.setAttribute('content', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover')
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, (event) => event.preventDefault(), { passive: false })
}

createApp(App).use(router).mount('#app')
installLongPress()
warmRoutes()

// Installable app and offline reading (public/sw.js). Not in development, where Vite serves
// changing modules that a cache would only get in the way of.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => {}))
}
if (import.meta.env.PROD) watchForUpdates()
