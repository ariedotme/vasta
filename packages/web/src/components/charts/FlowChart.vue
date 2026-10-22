<script setup lang="ts">
// Cumulative flow: per day, how many items were in each status category, stacked (done at the
// bottom, then in progress, then to do). A legend names the bands and the last day labels them;
// hovering (or focusing) a day shows its counts, and the table view holds every day.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

export interface FlowDay {
  day: string
  todo: number
  doing: number
  done: number
}

const props = withDefaults(defineProps<{ days: FlowDay[]; height?: number; labels: { todo: string; doing: string; done: string }; dayLabel: (day: string) => string }>(), { height: 200 })

const BANDS = [
  { key: 'done', color: 'var(--color-flow-done)' },
  { key: 'doing', color: 'var(--color-flow-doing)' },
  { key: 'todo', color: 'var(--color-flow-todo)' },
] as const

const root = ref<HTMLElement | null>(null)
const width = ref(600)
let observer: ResizeObserver | undefined
onMounted(() => {
  observer = new ResizeObserver(([entry]) => (width.value = entry!.contentRect.width))
  if (root.value) observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())

const AXIS = 32
const RIGHT = 30
const BOTTOM = 20
const TOP = 8
const plotWidth = computed(() => Math.max(1, width.value - AXIS - RIGHT))
const plotHeight = computed(() => props.height - BOTTOM - TOP)
const total = (d: FlowDay) => d.todo + d.doing + d.done
const top = computed(() => {
  const max = Math.max(1, ...props.days.map(total))
  const power = 10 ** Math.floor(Math.log10(max))
  return [1, 2, 3, 4, 5, 6, 8, 10].map((m) => m * power).find((t) => t >= max) ?? 10 * power
})
const ticks = computed(() => [0, top.value / 2, top.value].filter((t) => Number.isInteger(t)))
const x = (i: number) => AXIS + (props.days.length > 1 ? (plotWidth.value * i) / (props.days.length - 1) : plotWidth.value / 2)
const y = (value: number) => TOP + plotHeight.value * (1 - value / top.value)

/** Each band's area: from the sum of the bands under it to that plus its own count. */
const areas = computed(() =>
  BANDS.map((band, b) => {
    const below = (d: FlowDay) => BANDS.slice(0, b).reduce((sum, other) => sum + d[other.key], 0)
    const upper = props.days.map((d, i) => `${x(i)},${y(below(d) + d[band.key])}`)
    const lower = props.days.map((d, i) => `${x(i)},${y(below(d))}`).reverse()
    return { ...band, path: `M${upper.join(' L')} L${lower.join(' L')} Z`, line: `M${upper.join(' L')}` }
  })
)
const last = computed(() => props.days[props.days.length - 1])
/** Direct labels at the right end, in each band's middle, when the band is tall enough to hold one. */
const endLabels = computed(() => {
  const day = last.value
  if (!day) return []
  let below = 0
  return BANDS.flatMap((band) => {
    const value = day[band.key]
    const middle = y(below + value / 2)
    below += value
    return y(below - value) - y(below) >= 14 ? [{ key: band.key, y: middle, text: `${value}` }] : []
  })
})
const labelEvery = computed(() => Math.max(1, Math.ceil(60 / (plotWidth.value / Math.max(1, props.days.length)))))

const active = ref<number | null>(null)
function pointer(event: PointerEvent) {
  const box = (event.currentTarget as SVGElement).getBoundingClientRect()
  const i = Math.round(((event.clientX - box.left - AXIS) / plotWidth.value) * (props.days.length - 1))
  active.value = Math.min(props.days.length - 1, Math.max(0, i))
}
function key(event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  active.value = Math.min(props.days.length - 1, Math.max(0, (active.value ?? props.days.length - 1) + (event.key === 'ArrowRight' ? 1 : -1)))
}
// Beside the crosshair, inside the plot: right of it in the left half, left of it in the right half.
const tip = computed(() => {
  const i = active.value
  const day = i === null ? undefined : props.days[i]
  if (!day || i === null) return undefined
  const left = x(i) < width.value / 2
  return { day, style: left ? { left: `${x(i) + 10}px` } : { right: `${width.value - x(i) + 10}px` } }
})
</script>

<template>
  <figure class="m-0">
    <div class="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft" aria-hidden="true">
      <span v-for="band in [...BANDS].reverse()" :key="band.key" class="inline-flex items-center gap-1.5">
        <span class="h-2.5 w-2.5 rounded-sm" :style="{ background: band.color }" />{{ labels[band.key] }}
      </span>
    </div>
    <div ref="root" class="relative w-full" :style="{ height: `${height}px` }" @pointerleave="active = null">
      <svg
        :width="width"
        :height="height"
        role="img"
        :aria-label="`Cumulative flow over ${days.length} days`"
        tabindex="0"
        class="block overflow-visible outline-none"
        @pointermove="pointer"
        @focus="active = days.length - 1"
        @blur="active = null"
        @keydown="key"
      >
        <g>
          <template v-for="tick in ticks" :key="tick">
            <line :x1="AXIS" :x2="width - RIGHT" :y1="y(tick)" :y2="y(tick)" stroke="var(--color-line)" stroke-width="1" shape-rendering="crispEdges" />
            <text :x="AXIS - 6" :y="y(tick)" text-anchor="end" dominant-baseline="middle" fill="var(--color-ink-faint)" font-size="11" class="tabular-nums">{{ tick }}</text>
          </template>
        </g>
        <path v-for="area in areas" :key="area.key" :d="area.path" :fill="area.color" fill-opacity="0.85" />
        <!-- A 2px surface gap between the bands. -->
        <path v-for="area in areas" :key="`${area.key}-edge`" :d="area.line" fill="none" stroke="var(--color-surface)" stroke-width="2" stroke-linejoin="round" />
        <!-- The last day's counts beside the bands, in ink: the legend's colors carry which is which. -->
        <text v-for="label in endLabels" :key="label.key" :x="width - RIGHT + 6" :y="label.y" dominant-baseline="middle" font-size="11" fill="var(--color-ink-soft)" class="tabular-nums">{{ label.text }}</text>
        <template v-for="(d, i) in days" :key="d.day">
          <text v-if="i % labelEvery === (days.length - 1) % labelEvery" :x="x(i)" :y="height - 4" text-anchor="middle" font-size="11" fill="var(--color-ink-faint)">{{ dayLabel(d.day) }}</text>
        </template>
        <line v-if="active !== null" :x1="x(active)" :x2="x(active)" :y1="TOP" :y2="TOP + plotHeight" stroke="var(--color-ink-soft)" stroke-width="1" />
      </svg>
      <div
        v-if="tip"
        class="pointer-events-none absolute top-2 z-10 whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-lg"
        :style="tip.style"
      >
        <div class="font-semibold text-ink">{{ dayLabel(tip.day.day) }}</div>
        <div v-for="band in [...BANDS].reverse()" :key="band.key" class="flex items-center gap-1.5 text-ink-soft">
          <span class="h-2 w-2 rounded-sm" :style="{ background: band.color }" />{{ labels[band.key] }}
          <span class="ml-auto pl-3 tabular-nums text-ink">{{ tip.day[band.key] }}</span>
        </div>
      </div>
    </div>
    <details class="mt-1 text-xs text-ink-faint">
      <summary class="cursor-pointer select-none hover:text-ink">Show as a table</summary>
      <table class="mt-1 w-full max-w-md tabular-nums">
        <thead>
          <tr class="border-b border-line text-left">
            <th class="py-0.5 pr-3 font-medium">Day</th>
            <th v-for="band in [...BANDS].reverse()" :key="band.key" class="py-0.5 pr-3 text-right font-medium">{{ labels[band.key] }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in days" :key="d.day" class="border-b border-line">
            <td class="py-0.5 pr-3 text-ink-soft">{{ dayLabel(d.day) }}</td>
            <td v-for="band in [...BANDS].reverse()" :key="band.key" class="py-0.5 pr-3 text-right text-ink">{{ d[band.key] }}</td>
          </tr>
        </tbody>
      </table>
    </details>
  </figure>
</template>
