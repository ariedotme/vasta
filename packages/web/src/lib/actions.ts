import { foodCommand, type FoodLineAnswer, type Icon, type Id, type ObjectRecord, type ObjectSummary, type ObjectType, type Space } from '@vasta/core'
import type { CaptureAnswer } from '@vasta/core/client'
import { api } from './api.ts'
import { clone } from './clone.ts'
import { displayTitle } from './format.ts'
import { confirmDialog, promptDialog, type MenuItem } from './overlays.ts'
import { session } from './session.ts'
import { forgetSummary, loadWorkspace, notice, primeFromObject, refreshCounts, replaceType, summaryOf, systemType, typesById, workspace } from './state.ts'
import { typedLine, type CompletionSource } from './typed-line.ts'
import { people } from './people.ts'
import { loadTemplates, templates } from './templates.ts'
import { router } from '../router.ts'

/** With `line`, the title and properties are read from it, e.g. `Dune author:"Frank Herbert"`. */
export async function createObject(typeId: Id, data: Partial<ObjectRecord> = {}, open = true, line?: string): Promise<ObjectRecord> {
  const object = await api.createObject({ ...data, typeId }, line)
  primeFromObject(object)
  void refreshCounts()
  if (open) await router.push({ path: `/o/${object.id}`, query: { new: '1' } })
  return object
}

/** "YYYY-MM-DD" of a date in this device's calendar. */
export function dayKey(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Where captures from this app go: the user's capture space (Settings › Account) when it is one of
 * theirs (workspace.spaces holds only those), else the open space.
 */
export const captureSpace = (): Space | null => workspace.spaces.find((s) => s.id === session.user?.captureSpaceId) ?? workspace.space

/** The types of a space, from the workspace when it is the open one. */
export async function typesOf(space: Space): Promise<ObjectType[]> {
  return space.id === workspace.space?.id ? workspace.types : (await api.space(space.id)).types
}

/** Where completions of a typed line look (lib/typed-line.ts): a space's objects, on the replica or the server. */
export function completionSource(spaceId: Id, types: ObjectType[]): CompletionSource {
  if (spaceId === workspace.space?.id) void loadTemplates()
  return {
    types,
    today: dayKey(),
    people: spaceId === workspace.space?.id ? people.list : [],
    templates: () => (spaceId === templates.spaceId ? templates.list : []),
    objects: async (typeIds, text) => {
      if (text.trim()) {
        const found = await api.search(spaceId, text, 50)
        return typeIds.length ? found.filter((o) => typeIds.includes(o.typeId)) : found
      }
      if (!typeIds.length) return api.search(spaceId, '', 20)
      const lists = await Promise.all(typeIds.map((id) => api.objectsOfType(id)))
      return lists.flat().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 200)
    },
  }
}

/**
 * Capture a text into today's note of the capture space (Quick capture, the desktop app's panel).
 * A text that starts with a type, "/Book Dune author:x", makes an object of it from the first
 * line (the other lines are its body), and the note embeds it.
 */
export async function captureText(text: string, channel: string): Promise<{ space: Space; answer: CaptureAnswer; food?: FoodLineAnswer }> {
  const space = captureSpace()
  if (!space) throw new Error('There is no space to capture into.')
  // "/food …" logs what was eaten instead (core's nutrition.ts).
  const eaten = foodCommand(text)
  if (eaten !== undefined) {
    const food = await api.logFoodLine(space.id, eaten, dayKey())
    return { space, answer: { dailyNoteId: food.dailyNoteId ?? '', blockId: '', summary: food.summary }, food }
  }
  const typed = text.startsWith('/') ? typedLine(await typesOf(space), text) : undefined
  const answer = await api.capture(space.id, typed ? typed.rest : text, channel, dayKey(), typed?.type.id)
  return { space, answer }
}

/**
 * The tag a path names ("recipe/breakfast"), made with any missing level: each part is found
 * among the tags under the one before (by title, ignoring case), or created there.
 */
export async function tagFromPath(path: string): Promise<ObjectRecord | ObjectSummary | undefined> {
  const tagType = systemType('tag')
  const parts = path.split('/').map((part) => part.trim().replace(/^#/, '')).filter(Boolean)
  if (!tagType || !parts.length) return undefined
  const tags = await api.objectsOfType(tagType.id)
  let parent: ObjectRecord | ObjectSummary | undefined
  for (const title of parts) {
    const parentId: Id | undefined = parent?.id
    const existing: ObjectRecord | ObjectSummary | undefined = tags.find((t) => (t.parentId ?? undefined) === parentId && t.title.trim().toLowerCase() === title.toLowerCase())
    parent = existing ?? (await createObject(tagType.id, { title, ...(parentId ? { parentId } : {}) }, false))
  }
  return parent
}

/** Open the daily note of a day; the server creates it the first time. */
export async function openDay(day: string, replace = false) {
  if (!workspace.space) return
  const note = await api.dailyNote(workspace.space.id, day)
  primeFromObject(note)
  void refreshCounts()
  return replace ? router.replace(`/o/${note.id}`) : router.push(`/o/${note.id}`)
}

/** Today: the calendar's day view, with today's daily note in it. */
export const openToday = () => router.push(todayRoute())
export const todayRoute = (day = dayKey()) => ({ path: '/calendar', query: { view: 'day', date: day } })

/** The route is the day view of today (the sidebar's and the top bar's Today). */
export const isTodayRoute = (route: { path: string; query: Record<string, unknown> }) => route.path === '/calendar' && route.query.view === 'day' && route.query.date === dayKey()

// ---------------------------------------------------------------------------
// Types

export async function newTypeFlow() {
  if (!workspace.space) return
  const name = await promptDialog({ title: 'New type', message: 'Name one object of this type, e.g. “Book” or “Person”.', placeholder: 'Type name', confirmLabel: 'Create' })
  if (!name) return
  const type = await api.createType({ spaceId: workspace.space.id, name, pluralName: name, icon: { kind: 'icon', value: 'ph:cube' } })
  replaceType(type)
  // Open the settings right away to pick plural name, icon, color and properties.
  await router.push({ path: `/t/${type.id}`, query: { settings: '1' } })
}

/** Ask, then move a custom type and its objects to the trash, offering Undo. Returns true when deleted. */
export async function deleteTypeFlow(type: ObjectType): Promise<boolean> {
  if (type.system) return false
  const count = workspace.counts[type.id] ?? 0
  const ok = await confirmDialog({
    title: `Delete “${type.name}”?`,
    message: count
      ? `The type and its ${count} ${count === 1 ? 'object' : 'objects'} move to the trash.`
      : 'The type moves to the trash.',
    confirmLabel: 'Delete type',
    danger: true,
  })
  if (!ok) return false
  const places = sidebarPlaces(type.id)
  const wasOpen = router.currentRoute.value.path === `/t/${type.id}`
  await api.deleteType(type.id)
  await loadWorkspace(workspace.space?.id)
  if (wasOpen) await router.push('/')
  notice.value = {
    message: `Moved “${type.name}” to the trash`,
    action: {
      label: 'Undo',
      run: async () => {
        await restoreTypeFlow(type.id)
        await restorePlaces(type.id, places)
        if (wasOpen) await router.push(`/t/${type.id}`)
      },
    },
  }
  return true
}

/** Take a type out of the trash with the objects deleted together with it. */
export async function restoreTypeFlow(id: Id) {
  const { type, objects } = await api.restoreType(id)
  replaceType(type)
  for (const object of objects) primeFromObject(object)
  await refreshCounts()
  return type
}

// ---------------------------------------------------------------------------
// Objects

/** Move an object to the trash and offer Undo, which also puts it back in the sidebar and reopens it. */
export async function deleteObjectFlow(id: Id): Promise<boolean> {
  const summary = summaryOf(id)
  const title = displayTitle(summary, typesById.value.get(summary?.typeId ?? ''))
  const places = sidebarPlaces(id)
  const wasOpen = router.currentRoute.value.path === `/o/${id}`
  await api.deleteObject(id)
  forgetSummary(id)
  void refreshCounts()
  if (places.length) await updateSidebar((space) => removeEverywhere(space, id))
  if (wasOpen) await router.push(summary ? `/t/${summary.typeId}` : '/')
  notice.value = {
    message: `Moved “${title}” to the trash`,
    action: {
      label: 'Undo',
      run: async () => {
        await restoreObjectFlow(id)
        await restorePlaces(id, places)
        if (wasOpen) await router.push(`/o/${id}`)
      },
    },
  }
  return true
}

/** Take an object out of the trash; its type comes back too when it was deleted (returned then). */
export async function restoreObjectFlow(id: Id): Promise<{ object: ObjectRecord; type?: ObjectType }> {
  const result = await api.restoreObject(id)
  if (result.type) replaceType(result.type)
  primeFromObject(result.object)
  await refreshCounts()
  return result
}

/** Ask, then delete an object in the trash for good. */
export async function deleteForeverFlow(id: Id, title: string): Promise<boolean> {
  const ok = await confirmDialog({ title: `Delete “${title}” forever?`, message: 'This cannot be undone.', confirmLabel: 'Delete forever', danger: true })
  if (!ok) return false
  await api.deleteObjectForever(id)
  forgetSummary(id)
  await refreshCounts()
  return true
}

// ---------------------------------------------------------------------------
// Sidebar sections

async function updateSidebar(mutate: (space: Space) => void) {
  if (!workspace.space) return
  const next = clone(workspace.space)
  mutate(next)
  workspace.space = next
  workspace.space = await api.saveSpace(next)
}

function removeEverywhere(space: Space, id: Id) {
  for (const section of space.sidebar) section.items = section.items.filter((item) => item !== id)
}

type SidebarPlace = { sectionId: string; index: number }

/** Where an item is pinned, so an undo can put it back. */
function sidebarPlaces(id: Id): SidebarPlace[] {
  return (workspace.space?.sidebar ?? []).flatMap((section) => {
    const index = section.items.indexOf(id)
    return index >= 0 ? [{ sectionId: section.id, index }] : []
  })
}

async function restorePlaces(id: Id, places: SidebarPlace[]) {
  if (!places.length) return
  await updateSidebar((space) => {
    for (const place of places) {
      const section = space.sidebar.find((s) => s.id === place.sectionId)
      if (section && !section.items.includes(id)) section.items.splice(Math.min(place.index, section.items.length), 0, id)
    }
  })
}

export const isInSidebar = (id: Id) => !!workspace.space?.sidebar.some((s) => s.items.includes(id))

const PINNED = 'Pinned'

/**
 * Add an item to a section (the first one, conventionally Pinned, by default). An item may sit in
 * several sections, as in Capacities; it is added once to each.
 */
export function pinToSidebar(id: Id, sectionId?: string) {
  return updateSidebar((space) => {
    let section = sectionId ? space.sidebar.find((s) => s.id === sectionId) : space.sidebar[0]
    if (!section) {
      section = { id: crypto.randomUUID(), name: PINNED, items: [] }
      space.sidebar.unshift(section)
    }
    if (!section.items.includes(id)) section.items.push(id)
  })
}

export const removeFromSidebar = (id: Id) => updateSidebar((space) => removeEverywhere(space, id))

export const removeFromSection = (id: Id, sectionId: string) =>
  updateSidebar((space) => {
    const section = space.sidebar.find((s) => s.id === sectionId)
    if (section) section.items = section.items.filter((item) => item !== id)
  })

export function toggleInSection(id: Id, sectionId: string) {
  const inIt = workspace.space?.sidebar.find((s) => s.id === sectionId)?.items.includes(id)
  return inIt ? removeFromSection(id, sectionId) : pinToSidebar(id, sectionId)
}

const sectionIcon = (section: { name: string; icon?: Icon }) => section.icon ?? (section.name === PINNED ? 'ph:push-pin' : 'ph:folder-simple')

/** One checkbox per sidebar section, and a new section, for a type or an object. */
export function pinItems(id: Id): MenuItem[] {
  return [
    ...(workspace.space?.sidebar ?? []).map(
      (section): MenuItem => ({ label: section.name, icon: sectionIcon(section), checked: section.items.includes(id), keepOpen: true, run: () => toggleInSection(id, section.id) })
    ),
    { kind: 'separator' },
    { label: 'New section…', icon: 'ph:folder-simple-plus', run: () => newSectionFlow(id) },
  ]
}

/** "Pin to sidebar ›" for any right-click menu on a type or an object. */
export const pinMenu = (id: Id): MenuItem => ({ kind: 'submenu', label: isInSidebar(id) ? 'Pinned in sidebar' : 'Pin to sidebar', icon: 'ph:push-pin', items: pinItems(id) })

/**
 * Put an item at a place in a section (a drop in the sidebar). `from` is the section it was dragged
 * out of, which it leaves; without it (dragged from a page, or copied with ⌥) it is added.
 */
export function placeInSection(id: Id, sectionId: string, index: number, from?: string) {
  return updateSidebar((space) => {
    const target = space.sidebar.find((s) => s.id === sectionId)
    if (!target) return
    if (from && from !== sectionId) {
      const source = space.sidebar.find((s) => s.id === from)
      if (source) source.items = source.items.filter((item) => item !== id)
    }
    const current = target.items.indexOf(id)
    if (current >= 0) {
      target.items.splice(current, 1)
      if (current < index) index--
    }
    target.items.splice(Math.max(0, Math.min(index, target.items.length)), 0, id)
  })
}

/** Move a section to a place among the sections (a dragged section header). */
export function placeSection(sectionId: string, index: number) {
  return updateSidebar((space) => {
    const current = space.sidebar.findIndex((s) => s.id === sectionId)
    if (current < 0) return
    const [section] = space.sidebar.splice(current, 1)
    if (current < index) index--
    space.sidebar.splice(Math.max(0, Math.min(index, space.sidebar.length)), 0, section!)
  })
}

export function setSectionIcon(sectionId: string, icon: Icon | undefined) {
  return updateSidebar((space) => {
    const section = space.sidebar.find((s) => s.id === sectionId)
    if (!section) return
    if (icon) section.icon = icon
    else delete section.icon
  })
}

/**
 * Older versions pinned into a section with the id "pinned", which new spaces do not have (theirs
 * has a random id), so a second "Pinned" appeared. Fold the two into the first.
 */
export function mergeStrayPinned() {
  const pinned = (workspace.space?.sidebar ?? []).filter((s) => s.name === PINNED)
  if (pinned.length < 2 || !pinned.some((s) => s.id === 'pinned')) return
  return updateSidebar((space) => {
    const [first, ...rest] = space.sidebar.filter((s) => s.name === PINNED)
    for (const id of rest.flatMap((s) => s.items)) if (!first!.items.includes(id)) first!.items.push(id)
    space.sidebar = space.sidebar.filter((s) => !rest.includes(s))
  })
}

export function moveInSection(id: Id, sectionId: string, delta: number) {
  return updateSidebar((space) => {
    const items = space.sidebar.find((s) => s.id === sectionId)?.items
    const index = items?.indexOf(id) ?? -1
    if (!items || index < 0 || index + delta < 0 || index + delta >= items.length) return
    ;[items[index], items[index + delta]] = [items[index + delta]!, items[index]!]
  })
}

export async function newSectionFlow(withItem?: Id) {
  const name = await promptDialog({ title: 'New sidebar section', placeholder: 'Section name', confirmLabel: 'Create' })
  if (!name) return
  await updateSidebar((space) => {
    space.sidebar.push({ id: crypto.randomUUID(), name, items: withItem ? [withItem] : [] })
  })
}

export async function renameSectionFlow(sectionId: string) {
  const section = workspace.space?.sidebar.find((s) => s.id === sectionId)
  if (!section) return
  const name = await promptDialog({ title: 'Rename section', value: section.name, confirmLabel: 'Rename' })
  if (!name) return
  await updateSidebar((space) => {
    const target = space.sidebar.find((s) => s.id === sectionId)
    if (target) target.name = name
  })
}

export async function deleteSectionFlow(sectionId: string) {
  const section = workspace.space?.sidebar.find((s) => s.id === sectionId)
  if (!section) return
  const ok = await confirmDialog({
    title: `Remove the section “${section.name}”?`,
    message: 'Only the section goes away; its types and objects are not deleted.',
    confirmLabel: 'Remove section',
    danger: true,
  })
  if (ok) await updateSidebar((space) => (space.sidebar = space.sidebar.filter((s) => s.id !== sectionId)))
}

export function moveSection(sectionId: string, delta: number) {
  return updateSidebar((space) => {
    const index = space.sidebar.findIndex((s) => s.id === sectionId)
    const target = index + delta
    if (index < 0 || target < 0 || target >= space.sidebar.length) return
    ;[space.sidebar[index], space.sidebar[target]] = [space.sidebar[target]!, space.sidebar[index]!]
  })
}
