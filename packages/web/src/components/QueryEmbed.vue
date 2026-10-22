<script setup lang="ts">
// A saved query embedded in a document: its live results, and its settings on demand. Editing
// here changes the query object itself, so every page embedding it follows.
import { computed, onBeforeUnmount, ref } from 'vue'
import type { Id, QueryDef } from '@vasta/core'
import { api } from '../lib/api.ts'
import { displayTitle } from '../lib/format.ts'
import { primeFromObject, summaryOf, typesById } from '../lib/state.ts'
import AppIcon from './AppIcon.vue'
import QueryEditor from './QueryEditor.vue'
import QueryResults from './QueryResults.vue'

const props = defineProps<{ objectId: Id; parentId?: Id }>()

const summary = computed(() => summaryOf(props.objectId))
const type = computed(() => typesById.value.get(summary.value?.typeId ?? ''))
const query = computed<QueryDef>(() => draft.value ?? summary.value?.query ?? { typeIds: [] })
// A query that selects nothing yet (just created) opens its settings.
const editing = ref(!summary.value?.query?.typeIds.length && !summary.value?.query?.filter)
const draft = ref<QueryDef | null>(null)

let timer: ReturnType<typeof setTimeout> | undefined
function edit(next: QueryDef) {
  draft.value = next
  clearTimeout(timer)
  timer = setTimeout(save, 500)
}
async function save() {
  clearTimeout(timer)
  const query = draft.value
  if (!query) return
  const object = await api.object(props.objectId)
  const saved = await api.saveObject({ ...object, query })
  primeFromObject(saved)
  // Keep a newer draft made while saving; the next save sends it.
  if (draft.value === query) draft.value = null
}
onBeforeUnmount(() => void save())
</script>

<template>
  <div class="vasta-ui rounded-xl border border-line bg-surface">
    <header class="flex items-center gap-2 px-3 py-2" data-drag-handle>
      <AppIcon :icon="summary?.icon ?? type?.icon" fallback="ph:funnel" class="text-ink-soft" />
      <RouterLink :to="`/o/${objectId}`" class="truncate text-sm font-semibold hover:underline">{{ displayTitle(summary, type) }}</RouterLink>
      <button
        class="ml-auto flex items-center gap-1 rounded-md px-1.5 py-1 text-xs"
        :class="editing ? 'bg-hover text-ink' : 'text-ink-faint hover:bg-hover hover:text-ink'"
        @click="editing = !editing"
      >
        <AppIcon fallback="ph:sliders-horizontal" :size="13" /> {{ editing ? 'Done' : 'Edit query' }}
      </button>
    </header>
    <div v-if="editing" class="border-t border-line px-3 py-3">
      <QueryEditor :query="query" @update="edit" />
    </div>
    <div class="border-t border-line px-3 py-3">
      <QueryResults :query="query" :parent-id="parentId" :limit="24" @table="edit({ ...query, table: $event })" @board="edit({ ...query, board: $event })" />
    </div>
  </div>
</template>
