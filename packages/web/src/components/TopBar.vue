<script setup lang="ts">
// The bar above the page: back and forward, where you are (an object's type, then the object),
// and New and Search when the sidebar is put away. On phones: the menu, the page and Search.
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import type { ColorName, Icon, ObjectType } from '@vasta/core'
import { createObject, isTodayRoute } from '../lib/actions.ts'
import { displayTitle } from '../lib/format.ts'
import { trafficLights } from '../lib/platform.ts'
import { keysOf, toggleSidebar } from '../lib/shortcuts.ts'
import { summaryOf, typesById, ui, workspace } from '../lib/state.ts'
import { objectColor } from '../lib/tags.ts'
import { isPhone } from '../lib/viewport.ts'
import AppIcon from './AppIcon.vue'
import NotificationBell from './NotificationBell.vue'
import TypeIcon from './TypeIcon.vue'
import PopoverMenu from './PopoverMenu.vue'
import TypePicker from './TypePicker.vue'

const route = useRoute()
const router = useRouter()

interface Crumb {
  label: string
  icon?: Icon
  fallback: string
  /** A type's or an object's crumb: its icon in the type's color (TypeIcon). */
  typed?: boolean
  color?: ColorName | undefined
  to?: string
}

const typeCrumb = (type: ObjectType | undefined): Crumb | undefined =>
  type && { label: type.pluralName, icon: type.icon, fallback: 'ph:cube', typed: true, color: type.color, to: `/t/${type.id}` }

const PAGES: Record<string, Crumb> = {
  '/inbox': { label: 'Inbox', fallback: 'ph:tray' },
  '/nutrition': { label: 'Nutrition', fallback: 'ph:chart-bar' },
  '/calendar': { label: 'Calendar', fallback: 'ph:calendar-dots' },
  '/settings': { label: 'Settings', fallback: 'ph:gear-six' },
  '/trash': { label: 'Trash', fallback: 'ph:trash' },
}

const crumbs = computed((): Crumb[] => {
  const id = route.params.id as string | undefined
  if (route.path.startsWith('/o/') && id) {
    const summary = summaryOf(id)
    const type = typesById.value.get(summary?.typeId ?? '')
    const object: Crumb = { label: summary ? displayTitle(summary, type) : '…', icon: summary?.icon ?? type?.icon, fallback: 'ph:file-text', typed: true, color: objectColor(summary, type) }
    return [typeCrumb(type), object].filter((c): c is Crumb => !!c)
  }
  if (route.path.startsWith('/t/') && id) return [typeCrumb(typesById.value.get(id))].filter((c): c is Crumb => !!c)
  if (isTodayRoute(route)) return [{ label: 'Today', fallback: 'ph:calendar-check' }]
  const page = PAGES[route.path]
  if (page) return [page]
  return [{ label: workspace.space?.name ?? '', fallback: 'ph:planet' }]
})

// vue-router keeps the neighbours of the current entry in history.state.
const canBack = ref(false)
const canForward = ref(false)
watch(
  () => route.fullPath,
  () => {
    canBack.value = !!history.state?.back
    canForward.value = !!history.state?.forward
  },
  { immediate: true }
)

const newButton = ref<HTMLElement | null>(null)
const newOpen = ref(false)
async function pickType(type: ObjectType) {
  newOpen.value = false
  await createObject(type.id)
}

const button = 'grid h-8 w-8 shrink-0 place-items-center rounded-md text-ink-faint hover:bg-hover hover:text-ink disabled:pointer-events-none disabled:opacity-35 max-md:h-11 max-md:w-11 max-md:text-ink-soft'
</script>

<template>
  <header
    class="flex h-12 shrink-0 items-center gap-0.5 px-2 max-md:h-11 max-md:border-b max-md:border-line"
    :class="trafficLights && (isPhone || ui.sidebarCollapsed) ? 'pl-20' : ''"
    data-tauri-drag-region="deep"
  >
    <button v-if="isPhone" :class="button" title="Menu" @click="ui.sidebarOpen = true">
      <AppIcon fallback="ph:list" :size="22" />
    </button>
    <button v-else-if="ui.sidebarCollapsed" :class="button" :title="`Show sidebar (${keysOf('sidebar')})`" @click="toggleSidebar">
      <AppIcon fallback="ph:sidebar-simple" :size="17" />
    </button>
    <template v-if="!isPhone">
      <button :class="button" title="Back" :disabled="!canBack" @click="router.back()"><AppIcon fallback="ph:caret-left" :size="16" /></button>
      <button :class="button" title="Forward" :disabled="!canForward" @click="router.forward()"><AppIcon fallback="ph:caret-right" :size="16" /></button>
    </template>

    <nav class="ml-1 flex min-w-0 flex-1 items-center gap-0.5 text-sm" aria-label="Location">
      <template v-for="(crumb, i) in crumbs" :key="i">
        <AppIcon v-if="i" fallback="ph:caret-right" :size="11" class="shrink-0 text-ink-faint max-md:hidden" />
        <component
          :is="crumb.to && i < crumbs.length - 1 ? RouterLink : 'span'"
          v-bind="crumb.to && i < crumbs.length - 1 ? { to: crumb.to } : {}"
          class="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1"
          :class="[
            i < crumbs.length - 1 ? 'shrink-0 text-ink-soft hover:bg-hover hover:text-ink max-md:hidden' : 'font-medium text-ink',
          ]"
        >
          <TypeIcon v-if="crumb.typed" :icon="crumb.icon" :fallback="crumb.fallback" :size="15" :color="crumb.color" />
          <AppIcon v-else :icon="crumb.icon" :fallback="crumb.fallback" :size="15" class="text-ink-soft" />
          <span class="truncate">{{ crumb.label }}</span>
        </component>
      </template>
    </nav>

    <template v-if="isPhone || ui.sidebarCollapsed">
      <button v-if="!isPhone" ref="newButton" :class="button" title="New" @click="newOpen = !newOpen"><AppIcon fallback="ph:plus" :size="17" /></button>
      <NotificationBell v-if="isPhone" :button-class="button" :size="21" placement="bottom-end" />
      <button :class="button" :title="`Search (${keysOf('search')})`" @click="ui.paletteOpen = true">
        <AppIcon fallback="ph:magnifying-glass" :size="isPhone ? 21 : 17" />
      </button>
      <PopoverMenu v-model:open="newOpen" :anchor="newButton" placement="bottom-end">
        <TypePicker @pick="pickType" />
      </PopoverMenu>
    </template>
  </header>
</template>
