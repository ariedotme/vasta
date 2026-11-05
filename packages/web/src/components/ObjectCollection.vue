<script setup lang="ts">
// A set of objects shown in one of the view layouts (list, table, wall, grid, gallery, board),
// optionally grouped. Used by type pages, query pages and queries embedded in documents.
import { computed, nextTick, ref, watch, type Directive } from 'vue'
import type { BoardSettings, Id, ObjectRecord, ObjectSummary, PropertyDef, PropertyValue, SelectOption, TableSettings, ViewLayout } from '@vasta/core'
import { addSelectOption, setProperty } from '../lib/actions.ts'
import { chip } from '../lib/colors.ts'
import { columnWidth, MIN_COLUMN_WIDTH, tableColumns, tableSettings, type Column } from '../lib/columns.ts'
import { displayTitle, formatDate, formatRelative } from '../lib/format.ts'
import { groupObjects, NO_VALUE, typesOf, type Group } from '../lib/query.ts'
import { lastError, typesById } from '../lib/state.ts'
import { objectColor } from '../lib/tags.ts'
import AppIcon from './AppIcon.vue'
import BoardView from './BoardView.vue'
import TypeIcon from './TypeIcon.vue'
import ObjectCard from './ObjectCard.vue'
import ObjectChip from './ObjectChip.vue'
import PersonChip from './PersonChip.vue'
import PropertyDisplay from './PropertyDisplay.vue'
import PropertyValueEditor from './PropertyValueEditor.vue'

const props = defineProps<{
  objects: ObjectSummary[]
  layout: ViewLayout
  /** Field to group by; '' for no grouping. */
  groupField: string
  /** Types the objects come from (empty = any); decides table columns and group labels. */
  typeIds: Id[]
  /** Columns of the table layout, as saved on the view or query. */
  table?: TableSettings
  /** The board layout's settings, and whether its cards keep their manual order (no sort chosen). */
  board?: BoardSettings
  manual?: boolean
}>()
const emit = defineEmits<{
  menu: [event: MouseEvent, object: ObjectSummary]
  moved: [object: ObjectRecord]
  created: [object: ObjectRecord]
  table: [table: TableSettings]
  board: [board: BoardSettings]
  manual: []
}>()

const types = computed(() => typesOf(props.typeIds))
const typeOf = (object: ObjectSummary) => typesById.value.get(object.typeId)
const groups = computed<Group[]>(() => groupObjects(props.objects, props.groupField, types.value))

// A group shows its first STEP objects, and more as the page scrolls to its end: drawing a type's
// thousands of objects at once takes seconds. Sorting, grouping and filters still see them all.
const STEP = 200
const drawn = ref<Record<string, number>>({})
watch([() => props.typeIds.join(), () => props.groupField], () => (drawn.value = {}))
const shown = (group: Group) => group.items.slice(0, drawn.value[group.key] ?? STEP)
const drawMore = (group: Group) => (drawn.value = { ...drawn.value, [group.key]: (drawn.value[group.key] ?? STEP) + STEP })
/** Calls its value when the element comes near the viewport (it is keyed, so it asks again after each step). */
const vNear: Directive<HTMLElement & { near?: IntersectionObserver }, () => void> = {
  mounted(el, binding) {
    if (typeof IntersectionObserver === 'undefined') return
    el.near = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && binding.value(), { rootMargin: '600px' })
    el.near.observe(el)
  },
  unmounted: (el) => el.near?.disconnect(),
}

// Table columns; a column being resized shows its new width until the settings come back saved.
const resized = ref<Record<string, number>>({})
watch(() => props.table, () => (resized.value = {}))
const columns = computed(() => tableColumns(props.table, props.typeIds).filter((c) => !c.hidden))
const widthOf = (column: Column) => resized.value[column.field] ?? columnWidth(column)
const tableWidth = computed(() => columns.value.reduce((sum, c) => sum + widthOf(c), 0))

function startResize(event: PointerEvent, column: Column) {
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(event.pointerId)
  const startX = event.clientX
  const startWidth = widthOf(column)
  const move = (e: PointerEvent) => (resized.value = { ...resized.value, [column.field]: Math.max(MIN_COLUMN_WIDTH, startWidth + e.clientX - startX) })
  const end = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', end)
    handle.removeEventListener('pointercancel', end)
    const width = resized.value[column.field]
    if (width === undefined || width === startWidth) return
    emit('table', tableSettings(tableColumns(props.table, props.typeIds).map((c) => (c.field === column.field ? { ...c, width } : c))))
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', end)
  handle.addEventListener('pointercancel', end)
}
// Editing in the table: a click anywhere on a property's cell (or Enter on it) opens its editor
// there, one cell at a time; the related objects' chips and links in it do not navigate then. In a
// query embedded in a page, presses in a cell stay out of the page editor, which would select the
// embed and lose track of the document. A value shows as soon as it is picked (`edits`) and is saved like the object page
// saves it; only the latest edit of a cell clears it, so quick changes do not flicker back.
const EDITABLE = new Set<PropertyDef['kind']>(['text', 'url', 'number', 'checkbox', 'date', 'select', 'relation', 'person'])
const editable = (column: Column) => !!column.def && EDITABLE.has(column.def.kind)
const cellKey = (object: ObjectSummary, column: Column) => `${object.id} ${column.field}`
const editing = ref('')
const edits = ref<Record<string, PropertyValue | null>>({})
const latest = new Map<string, number>()
let saves = 0
const container = ref<HTMLElement | null>(null)
const valueOf = (object: ObjectSummary, column: Column) => {
  const key = cellKey(object, column)
  return key in edits.value ? (edits.value[key] ?? undefined) : object.props[column.field]
}

function startEdit(object: ObjectSummary, column: Column) {
  if (!editable(column)) return
  // A checkbox has nothing to open: a click toggles it.
  if (column.def?.kind === 'checkbox') {
    const value = valueOf(object, column)
    void saveCell(object, column, { kind: 'checkbox', value: !(value?.kind === 'checkbox' && value.value) })
  } else editing.value = cellKey(object, column)
}

/** Editing ended; the focus goes back to the cell when nothing else took it (Enter, Escape). */
function endEdit(key: string) {
  if (editing.value !== key) return
  editing.value = ''
  void nextTick(() => {
    if (document.activeElement && document.activeElement !== document.body) return
    container.value?.querySelector<HTMLElement>(`[data-cell="${CSS.escape(key)}"]`)?.focus()
  })
}

async function saveCell(object: ObjectSummary, column: Column, value: PropertyValue | undefined) {
  const key = cellKey(object, column)
  const save = ++saves
  latest.set(key, save)
  edits.value = { ...edits.value, [key]: value ?? null }
  try {
    const saved = await setProperty(object.id, column.field, value)
    if (latest.get(key) === save) emit('moved', saved)
  } catch (error) {
    lastError.value = (error as Error).message
  } finally {
    if (latest.get(key) === save) {
      latest.delete(key)
      const { [key]: _done, ...rest } = edits.value
      edits.value = rest
    }
  }
}

function addOption(object: ObjectSummary, column: Column, option: SelectOption) {
  const type = typeOf(object)
  if (type) void addSelectOption(type, column.field, option).catch((error) => (lastError.value = (error as Error).message))
}

const cardVariant = computed(() => (props.layout === 'wall' || props.layout === 'embed' ? 'wall' : props.layout === 'gallery' ? 'gallery' : 'grid'))

</script>

<template>
  <!-- Board -->
  <BoardView
    v-if="layout === 'kanban'"
    :objects="objects"
    :group-field="groupField"
    :type-ids="typeIds"
    :board="board"
    :manual="manual ?? true"
    @menu="(event, object) => emit('menu', event, object)"
    @moved="emit('moved', $event)"
    @created="emit('created', $event)"
    @board="emit('board', $event)"
    @manual="emit('manual')"
  />

  <!-- Container queries: the same view sits in a full page or in a narrow document column. -->
  <div v-else ref="container" class="@container">
    <section v-for="group in groups" :key="group.key" class="mt-4 first:mt-0">
      <header v-if="groupField" class="mb-3 flex items-center gap-2 text-sm">
        <span v-if="group.objectId"><ObjectChip :id="group.objectId" :tag="groupField === 'tags'" /></span>
        <PersonChip v-else-if="group.personId" :id="group.personId" />
        <span v-else class="rounded-md px-2 py-0.5 font-medium" :class="group.key === NO_VALUE ? 'text-ink-faint' : chip(group.color as never)">{{ group.label }}</span>
        <span class="text-xs text-ink-faint">{{ group.items.length }}</span>
      </header>

      <!-- List -->
      <div v-if="layout === 'list'" class="divide-y divide-line/70">
        <RouterLink v-for="object in shown(group)" :key="object.id" :to="`/o/${object.id}`" class="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-hover" @contextmenu="emit('menu', $event, object)">
          <TypeIcon :icon="object.icon ?? typeOf(object)?.icon" fallback="ph:file-text" :color="objectColor(object, typeOf(object))" />
          <span class="min-w-0 flex-1 truncate font-medium">{{ displayTitle(object, typeOf(object)) }}</span>
          <span class="hidden gap-1 md:flex" @click.prevent>
            <ObjectChip v-for="id in object.tagIds.slice(0, 3)" :key="id" :id="id" tag />
          </span>
          <span class="w-24 shrink-0 text-right text-xs text-ink-faint">{{ formatRelative(object.updatedAt) }}</span>
        </RouterLink>
      </div>

      <!-- Table: fixed column widths; the last, empty column takes the space left. -->
      <div v-else-if="layout === 'table'" class="overflow-x-auto rounded-xl border border-line">
        <table class="table-fixed text-sm" :style="{ width: `max(100%, ${tableWidth}px)` }">
          <colgroup>
            <col v-for="column in columns" :key="column.field" :style="{ width: `${widthOf(column)}px` }" />
            <col />
          </colgroup>
          <thead class="bg-raised text-left text-xs text-ink-faint">
            <tr>
              <th v-for="column in columns" :key="column.field" class="relative px-3 py-2 font-medium" :data-column="column.field">
                <span class="block truncate">{{ column.field === 'title' ? 'Title' : column.label }}</span>
                <span
                  class="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none hover:bg-accent/30"
                  title="Drag to resize"
                  @pointerdown.prevent="startResize($event, column)"
                />
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="object in shown(group)" :key="object.id" class="border-t border-line hover:bg-hover/60" @contextmenu="emit('menu', $event, object)">
              <td
                v-for="column in columns"
                :key="column.field"
                class="overflow-hidden px-3 py-2 align-top"
                :class="column.wrap ? 'break-words' : 'whitespace-nowrap text-ellipsis'"
              >
                <RouterLink v-if="column.field === 'title'" :to="`/o/${object.id}`" class="font-medium hover:underline">
                  <AppIcon :icon="object.icon ?? typeOf(object)?.icon" fallback="ph:file-text" class="mr-2 inline-block align-[-2px] text-ink-soft" />{{ displayTitle(object, typeOf(object)) }}
                </RouterLink>
                <span v-else-if="column.field === 'tags' || column.field === 'collections'" class="flex gap-1" :class="column.wrap ? 'flex-wrap' : 'overflow-hidden'">
                  <ObjectChip v-for="id in column.field === 'tags' ? object.tagIds : object.collectionIds" :key="id" :id="id" :tag="column.field === 'tags'" />
                </span>
                <span v-else-if="column.field === 'type'" class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs" :class="chip(typeOf(object)?.color)">
                  <AppIcon :icon="typeOf(object)?.icon" fallback="ph:cube" :size="12" />{{ typeOf(object)?.name }}
                </span>
                <span v-else-if="column.field === 'createdAt' || column.field === 'updatedAt'" class="text-xs text-ink-faint">{{ formatRelative(object[column.field]) }}</span>
                <span v-else-if="column.field === 'date'">{{ object.date ? formatDate(object.date) : '' }}</span>
                <span v-else-if="column.field === 'host'">{{ object.media?.host?.replace(/^www\./, '') }}</span>
                <PropertyValueEditor
                  v-else-if="column.def && editing === cellKey(object, column)"
                  :def="column.def"
                  :value="valueOf(object, column)"
                  autofocus
                  class="-mx-2 -my-1.5"
                  @update="saveCell(object, column, $event)"
                  @add-option="addOption(object, column, $event)"
                  @close="endEdit(cellKey(object, column))"
                  @mousedown.stop
                />
                <div
                  v-else-if="column.def && editable(column)"
                  role="button"
                  tabindex="0"
                  class="-mx-1.5 -my-0.5 min-h-6 cursor-pointer rounded-md px-1.5 py-0.5 outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-accent/50"
                  :class="column.wrap ? '' : 'overflow-hidden'"
                  :aria-label="`${column.label}: edit`"
                  :data-edit="column.field"
                  :data-cell="cellKey(object, column)"
                  @mousedown.stop
                  @click.capture.prevent="startEdit(object, column)"
                  @keydown.enter.self.prevent="startEdit(object, column)"
                  @keydown.space.self.prevent="startEdit(object, column)"
                >
                  <PropertyDisplay :def="column.def" :value="valueOf(object, column)" :object="object" :wrap="column.wrap" />
                </div>
                <PropertyDisplay v-else-if="column.def" :def="column.def" :value="object.props[column.field]" :object="object" :wrap="column.wrap" />
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Wall: masonry columns -->
      <div v-else-if="cardVariant === 'wall'" class="columns-1 gap-3 @lg:columns-2 @4xl:columns-3 @7xl:columns-4">
        <ObjectCard v-for="object in shown(group)" :key="object.id" :object="object" :type="typeOf(object)" variant="wall" @contextmenu="emit('menu', $event, object)" />
      </div>

      <!-- Grid and gallery -->
      <div v-else class="grid gap-3" :class="cardVariant === 'gallery' ? 'grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]'">
        <ObjectCard v-for="object in shown(group)" :key="object.id" :object="object" :type="typeOf(object)" :variant="cardVariant" @contextmenu="emit('menu', $event, object)" />
      </div>

      <button
        v-if="group.items.length > shown(group).length"
        :key="shown(group).length"
        v-near="() => drawMore(group)"
        class="mt-2 w-full rounded-lg py-2 text-center text-xs text-ink-faint hover:bg-hover hover:text-ink"
        @click="drawMore(group)"
      >
        {{ shown(group).length.toLocaleString() }} of {{ group.items.length.toLocaleString() }} · Show more
      </button>
    </section>
  </div>
</template>
