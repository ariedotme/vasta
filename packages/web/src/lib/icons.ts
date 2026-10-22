// Phosphor icons. The ones the app's own code names ship in the main bundle (a subset built by
// vite.config.ts); the full set, which objects and types may use since the icon picker offers all
// of it, is a separate 4.6 MB JSON file fetched the first time an icon outside the subset is shown
// or the picker opens. The service worker caches it like any asset, so it also works offline.
// Icons that had to wait for the full set are remembered in localStorage, so the next start shows
// them at once without loading the set again.
import { addCollection, type IconifyJSON } from '@iconify/vue'
import fullSetUrl from '@iconify-json/ph/icons.json?url'
import subset from 'virtual:phosphor-subset'
import { ref } from 'vue'

const REMEMBERED_KEY = 'vasta.icons'
const MAX_REMEMBERED = 400

type IconData = IconifyJSON['icons'][string]

function readRemembered(): Record<string, IconData> {
  try {
    return JSON.parse(localStorage.getItem(REMEMBERED_KEY) ?? '{}') as Record<string, IconData>
  } catch {
    return {}
  }
}

const remembered = readRemembered()
addCollection({ ...(subset as IconifyJSON), icons: { ...remembered, ...subset.icons } })

/** True once every Phosphor icon is available. */
export const phosphorReady = ref(false)

let loading: Promise<IconifyJSON> | undefined
/** Names (without "ph:") shown while the full set was loading. */
const wanted = new Set<string>()

/** Load the whole Phosphor set (once); resolves to it, for the icon picker's list of names. */
export function loadPhosphor(): Promise<IconifyJSON> {
  loading ??= fetch(fullSetUrl)
    .then((response) => {
      if (!response.ok) throw new Error(`icons: ${response.status}`)
      return response.json() as Promise<IconifyJSON>
    })
    .then((collection) => {
      addCollection(collection)
      phosphorReady.value = true
      remember(collection)
      return collection
    })
    .catch((error) => {
      // Let a later call try again (e.g. once back online).
      loading = undefined
      throw error
    })
  return loading
}

/** Show `name` ("ph:…"), which is not loaded yet: load the full set and remember the icon. */
export function requestPhosphor(name: string) {
  wanted.add(name.slice(3))
  if (phosphorReady.value) return
  void loadPhosphor().catch(() => {})
}

function remember(collection: IconifyJSON) {
  for (const name of wanted) {
    const data = collection.icons[collection.aliases?.[name]?.parent ?? name]
    // Aliases are stored under their own name with the parent's drawing.
    if (data) remembered[name] = data
  }
  wanted.clear()
  const names = Object.keys(remembered)
  for (const name of names.slice(0, Math.max(0, names.length - MAX_REMEMBERED))) delete remembered[name]
  try {
    localStorage.setItem(REMEMBERED_KEY, JSON.stringify(remembered))
  } catch {}
}
