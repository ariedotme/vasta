<script setup lang="ts">
// The bar above a board's selection: what can be done to what is selected, by kind (color,
// shape, label, title, open), and to any selection (front, back, duplicate, delete).
import { computed, ref } from 'vue'
import { SHAPES, type BoardElement, type ColorName, type ShapeName } from '@vasta/core'
import { BOARD_COLORS, PICKER_COLORS, SHAPE_ICONS, SHAPE_LABELS } from '../../lib/whiteboard.ts'
import AppIcon from '../AppIcon.vue'

const props = defineProps<{ elements: BoardElement[]; x: number; y: number; below: boolean }>()
const emit = defineEmits<{
  color: [color: ColorName | undefined]
  shape: [shape: ShapeName]
  front: []
  back: []
  duplicate: []
  remove: []
  label: []
  rename: []
  open: []
}>()

const open = ref<'color' | 'shape' | null>(null)
const colorable = computed(() => props.elements.some((e) => e.kind !== 'card'))
const shapes = computed(() => props.elements.length > 0 && props.elements.every((e) => e.kind === 'shape'))
const single = computed(() => (props.elements.length === 1 ? props.elements[0] : undefined))
const current = computed(() => {
  const colors = new Set(props.elements.filter((e) => e.kind !== 'card').map((e) => ('color' in e ? e.color : undefined)))
  return colors.size === 1 ? [...colors][0] : undefined
})
const currentShape = computed(() => (shapes.value ? (props.elements[0] as { shape: ShapeName }).shape : 'rectangle'))

const toggle = (menu: 'color' | 'shape') => (open.value = open.value === menu ? null : menu)
const button = 'grid h-8 w-8 place-items-center rounded-lg text-ink-soft hover:bg-hover hover:text-ink'
</script>

<template>
  <div
    data-ui
    class="absolute z-[5] flex -translate-x-1/2 items-center gap-0.5 rounded-xl border border-line bg-surface p-1 shadow-md"
    :class="below ? '' : '-translate-y-full'"
    :style="{ left: `${x}px`, top: `${y}px` }"
    @pointerdown.stop
    @dblclick.stop
  >
    <div v-if="colorable" class="relative">
      <button :class="button" title="Color" aria-label="Color" @click="toggle('color')">
        <span class="h-4 w-4 rounded-full border border-line-strong" :style="{ background: current ? BOARD_COLORS[current] : 'var(--color-ink)' }" />
      </button>
      <div v-if="open === 'color'" class="absolute left-0 top-full mt-1.5 grid w-max grid-cols-5 gap-1 rounded-xl border border-line bg-surface p-1.5 shadow-md">
        <button class="grid h-7 w-7 place-items-center rounded-md hover:bg-hover" title="Default" @click="(emit('color', undefined), (open = null))">
          <span class="h-4 w-4 rounded-full border border-line-strong bg-ink" />
        </button>
        <button v-for="c in PICKER_COLORS" :key="c" class="grid h-7 w-7 place-items-center rounded-md hover:bg-hover" :title="c" @click="(emit('color', c), (open = null))">
          <span class="h-4 w-4 rounded-full" :class="current === c ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface' : ''" :style="{ background: BOARD_COLORS[c] }" />
        </button>
      </div>
    </div>
    <div v-if="shapes" class="relative">
      <button :class="button" title="Shape" aria-label="Shape" @click="toggle('shape')"><AppIcon :fallback="SHAPE_ICONS[currentShape]" :size="17" /></button>
      <div v-if="open === 'shape'" class="absolute left-0 top-full mt-1.5 flex w-max gap-0.5 rounded-xl border border-line bg-surface p-1 shadow-md">
        <button v-for="s in SHAPES" :key="s" :class="[button, s === currentShape ? 'bg-hover text-ink' : '']" :title="SHAPE_LABELS[s]" @click="(emit('shape', s), (open = null))">
          <AppIcon :fallback="SHAPE_ICONS[s]" :size="17" />
        </button>
      </div>
    </div>
    <button v-if="single?.kind === 'card'" :class="button" title="Open" aria-label="Open" @click="emit('open')"><AppIcon fallback="ph:arrow-square-out" :size="17" /></button>
    <button v-if="single?.kind === 'arrow'" :class="button" title="Label (Enter)" aria-label="Label" @click="emit('label')"><AppIcon fallback="ph:tag-simple" :size="17" /></button>
    <button v-if="single?.kind === 'frame'" :class="button" title="Rename (Enter)" aria-label="Rename" @click="emit('rename')"><AppIcon fallback="ph:pencil-simple" :size="17" /></button>
    <span v-if="colorable || shapes || single?.kind === 'card' || single?.kind === 'arrow' || single?.kind === 'frame'" class="mx-0.5 h-5 w-px bg-line" />
    <button :class="button" title="Bring to front (])" aria-label="Bring to front" @click="emit('front')"><AppIcon fallback="ph:arrow-line-up" :size="17" /></button>
    <button :class="button" title="Send to back ([)" aria-label="Send to back" @click="emit('back')"><AppIcon fallback="ph:arrow-line-down" :size="17" /></button>
    <button :class="button" title="Duplicate (⌘D)" aria-label="Duplicate" @click="emit('duplicate')"><AppIcon fallback="ph:copy" :size="17" /></button>
    <button :class="button" title="Delete" aria-label="Delete" @click="emit('remove')"><AppIcon fallback="ph:trash" :size="17" /></button>
  </div>
</template>
