import { createRouter, createWebHistory } from 'vue-router'
import HomeView from './views/HomeView.vue'

// Pages load as their own chunks, so the first paint does not wait for the editor or the calendar.
// warmRoutes() fetches the rest once the app is idle, so the service worker has them for offline use.
const pages = {
  object: () => import('./views/ObjectPage.vue'),
  type: () => import('./views/TypePage.vue'),
  day: () => import('./views/DayView.vue'),
  calendar: () => import('./views/CalendarPage.vue'),
  settings: () => import('./views/SettingsView.vue'),
  trash: () => import('./views/TrashView.vue'),
  inbox: () => import('./views/InboxView.vue'),
  nutrition: () => import('./views/NutritionView.vue'),
}

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: HomeView },
    {
      path: '/o/:id',
      component: pages.object,
      // The page reads its address only through these, so the side pane can show it without one.
      props: (route) => ({
        id: route.params.id,
        isNew: route.query.new === '1',
        capture: typeof route.query.capture === 'string' ? route.query.capture : undefined,
        cursor: typeof route.query.cursor === 'string' ? route.query.cursor : undefined,
        block: route.hash.startsWith('#b-') ? route.hash.slice(3) : undefined,
      }),
    },
    { path: '/t/:id', component: pages.type, props: true },
    { path: '/day/:day', component: pages.day, props: true },
    { path: '/calendar', component: pages.calendar },
    { path: '/settings', component: pages.settings },
    { path: '/trash', component: pages.trash },
    { path: '/inbox', component: pages.inbox },
    { path: '/nutrition', component: pages.nutrition },
  ],
})

export function warmRoutes() {
  const run = () => void Promise.all(Object.values(pages).map((load) => load())).catch(() => {})
  if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 5000 })
  else setTimeout(run, 2000)
}
