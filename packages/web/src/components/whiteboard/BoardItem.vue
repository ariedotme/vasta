<script setup lang="ts">
// One element of a whiteboard drawn in its box (board coordinates; the canvas scales the layer).
// Text of text, shapes and notes is edited in place: the canvas says which one is being edited
// and holds the draft.
import { computed } from 'vue'
import type { ObjectSummary, ObjectType, PlacedElement } from '@vasta/core'
import { STICKY_INK, fillColor, hasPressure, shapePath, stickyColor, strokeColor, strokePath } from '../../lib/whiteboard.ts'
import ObjectCard from '../ObjectCard.vue'

const props = defineProps<{
  element: PlacedElement
  box: { x: number; y: number; w: number; h: number }
  zoom: number
  selected: boolean
  editing: boolean
  faded?: boolean
  summary?: ObjectSummary
  type?: ObjectType
}>()
const draft = defineModel<string>('draft', { default: '' })
const emit = defineEmits<{ input: [el: HTMLTextAreaElement]; commit: []; editor: [el: HTMLTextAreaElement | null] }>()

const e = computed(() => props.element)
const line = computed(() => Math.max(1.5, 1.5 / Math.max(props.zoom, 0.5)))
const path = computed(() => {
  const el = e.value
  if (el.kind === 'shape') return shapePath(el.shape, props.box.w, props.box.h, line.value)
  if (el.kind === 'stroke') return strokePath(el.points, el.size, { sx: props.box.w / el.sw, sy: props.box.h / el.sh, pen: hasPressure(el.points) })
  return ''
})
/** A stroke is hit only on its ink, not on the empty part of its box. */
const passThrough = computed(() => e.value.kind === 'stroke' || e.value.kind === 'frame')
const edge = computed(() => `${10 / props.zoom}px`)
const textClass = computed(() => {
  const kind = e.value.kind
  if (kind === 'shape') return 'grid place-items-center text-center px-3'
  if (kind === 'sticky') return 'p-3 text-[15px]'
  return 'p-1'
})
const textColor = computed(() => {
  const el = e.value
  if (el.kind === 'sticky') return STICKY_INK
  return (el.kind === 'text' || el.kind === 'shape') && el.color ? strokeColor(el.color) : undefined
})
const text = computed(() => ('text' in e.value ? e.value.text : ''))

/** In a shape the text sits in the middle, so its editor grows with what is typed. */
function grow(el: HTMLTextAreaElement) {
  if (e.value.kind !== 'shape') return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, props.box.h)}px`
}
function setEditor(el: HTMLTextAreaElement | null) {
  if (el) grow(el)
  emit('editor', el)
}
function onInput(event: Event) {
  const el = event.target as HTMLTextAreaElement
  grow(el)
  emit('input', el)
}
</script>

<template>
  <div
    :data-element="passThrough ? undefined : element.id"
    class="absolute"
    :class="[passThrough ? 'pointer-events-none' : '', faded ? 'opacity-25' : '']"
    :style="{ left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` }"
    @click.capture.prevent
    @dragstart.prevent
  >
    <!-- Object card -->
    <template v-if="element.kind === 'card'">
      <ObjectCard v-if="summary" :object="summary" :type="type" variant="grid" class="pointer-events-none h-full" />
      <div v-else class="grid h-full place-items-center rounded-xl border border-dashed border-line-strong bg-surface text-sm text-ink-faint">Loading…</div>
    </template>

    <!-- Pen stroke: only its ink takes the pointer -->
    <svg v-else-if="element.kind === 'stroke'" class="absolute inset-0 overflow-visible" :width="box.w" :height="box.h">
      <path
        :d="path"
        :data-element="element.id"
        :fill="strokeColor(element.color ?? (element.highlight ? 'yellow' : undefined))"
        :fill-opacity="element.highlight ? 0.4 : 1"
        style="pointer-events: visiblePainted"
      />
    </svg>

    <!-- Frame: a titled outline; it is picked by its title or its edges, so what is inside stays reachable -->
    <template v-else-if="element.kind === 'frame'">
      <div class="absolute inset-0 rounded-xl border border-line-strong" :style="{ background: element.color ? fillColor(element.color, 8) : 'color-mix(in srgb, var(--color-surface) 45%, transparent)' }" />
      <div
        :data-element="element.id"
        class="pointer-events-auto absolute left-0 max-w-full origin-bottom-left truncate whitespace-nowrap pb-1 text-ink-soft"
        :style="{ bottom: '100%', fontSize: `${13 / zoom}px` }"
      >
        {{ element.title?.trim() || 'Frame' }}
      </div>
      <div :data-element="element.id" class="pointer-events-auto absolute inset-x-0 top-0" :style="{ height: edge }" />
      <div :data-element="element.id" class="pointer-events-auto absolute inset-x-0 bottom-0" :style="{ height: edge }" />
      <div :data-element="element.id" class="pointer-events-auto absolute inset-y-0 left-0" :style="{ width: edge }" />
      <div :data-element="element.id" class="pointer-events-auto absolute inset-y-0 right-0" :style="{ width: edge }" />
    </template>

    <!-- Text, shapes and sticky notes -->
    <template v-else>
      <svg v-if="element.kind === 'shape'" class="absolute inset-0 overflow-visible" :width="box.w" :height="box.h">
        <path :d="path" :fill="fillColor(element.color)" :stroke="strokeColor(element.color)" :stroke-width="line" stroke-linejoin="round" />
      </svg>
      <div
        v-else-if="element.kind === 'sticky'"
        class="absolute inset-0 rounded-sm shadow-[0_1px_2px_rgba(0,0,0,0.12),0_6px_16px_-8px_rgba(0,0,0,0.25)]"
        :style="{ background: stickyColor(element.color) }"
      />
      <div v-if="editing" class="relative h-full w-full" :class="element.kind === 'shape' ? 'grid place-items-center px-3' : ''">
        <textarea
          :ref="(el) => setEditor(el as HTMLTextAreaElement | null)"
          v-model="draft"
          rows="1"
          class="w-full resize-none overflow-hidden bg-transparent text-[15px] leading-snug text-ink outline-none"
          :class="element.kind === 'shape' ? 'text-center' : element.kind === 'sticky' ? 'h-full p-3' : 'h-full p-1'"
          :style="{ color: textColor }"
          :placeholder="element.kind === 'text' ? 'Text' : ''"
          @input="onInput"
          @blur="emit('commit')"
        />
      </div>
      <div
        v-else
        class="relative h-full w-full overflow-hidden whitespace-pre-wrap break-words text-[15px] leading-snug text-ink"
        :class="textClass"
        :style="{ color: textColor }"
      >
        <span>{{ text }}</span>
      </div>
    </template>

    <div
      v-if="selected"
      class="pointer-events-none absolute border-accent"
      :class="element.kind === 'card' ? 'rounded-[14px]' : 'rounded-md'"
      :style="{ inset: `${-4 / zoom}px`, borderWidth: `${2 / zoom}px` }"
    />
  </div>
</template>
