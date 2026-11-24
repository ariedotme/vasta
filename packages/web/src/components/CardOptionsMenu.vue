<script setup lang="ts">
// Card customisation for board, gallery, grid and wall views: cover image, fit, text preview,
// property labels, card size, and which fields appear (including tags), with drag-to-reorder.
import { computed, ref } from 'vue'
import type { CardSettings, CardSize } from '@vasta/core'
import { cardFieldRows, resolveCard, toggleCardFieldId, type CardFieldOption, type CardFieldRow, type CardVariant } from '../lib/cards.ts'
import { t } from '../lib/i18n.ts'
import AppIcon from './AppIcon.vue'

const props = defineProps<{
  variant: CardVariant
  card?: CardSettings
  choices: CardFieldOption[]
}>()
const emit = defineEmits<{ patch: [patch: Partial<CardSettings>] }>()

const appearance = computed(() => resolveCard(props.variant, props.card))
const manual = computed(() => props.card?.cardFields !== undefined)
const saved = computed(() => cardFieldRows(props.choices, props.card?.cardFields))

// While dragging, the order shown; saved on release (same pointer-capture pattern as ListFieldsMenu).
const dragOrder = ref<CardFieldRow[] | null>(null)
const fields = computed(() => dragOrder.value ?? saved.value)

const sizes = computed<{ value: CardSize; label: string }[]>(() => [
  { value: 'sm', label: t('views.cardSizeSm') },
  { value: 'md', label: t('views.cardSizeMd') },
  { value: 'lg', label: t('views.cardSizeLg') },
])

function toggleField(id: string) {
  emit('patch', { cardFields: toggleCardFieldId(props.choices, props.card?.cardFields, id) })
}
function resetFields() {
  emit('patch', { cardFields: undefined })
}

const rows = ref<HTMLElement | null>(null)
const dragged = ref<string | null>(null)

function startDrag(event: PointerEvent, id: string) {
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  dragged.value = id
  dragOrder.value = [...saved.value]
}
function drag(event: PointerEvent) {
  const order = dragOrder.value
  if (!dragged.value || !order) return
  const from = order.findIndex((f) => f.id === dragged.value)
  const count = order.filter((f) => f.on).length
  if (from < 0 || !count) return
  const elements = [...(rows.value?.querySelectorAll<HTMLElement>('[data-card-field]') ?? [])]
  const over = elements.findIndex((row) => {
    const rect = row.getBoundingClientRect()
    return event.clientY >= rect.top && event.clientY < rect.bottom
  })
  if (over < 0) return
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
  if (order && order.some((f, i) => f.id !== saved.value[i]?.id)) {
    emit('patch', { cardFields: order.filter((f) => f.on).map((f) => f.id) })
  }
}
</script>

<template>
  <div class="flex flex-col text-sm">
    <!-- Size -->
    <div class="flex items-center justify-between gap-2 px-2.5 py-1.5">
      <span class="text-xs text-ink-soft">{{ t('views.cardSize') }}</span>
      <div class="flex rounded-lg bg-hover p-0.5 text-xs">
        <button
          v-for="s in sizes"
          :key="s.value"
          type="button"
          class="rounded-md px-2 py-0.5 font-medium transition"
          :class="appearance.size === s.value ? 'bg-surface text-ink shadow-xs' : 'text-ink-faint hover:text-ink'"
          :aria-pressed="appearance.size === s.value"
          @click="emit('patch', { cardSize: s.value })"
        >
          {{ s.label }}
        </button>
      </div>
    </div>

    <!-- Visual toggles -->
    <button
      type="button"
      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-hover"
      :aria-pressed="appearance.cover"
      @click="emit('patch', { cardCover: !appearance.cover })"
    >
      <AppIcon :fallback="appearance.cover ? 'ph:check-square-fill' : 'ph:square'" :class="appearance.cover ? 'text-accent' : 'text-ink-faint'" />
      {{ t('views.cardCover') }}
    </button>
    <button
      v-if="appearance.cover"
      type="button"
      class="flex w-full items-center gap-2 rounded-lg py-1.5 pl-6 pr-2.5 text-left hover:bg-hover"
      :aria-pressed="appearance.fit"
      @click="emit('patch', { cardFit: !appearance.fit })"
    >
      <AppIcon :fallback="appearance.fit ? 'ph:check-square-fill' : 'ph:square'" :class="appearance.fit ? 'text-accent' : 'text-ink-faint'" />
      {{ t('views.cardFit') }}
    </button>
    <button
      type="button"
      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-hover"
      :aria-pressed="appearance.preview"
      @click="emit('patch', { cardPreview: !appearance.preview })"
    >
      <AppIcon :fallback="appearance.preview ? 'ph:check-square-fill' : 'ph:square'" :class="appearance.preview ? 'text-accent' : 'text-ink-faint'" />
      {{ t('views.cardPreview') }}
    </button>
    <button
      type="button"
      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-hover"
      :aria-pressed="appearance.labels"
      @click="emit('patch', { cardLabels: !appearance.labels })"
    >
      <AppIcon :fallback="appearance.labels ? 'ph:check-square-fill' : 'ph:square'" :class="appearance.labels ? 'text-accent' : 'text-ink-faint'" />
      {{ t('views.cardLabels') }}
    </button>

    <!-- Fields on the card -->
    <div class="my-1 border-t border-line" />
    <div class="flex items-center px-2.5 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
      {{ t('views.cardFields') }}
      <button v-if="manual" type="button" class="ml-auto normal-case tracking-normal text-ink-faint hover:text-ink" @click="resetFields">{{ t('views.automatic') }}</button>
    </div>
    <p v-if="!manual" class="px-2.5 pb-1 text-xs text-ink-faint">{{ t('views.cardFieldsHint') }}</p>
    <div ref="rows" class="flex flex-col">
      <div
        v-for="field in fields"
        :key="field.id"
        class="flex items-center gap-1 rounded-lg px-1 py-0.5"
        :class="dragged === field.id ? 'bg-hover' : 'hover:bg-hover/60'"
        :data-card-field="field.id"
      >
        <span
          v-if="field.on"
          class="cursor-grab touch-none rounded p-0.5 text-ink-faint hover:text-ink active:cursor-grabbing"
          :title="t('views.dragToReorder')"
          @pointerdown.prevent="startDrag($event, field.id)"
          @pointermove="drag"
          @pointerup="endDrag"
          @pointercancel="endDrag"
        >
          <AppIcon fallback="ph:dots-six-vertical" :size="14" />
        </span>
        <span v-else class="w-[18px]" />
        <button type="button" class="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 pr-1.5 text-left" @click="toggleField(field.id)">
          <AppIcon :fallback="field.on ? 'ph:check-square-fill' : 'ph:square'" :class="field.on ? 'text-accent' : 'text-ink-faint'" class="shrink-0" />
          <AppIcon :fallback="field.icon" :size="14" class="shrink-0 text-ink-faint" />
          <span class="truncate">{{ field.label }}</span>
        </button>
      </div>
    </div>
  </div>
</template>
