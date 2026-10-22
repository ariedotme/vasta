<script setup lang="ts">
// Edits a query: which types, filters, sort, grouping and layout. Emits the whole new query.
import { computed, ref } from 'vue'
import type { FilterGroup, Id, QueryDef, SortRule, TableSettings, ViewLayout } from '@vasta/core'
import { chip } from '../lib/colors.ts'
import { fieldOptions, groupOptions } from '../lib/query.ts'
import { workspace } from '../lib/state.ts'
import AppIcon from './AppIcon.vue'
import ColumnsMenu from './ColumnsMenu.vue'
import FilterGroupEditor from './FilterGroupEditor.vue'
import PopoverMenu from './PopoverMenu.vue'

const props = defineProps<{ query: QueryDef }>()
const emit = defineEmits<{ update: [query: QueryDef] }>()

const LAYOUTS: { layout: ViewLayout; label: string; icon: string }[] = [
  { layout: 'list', label: 'List', icon: 'ph:list-dashes' },
  { layout: 'grid', label: 'Grid', icon: 'ph:grid-four' },
  { layout: 'wall', label: 'Wall', icon: 'ph:wall' },
  { layout: 'gallery', label: 'Gallery', icon: 'ph:images' },
  { layout: 'table', label: 'Table', icon: 'ph:table' },
  { layout: 'kanban', label: 'Board', icon: 'ph:kanban' },
]

const update = (patch: Partial<QueryDef>) => {
  const next: QueryDef = { ...props.query, ...patch }
  for (const key of Object.keys(patch) as (keyof QueryDef)[]) if (patch[key] === undefined) delete next[key]
  emit('update', next)
}

const types = computed(() => [...workspace.types].sort((a, b) => a.name.localeCompare(b.name)))
function toggleType(id: Id) {
  const typeIds = props.query.typeIds.includes(id) ? props.query.typeIds.filter((t) => t !== id) : [...props.query.typeIds, id]
  update({ typeIds })
}

const filter = computed<FilterGroup>(() => props.query.filter ?? { kind: 'group', operator: 'and', items: [] })
const setFilter = (group: FilterGroup) => update({ filter: group.items.length ? group : undefined })

const sortFields = computed(() => fieldOptions(props.query.typeIds).filter((f) => f.kind !== 'ids' || f.def?.kind === 'select'))
const sort = computed<SortRule | undefined>(() => props.query.sort?.[0])
function setSort(field: string) {
  update({ sort: field ? [{ field, direction: sort.value?.direction ?? (field === 'title' ? 'asc' : 'desc') }] : undefined })
}
function flipSort() {
  if (sort.value) update({ sort: [{ ...sort.value, direction: sort.value.direction === 'asc' ? 'desc' : 'asc' }] })
}

const groups = computed(() => groupOptions(props.query.typeIds))
const groupField = computed(() => props.query.groupBy?.[0]?.field ?? '')
const setGroup = (field: string) => update({ groupBy: field ? [{ field }] : undefined })

const columnsAnchor = ref<HTMLElement | null>(null)
const columnsOpen = ref(false)
const setTable = (table: TableSettings | undefined) => update({ table })

const control = 'rounded-md bg-hover px-1.5 py-1 text-sm outline-none'
</script>

<template>
  <div class="flex flex-col gap-4 text-sm">
    <section>
      <h3 class="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-faint">Types</h3>
      <div class="flex flex-wrap gap-1">
        <button
          v-for="t in types"
          :key="t.id"
          class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs"
          :class="query.typeIds.includes(t.id) ? chip(t.color) : 'text-ink-faint ring-1 ring-line hover:text-ink'"
          @click="toggleType(t.id)"
        >
          <AppIcon :icon="t.icon" fallback="ph:cube" :size="12" />{{ t.pluralName }}
        </button>
      </div>
      <p v-if="!query.typeIds.length" class="mt-1 text-xs text-ink-faint">No type chosen: the query searches every type.</p>
    </section>

    <section>
      <h3 class="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-faint">Filters</h3>
      <FilterGroupEditor :group="filter" :type-ids="query.typeIds" @update="setFilter" />
    </section>

    <section class="flex flex-wrap items-center gap-x-5 gap-y-2">
      <label class="flex items-center gap-1.5 text-ink-soft">
        Sort by
        <select :value="sort?.field ?? ''" :class="control" @change="setSort(($event.target as HTMLSelectElement).value)">
          <option value="">Newest first</option>
          <option v-for="f in sortFields" :key="f.field" :value="f.field">{{ f.label }}</option>
        </select>
        <button v-if="sort" class="rounded-md p-1 hover:bg-hover" :title="sort.direction === 'asc' ? 'Ascending' : 'Descending'" @click="flipSort">
          <AppIcon :fallback="sort.direction === 'asc' ? 'ph:sort-ascending' : 'ph:sort-descending'" />
        </button>
      </label>
      <label class="flex items-center gap-1.5 text-ink-soft">
        Group by
        <select :value="groupField" :class="control" @change="setGroup(($event.target as HTMLSelectElement).value)">
          <option value="">Nothing</option>
          <option v-for="f in groups" :key="f.field" :value="f.field">{{ f.label }}</option>
        </select>
      </label>
      <div class="flex items-center gap-0.5">
        <button
          v-for="l in LAYOUTS"
          :key="l.layout"
          class="rounded-md p-1.5"
          :class="(query.layout ?? 'list') === l.layout ? 'bg-hover text-ink' : 'text-ink-faint hover:bg-hover hover:text-ink'"
          :title="l.label"
          @click="update({ layout: l.layout })"
        >
          <AppIcon :fallback="l.icon" />
        </button>
      </div>
      <button
        v-if="query.layout === 'table'"
        ref="columnsAnchor"
        class="flex items-center gap-1 rounded-md px-1.5 py-1 text-ink-soft hover:bg-hover hover:text-ink"
        @click="columnsOpen = !columnsOpen"
      >
        <AppIcon fallback="ph:columns" /> Columns
      </button>
      <PopoverMenu v-model:open="columnsOpen" :anchor="columnsAnchor" placement="bottom-end" width="17rem">
        <ColumnsMenu :table="query.table" :type-ids="query.typeIds" @update="setTable" />
      </PopoverMenu>
    </section>
  </div>
</template>
