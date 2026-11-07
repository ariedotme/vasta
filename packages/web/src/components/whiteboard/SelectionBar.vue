<script setup lang="ts">
// The bar above a board's selection: what can be done to what is selected, by kind (color,
// shape, label, title, open), and to any selection (front, back, duplicate, delete).
import { computed, ref, watch } from 'vue'
import { ARROW_TIPS, SHAPES, arrowDashPatch, arrowTips, arrowTipsPatch, lineDash, type ArrowElement, type ArrowPath, type ArrowTip, type BoardElement, type BoardPatch, type CardView, type ColorName, type Dash, type ShapeName, type Side, type TipSize } from '@vasta/core'
import { BOARD_COLORS, PICKER_COLORS, SHAPE_ICONS, SHAPE_LABELS } from '../../lib/whiteboard.ts'
import AppIcon from '../AppIcon.vue'

/** `linkable`: the selection is one arrow between two cards (it can become a relation). */
const props = defineProps<{ elements: BoardElement[]; x: number; y: number; below: boolean; linkable?: boolean }>()
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
  drawOn: []
  view: [view: CardView]
  arrowStyle: [patch: BoardPatch]
  link: [event: MouseEvent]
}>()

const open = ref<'color' | 'shape' | 'view' | 'arrow' | null>(null)
const arrows = computed(() => props.elements.length > 0 && props.elements.every((e) => e.kind === 'arrow'))
const firstArrow = computed(() => (arrows.value ? (props.elements[0] as ArrowElement) : undefined))
const tips = computed(() => arrowTips(firstArrow.value ?? {}))
const TIP_ICONS: Record<ArrowTip, string> = { arrow: 'ph:caret-right-fill', dot: 'ph:circle-fill', none: 'ph:minus' }
const TIP_LABELS: Record<ArrowTip, string> = { arrow: 'Arrow', dot: 'Dot', none: 'Nothing' }
const DASHES: { id: Dash | undefined; label: string }[] = [
  { id: undefined, label: 'Solid' },
  { id: 'dashed', label: 'Dashed' },
  { id: 'dotted', label: 'Dotted' },
]
const WIDTHS: { id: number | undefined; label: string }[] = [
  { id: 1, label: 'Thin' },
  { id: undefined, label: 'Regular' },
  { id: 4, label: 'Thick' },
]
const TIP_SIZES: { id: TipSize | undefined; label: string }[] = [
  { id: 'sm', label: 'S' },
  { id: undefined, label: 'M' },
  { id: 'lg', label: 'L' },
]
const SIDES: { id: Side | undefined; label: string }[] = [
  { id: undefined, label: 'Auto' },
  { id: 'top', label: 'Top' },
  { id: 'right', label: 'Right' },
  { id: 'bottom', label: 'Bottom' },
  { id: 'left', label: 'Left' },
]
const setTip = (end: 'start' | 'end', tip: ArrowTip) => emit('arrowStyle', arrowTipsPatch(end === 'start' ? tip : tips.value.start, end === 'end' ? tip : tips.value.end))
const PATHS: { id: ArrowPath; label: string; icon: string }[] = [
  { id: 'straight', label: 'Straight', icon: 'ph:line-segment' },
  { id: 'curved', label: 'Curved', icon: 'ph:bezier-curve' },
  { id: 'elbow', label: 'Right angles', icon: 'ph:arrow-elbow-right' },
]
const cards = computed(() => props.elements.length > 0 && props.elements.every((e) => e.kind === 'card'))
const currentView = computed<CardView>(() => (cards.value ? ((props.elements[0] as { view?: CardView }).view ?? 'card') : 'card'))
const VIEWS: { id: CardView; label: string; icon: string }[] = [
  { id: 'card', label: 'Card', icon: 'ph:cards' },
  { id: 'compact', label: 'One line', icon: 'ph:rows' },
  { id: 'embed', label: 'Contents (a query’s results, the text)', icon: 'ph:article' },
]
const colorable = computed(() => props.elements.some((e) => e.kind !== 'card'))
const shapes = computed(() => props.elements.length > 0 && props.elements.every((e) => e.kind === 'shape'))
const single = computed(() => (props.elements.length === 1 ? props.elements[0] : undefined))
const current = computed(() => {
  const colors = new Set(props.elements.filter((e) => e.kind !== 'card').map((e) => ('color' in e ? e.color : undefined)))
  return colors.size === 1 ? [...colors][0] : undefined
})
const currentShape = computed(() => (shapes.value ? (props.elements[0] as { shape: ShapeName }).shape : 'rectangle'))

// A menu left open closes when the selection changes.
watch(
  () => props.elements.map((e) => e.id).join(),
  () => (open.value = null)
)
const toggle = (menu: 'color' | 'shape' | 'view' | 'arrow') => (open.value = open.value === menu ? null : menu)
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
    <button
      v-if="single && single.kind !== 'arrow' && single.kind !== 'stroke' && single.kind !== 'text'"
      :class="button"
      title="Draw on it: the strokes move and resize with it"
      aria-label="Draw on it"
      @click="emit('drawOn')"
    >
      <AppIcon fallback="ph:pen-nib" :size="17" />
    </button>
    <div v-if="cards" class="relative">
      <button :class="button" title="How the card shows its object" aria-label="Card view" @click="toggle('view')">
        <AppIcon :fallback="VIEWS.find((v) => v.id === currentView)!.icon" :size="17" />
      </button>
      <div v-if="open === 'view'" class="absolute left-0 top-full mt-1.5 w-max rounded-xl border border-line bg-surface p-1 shadow-md">
        <button
          v-for="v in VIEWS"
          :key="v.id"
          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover"
          :class="v.id === currentView ? 'text-accent' : 'text-ink'"
          @click="(emit('view', v.id), (open = null))"
        >
          <AppIcon :fallback="v.icon" :size="16" />{{ v.label }}
        </button>
      </div>
    </div>
    <div v-if="arrows" class="relative">
      <button :class="button" title="Line: course, ends, dashes" aria-label="Line style" @click="toggle('arrow')">
        <AppIcon :fallback="PATHS.find((p) => p.id === (firstArrow?.path ?? 'straight'))!.icon" :size="17" />
      </button>
      <div v-if="open === 'arrow'" class="absolute left-0 top-full mt-1.5 w-64 space-y-2 rounded-xl border border-line bg-surface p-2 text-xs shadow-md">
        <div class="flex gap-0.5">
          <button
            v-for="p in PATHS"
            :key="p.id"
            :class="[button, (firstArrow?.path ?? 'straight') === p.id ? 'bg-hover text-ink' : '']"
            :title="p.label"
            @click="emit('arrowStyle', { path: p.id === 'straight' ? undefined : p.id, bend: undefined })"
          >
            <AppIcon :fallback="p.icon" :size="17" />
          </button>
        </div>
        <div v-for="end in ['start', 'end'] as const" :key="end" class="flex items-center gap-1">
          <span class="w-12 text-ink-soft">{{ end === 'start' ? 'Start' : 'End' }}</span>
          <button
            v-for="t in ARROW_TIPS"
            :key="t"
            :class="[button, tips[end] === t ? 'bg-hover text-ink' : '']"
            :title="TIP_LABELS[t]"
            @click="setTip(end, t)"
          >
            <AppIcon :fallback="TIP_ICONS[t]" :size="t === 'dot' ? 10 : 14" :class="end === 'start' && t === 'arrow' ? 'rotate-180' : ''" />
          </button>
          <span class="ml-auto flex gap-0.5">
            <button v-for="z in TIP_SIZES" v-show="end === 'end'" :key="z.label" class="h-7 w-6 rounded-md hover:bg-hover" :class="firstArrow?.tipSize === z.id ? 'bg-hover text-ink' : 'text-ink-soft'" :title="`Tip size ${z.label}`" @click="emit('arrowStyle', { tipSize: z.id })">{{ z.label }}</button>
          </span>
        </div>
        <div class="flex gap-1">
          <button v-for="d in DASHES" :key="d.label" class="h-7 flex-1 rounded-md hover:bg-hover" :class="firstArrow && lineDash(firstArrow) === d.id ? 'bg-hover text-ink' : 'text-ink-soft'" @click="emit('arrowStyle', arrowDashPatch(d.id))">{{ d.label }}</button>
        </div>
        <div class="flex gap-1">
          <button v-for="w in WIDTHS" :key="w.label" class="h-7 flex-1 rounded-md hover:bg-hover" :class="firstArrow?.width === w.id ? 'bg-hover text-ink' : 'text-ink-soft'" @click="emit('arrowStyle', { width: w.id })">{{ w.label }}</button>
        </div>
        <div v-for="end in ['fromSide', 'toSide'] as const" :key="end" class="flex items-center gap-1">
          <span class="w-12 shrink-0 text-ink-soft">{{ end === 'fromSide' ? 'Leaves' : 'Arrives' }}</span>
          <select
            class="h-7 min-w-0 flex-1 rounded-md bg-hover px-1.5 text-ink outline-none"
            :value="firstArrow?.[end] ?? ''"
            @change="emit('arrowStyle', { [end]: (($event.target as HTMLSelectElement).value || undefined) as Side | undefined, bend: undefined })"
          >
            <option v-for="side in SIDES" :key="side.label" :value="side.id ?? ''">{{ side.label }}</option>
          </select>
        </div>
      </div>
    </div>
    <button v-if="linkable" :class="button" title="Link the objects (a relation)" aria-label="Link the objects" @click="((open = null), emit('link', $event))"><AppIcon fallback="ph:link-simple" :size="17" /></button>
    <button v-if="single?.kind === 'card'" :class="button" title="Open" aria-label="Open" @click="emit('open')"><AppIcon fallback="ph:arrow-square-out" :size="17" /></button>
    <button v-if="single?.kind === 'arrow'" :class="button" title="Label (Enter)" aria-label="Label" @click="emit('label')"><AppIcon fallback="ph:tag-simple" :size="17" /></button>
    <button v-if="single?.kind === 'frame'" :class="button" title="Rename (Enter)" aria-label="Rename" @click="emit('rename')"><AppIcon fallback="ph:pencil-simple" :size="17" /></button>
    <span v-if="colorable || shapes || cards || linkable || arrows || single?.kind === 'card' || single?.kind === 'arrow' || single?.kind === 'frame' || single?.kind === 'shape' || single?.kind === 'sticky'" class="mx-0.5 h-5 w-px bg-line" />
    <button :class="button" title="Bring to front (])" aria-label="Bring to front" @click="emit('front')"><AppIcon fallback="ph:arrow-line-up" :size="17" /></button>
    <button :class="button" title="Send to back ([)" aria-label="Send to back" @click="emit('back')"><AppIcon fallback="ph:arrow-line-down" :size="17" /></button>
    <button :class="button" title="Duplicate (⌘D)" aria-label="Duplicate" @click="emit('duplicate')"><AppIcon fallback="ph:copy" :size="17" /></button>
    <button :class="button" title="Delete" aria-label="Delete" @click="emit('remove')"><AppIcon fallback="ph:trash" :size="17" /></button>
  </div>
</template>
