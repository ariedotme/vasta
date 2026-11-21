<script setup lang="ts">
// The list layout's fields: tick each on or off, drag the ticked ones to reorder, let titles wrap.
// The title always comes first. Emits the whole new settings; the view or query saves them.
import { computed, ref } from 'vue'
import type { Id, ListSettings } from '@vasta/core'
import { listFields, listSettings, type ListField } from '../lib/columns.ts'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ list: ListSettings | undefined; typeIds: Id[] }>()
const emit = defineEmits<{ update: [list: ListSettings | undefined] }>()

const saved = computed(() => listFields(props.list, props.typeIds))
// While dragging, the order shown; saved on release.
const dragOrder = ref<ListField[] | null>(null)
const fields = computed(() => dragOrder.value ?? saved.value)

function toggle(field: string) {
  const next = saved.value.map((f) => (f.field === field ? { ...f, on: !f.on } : f))
  const index = next.findIndex((f) => f.field === field && f.on)
  if (index >= 0) next.push(...next.splice(index, 1))
  emit('update', listSettings(next, props.list?.wrap))
}

function toggleWrap() {
  const { wrap: _, ...rest } = props.list ?? {}
  const next: ListSettings = props.list?.wrap ? rest : { ...rest, wrap: true }
  emit('update', Object.keys(next).length ? next : undefined)
}

const rows = ref<HTMLElement | null>(null)
const dragged = ref<string | null>(null)

function startDrag(event: PointerEvent, field: string) {
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  dragged.value = field
  dragOrder.value = [...saved.value]
}
function drag(event: PointerEvent) {
  const order = dragOrder.value
  if (!dragged.value || !order) return
  const from = order.findIndex((f) => f.field === dragged.value)
  const count = order.filter((f) => f.on).length
  if (from < 0 || !count) return
  const elements = [...(rows.value?.querySelectorAll<HTMLElement>('[data-list-field]') ?? [])]
  const over = elements.findIndex((row) => {
    const rect = row.getBoundingClientRect()
    return event.clientY >= rect.top && event.clientY < rect.bottom
  })
  if (over < 0) return
  // Only the ticked fields, which come first, take part in the order.
  const to = Math.min(over, count - 1)
  if (to === from) return
  const next = [...order]
  next.splice(to, 0, ...next.splice(from, 1))
  dragOrder.value = next
}
function endDrag() {
  const order = dragOrder.value
  dragged.value = null
  dragOrder.value = null
  if (order && order.some((f, i) => f.field !== saved.value[i]?.field)) emit('update', listSettings(order, props.list?.wrap))
}
</script>

<template>
  <div ref="rows" class="flex flex-col p-1 text-sm">
    <div class="px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-ink-faint">Fields after the title</div>
    <div
      v-for="field in fields"
      :key="field.field"
      class="flex items-center gap-1.5 rounded-lg px-1 py-1"
      :class="dragged === field.field ? 'bg-hover' : 'hover:bg-hover/60'"
      :data-list-field="field.field"
    >
      <span
        v-if="field.on"
        class="cursor-grab touch-none rounded p-0.5 text-ink-faint hover:text-ink active:cursor-grabbing"
        title="Drag to reorder"
        @pointerdown.prevent="startDrag($event, field.field)"
        @pointermove="drag"
        @pointerup="endDrag"
        @pointercancel="endDrag"
      >
        <AppIcon fallback="ph:dots-six-vertical" :size="14" />
      </span>
      <span v-else class="w-[18px]" />
      <AppIcon :fallback="field.icon" :size="14" class="shrink-0 text-ink-soft" />
      <span class="min-w-0 flex-1 truncate" :class="field.on ? '' : 'text-ink-faint'">{{ field.label }}</span>
      <button
        class="rounded p-1"
        :class="field.on ? 'text-accent' : 'text-ink-faint hover:text-ink'"
        :title="field.on ? 'Hide field' : 'Show field'"
        :aria-pressed="field.on"
        @click="toggle(field.field)"
      >
        <AppIcon :fallback="field.on ? 'ph:check-square-fill' : 'ph:square'" :size="14" />
      </button>
    </div>
    <div class="my-1 border-t border-line" />
    <button class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-hover" :aria-pressed="!!list?.wrap" @click="toggleWrap">
      <AppIcon :fallback="list?.wrap ? 'ph:check-square-fill' : 'ph:square'" :size="14" :class="list?.wrap ? 'text-accent' : 'text-ink-faint'" />
      Wrap titles
    </button>
    <button
      v-if="list"
      class="mt-1 rounded-lg px-2 py-1.5 text-left text-xs text-ink-faint hover:bg-hover hover:text-ink"
      @click="emit('update', undefined)"
    >
      Reset to default
    </button>
  </div>
</template>
