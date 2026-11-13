// Where an object opens: its own page (/o/<id>), or the side pane next to the page that is
// showing (?pane=<id> on that page's address). Everything that opens an object goes through here,
// so the choice is made in one place. The pane lives in the address, so back/forward, reload and
// copied links bring it back; leaving the page closes it, and a page changing only its own query
// (the calendar's view and date) keeps it (the guard in router.ts).
import { computed, type InjectionKey } from 'vue'
import type { LocationQueryRaw, RouteLocationRaw } from 'vue-router'
import type { Id } from '@vasta/core'
import { paneNavigation, router } from '../router.ts'
import { isPhone } from './viewport.ts'
import { lastError, notice } from './state.ts'

export type OpenPlace = 'page' | 'pane'

export interface OpenOptions {
  /** A block of its text to scroll to (#b-<id>). */
  block?: Id | undefined
  /** Extra query for the page, such as `new` or `capture`. */
  query?: LocationQueryRaw
  /** 'pane' opens it next to the current page where there is room for one; the default is its page. */
  where?: OpenPlace
  /** Replace the current history entry; a pane already open is always replaced (see openObject). */
  replace?: boolean
}

export const objectPath = (id: Id) => `/o/${id}`

/** The route of an object's page, for links (they keep ⌘-click, middle click and "Copy link"). */
export function objectRoute(id: Id, options: Pick<OpenOptions, 'block' | 'query'> = {}): RouteLocationRaw {
  return { path: objectPath(id), ...(options.query ? { query: options.query } : {}), ...(options.block ? { hash: `#b-${options.block}` } : {}) }
}

/**
 * "Copy link to page": <server>/o/<object-id> in the browser, vasta://o/<object-id> in the
 * desktop app. Shows a notice on success or an error banner on rejection.
 */
export async function copyObjectLink(objectId: Id) {
  const path = `o/${objectId}`
  const desktop = '__TAURI_INTERNALS__' in window
  try {
    await navigator.clipboard.writeText(desktop ? `vasta://${path}` : `${location.origin}/${path}`)
    notice.value = { message: 'Link to the page copied' }
  } catch {
    lastError.value = 'Could not copy the link'
  }
}

/**
 * Where a view (a type's view or a query) opens what is linked inside it, by id: its own choice,
 * else the type's of the object linked (a relation's chip included); undefined opens its page.
 * Provided by the collection, read by every ObjectLink inside it, whatever the layout.
 */
export const VIEW_OPENS: InjectionKey<(id: Id) => OpenPlace | undefined> = Symbol('view-opens')

/** The object in the side pane, if one is open. */
export const paneObjectId = computed(() => {
  const value = router.currentRoute.value.query.pane
  return typeof value === 'string' && value ? value : undefined
})
/** The block the pane scrolls to. */
export const paneBlockId = computed(() => {
  const value = router.currentRoute.value.query.paneBlock
  return typeof value === 'string' && value ? value : undefined
})

/** The object whose page is showing. */
export const pageObjectId = computed(() => {
  const route = router.currentRoute.value
  return route.path.startsWith('/o/') ? (route.params.id as string | undefined) : undefined
})

/** Whether an object is open, on its page or in the pane. */
export const isOpen = (id: Id) => pageObjectId.value === id || paneObjectId.value === id

/**
 * Where an object asked to open in the pane goes: phones have no room for a pane, and the page
 * of the same object is already showing it, so both open (or stay on) the page.
 */
export function resolvePlace(id: Id, where: OpenPlace = 'page', phone = isPhone.value, onPage = pageObjectId.value): OpenPlace {
  return where === 'pane' && !phone && onPage !== id ? 'pane' : 'page'
}

/** The current address with the pane set to an object, or without a pane. */
function withPane(id: Id | undefined, block?: Id): RouteLocationRaw {
  const { pane: _pane, paneBlock: _block, ...rest } = router.currentRoute.value.query
  return { query: { ...rest, ...(id ? { pane: id } : {}), ...(id && block ? { paneBlock: block } : {}) }, hash: router.currentRoute.value.hash }
}

/**
 * Opens an object. With the pane already open, showing another object in it replaces the history
 * entry: reading through a list is one Back to leave it, not one per object.
 */
export function openObject(id: Id, options: OpenOptions = {}) {
  const inPane = resolvePlace(id, options.where) === 'pane'
  const to = inPane ? withPane(id, options.block) : objectRoute(id, options)
  return options.replace || (inPane && paneObjectId.value) ? router.replace(to) : router.push(to)
}

export async function closePane(replace = false) {
  if (!paneObjectId.value) return
  const to = withPane(undefined)
  paneNavigation.closing = true
  try {
    return await (replace ? router.replace(to) : router.push(to))
  } finally {
    paneNavigation.closing = false
  }
}

/** The pane's object on its own page, in place of the page behind it. */
export function expandPane(replace = false) {
  const id = paneObjectId.value
  if (!id) return
  const to = objectRoute(id, { block: paneBlockId.value })
  return replace ? router.replace(to) : router.push(to)
}
