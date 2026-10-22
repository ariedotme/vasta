<script setup lang="ts">
// Search box listing objects, optionally limited to some types, with a "create" entry.
import { computed, onMounted, ref, watch } from 'vue'
import type { Id, ObjectSummary } from '@vasta/core'
import { api } from '../lib/api.ts'
import { displayTitle } from '../lib/format.ts'
import { primeSummaries, typesById, workspace } from '../lib/state.ts'
import { objectColor } from '../lib/tags.ts'
import AppIcon from './AppIcon.vue'
import TypeIcon from './TypeIcon.vue'

const props = defineProps<{ typeIds?: Id[]; exclude?: Id[]; createLabel?: string }>()
const emit = defineEmits<{ pick: [object: ObjectSummary]; create: [title: string] }>()

const query = ref('')
const found = ref<ObjectSummary[]>([])
const active = ref(0)
const input = ref<HTMLInputElement | null>(null)
let seq = 0

const allowed = (o: ObjectSummary) => (!props.typeIds?.length || props.typeIds.includes(o.typeId)) && !props.exclude?.includes(o.id)

async function load() {
  const mine = ++seq
  let list: ObjectSummary[]
  if (!query.value.trim() && props.typeIds?.length) {
    list = (await Promise.all(props.typeIds.slice(0, 4).map((id) => api.objectsOfType(id)))).flat()
  } else {
    list = workspace.space ? await api.search(workspace.space.id, query.value, 40) : []
  }
  if (mine !== seq) return
  primeSummaries(list)
  found.value = list.filter(allowed).slice(0, 30)
  active.value = 0
}

const rows = computed(() => [
  ...found.value.map((object) => ({ kind: 'object' as const, object })),
  ...(query.value.trim() ? [{ kind: 'create' as const, title: query.value.trim() }] : []),
])

function choose(index: number) {
  const row = rows.value[index]
  if (!row) return
  if (row.kind === 'object') emit('pick', row.object)
  else emit('create', row.title)
  query.value = ''
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') active.value = Math.min(active.value + 1, rows.value.length - 1)
  else if (event.key === 'ArrowUp') active.value = Math.max(active.value - 1, 0)
  else if (event.key === 'Enter') choose(active.value)
  else return
  event.preventDefault()
}

let timer: ReturnType<typeof setTimeout> | undefined
watch(query, () => {
  clearTimeout(timer)
  timer = setTimeout(load, 120)
})
onMounted(() => {
  void load()
  input.value?.focus()
})
</script>

<template>
  <div>
    <input
      ref="input"
      v-model="query"
      class="mb-1 w-full rounded-lg bg-hover px-2.5 py-1.5 text-sm outline-none placeholder:text-ink-faint"
      placeholder="Search…"
      @keydown="onKey"
    />
    <button
      v-for="(row, i) in rows"
      :key="i"
      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm"
      :class="i === active ? 'bg-hover' : ''"
      @mouseenter="active = i"
      @click="choose(i)"
    >
      <template v-if="row.kind === 'object'">
        <TypeIcon :icon="row.object.icon ?? typesById.get(row.object.typeId)?.icon" fallback="ph:file-text" :color="objectColor(row.object, typesById.get(row.object.typeId))" />
        <span class="truncate">{{ displayTitle(row.object, typesById.get(row.object.typeId)) }}</span>
      </template>
      <template v-else>
        <AppIcon fallback="ph:plus-circle" class="text-accent" />
        <span class="truncate">{{ createLabel ?? 'Create' }} “{{ row.title }}”</span>
      </template>
    </button>
    <p v-if="!rows.length" class="px-2.5 py-2 text-sm text-ink-faint">Nothing found</p>
  </div>
</template>
