<script setup lang="ts">
// A column chart of one series over time (a value per day, per week…), with an optional target
// per column drawn as a hairline across its slot. Columns past their target take the "over" color;
// the tooltip (hover or keyboard focus) says so in words, and the table view below holds every
// value. Built to be reused (nutrition now, work-tracking metrics later); colors are the
// --color-chart tokens in style.css. One series: no legend, the heading names it.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

export interface Bar {
  key: string
  /** Under the column ("Mon", "12"). */
  label: string
  /** The tooltip's heading ("Monday 12 Oct"). */
  title: string
  value: number
  target?: number
  /** Past its target (shown in the "over" color, and said in the tooltip). */
  over?: boolean
  /** Shown faded (a day that does not count). */
  faded?: boolean
  /** A line under the value in the tooltip. */
  note?: string
}

const props = withDefaults(defineProps<{ bars: Bar[]; height?: number; format?: (value: number) => string; unit?: string; label: string }>(), {
  height: 168,
  format: (value: number) => String(Math.round(value)),
  unit: '',
})

const root = ref<HTMLElement | null>(null)
const width = ref(600)
let observer: ResizeObserver | undefined
onMounted(() => {
  observer = new ResizeObserver(([entry]) => (width.value = entry!.contentRect.width))
  if (root.value) observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())

const AXIS = 40
const BOTTOM = 20
const TOP = 8
const plot = computed(() => ({ left: AXIS, width: Math.max(1, width.value - AXIS), height: props.height - BOTTOM - TOP }))

/** A clean top for the y axis (its half a clean number too), at or above the highest value or target. */
const top = computed(() => {
  const max = Math.max(1, ...props.bars.map((b) => Math.max(b.value, b.target ?? 0)))
  const power = 10 ** Math.floor(Math.log10(max))
  // Some room above the highest, so a target there is not lost in the top gridline.
  return [1, 2, 3, 4, 5, 6, 8, 10].map((m) => m * power).find((t) => t >= max * 1.1) ?? 10 * power
})
const ticks = computed(() => [0, top.value / 2, top.value])
const y = (value: number) => TOP + plot.value.height * (1 - Math.min(value, top.value) / top.value)
const compact = (value: number) => (value >= 1000 ? `${Math.round(value / 100) / 10}k`.replace('.0k', 'k') : String(Math.round(value)))

const slot = computed(() => plot.value.width / Math.max(1, props.bars.length))
const barWidth = computed(() => Math.max(2, Math.min(24, slot.value - 2)))
/** Every nth label, so they don't run into each other. */
const labelEvery = computed(() => Math.max(1, Math.ceil(30 / slot.value)))

/** A column with a 4px rounded top, square at the baseline. */
function column(index: number, value: number): string {
  const x = AXIS + slot.value * index + (slot.value - barWidth.value) / 2
  const base = TOP + plot.value.height
  const h = Math.max(0, base - y(value))
  if (h <= 0) return ''
  const r = Math.min(4, h, barWidth.value / 2)
  const w = barWidth.value
  return `M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + w - r} Q${x + w},${base - h} ${x + w},${base - h + r} V${base} Z`
}

const active = ref<number | null>(null)
const tip = computed(() => {
  const index = active.value
  const bar = index === null ? undefined : props.bars[index]
  if (!bar || index === null) return undefined
  const center = AXIS + slot.value * (index + 0.5)
  return { bar, left: Math.min(Math.max(center, 80), width.value - 80), top: Math.max(0, y(Math.max(bar.value, bar.target ?? 0)) - 8) }
})
</script>

<template>
  <figure class="m-0">
    <div ref="root" class="relative w-full" :style="{ height: `${height}px` }" @pointerleave="active = null">
      <svg :width="width" :height="height" role="img" :aria-label="label" class="block overflow-visible">
        <g class="text-ink-faint">
          <template v-for="tick in ticks" :key="tick">
            <line :x1="AXIS" :x2="width" :y1="y(tick)" :y2="y(tick)" stroke="var(--color-line)" stroke-width="1" shape-rendering="crispEdges" />
            <text :x="AXIS - 6" :y="y(tick)" text-anchor="end" dominant-baseline="middle" fill="currentColor" font-size="11" class="tabular-nums">{{ compact(tick) }}</text>
          </template>
        </g>
        <g v-for="(bar, index) in bars" :key="bar.key">
          <path
            :d="column(index, bar.value)"
            :fill="bar.over ? 'var(--color-chart-over)' : 'var(--color-chart)'"
            :opacity="(bar.faded ? 0.35 : 1) * (active === null || active === index ? 1 : 0.55)"
          />
          <line
            v-if="bar.target"
            :x1="AXIS + slot * index + slot * 0.12"
            :x2="AXIS + slot * (index + 0.88)"
            :y1="y(bar.target)"
            :y2="y(bar.target)"
            stroke="var(--color-ink-soft)"
            stroke-width="1.5"
            stroke-linecap="round"
          />
          <text
            v-if="index % labelEvery === (bars.length - 1) % labelEvery"
            :x="AXIS + slot * (index + 0.5)"
            :y="height - 4"
            text-anchor="middle"
            font-size="11"
            fill="var(--color-ink-faint)"
          >
            {{ bar.label }}
          </text>
          <!-- The hit target: the whole slot, taller than the column. -->
          <rect
            :x="AXIS + slot * index"
            :y="0"
            :width="slot"
            :height="height - BOTTOM"
            fill="transparent"
            tabindex="0"
            class="outline-none"
            :aria-label="`${bar.title}: ${format(bar.value)}${unit}${bar.target ? ` of ${format(bar.target)}${unit}` : ''}`"
            @pointerenter="active = index"
            @focus="active = index"
            @blur="active = null"
          />
        </g>
      </svg>
      <div
        v-if="tip"
        class="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs shadow-lg"
        :style="{ left: `${tip.left}px`, top: `${tip.top}px` }"
      >
        <div class="font-semibold tabular-nums text-ink">
          {{ format(tip.bar.value) }}{{ unit }}<span v-if="tip.bar.target" class="font-normal text-ink-faint"> of {{ format(tip.bar.target) }}{{ unit }}</span>
        </div>
        <div class="text-ink-soft">{{ tip.bar.title }}</div>
        <div v-if="tip.bar.note" class="text-ink-faint">{{ tip.bar.note }}</div>
      </div>
    </div>
    <details class="mt-1 text-xs text-ink-faint">
      <summary class="cursor-pointer select-none hover:text-ink">Show as a table</summary>
      <table class="mt-1 w-full max-w-sm tabular-nums">
        <tbody>
          <tr v-for="bar in bars" :key="bar.key" class="border-b border-line">
            <td class="py-0.5 pr-3 text-ink-soft">{{ bar.title }}</td>
            <td class="py-0.5 pr-3 text-right text-ink">{{ format(bar.value) }}{{ unit }}</td>
            <td class="py-0.5 text-right">{{ bar.target ? `${format(bar.target)}${unit}` : '' }}</td>
          </tr>
        </tbody>
      </table>
    </details>
  </figure>
</template>
