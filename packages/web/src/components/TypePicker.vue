<script setup lang="ts">
// Filterable list of types; emits the chosen one.
import { computed, onMounted, ref } from 'vue'
import type { ObjectType } from '@vasta/core'
import { workspace } from '../lib/state.ts'
import TypeIcon from './TypeIcon.vue'

const props = defineProps<{ exclude?: string[] }>()
const emit = defineEmits<{ pick: [type: ObjectType] }>()
const filter = ref('')
const input = ref<HTMLInputElement | null>(null)
const active = ref(0)

const HIDDEN = new Set(['date', 'query', 'collection', 'image', 'pdf', 'audio', 'video', 'file'])

const types = computed(() => {
  const q = filter.value.trim().toLowerCase()
  return workspace.types
    .filter((t) => !(props.exclude ?? []).includes(t.id))
    .filter((t) => (q ? t.name.toLowerCase().includes(q) || t.pluralName.toLowerCase().includes(q) : !HIDDEN.has(t.system ?? '')))
    .sort((a, b) => (workspace.counts[b.id] ?? 0) - (workspace.counts[a.id] ?? 0) || a.name.localeCompare(b.name))
})

function onKey(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') active.value = Math.min(active.value + 1, types.value.length - 1)
  else if (event.key === 'ArrowUp') active.value = Math.max(active.value - 1, 0)
  else if (event.key === 'Enter' && types.value[active.value]) emit('pick', types.value[active.value]!)
  else return
  event.preventDefault()
}

onMounted(() => input.value?.focus())
</script>

<template>
  <div>
    <input
      ref="input"
      v-model="filter"
      class="mb-1 w-full rounded-lg bg-hover px-2.5 py-1.5 text-sm outline-none placeholder:text-ink-faint"
      placeholder="Type…"
      @input="active = 0"
      @keydown="onKey"
    />
    <button
      v-for="(type, i) in types"
      :key="type.id"
      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm"
      :class="i === active ? 'bg-hover' : 'hover:bg-hover'"
      @mouseenter="active = i"
      @click="emit('pick', type)"
    >
      <TypeIcon :icon="type.icon" fallback="ph:cube" :color="type.color" />
      <span class="truncate">{{ type.name }}</span>
    </button>
    <p v-if="!types.length" class="px-2.5 py-2 text-sm text-ink-faint">No matching type</p>
  </div>
</template>
