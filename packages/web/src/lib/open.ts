// Where an object opens: its own page (/o/<id>), or the side pane next to the page that is
// showing (?pane=<id> on that page's address). Everything that opens an object goes through here,
// so the choice is made in one place. The pane lives in the address, so back/forward, reload and
// copied links bring it back; leaving the page closes it.
import { computed, type InjectionKey } from 'vue'
import type { LocationQueryRaw, RouteLocationRaw } from 'vue-router'
import type { Id } from '@vasta/core'
import { router } from '../router.ts'
import { isPhone } from './viewport.ts'

export type OpenPlace = 'page' | 'pane'

export interface OpenOptions {
  /** A block of its text to scroll to (#b-<id>). */
  block?: Id | undefined
  /** Extra query for the page, such as `new` or `capture`. */
  query?: LocationQueryRaw
  /** 'pane' opens it next to the current page where there is room for one; the default is its page. */
  where?: OpenPlace
  replace?: boolean
}

export const objectPath = (id: Id) => `/o/${id}`

/** The route of an object's page, for links (they keep ⌘-click, middle click and "Copy link"). */
export function objectRoute(id: Id, options: Pick<OpenOptions, 'block' | 'query'> = {}): RouteLocationRaw {
  return { path: objectPath(id), ...(options.query ? { query: options.query } : {}), ...(options.block ? { hash: `#b-${options.block}` } : {}) }
}

/**
 * Where a view (a type's view or a query) opens the objects it shows, by id: its own choice, else
 * the object's type's; undefined for anything else in it (a relation's chip), which opens its page.
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

export function openObject(id: Id, options: OpenOptions = {}) {
  const to = resolvePlace(id, options.where) === 'pane' ? withPane(id, options.block) : objectRoute(id, options)
  return options.replace ? router.replace(to) : router.push(to)
}

export function closePane(replace = false) {
  if (!paneObjectId.value) return
  const to = withPane(undefined)
  return replace ? router.replace(to) : router.push(to)
}

/** The pane's object on its own page, in place of the page behind it. */
export function expandPane(replace = false) {
  const id = paneObjectId.value
  if (!id) return
  const to = objectRoute(id, { block: paneBlockId.value })
  return replace ? router.replace(to) : router.push(to)
}

/**
 * Query for a page that rewrites its own query (the calendar's view and date): the pane's part is
 * kept, so the pane stays open.
 */
export function keepPane(query: LocationQueryRaw): LocationQueryRaw {
  const { pane, paneBlock } = router.currentRoute.value.query
  return { ...query, ...(pane ? { pane } : {}), ...(paneBlock ? { paneBlock } : {}) }
}
