<script setup lang="ts">
// A status type's flow (core metrics.ts, worked out by the server from the activity): how much got
// done, how long it took (cycle: started → done; lead: created → done), how work moved day by day
// (cumulative flow) and what has been sitting longest. It reaches back only as far as the space
// keeps activity.
import { computed, ref, watch } from 'vue'
import type { FlowMetrics, ObjectType } from '@vasta/core'
import { addDays } from '@vasta/core'
import { dayKey } from '../lib/actions.ts'
import { api } from '../lib/api.ts'
import { locale, t } from '../lib/i18n.ts'
import AppIcon from './AppIcon.vue'
import BarChart, { type Bar } from './charts/BarChart.vue'
import FlowChart from './charts/FlowChart.vue'
import ObjectLink from './ObjectLink.vue'

const props = defineProps<{ type: ObjectType }>()

const RANGES = computed(() => [
  { days: 14, label: t('metrics.twoWeeks') },
  { days: 30, label: t('metrics.days', { days: 30 }) },
  { days: 90, label: t('metrics.days', { days: 90 }) },
])
const range = ref(30)
const metrics = ref<(FlowMetrics & { retentionDays: number }) | null>(null)
const failed = ref('')
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

async function load() {
  const to = dayKey()
  try {
    metrics.value = await api.typeMetrics(props.type.id, addDays(to, -(range.value - 1)), to, timeZone)
    failed.value = ''
  } catch (error) {
    failed.value = (error as Error).message
  }
}
watch(() => [props.type.id, range.value], load, { immediate: true })

const short = computed(() => new Intl.DateTimeFormat(locale.value, { day: 'numeric', month: 'short', timeZone: 'UTC' }))
const dayLabel = (day: string) => short.value.format(new Date(`${day}T00:00:00Z`))
const daysText = (value: number | undefined) =>
  value === undefined ? '—' : value * 24 < 1 ? '< 1 h' : value < 1 ? `${Math.round(value * 24)} h` : `${Math.round(value * 10) / 10} d`

const done = computed(() => metrics.value?.throughput.reduce((sum, w) => sum + w.done, 0) ?? 0)
const bars = computed<Bar[]>(() =>
  (metrics.value?.throughput ?? []).map((w) => ({ key: w.week, label: dayLabel(w.week), title: t('metrics.weekOf', { date: dayLabel(w.week) }), value: w.done }))
)
/** Open items, the longest in their status first; past the usual cycle time (its 85th percentile) they stand out. */
const aging = computed(() => {
  const m = metrics.value
  if (!m) return []
  const now = Date.now()
  return m.items
    .filter((i) => i.category !== 'done')
    .map((i) => ({ ...i, age: (now - Date.parse(i.since)) / 86_400_000 }))
    .sort((a, b) => b.age - a.age)
    .slice(0, 10)
})
const late = (age: number) => metrics.value?.cycle.p85 !== undefined && age > metrics.value.cycle.p85
const labels = computed(() => ({ todo: t('builtin.opt.status.todo'), doing: t('builtin.opt.status.doing'), done: t('builtin.opt.status.done') }))
/** The flow from the first day anything existed (at least the last week of the range). */
const flowDays = computed(() => {
  const days = metrics.value?.flow ?? []
  const first = days.findIndex((d) => d.todo + d.doing + d.done > 0)
  return days.slice(Math.min(first < 0 ? days.length : first, Math.max(0, days.length - 7)))
})
const retention = computed(() => metrics.value?.retentionDays ?? 0)
</script>

<template>
  <div class="mt-6 space-y-8">
    <div class="flex flex-wrap items-center gap-2">
      <div class="inline-flex rounded-lg bg-hover p-0.5 text-sm">
        <button v-for="r in RANGES" :key="r.days" class="rounded-md px-3 py-1" :class="range === r.days ? 'bg-surface font-medium shadow-sm' : 'text-ink-soft'" @click="range = r.days">{{ r.label }}</button>
      </div>
      <span v-if="retention && retention < range" class="text-xs text-ink-faint">{{ t('metrics.retentionNote', { days: retention }) }}</span>
    </div>
    <p v-if="failed" class="text-sm text-red-600">{{ failed }}</p>
    <template v-else-if="metrics">
      <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div class="rounded-xl border border-line p-3">
          <div class="text-xs text-ink-faint">{{ t('builtin.opt.status.done') }}</div>
          <div class="mt-1 text-2xl font-semibold tabular-nums">{{ done }}</div>
          <div class="text-xs text-ink-faint">{{ t('metrics.inDays', { days: range }) }}</div>
        </div>
        <div class="rounded-xl border border-line p-3">
          <div class="text-xs text-ink-faint">{{ t('metrics.cycleTime') }}</div>
          <div class="mt-1 text-2xl font-semibold tabular-nums">{{ daysText(metrics.cycle.median) }}</div>
          <div class="text-xs text-ink-faint">{{ metrics.cycle.p85 !== undefined ? t('metrics.within85', { value: daysText(metrics.cycle.p85) }) : t('metrics.startedToDone') }}</div>
        </div>
        <div class="rounded-xl border border-line p-3">
          <div class="text-xs text-ink-faint">{{ t('metrics.leadTime') }}</div>
          <div class="mt-1 text-2xl font-semibold tabular-nums">{{ daysText(metrics.lead.median) }}</div>
          <div class="text-xs text-ink-faint">{{ metrics.lead.p85 !== undefined ? t('metrics.within85', { value: daysText(metrics.lead.p85) }) : t('metrics.createdToDone') }}</div>
        </div>
        <div class="rounded-xl border border-line p-3">
          <div class="text-xs text-ink-faint">{{ t('builtin.opt.status.doing') }}</div>
          <div class="mt-1 text-2xl font-semibold tabular-nums">{{ metrics.wip }}</div>
          <div class="text-xs text-ink-faint">{{ t('metrics.now') }}</div>
        </div>
      </div>

      <section>
        <h3 class="mb-2 text-sm font-semibold">{{ t('metrics.donePerWeek') }}</h3>
        <BarChart :bars="bars" :label="t('metrics.donePerWeek')" :height="150" />
      </section>

      <section>
        <h3 class="mb-2 text-sm font-semibold">{{ t('metrics.cumulativeFlow') }}</h3>
        <p class="mb-2 text-xs text-ink-faint">{{ t('metrics.cumulativeFlowHint') }}</p>
        <FlowChart :days="flowDays" :labels="labels" :day-label="dayLabel" />
      </section>

      <section>
        <h3 class="mb-2 text-sm font-semibold">{{ t('metrics.waitingLongest') }}</h3>
        <p v-if="!aging.length" class="text-sm text-ink-faint">{{ t('metrics.nothingOpen') }}</p>
        <ul v-else class="divide-y divide-line rounded-xl border border-line">
          <li v-for="item in aging" :key="item.id" class="flex items-center gap-3 px-3 py-2 text-sm">
            <ObjectLink :id="item.id" class="min-w-0 flex-1 truncate hover:underline">{{ item.title || t('common.untitled') }}</ObjectLink>
            <span class="text-xs text-ink-faint">{{ labels[item.category] }}</span>
            <span class="w-20 text-right tabular-nums" :class="late(item.age) ? 'font-medium text-amber-700 dark:text-amber-400' : 'text-ink-soft'" :title="late(item.age) ? t('metrics.lateTooltip') : undefined">
              <AppIcon v-if="late(item.age)" fallback="ph:warning" :size="12" class="mr-0.5 inline" />{{ daysText(item.age) }}
            </span>
          </li>
        </ul>
      </section>
    </template>
    <p v-else class="text-sm text-ink-faint">{{ t('common.loading') }}</p>
  </div>
</template>
