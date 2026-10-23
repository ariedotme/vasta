<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { FilterGroup, GroupRule, ObjectRecord, ObjectSummary, SortRule, ViewDef, ViewLayout } from '@vasta/core'
import { RANK_PROPERTY_ID, matchesFilter, sortKey as fieldSortKey, statusProperty } from '@vasta/core'
import AppIcon from '../components/AppIcon.vue'
import TipsCard from '../components/TipsCard.vue'
import ColumnsMenu from '../components/ColumnsMenu.vue'
import FilterGroupEditor from '../components/FilterGroupEditor.vue'
import FlowMetrics from '../components/FlowMetrics.vue'
import ObjectCollection from '../components/ObjectCollection.vue'
import HabitBoard from '../components/HabitBoard.vue'
import TagTree from '../components/TagTree.vue'
import PopoverMenu from '../components/PopoverMenu.vue'
import TypeSettings from '../components/TypeSettings.vue'
import { deleteObjectFlow, deleteTypeFlow, isInSidebar, pinItems, pinMenu } from '../lib/actions.ts'
import { api } from '../lib/api.ts'
import { onChange } from '../lib/events.ts'
import { clone } from '../lib/clone.ts'
import { chip } from '../lib/colors.ts'
import { displayTitle } from '../lib/format.ts'
import { confirmDialog, openContextMenu, openMenuAt, promptDialog } from '../lib/overlays.ts'
import { groupOptions, queryContext } from '../lib/query.ts'
import { keysOf } from '../lib/shortcuts.ts'
import { meId, sharedSpace } from '../lib/people.ts'
import { primeSummaries, replaceType, typesById, unsavedTypes } from '../lib/state.ts'
import { createFromTemplate, currentTemplates, loadTemplates, newTemplate, templatesOf } from '../lib/templates.ts'

const props = defineProps<{ id: string }>()
const router = useRouter()

const type = computed(() => typesById.value.get(props.id))
const objects = ref<ObjectSummary[]>([])
const loading = ref(true)
const filterText = ref('')
const activeViewId = ref<string>('')

async function loadObjects() {
  objects.value = await api.objectsOfType(props.id)
  primeSummaries(objects.value)
  loading.value = false
}
onMounted(loadObjects)

// Objects of this type created, changed, deleted or restored elsewhere (another page, an undo, a capture).
let reloadTimer: ReturnType<typeof setTimeout> | undefined
const stopListening = onChange((event) => {
  if (event.kind !== 'object' || event.typeId !== props.id) return
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => void loadObjects(), 300)
})
onBeforeUnmount(() => {
  stopListening()
  clearTimeout(reloadTimer)
})

/**
 * Some built-in types get a fixed view before their saved views, and open on it: Tags a Tree of
 * nested tags (TagTree), Habits a Tracker of the last days (HabitBoard).
 */
const FIXED_VIEWS: Partial<Record<string, { id: string; label: string; icon: string }>> = {
  tag: { id: '__tree', label: 'Tree', icon: 'ph:tree-structure' },
  habit: { id: '__tracker', label: 'Tracker', icon: 'ph:check-square' },
}
const fixedView = computed(() => FIXED_VIEWS[type.value?.system ?? ''])
// A type with a status (tasks) also has its flow metrics, after its views.
const METRICS_VIEW = '__metrics'
const hasMetrics = computed(() => !!statusProperty(type.value))
const metricsActive = computed(() => hasMetrics.value && activeViewId.value === METRICS_VIEW)
const fixedActive = computed(() => metricsActive.value || (!!fixedView.value && activeViewId.value === fixedView.value.id))

watch(type, (t) => {
  if (!t) return
  const fixed = FIXED_VIEWS[t.system ?? '']
  if (!activeViewId.value && fixed) activeViewId.value = fixed.id
  else if (activeViewId.value !== fixed?.id && activeViewId.value !== METRICS_VIEW && !t.views.some((v) => v.id === activeViewId.value)) activeViewId.value = t.views[0]?.id ?? ''
}, { immediate: true })

const view = computed<ViewDef>(() => type.value?.views.find((v) => v.id === activeViewId.value) ?? { id: 'default', name: 'All', layout: 'list' })

// View settings are saved on the type, debounced. Until the save answers, the edited copy is the
// type (unsavedTypes): a change event reloading the stored one meanwhile would undo the edit.
let saveTimer: ReturnType<typeof setTimeout> | undefined
function updateView(patch: Partial<ViewDef>) {
  if (!type.value) return
  const next = clone(type.value)
  let target = next.views.find((v) => v.id === view.value.id)
  if (!target) {
    target = { ...view.value, id: `${next.id}:all` }
    next.views.push(target)
    activeViewId.value = target.id
  }
  Object.assign(target, patch)
  for (const key of Object.keys(patch) as (keyof ViewDef)[]) if (patch[key] === undefined) delete target[key]
  unsavedTypes.set(next.id, next)
  replaceType(next)
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    const sending = unsavedTypes.get(next.id)
    if (!sending) return
    try {
      const saved = await api.saveType(sending)
      if (unsavedTypes.get(next.id) !== sending) return
      unsavedTypes.delete(next.id)
      replaceType(saved)
    } catch (error) {
      if (unsavedTypes.get(next.id) === sending) unsavedTypes.delete(next.id)
      throw error
    }
  }, 400)
}

async function addView() {
  if (!type.value) return
  const id = crypto.randomUUID()
  const name = await promptDialog({ title: 'New view', value: 'New view', confirmLabel: 'Create' })
  if (!name || !type.value) return
  const next = clone(type.value)
  next.views.push({ id, name, layout: view.value.layout })
  replaceType(next)
  activeViewId.value = id
  void api.saveType(next).then(replaceType)
}

// ---------------------------------------------------------------------------
// "…" menu

const menuAnchor = ref<HTMLElement | null>(null)
const menuOpen = ref(false)
const route = useRoute()
const settingsOpen = ref(route.query.settings === '1')
watch(
  () => route.query.settings,
  (value) => {
    if (value === '1') settingsOpen.value = true
  }
)
function closeSettings() {
  settingsOpen.value = false
  if (route.query.settings) void router.replace({ query: {} })
}

function saveViews(mutate: (views: ViewDef[]) => void) {
  if (!type.value) return
  const next = clone(type.value)
  mutate(next.views)
  replaceType(next)
  void api.saveType(next).then(replaceType)
}

async function renameView() {
  menuOpen.value = false
  const name = await promptDialog({ title: 'Rename view', value: view.value.name, confirmLabel: 'Rename' })
  if (!name) return
  saveViews((views) => {
    const target = views.find((v) => v.id === view.value.id)
    if (target) target.name = name
  })
}

function duplicateView() {
  menuOpen.value = false
  const copy: ViewDef = { ...clone(view.value), id: crypto.randomUUID(), name: `${view.value.name} copy` }
  saveViews((views) => views.push(copy))
  activeViewId.value = copy.id
}

async function deleteView() {
  menuOpen.value = false
  if ((type.value?.views.length ?? 0) <= 1) return
  const id = view.value.id
  if (!(await confirmDialog({ title: `Delete the view “${view.value.name}”?`, confirmLabel: 'Delete view', danger: true }))) return
  saveViews((views) => views.splice(views.findIndex((v) => v.id === id), 1))
  activeViewId.value = type.value?.views[0]?.id ?? ''
}

const pinned = computed(() => isInSidebar(props.id))

/** The sections to pin the type in, beside the More menu's row. */
function pinFrom(event: MouseEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  menuOpen.value = false
  openMenuAt(rect.left, rect.top, pinItems(props.id))
}

async function deleteType() {
  menuOpen.value = false
  if (type.value) await deleteTypeFlow(type.value)
}

/** Right-click on an object in any layout. */
function objectMenu(event: MouseEvent, object: ObjectSummary) {
  openContextMenu(event, [
    { kind: 'heading', label: displayTitle(object, type.value) },
    { label: 'Open', icon: 'ph:arrow-square-out', run: () => router.push(`/o/${object.id}`) },
    pinMenu(object.id),
    { kind: 'separator' },
    {
      label: 'Move to trash',
      icon: 'ph:trash',
      danger: true,
      run: async () => {
        if (await deleteObjectFlow(object.id)) objects.value = objects.value.filter((o) => o.id !== object.id)
      },
    },
  ])
}

// ---------------------------------------------------------------------------
// Fields

const valueProps = computed(() => (type.value?.properties ?? []).filter((p) => p.kind !== 'rich-text'))
const selectProps = computed(() => valueProps.value.filter((p) => p.kind === 'select'))
/** "Mine": only what one of the type's person fields (Assignee…) names the user in; per type, on this device. */
const personProps = computed(() => valueProps.value.filter((p) => p.kind === 'person'))
const mineKey = computed(() => `vasta.mine.${props.id}`)
const mineOnly = ref(false)
watch(
  mineKey,
  (key) => {
    try {
      mineOnly.value = localStorage.getItem(key) === '1'
    } catch {}
  },
  { immediate: true }
)
function toggleMine() {
  mineOnly.value = !mineOnly.value
  try {
    localStorage.setItem(mineKey.value, mineOnly.value ? '1' : '0')
  } catch {}
}
const showMine = computed(() => sharedSpace.value && personProps.value.length > 0)
const isMine = (o: ObjectSummary) => {
  const me = meId()
  return personProps.value.some((p) => {
    const value = o.props[p.id]
    return value?.kind === 'person' && !!me && value.value.includes(me)
  })
}

const sortFields = computed(() => [
  // A board keeps the order its cards were dragged into until it is sorted by a field.
  ...(view.value.layout === 'kanban' ? [{ field: RANK_PROPERTY_ID, label: 'Manual' }] : []),
  { field: 'updatedAt', label: 'Last edited' },
  { field: 'createdAt', label: 'Created' },
  { field: 'title', label: 'Title' },
  ...valueProps.value.filter((p) => ['date', 'number', 'text', 'select', 'formula'].includes(p.kind)).map((p) => ({ field: p.id, label: p.name })),
])
const groupFields = computed(() => [{ field: '', label: 'No grouping' }, ...groupOptions([props.id]).filter((f) => f.field !== 'type')])

const manual = computed(() => view.value.layout === 'kanban' && !view.value.sort?.length)
const sort = computed<SortRule>(() => (manual.value ? { field: RANK_PROPERTY_ID, direction: 'asc' } : (view.value.sort?.[0] ?? { field: 'updatedAt', direction: 'desc' })))
const groupField = computed(() => {
  if (view.value.layout === 'kanban') return view.value.groupBy?.[0]?.field ?? selectProps.value[0]?.id ?? 'tags'
  return view.value.groupBy?.[0]?.field ?? ''
})

const visible = computed(() => {
  const q = filterText.value.trim().toLowerCase()
  const context = queryContext()
  const list = objects.value.filter(
    (o) => matchesFilter(o, view.value.filter, context) && (!showMine.value || !mineOnly.value || isMine(o)) && (!q || displayTitle(o, type.value).toLowerCase().includes(q) || o.preview.toLowerCase().includes(q))
  )
  const { field, direction } = sort.value
  const factor = direction === 'asc' ? 1 : -1
  // Keys are read once per object (a formula would otherwise run at every comparison); titles
  // sort as shown, so daily notes and untitled objects take their place.
  // The board puts ranked cards in order itself; the others come by when they changed.
  if (field === RANK_PROPERTY_ID) return [...list].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  const keyOf = (o: ObjectSummary) => (field === 'title' ? displayTitle(o, type.value).toLowerCase() : fieldSortKey(o, field, context))
  return list
    .map((object) => ({ object, key: keyOf(object) }))
    .sort((a, b) => {
      if (a.key === b.key) return 0
      if (a.key === '') return 1
      if (b.key === '') return -1
      return a.key < b.key ? -factor : factor
    })
    .map((k) => k.object)
})

function created(object: ObjectRecord) {
  if (!objects.value.some((o) => o.id === object.id)) objects.value.push({ ...object, preview: '' } as ObjectSummary)
}

// Board options: the fields cards show and the rows (swimlanes) they are in.
const boardAnchor = ref<HTMLElement | null>(null)
const boardOpen = ref(false)
const cardFieldChoices = computed(() => valueProps.value.filter((p) => p.id !== groupField.value))
const cardFieldIds = computed(() => view.value.board?.cardFields)
function toggleCardField(id: string) {
  const current = cardFieldIds.value ?? []
  const next = current.includes(id) ? current.filter((f) => f !== id) : cardFieldChoices.value.map((p) => p.id).filter((f) => f === id || current.includes(f))
  updateView({ board: { ...view.value.board, cardFields: next } })
}
function resetCardFields() {
  const { cardFields: _, ...rest } = view.value.board ?? {}
  updateView({ board: Object.keys(rest).length ? rest : undefined })
}
function setSwimlanes(field: string) {
  const { swimlanes: _, ...rest } = view.value.board ?? {}
  const next = field ? { ...rest, swimlanes: field } : rest
  updateView({ board: Object.keys(next).length ? next : undefined })
}

function moved(saved: ObjectRecord) {
  const index = objects.value.findIndex((o) => o.id === saved.id)
  if (index >= 0) objects.value[index] = { ...saved, preview: objects.value[index]!.preview } as ObjectSummary
}

// Filter: saved on the view, applied with the same engine as queries.
const filterAnchor = ref<HTMLElement | null>(null)
const filterOpen = ref(false)
const filterGroup = computed<FilterGroup>(() => view.value.filter ?? { kind: 'group', operator: 'and', items: [] })
const filterCount = computed(() => filterGroup.value.items.length)
const setFilter = (group: FilterGroup) => updateView({ filter: group.items.length ? group : undefined })

// ---------------------------------------------------------------------------
// Menus

const layouts: { layout: ViewLayout; label: string; icon: string }[] = [
  { layout: 'list', label: 'List', icon: 'ph:list-dashes' },
  { layout: 'grid', label: 'Grid', icon: 'ph:grid-four' },
  { layout: 'wall', label: 'Wall', icon: 'ph:wall' },
  { layout: 'gallery', label: 'Gallery', icon: 'ph:images' },
  { layout: 'table', label: 'Table', icon: 'ph:table' },
  { layout: 'kanban', label: 'Board', icon: 'ph:kanban' },
]
const layoutAnchor = ref<HTMLElement | null>(null)
const layoutOpen = ref(false)
const sortAnchor = ref<HTMLElement | null>(null)
const sortOpen = ref(false)
const columnsAnchor = ref<HTMLElement | null>(null)
const columnsOpen = ref(false)
const groupAnchor = ref<HTMLElement | null>(null)
const groupOpen = ref(false)

function setSort(field: string) {
  if (field === RANK_PROPERTY_ID) return updateView({ sort: undefined })
  const direction: SortRule['direction'] = sort.value.field === field ? (sort.value.direction === 'asc' ? 'desc' : 'asc') : field === 'title' ? 'asc' : 'desc'
  updateView({ sort: [{ field, direction }] })
}

function setGroup(field: string) {
  updateView({ groupBy: field ? [{ field } as GroupRule] : undefined })
  groupOpen.value = false
}

const currentLayout = computed(() => layouts.find((l) => l.layout === view.value.layout) ?? layouts[0]!)

// New: from the type's default template (lib/templates.ts); the chevron picks another, or none.
const typeTemplates = computed(() => (type.value ? templatesOf(type.value.id) : []))
const defaultTemplate = computed(() => typeTemplates.value.find((t) => t.template?.kind === 'template' && t.template.default))

async function createNew() {
  const t = type.value
  if (!t) return
  await currentTemplates()
  void createFromTemplate(t, defaultTemplate.value)
}

async function newMenu(event: MouseEvent) {
  if (!type.value) return
  const t = type.value
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  await loadTemplates()
  openMenuAt(rect.right - 224, rect.bottom + 4, [
    { label: `Blank ${t.name.toLowerCase()}`, icon: 'ph:file', run: () => createFromTemplate(t, undefined) },
    ...typeTemplates.value.map((template) => ({
      label: template.template!.name,
      icon: template === defaultTemplate.value ? 'ph:star-fill' : 'ph:copy-simple',
      ...(template === defaultTemplate.value ? { hint: 'Default' } : {}),
      run: () => createFromTemplate(t, template),
    })),
    { kind: 'separator' as const },
    { label: 'New template…', icon: 'ph:plus', run: () => newTemplate(t) },
    { label: 'Manage templates…', icon: 'ph:gear-six', run: () => (settingsOpen.value = true) },
  ])
}
</script>

<template>
  <div v-if="type" class="px-4 pb-24 pt-6 md:px-10 md:pt-10">
    <header class="flex items-center gap-3">
      <button class="grid h-10 w-10 place-items-center rounded-xl hover:ring-2 hover:ring-line" :class="chip(type.color)" title="Type settings" @click="settingsOpen = true">
        <AppIcon :icon="type.icon" fallback="ph:cube" :size="22" />
      </button>
      <h1 class="min-w-0 truncate text-2xl font-bold tracking-tight">{{ type.pluralName }}</h1>
      <span class="text-sm text-ink-faint">{{ objects.length }}</span>
      <button ref="menuAnchor" class="ml-auto rounded-lg p-2 text-ink-soft hover:bg-hover hover:text-ink" title="More" @click="menuOpen = !menuOpen">
        <AppIcon fallback="ph:dots-three" :size="18" />
      </button>
      <div class="flex shrink-0 items-stretch rounded-lg bg-ink text-sm font-medium text-surface" data-new-split>
        <button class="flex items-center gap-1.5 rounded-l-lg px-3 py-1.5 hover:opacity-90" :title="defaultTemplate ? `New ${type.name} from “${defaultTemplate.template!.name}”` : `New ${type.name}`" @click="createNew">
          <AppIcon fallback="ph:plus" /> <span class="max-sm:hidden">New {{ type.name }}</span>
        </button>
        <button class="grid place-items-center rounded-r-lg border-l border-surface/25 px-1.5 hover:opacity-90" title="Templates" aria-label="New from a template" @click="newMenu">
          <AppIcon fallback="ph:caret-down" :size="13" />
        </button>
      </div>
    </header>
    <PopoverMenu v-model:open="menuOpen" :anchor="menuAnchor" placement="bottom-end" width="15rem">
      <button class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover" @click="(settingsOpen = true), (menuOpen = false)">
        <AppIcon fallback="ph:gear-six" class="text-ink-soft" /> Type settings…
      </button>
      <button class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover" @click="pinFrom">
        <AppIcon fallback="ph:push-pin" class="text-ink-soft" /> {{ pinned ? 'Pinned in sidebar' : 'Pin to sidebar' }}
        <AppIcon fallback="ph:caret-right" :size="12" class="ml-auto text-ink-faint" />
      </button>
      <div class="my-1 border-t border-line" />
      <template v-if="!fixedActive">
      <div class="px-2.5 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-ink-faint">View “{{ view.name }}”</div>
      <button class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover" @click="renameView">
        <AppIcon fallback="ph:pencil-simple" class="text-ink-soft" /> Rename view
      </button>
      <button class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover" @click="duplicateView">
        <AppIcon fallback="ph:copy" class="text-ink-soft" /> Duplicate view
      </button>
      <button
        class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent"
        :disabled="type.views.length <= 1"
        @click="deleteView"
      >
        <AppIcon fallback="ph:trash-simple" class="text-ink-soft" /> Delete view
      </button>
      </template>
      <template v-if="!type.system">
        <div class="my-1 border-t border-line" />
        <button class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-red-600 hover:bg-hover" @click="deleteType">
          <AppIcon fallback="ph:trash" /> Delete type…
        </button>
      </template>
    </PopoverMenu>
    <TypeSettings v-if="settingsOpen" :type="type" @close="closeSettings" />
    <p v-if="type.description" class="mt-2 max-w-2xl text-sm text-ink-soft">{{ type.description }}</p>

    <div class="mt-6 flex flex-wrap items-center gap-1 border-b border-line pb-2">
      <button
        v-if="fixedView"
        class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm"
        :class="fixedActive ? 'bg-hover font-medium' : 'text-ink-soft hover:bg-hover'"
        @click="activeViewId = fixedView.id"
      >
        <AppIcon :fallback="fixedView.icon" :size="14" /> {{ fixedView.label }}
      </button>
      <button
        v-for="v in type.views"
        :key="v.id"
        class="rounded-lg px-3 py-1.5 text-sm"
        :class="v.id === view.id ? 'bg-hover font-medium' : 'text-ink-soft hover:bg-hover'"
        @click="activeViewId = v.id"
      >
        {{ v.name }}
      </button>
      <button class="rounded-lg px-2 py-1.5 text-ink-faint hover:bg-hover hover:text-ink" title="Add view" @click="addView">
        <AppIcon fallback="ph:plus" :size="14" />
      </button>
      <button
        v-if="hasMetrics"
        class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm"
        :class="metricsActive ? 'bg-hover font-medium' : 'text-ink-soft hover:bg-hover'"
        @click="activeViewId = METRICS_VIEW"
      >
        <AppIcon fallback="ph:chart-line-up" :size="14" /> Metrics
      </button>

      <div class="ml-auto flex items-center gap-1 whitespace-nowrap text-sm max-md:-mx-1 max-md:w-full max-md:overflow-x-auto [&>*]:shrink-0">
        <div class="flex items-center gap-1.5 rounded-lg px-2 py-1 text-ink-faint focus-within:bg-hover">
          <AppIcon fallback="ph:magnifying-glass" :size="14" />
          <input v-model="filterText" class="w-28 bg-transparent md:w-36 text-ink outline-none placeholder:text-ink-faint" placeholder="Filter…" />
        </div>
        <template v-if="!fixedActive">
        <button
          v-if="showMine"
          class="flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-hover"
          :class="mineOnly ? 'bg-accent/10 text-accent' : 'text-ink-soft'"
          :title="`Only what ${personProps.map((p) => p.name).join(' or ')} names you in`"
          @click="toggleMine"
        >
          <AppIcon fallback="ph:user-circle" /> Mine
        </button>
        <button
          ref="filterAnchor"
          class="flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-hover"
          :class="filterCount ? 'text-accent' : 'text-ink-soft'"
          @click="filterOpen = !filterOpen"
        >
          <AppIcon fallback="ph:funnel" /> Filter<span v-if="filterCount"> · {{ filterCount }}</span>
        </button>
        <button ref="sortAnchor" class="flex items-center gap-1 rounded-lg px-2 py-1.5 text-ink-soft hover:bg-hover" @click="sortOpen = !sortOpen">
          <AppIcon :fallback="sort.direction === 'asc' ? 'ph:sort-ascending' : 'ph:sort-descending'" />
          {{ sortFields.find((f) => f.field === sort.field)?.label }}
        </button>
        <button ref="groupAnchor" class="flex items-center gap-1 rounded-lg px-2 py-1.5 text-ink-soft hover:bg-hover" @click="groupOpen = !groupOpen">
          <AppIcon fallback="ph:rows" />
          {{ groupField ? groupFields.find((f) => f.field === groupField)?.label ?? 'Group' : 'Group' }}
        </button>
        <button v-if="view.layout === 'kanban'" ref="boardAnchor" class="flex items-center gap-1 rounded-lg px-2 py-1.5 text-ink-soft hover:bg-hover" @click="boardOpen = !boardOpen">
          <AppIcon fallback="ph:cards" /> Cards
        </button>
        <button
          v-if="view.layout === 'table'"
          ref="columnsAnchor"
          class="flex items-center gap-1 rounded-lg px-2 py-1.5 text-ink-soft hover:bg-hover"
          @click="columnsOpen = !columnsOpen"
        >
          <AppIcon fallback="ph:columns" /> Columns
        </button>
        <button ref="layoutAnchor" class="flex items-center gap-1 rounded-lg px-2 py-1.5 text-ink-soft hover:bg-hover" @click="layoutOpen = !layoutOpen">
          <AppIcon :fallback="currentLayout.icon" /> {{ currentLayout.label }}
        </button>
        </template>
      </div>
      <PopoverMenu v-model:open="filterOpen" :anchor="filterAnchor" placement="bottom-end" width="34rem">
        <div class="p-1.5">
          <FilterGroupEditor :group="filterGroup" :type-ids="[id]" @update="setFilter" />
        </div>
      </PopoverMenu>
      <PopoverMenu v-model:open="sortOpen" :anchor="sortAnchor" placement="bottom-end" width="13rem">
        <button v-for="f in sortFields" :key="f.field" class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover" @click="setSort(f.field)">
          {{ f.label }}
          <AppIcon v-if="sort.field === f.field" :fallback="sort.direction === 'asc' ? 'ph:arrow-up' : 'ph:arrow-down'" class="ml-auto text-accent" />
        </button>
      </PopoverMenu>
      <PopoverMenu v-model:open="groupOpen" :anchor="groupAnchor" placement="bottom-end" width="13rem">
        <button v-for="f in groupFields" :key="f.field" class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover" @click="setGroup(f.field)">
          {{ f.label }}
          <AppIcon v-if="groupField === f.field" fallback="ph:check" class="ml-auto text-accent" />
        </button>
      </PopoverMenu>
      <PopoverMenu v-model:open="boardOpen" :anchor="boardAnchor" placement="bottom-end" width="15rem">
        <div class="px-2.5 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Swimlanes</div>
        <select
          :value="view.board?.swimlanes ?? ''"
          class="mx-1.5 mb-2 w-[calc(100%-0.75rem)] rounded-md bg-hover px-2 py-1 text-sm outline-none"
          aria-label="Swimlanes"
          @change="setSwimlanes(($event.target as HTMLSelectElement).value)"
        >
          <option value="">None</option>
          <option v-for="f in groupFields.filter((g) => g.field && g.field !== groupField)" :key="f.field" :value="f.field">{{ f.label }}</option>
        </select>
        <div class="flex items-center px-2.5 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
          Card fields
          <button v-if="cardFieldIds" class="ml-auto normal-case tracking-normal text-ink-faint hover:text-ink" @click="resetCardFields">Automatic</button>
        </div>
        <p v-if="!cardFieldIds" class="px-2.5 pb-1 text-xs text-ink-faint">The first two with a value. Pick to choose.</p>
        <button
          v-for="p in cardFieldChoices"
          :key="p.id"
          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover"
          @click="toggleCardField(p.id)"
        >
          <AppIcon :fallback="cardFieldIds?.includes(p.id) ? 'ph:check-square-fill' : 'ph:square'" :class="cardFieldIds?.includes(p.id) ? 'text-accent' : 'text-ink-faint'" />
          {{ p.name }}
        </button>
      </PopoverMenu>
      <PopoverMenu v-model:open="columnsOpen" :anchor="columnsAnchor" placement="bottom-end" width="17rem">
        <ColumnsMenu :table="view.table" :type-ids="[id]" @update="updateView({ table: $event })" />
      </PopoverMenu>
      <PopoverMenu v-model:open="layoutOpen" :anchor="layoutAnchor" placement="bottom-end" width="11rem">
        <button
          v-for="l in layouts"
          :key="l.layout"
          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover"
          @click="updateView({ layout: l.layout }), (layoutOpen = false)"
        >
          <AppIcon :fallback="l.icon" class="text-ink-soft" /> {{ l.label }}
          <AppIcon v-if="view.layout === l.layout" fallback="ph:check" class="ml-auto text-accent" />
        </button>
      </PopoverMenu>
    </div>

    <p v-if="loading" class="py-10 text-sm text-ink-faint">Loading…</p>
    <div v-else-if="!objects.length" class="py-16 text-center text-sm text-ink-faint">
      No {{ type.pluralName.toLowerCase() }} yet.<template v-if="type.system === 'habit'"> Make one with New {{ type.name }}, then check it off each day from Today.</template
      ><template v-else> Make one with New {{ type.name }}, or press {{ keysOf('search') }} and type “/{{ type.name }}” and a title.</template>
      <TipsCard class="mx-auto mt-10 max-w-xl text-left" />
    </div>

    <FlowMetrics v-else-if="metricsActive" :type="type" />
    <TagTree v-else-if="fixedActive && type.system === 'tag'" :tags="objects" :filter="filterText" @menu="objectMenu" />
    <HabitBoard v-else-if="fixedActive && type.system === 'habit'" :habits="objects" :filter="filterText" @menu="objectMenu" />
    <p v-else-if="!visible.length" class="py-16 text-center text-sm text-ink-faint">No {{ type.pluralName.toLowerCase() }} match the filter.</p>
    <ObjectCollection
      v-else
      class="mt-6"
      :objects="visible"
      :layout="view.layout"
      :group-field="groupField"
      :type-ids="[id]"
      :table="view.table"
      :board="view.board"
      :manual="manual"
      @table="updateView({ table: $event })"
      @board="updateView({ board: $event })"
      @manual="updateView({ sort: undefined })"
      @menu="objectMenu"
      @moved="moved"
      @created="created"
    />
  </div>
  <div v-else class="grid h-full place-items-center text-sm text-ink-soft">Type not found.</div>
</template>
