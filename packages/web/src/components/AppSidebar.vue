<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Icon, Id, ObjectType } from '@vasta/core'
import {
  createObject,
  deleteObjectFlow,
  deleteSectionFlow,
  deleteTypeFlow,
  mergeStrayPinned,
  moveInSection,
  moveSection,
  newSectionFlow,
  newTypeFlow,
  pinMenu,
  placeInSection,
  placeSection,
  removeFromSection,
  renameSectionFlow,
  setSectionIcon,
} from '../lib/actions.ts'
import { displayTitle } from '../lib/format.ts'
import { api } from '../lib/api.ts'
import { openContextMenu, openMenuAt, promptDialog, type MenuItem } from '../lib/overlays.ts'
import { logOut, session } from '../lib/session.ts'
import { isLocalServer, trafficLights } from '../lib/platform.ts'
import { keysOf, toggleSidebar } from '../lib/shortcuts.ts'
import { THEME_ICONS, THEME_LABELS, cycleTheme, theme } from '../lib/theme.ts'
import { lastError, loadWorkspace, primeSummaries, summaryOf, systemType, typesById, ui, workspace } from '../lib/state.ts'
import { objectColor } from '../lib/tags.ts'
import AppIcon from './AppIcon.vue'
import NotificationBell from './NotificationBell.vue'
import IconPicker from './IconPicker.vue'
import TypeIcon from './TypeIcon.vue'
import PopoverMenu from './PopoverMenu.vue'
import TypePicker from './TypePicker.vue'
import { objectPath, openObject } from '../lib/open.ts'

const route = useRoute()
const router = useRouter()
const newButton = ref<HTMLElement | null>(null)
const newOpen = ref(false)
const collapsed = ref(new Set<string>())

interface Item {
  id: Id
  kind: 'type' | 'object'
  to: string
  /** Its place in the section's items (Tasks, kept out of the list, still has one). */
  index: number
}

const sections = computed(() =>
  (workspace.space?.sidebar ?? []).map((section) => ({
    ...section,
    entries: section.items.flatMap((id, index): Item[] =>
      id === taskType.value?.id ? [] : [{ id, index, kind: typesById.value.has(id) ? 'type' : 'object', to: typesById.value.has(id) ? `/t/${id}` : objectPath(id) }]
    ),
  }))
)

// A second "Pinned" left by older versions goes away when the space opens.
watch(
  () => workspace.space?.id,
  () => void mergeStrayPinned()?.catch(() => {}),
  { immediate: true }
)

/** Types that are not placed in any sidebar section, but have content or are user-made. */
/** Tasks have their own row at the top, next to Calendar and Inbox, not one among the types. */
const taskType = computed(() => systemType('task'))

const otherTypes = computed(() => {
  const placed = new Set((workspace.space?.sidebar ?? []).flatMap((s) => s.items))
  return workspace.types
    .filter((t) => t.system !== 'task' && !placed.has(t.id) && (!t.system || (workspace.counts[t.id] ?? 0) > 0))
    .sort((a, b) => a.pluralName.localeCompare(b.pluralName))
})

function toggle(id: string) {
  const next = new Set(collapsed.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsed.value = next
}

const isActive = (to: string) => route.path === to

// ---------------------------------------------------------------------------
// Right-click menus

function sectionName(sectionId: string) {
  return workspace.space?.sidebar.find((s) => s.id === sectionId)?.name ?? ''
}

/** Moving and removing a row within the section it was right-clicked in. */
function inSectionItems(id: Id, sectionId: string): MenuItem[] {
  return [
    { label: 'Move up', icon: 'ph:arrow-up', run: () => moveInSection(id, sectionId, -1) },
    { label: 'Move down', icon: 'ph:arrow-down', run: () => moveInSection(id, sectionId, 1) },
    { label: `Remove from ${sectionName(sectionId)}`, icon: 'ph:push-pin-slash', run: () => removeFromSection(id, sectionId) },
  ]
}

function typeMenu(event: MouseEvent, type: ObjectType, sectionId?: string) {
  const items: MenuItem[] = [
    { kind: 'heading', label: type.pluralName },
    { label: 'Open', icon: 'ph:arrow-square-out', run: () => router.push(`/t/${type.id}`) },
    { label: `New ${type.name}`, icon: 'ph:plus', run: () => createObject(type.id) },
    { label: 'Type settings…', icon: 'ph:gear-six', run: () => router.push({ path: `/t/${type.id}`, query: { settings: '1' } }) },
    { kind: 'separator' },
    pinMenu(type.id),
    ...(sectionId ? inSectionItems(type.id, sectionId) : []),
    ...(!type.system ? [{ kind: 'separator' } as MenuItem, { label: 'Delete type…', icon: 'ph:trash', danger: true, run: () => deleteTypeFlow(type) }] : []),
  ]
  openContextMenu(event, items)
}

function objectMenu(event: MouseEvent, id: Id, sectionId: string) {
  openContextMenu(event, [
    { kind: 'heading', label: displayTitle(summaryOf(id)) },
    { label: 'Open', icon: 'ph:arrow-square-out', run: () => openObject(id) },
    { kind: 'separator' },
    pinMenu(id),
    ...inSectionItems(id, sectionId),
    { kind: 'separator' },
    { label: 'Move to trash', icon: 'ph:trash', danger: true, run: () => deleteObjectFlow(id) },
  ])
}

// Section icons: picked in a popover under the section's header.
const iconSection = ref<string | null>(null)
const iconAnchor = ref<HTMLElement | null>(null)
const iconOpen = computed({ get: () => !!iconSection.value, set: (open) => void (open || (iconSection.value = null)) })
const iconSectionIcon = computed(() => workspace.space?.sidebar.find((s) => s.id === iconSection.value)?.icon)

function changeSectionIcon(sectionId: string) {
  iconAnchor.value = document.querySelector<HTMLElement>(`[data-section="${CSS.escape(sectionId)}"]`)
  iconSection.value = sectionId
}

async function pickSectionIcon(icon: Icon | undefined) {
  const sectionId = iconSection.value
  iconSection.value = null
  if (sectionId) await setSectionIcon(sectionId, icon)
}

function sectionMenu(event: MouseEvent, sectionId: string) {
  openContextMenu(event, [
    { label: collapsed.value.has(sectionId) ? 'Expand' : 'Collapse', icon: 'ph:caret-up-down', run: () => toggle(sectionId) },
    { label: 'Rename…', icon: 'ph:pencil-simple', run: () => renameSectionFlow(sectionId) },
    { label: 'Change icon…', icon: 'ph:smiley', run: () => changeSectionIcon(sectionId) },
    { label: 'Move up', icon: 'ph:arrow-up', run: () => moveSection(sectionId, -1) },
    { label: 'Move down', icon: 'ph:arrow-down', run: () => moveSection(sectionId, 1) },
    { label: 'New section…', icon: 'ph:folder-simple-plus', run: () => newSectionFlow() },
    { kind: 'separator' },
    { label: 'Remove section…', icon: 'ph:trash', danger: true, run: () => deleteSectionFlow(sectionId) },
  ])
}

function typesHeaderMenu(event: MouseEvent) {
  openContextMenu(event, [
    { label: 'New type…', icon: 'ph:plus', run: newTypeFlow },
    { label: 'New section…', icon: 'ph:folder-simple-plus', run: () => newSectionFlow() },
  ])
}

async function switchSpace(id: Id) {
  if (id === workspace.space?.id) return
  await loadWorkspace(id)
  await router.push('/')
}

async function newSpaceFlow() {
  const name = await promptDialog({ title: 'New space', message: 'A space of its own, with the built-in types. Share it from Settings.', placeholder: 'Home', confirmLabel: 'Create space' })
  if (!name) return
  try {
    const space = await api.createSpace({ name })
    await loadWorkspace(space.id)
    await router.push('/')
  } catch (error) {
    lastError.value = (error as Error).message
  }
}

/** Spaces to switch to, and the account. */
function spaceMenu(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  openMenuAt(rect.left, rect.bottom + 4, [
    { kind: 'heading', label: 'Spaces' },
    ...workspace.spaces.map(
      (space): MenuItem => ({ label: space.name, icon: space.id === workspace.space?.id ? 'ph:check' : 'ph:planet', run: () => switchSpace(space.id) })
    ),
    { kind: 'separator' },
    { label: 'New space…', icon: 'ph:plus', run: newSpaceFlow },
    { kind: 'separator' },
    { kind: 'heading', label: session.user?.name ?? '' },
    { label: 'Settings', icon: 'ph:gear-six', run: () => router.push('/settings') },
    // The desktop app logs its own server's one account in itself: no password to know, no logging out.
    ...(isLocalServer()
      ? []
      : [
          { label: 'Change password…', icon: 'ph:key', run: () => (ui.passwordOpen = true) },
          { label: 'Log out', icon: 'ph:sign-out', run: logOut },
        ]),
  ])
}

// ---------------------------------------------------------------------------
// Drag and drop: rows move within and between sections (⌥ copies, so a row sits in both), a type
// from All types or any link to an object or a type (a card, a row of a list) is added where it is
// dropped, and section headers reorder the sections.

type Dragged = { kind: 'item'; id: Id; from?: string } | { kind: 'section'; id: string }
let dragged: Dragged | null = null
/** An item is being dragged: empty sections show a place to drop it. */
const draggingItem = ref(false)
/** Where an item would land: before `index` in that section. */
const itemDrop = ref<{ sectionId: string; index: number } | null>(null)
/** Where a section would land: before that index among the sections. */
const sectionDrop = ref<number | null>(null)

function startItemDrag(event: DragEvent, id: Id, from?: string) {
  dragged = { kind: 'item', id, from }
  // A tick later: WebKit cancels a drag whose page changes during dragstart.
  setTimeout(() => (draggingItem.value = dragged?.kind === 'item'))
  event.dataTransfer!.effectAllowed = 'copyMove'
}

function startSectionDrag(event: DragEvent, id: string) {
  dragged = { kind: 'section', id }
  event.dataTransfer!.effectAllowed = 'move'
  event.dataTransfer!.setData('text/plain', sectionName(id))
}

function endDrag() {
  dragged = null
  draggingItem.value = false
  itemDrop.value = null
  sectionDrop.value = null
}

/** A type or an object from a link dragged in from the page: /o/<id> or /t/<id>. */
function linkedId(data: DataTransfer): Id | null {
  for (const text of [data.getData('text/uri-list'), data.getData('text/plain')]) {
    try {
      const match = /^\/(o|t)\/([^/]+)$/.exec(new URL(text.trim().split('\n')[0]!, location.href).pathname)
      if (match) return decodeURIComponent(match[2]!)
    } catch {}
  }
  return null
}

const carriesItem = (event: DragEvent) => dragged?.kind === 'item' || (!dragged && !!event.dataTransfer?.types.includes('text/uri-list'))

function setEffect(event: DragEvent) {
  event.dataTransfer!.dropEffect = dragged?.kind === 'item' && dragged.from && !event.altKey ? 'move' : 'copy'
}

const upperHalf = (event: DragEvent) => {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  return event.clientY < rect.top + rect.height / 2
}

function overRow(event: DragEvent, sectionId: string, index: number) {
  if (!carriesItem(event)) return
  event.preventDefault()
  setEffect(event)
  itemDrop.value = { sectionId, index: upperHalf(event) ? index : index + 1 }
}

function overHeader(event: DragEvent, sectionId: string, sectionIndex: number, length: number) {
  if (dragged?.kind === 'section') {
    event.preventDefault()
    event.dataTransfer!.dropEffect = 'move'
    sectionDrop.value = upperHalf(event) ? sectionIndex : sectionIndex + 1
  } else if (carriesItem(event)) {
    event.preventDefault()
    setEffect(event)
    itemDrop.value = { sectionId, index: length }
  }
}

function overEmpty(event: DragEvent, sectionId: string) {
  if (!carriesItem(event)) return
  event.preventDefault()
  setEffect(event)
  itemDrop.value = { sectionId, index: 0 }
}

/** Leaving the sidebar clears the drop line (by the pointer: WebKit gives no relatedTarget). */
function leaveNav(event: DragEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  if (event.clientX > rect.left && event.clientX < rect.right && event.clientY > rect.top && event.clientY < rect.bottom) return
  itemDrop.value = null
  sectionDrop.value = null
}

async function inThisSpace(id: Id) {
  try {
    const [summary] = await api.summaries([id])
    if (summary) primeSummaries([summary])
    return summary?.spaceId === workspace.space?.id && !summary?.deletedAt
  } catch {
    return false
  }
}

async function dropHere(event: DragEvent) {
  event.preventDefault()
  const place = itemDrop.value
  const sectionPlace = sectionDrop.value
  const source = dragged
  const copy = event.altKey
  const linked = source ? null : linkedId(event.dataTransfer!)
  endDrag()
  if (source?.kind === 'section') {
    if (sectionPlace !== null) await placeSection(source.id, sectionPlace)
    return
  }
  const id = source?.id ?? linked
  if (!place || !id) return
  // A link to something that is not in this space (another space's object, a stale page) is skipped.
  if (!source && !typesById.value.has(id) && !(await inThisSpace(id))) return
  await placeInSection(id, place.sectionId, place.index, copy ? undefined : source?.from)
}

const dropLine = 'pointer-events-none relative z-10 mx-2 -my-px h-0.5 rounded-full bg-accent'

/** A sidebar row; the open page's is raised, like a card on the sidebar. */
const row = (active: boolean) =>
  [
    'group flex items-center gap-2 rounded-md px-2 py-[5px] max-md:py-2',
    active ? 'bg-surface font-medium text-ink shadow-sm ring-1 ring-line' : 'text-ink/90 hover:bg-hover',
  ].join(' ')
const sectionHeader = 'group/section flex w-full cursor-default select-none items-center gap-1.5 px-2 py-1 text-xs font-medium text-ink-faint hover:text-ink-soft'
const hint = 'ml-auto font-sans text-[11px] text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 max-md:hidden'
const tool = 'flex h-8 min-w-8 items-center justify-center rounded-md hover:bg-hover hover:text-ink max-md:h-10 max-md:min-w-10'

const initial = computed(() => (workspace.space?.name ?? '?').trim().charAt(0).toUpperCase())

async function pickType(type: ObjectType) {
  newOpen.value = false
  await createObject(type.id)
}
</script>

<template>
  <!-- Next to the macOS traffic lights, a little wider so the space's name still fits. -->
  <aside class="flex h-full w-60 shrink-0 flex-col bg-canvas md:border-r-0 max-md:border-r max-md:border-line" :class="trafficLights ? 'md:w-[17rem]' : ''">
    <div class="flex h-12 shrink-0 items-center gap-1 px-2" :class="trafficLights ? 'pl-[76px]' : ''" data-tauri-drag-region="deep">
      <button class="mr-auto flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover" title="Spaces and account" @click="spaceMenu">
        <span class="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-ink text-[11px] font-semibold text-surface" v-if="!workspace.space?.icon">{{ initial }}</span>
        <AppIcon v-else :icon="workspace.space?.icon" :size="18" class="text-ink-soft" />
        <span class="truncate text-sm font-semibold">{{ workspace.space?.name }}</span>
        <AppIcon fallback="ph:caret-up-down" :size="12" class="shrink-0 text-ink-faint" />
      </button>
      <button class="grid h-8 w-8 shrink-0 place-items-center rounded-md text-ink-faint hover:bg-hover hover:text-ink max-md:hidden" :title="`Hide sidebar (${keysOf('sidebar')})`" @click="toggleSidebar">
        <AppIcon fallback="ph:sidebar-simple" :size="17" />
      </button>
    </div>

    <div class="flex gap-1.5 px-2 pb-2">
      <button
        ref="newButton"
        class="flex flex-1 items-center gap-2 rounded-lg bg-surface px-2.5 py-1.5 text-sm font-medium shadow-sm ring-1 ring-line hover:bg-raised max-md:py-2"
        @click="newOpen = !newOpen"
      >
        <AppIcon fallback="ph:plus" /> New
      </button>
      <button
        class="flex items-center rounded-lg bg-surface px-2.5 text-ink-soft shadow-sm ring-1 ring-line hover:bg-raised hover:text-ink"
        :title="`Search (${keysOf('search')})`"
        @click="ui.paletteOpen = true"
      >
        <AppIcon fallback="ph:magnifying-glass" />
      </button>
    </div>
    <PopoverMenu v-model:open="newOpen" :anchor="newButton">
      <TypePicker @pick="pickType" />
    </PopoverMenu>
    <PopoverMenu v-model:open="iconOpen" :anchor="iconAnchor" width="auto">
      <IconPicker :icon="iconSectionIcon" allow-remove @pick="pickSectionIcon" />
    </PopoverMenu>

    <nav class="vasta-sidebar-nav flex-1 overflow-y-auto px-2 pb-6 text-sm max-md:text-[15px]" @dragleave="leaveNav" @drop="dropHere">
      <RouterLink to="/calendar" :class="row(route.path === '/calendar')" :title="`Calendar (${keysOf('calendar')}); today: ${keysOf('today')}`">
        <AppIcon fallback="ph:calendar-dots" class="text-ink-soft" /> Calendar
        <kbd :class="hint">{{ keysOf('calendar') }}</kbd>
      </RouterLink>
      <RouterLink to="/inbox" :class="row(route.path === '/inbox')">
        <AppIcon fallback="ph:tray" class="text-ink-soft" /> Inbox
        <kbd :class="hint">{{ keysOf('inbox') }}</kbd>
      </RouterLink>
      <RouterLink v-if="taskType" :to="`/t/${taskType.id}`" :class="row(isActive(`/t/${taskType.id}`))">
        <AppIcon fallback="ph:check-circle" class="text-ink-soft" /> Tasks
        <span v-if="workspace.counts[taskType.id]" class="ml-auto text-xs tabular-nums text-ink-faint group-hover:hidden">{{ workspace.counts[taskType.id] }}</span>
        <kbd :class="hint" class="hidden group-hover:inline">{{ keysOf('tasks') }}</kbd>
      </RouterLink>

      <template v-for="(section, sectionIndex) in sections" :key="section.id">
        <div v-if="sectionDrop === sectionIndex" :class="dropLine" class="mt-4" />
        <!-- A div: WebKit does not start a drag on a button. -->
        <div
          role="button"
          tabindex="0"
          :class="[sectionHeader, itemDrop?.sectionId === section.id && (collapsed.has(section.id) || !section.entries.length) ? 'rounded-md bg-hover text-ink-soft' : '']"
          class="mt-5"
          :data-section="section.id"
          draggable="true"
          @click="toggle(section.id)"
          @keydown.enter.space.prevent="toggle(section.id)"
          @contextmenu="sectionMenu($event, section.id)"
          @dragstart="startSectionDrag($event, section.id)"
          @dragend="endDrag"
          @dragover="overHeader($event, section.id, sectionIndex, section.items.length)"
        >
          <AppIcon :icon="section.icon" :size="13" />
          <span class="truncate">{{ section.name }}</span>
          <AppIcon :fallback="collapsed.has(section.id) ? 'ph:caret-right' : 'ph:caret-down'" :size="11" class="ml-auto opacity-0 transition-opacity group-hover/section:opacity-100 [@media(hover:none)]:opacity-100" />
        </div>
        <template v-if="!collapsed.has(section.id)">
          <template v-for="(entry, position) in section.entries" :key="entry.id">
            <div v-if="itemDrop?.sectionId === section.id && itemDrop.index === entry.index" :class="dropLine" />
            <RouterLink
              :to="entry.to"
              :class="row(isActive(entry.to))"
              @contextmenu="entry.kind === 'type' ? typeMenu($event, typesById.get(entry.id)!, section.id) : objectMenu($event, entry.id, section.id)"
              @dragstart="startItemDrag($event, entry.id, section.id)"
              @dragend="endDrag"
              @dragover="overRow($event, section.id, entry.index)"
            >
              <template v-if="entry.kind === 'type'">
                <TypeIcon :icon="typesById.get(entry.id)?.icon" fallback="ph:cube" :color="typesById.get(entry.id)?.color" />
                <span class="truncate">{{ typesById.get(entry.id)?.pluralName }}</span>
              </template>
              <template v-else>
                <TypeIcon
                  :icon="summaryOf(entry.id)?.icon ?? typesById.get(summaryOf(entry.id)?.typeId ?? '')?.icon"
                  fallback="ph:file-text"
                  :color="objectColor(summaryOf(entry.id), typesById.get(summaryOf(entry.id)?.typeId ?? ''))"
                />
                <span class="truncate">{{ displayTitle(summaryOf(entry.id)) }}</span>
              </template>
            </RouterLink>
            <div v-if="position === section.entries.length - 1 && itemDrop?.sectionId === section.id && itemDrop.index > entry.index" :class="dropLine" />
          </template>
          <!-- An empty section takes a drop while something is dragged. -->
          <div
            v-if="draggingItem && !section.entries.length"
            class="mx-1 rounded-md border border-dashed px-2 py-1.5 text-xs text-ink-faint"
            :class="itemDrop?.sectionId === section.id ? 'border-accent text-ink-soft' : 'border-line'"
            @dragover="overEmpty($event, section.id)"
          >
            Drop here
          </div>
        </template>
      </template>
      <div v-if="sectionDrop === sections.length" :class="dropLine" class="mt-4" />

      <div class="group/section mt-5 flex items-center">
        <button :class="sectionHeader" @click="toggle('__types')" @contextmenu="typesHeaderMenu">
          <AppIcon fallback="ph:shapes" :size="13" />
          <span>All types</span>
          <AppIcon :fallback="collapsed.has('__types') ? 'ph:caret-right' : 'ph:caret-down'" :size="11" class="ml-auto opacity-0 transition-opacity group-hover/section:opacity-100 [@media(hover:none)]:opacity-100" />
        </button>
        <button class="rounded p-1 text-ink-faint opacity-0 transition-opacity hover:bg-hover hover:text-ink group-hover/section:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100" title="New type" @click="newTypeFlow">
          <AppIcon fallback="ph:plus" :size="12" />
        </button>
      </div>
      <template v-if="!collapsed.has('__types')">
        <RouterLink
          v-for="type in otherTypes"
          :key="type.id"
          :to="`/t/${type.id}`"
          :class="row(isActive(`/t/${type.id}`))"
          @contextmenu="typeMenu($event, type)"
          @dragstart="startItemDrag($event, type.id)"
          @dragend="endDrag"
        >
          <TypeIcon :icon="type.icon" fallback="ph:cube" :color="type.color" />
          <span class="truncate">{{ type.pluralName }}</span>
          <span class="ml-auto text-xs tabular-nums text-ink-faint">{{ workspace.counts[type.id] ?? '' }}</span>
        </RouterLink>
      </template>
    </nav>

    <div class="flex items-center gap-0.5 border-t border-line px-2 py-1.5 text-ink-faint">
      <RouterLink to="/settings" :class="[tool, route.path === '/settings' ? 'bg-hover text-ink' : '']" title="Settings">
        <AppIcon fallback="ph:gear-six" :size="17" />
      </RouterLink>
      <button :class="tool" :title="THEME_LABELS[theme]" @click="cycleTheme">
        <AppIcon :fallback="THEME_ICONS[theme]" :size="17" />
      </button>
      <button :class="tool" class="max-md:hidden" :title="`Keyboard shortcuts (${keysOf('shortcuts')})`" @click="ui.shortcutsOpen = true">
        <AppIcon fallback="ph:keyboard" :size="17" />
      </button>
      <NotificationBell :button-class="tool" />
      <RouterLink to="/trash" :class="[tool, 'ml-auto gap-1 px-2', route.path === '/trash' ? 'bg-hover text-ink' : '']" title="Trash">
        <AppIcon fallback="ph:trash" :size="17" />
        <span v-if="workspace.trash" class="text-xs tabular-nums">{{ workspace.trash }}</span>
      </RouterLink>
    </div>
  </aside>
</template>
