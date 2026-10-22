<script setup lang="ts">
// Nested and/or filter groups. Emits a new group on every change; the parent decides when to save.
import type { Filter, FilterGroup, Id } from '@vasta/core'
import AppIcon from './AppIcon.vue'
import FilterRow from './FilterRow.vue'

const props = defineProps<{ group: FilterGroup; typeIds: Id[]; depth?: number }>()
const emit = defineEmits<{ update: [group: FilterGroup]; remove: [] }>()

const depth = props.depth ?? 0

function replace(index: number, item: Filter | FilterGroup) {
  emit('update', { ...props.group, items: props.group.items.map((current, i) => (i === index ? item : current)) })
}
function remove(index: number) {
  emit('update', { ...props.group, items: props.group.items.filter((_, i) => i !== index) })
}
function add(item: Filter | FilterGroup) {
  emit('update', { ...props.group, items: [...props.group.items, item] })
}
const toggleOperator = () => emit('update', { ...props.group, operator: props.group.operator === 'and' ? 'or' : 'and' })
</script>

<template>
  <div :class="depth ? 'rounded-lg border border-line bg-raised/60 p-2' : ''">
    <div v-if="group.items.length > 1 || depth" class="mb-1.5 flex items-center gap-1.5 text-xs text-ink-soft">
      Match
      <button class="rounded-md bg-hover px-1.5 py-0.5 font-medium text-ink hover:ring-1 hover:ring-line" @click="toggleOperator">
        {{ group.operator === 'and' ? 'all' : 'any' }}
      </button>
      of these
      <button v-if="depth" class="ml-auto rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink" title="Remove group" @click="emit('remove')">
        <AppIcon fallback="ph:trash-simple" :size="13" />
      </button>
    </div>
    <div class="flex flex-col gap-1.5">
      <template v-for="(item, index) in group.items" :key="index">
        <FilterGroupEditor
          v-if="item.kind === 'group'"
          :group="item"
          :type-ids="typeIds"
          :depth="depth + 1"
          @update="replace(index, $event)"
          @remove="remove(index)"
        />
        <FilterRow v-else :filter="item" :type-ids="typeIds" @update="replace(index, $event)" @remove="remove(index)" />
      </template>
    </div>
    <div class="mt-1.5 flex gap-1 text-xs">
      <button class="flex items-center gap-1 rounded-md px-1.5 py-1 text-ink-faint hover:bg-hover hover:text-ink" @click="add({ kind: 'filter', field: 'title', operator: 'contains' })">
        <AppIcon fallback="ph:plus" :size="12" /> Add filter
      </button>
      <button
        v-if="depth < 2"
        class="flex items-center gap-1 rounded-md px-1.5 py-1 text-ink-faint hover:bg-hover hover:text-ink"
        @click="add({ kind: 'group', operator: group.operator === 'and' ? 'or' : 'and', items: [{ kind: 'filter', field: 'title', operator: 'contains' }] })"
      >
        <AppIcon fallback="ph:brackets-curly" :size="12" /> Add group
      </button>
    </div>
  </div>
</template>
