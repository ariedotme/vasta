<script setup lang="ts">
// The table layout's columns: show or hide each, drag to reorder, let long values wrap. The title
// stays first. Emits the whole new settings; the view or query saves them.
import { computed, ref } from 'vue'
import type { Id, TableSettings } from '@vasta/core'
import { tableColumns, tableSettings, type Column } from '../lib/columns.ts'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ table: TableSettings | undefined; typeIds: Id[] }>()
const emit = defineEmits<{ update: [table: TableSettings | undefined] }>()

const saved = computed(() => tableColumns(props.table, props.typeIds))
// While dragging, the order shown; saved on release.
const dragOrder = ref<Column[] | null>(null)
const columns = computed(() => dragOrder.value ?? saved.value)

function change(field: string, patch: Partial<Column>) {
  emit('update', tableSettings(saved.value.map((c) => (c.field === field ? { ...c, ...patch } : c))))
}

const list = ref<HTMLElement | null>(null)
const dragged = ref<string | null>(null)

function startDrag(event: PointerEvent, field: string) {
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  dragged.value = field
  dragOrder.value = [...saved.value]
}
function drag(event: PointerEvent) {
  const order = dragOrder.value
  if (!dragged.value || !order) return
  const from = order.findIndex((c) => c.field === dragged.value)
  // The row under the pointer; the title (row 0) stays first.
  const rows = [...(list.value?.querySelectorAll<HTMLElement>('[data-column]') ?? [])]
  let to = rows.findIndex((row) => {
    const rect = row.getBoundingClientRect()
    return event.clientY >= rect.top && event.clientY < rect.bottom
  })
  if (to < 0) return
  to = Math.max(1, to)
  if (to === from) return
  const next = [...order]
  next.splice(to, 0, ...next.splice(from, 1))
  dragOrder.value = next
}
function endDrag() {
  const order = dragOrder.value
  dragged.value = null
  dragOrder.value = null
  if (order && order.some((c, i) => c.field !== saved.value[i]?.field)) emit('update', tableSettings(order))
}
</script>

<template>
  <div ref="list" class="flex flex-col p-1 text-sm">
    <div class="px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Columns</div>
    <div
      v-for="(column, index) in columns"
      :key="column.field"
      class="flex items-center gap-1.5 rounded-lg px-1 py-1"
      :class="dragged === column.field ? 'bg-hover' : 'hover:bg-hover/60'"
      :data-column="column.field"
    >
      <span
        v-if="index"
        class="cursor-grab touch-none rounded p-0.5 text-ink-faint hover:text-ink active:cursor-grabbing"
        title="Drag to reorder"
        @pointerdown.prevent="startDrag($event, column.field)"
        @pointermove="drag"
        @pointerup="endDrag"
        @pointercancel="endDrag"
      >
        <AppIcon fallback="ph:dots-six-vertical" :size="14" />
      </span>
      <span v-else class="w-[18px]" />
      <AppIcon :fallback="column.icon" :size="14" class="shrink-0 text-ink-soft" />
      <span class="min-w-0 flex-1 truncate" :class="column.hidden ? 'text-ink-faint' : ''">{{ column.label }}</span>
      <button
        class="rounded p-1"
        :class="column.wrap ? 'text-accent' : 'text-ink-faint hover:text-ink'"
        :title="column.wrap ? 'Long values wrap' : 'Long values on one line'"
        @click="change(column.field, { wrap: !column.wrap })"
      >
        <AppIcon fallback="ph:arrow-u-down-left" :size="14" />
      </button>
      <button
        v-if="index"
        class="rounded p-1"
        :class="column.hidden ? 'text-ink-faint hover:text-ink' : 'text-ink-soft hover:text-ink'"
        :title="column.hidden ? 'Show column' : 'Hide column'"
        @click="change(column.field, { hidden: !column.hidden })"
      >
        <AppIcon :fallback="column.hidden ? 'ph:eye-slash' : 'ph:eye'" :size="14" />
      </button>
      <span v-else class="w-[22px]" />
    </div>
    <button
      v-if="table"
      class="mt-1 rounded-lg px-2 py-1.5 text-left text-xs text-ink-faint hover:bg-hover hover:text-ink"
      @click="emit('update', undefined)"
    >
      Reset columns
    </button>
  </div>
</template>
