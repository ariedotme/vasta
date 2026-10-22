<script setup lang="ts">
// Live results of a query, laid out as the query says. Re-runs when the query changes and when
// objects change anywhere (debounced), so embedded queries stay current.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { BoardSettings, Id, ObjectSummary, QueryDef, TableSettings } from '@vasta/core'
import { pinMenu } from '../lib/actions.ts'
import { onChange } from '../lib/events.ts'
import { displayTitle } from '../lib/format.ts'
import { openContextMenu } from '../lib/overlays.ts'
import { runServerQuery } from '../lib/query.ts'
import { primeSummaries, typesById } from '../lib/state.ts'
import ObjectCollection from './ObjectCollection.vue'

const props = defineProps<{ query: QueryDef; parentId?: Id; limit?: number }>()
const emit = defineEmits<{ table: [table: TableSettings]; board: [board: BoardSettings] }>()

const results = ref<ObjectSummary[]>([])
const loading = ref(true)
const failed = ref(false)
const showAll = ref(false)
let seq = 0

async function load() {
  const mine = ++seq
  try {
    const list = await runServerQuery(props.query, props.parentId)
    if (mine !== seq) return
    primeSummaries(list)
    results.value = list
    failed.value = false
  } catch {
    if (mine === seq) failed.value = true
  } finally {
    if (mine === seq) loading.value = false
  }
}

watch(() => [JSON.stringify(props.query), props.parentId], () => void load(), { immediate: true })

let timer: ReturnType<typeof setTimeout> | undefined
const stop = onChange((event) => {
  // Typing in the page that embeds the query saves it constantly; that alone changes no results.
  if (event.kind !== 'object' || event.id === props.parentId) return
  clearTimeout(timer)
  timer = setTimeout(() => void load(), 400)
})
onBeforeUnmount(() => {
  stop()
  clearTimeout(timer)
})

const shown = computed(() => (props.limit && !showAll.value ? results.value.slice(0, props.limit) : results.value))

function moved(saved: ObjectSummary) {
  const index = results.value.findIndex((o) => o.id === saved.id)
  if (index >= 0) results.value[index] = { ...saved, preview: results.value[index]!.preview }
  void load()
}

const router = useRouter()

function objectMenu(event: MouseEvent, object: ObjectSummary) {
  openContextMenu(event, [
    { kind: 'heading', label: displayTitle(object, typesById.value.get(object.typeId)) },
    { label: 'Open', icon: 'ph:arrow-square-out', run: () => router.push(`/o/${object.id}`) },
    pinMenu(object.id),
  ])
}

defineExpose({ count: computed(() => results.value.length) })
</script>

<template>
  <div>
    <p v-if="loading" class="py-3 text-sm text-ink-faint">Loading…</p>
    <p v-else-if="failed" class="py-3 text-sm text-red-600">Could not run this query.</p>
    <p v-else-if="!results.length" class="py-3 text-sm text-ink-faint">No objects match this query.</p>
    <template v-else>
      <ObjectCollection
        :objects="shown"
        :layout="query.layout ?? 'list'"
        :group-field="query.groupBy?.[0]?.field ?? ''"
        :type-ids="query.typeIds"
        :table="query.table"
        :board="query.board"
        :manual="!query.sort?.length"
        @table="emit('table', $event)"
        @board="emit('board', $event)"
        @moved="moved({ ...$event, preview: '' })"
        @menu="objectMenu"
      />
      <button v-if="limit && results.length > limit && !showAll" class="mt-2 text-xs text-ink-faint hover:text-ink" @click="showAll = true">
        Show all {{ results.length }}
      </button>
    </template>
  </div>
</template>
