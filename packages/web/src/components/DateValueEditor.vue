<script setup lang="ts">
// Date property editor: start, optional end, all-day or timed, and an optional repeat rule.
// Day values are stored at midnight UTC; timed values as instants from this device's clock.
import { computed, onMounted, ref, watch } from 'vue'
import type { DateValue } from '@vasta/core'
import { addDays } from '@vasta/core'
import { dayKey } from '../lib/actions.ts'
import { WEEKDAY_CODES, buildRepeat, describeRepeat, formatWeekday, parseRepeat, viewerTimeZone, weekdayOf, type RepeatFreq, type RepeatRule } from '../lib/calendar.ts'
import { formatDate } from '../lib/format.ts'
import AppIcon from './AppIcon.vue'
import PopoverMenu from './PopoverMenu.vue'

// `autofocus`: open the picker on mount (a table cell being edited); `close` says it was closed.
const props = defineProps<{ value: DateValue | undefined; withTime?: boolean; autofocus?: boolean }>()
const emit = defineEmits<{ update: [value: DateValue | undefined]; close: [] }>()

const anchor = ref<HTMLElement | null>(null)
const open = ref(false)
onMounted(() => props.autofocus && (open.value = true))
watch(open, (value) => !value && emit('close'))

const pad = (n: number) => String(n).padStart(2, '0')
const localDay = (iso: string) => dayKey(new Date(iso))
const localTime = (iso: string) => {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const allDay = computed(() => (props.value ? props.value.resolution === 'day' : !props.withTime))
const startDay = computed(() => (props.value ? (allDay.value ? props.value.start.slice(0, 10) : localDay(props.value.start)) : ''))
const startTime = computed(() => (props.value && !allDay.value ? localTime(props.value.start) : '09:00'))
const endDay = computed(() => (props.value?.end ? (allDay.value ? props.value.end.slice(0, 10) : localDay(props.value.end)) : ''))
const endTime = computed(() => (props.value?.end && !allDay.value ? localTime(props.value.end) : ''))

function toInstant(day: string, time: string) {
  return new Date(`${day}T${time || '00:00'}`).toISOString()
}

/** Rebuild the value from the editor's fields, keeping the repeat rule. */
function commit(fields: { allDay?: boolean; startDay?: string; startTime?: string; endDay?: string | null; endTime?: string }) {
  const day = fields.startDay ?? startDay.value
  if (!day) return emit('update', undefined)
  const isAllDay = fields.allDay ?? allDay.value
  const time = fields.startTime ?? startTime.value
  const end = fields.endDay === null ? '' : (fields.endDay ?? endDay.value)
  const rrule = props.value?.rrule
  const next: DateValue = isAllDay
    ? { start: `${day}T00:00:00.000Z`, resolution: 'day' }
    : { start: toInstant(day, time), resolution: 'time' }
  if (end) {
    const value = isAllDay ? `${end}T00:00:00.000Z` : toInstant(end, fields.endTime ?? (endTime.value || time))
    if (value > next.start) next.end = value
  }
  if (rrule) {
    next.rrule = rrule
    if (!isAllDay) next.timeZone = props.value?.timeZone ?? viewerTimeZone()
    // Occurrences changed on their own are kept while the series starts where it did.
    const exceptions = props.value?.exceptions
    if (exceptions && next.start === props.value?.start && next.resolution === props.value.resolution) next.exceptions = exceptions
  }
  emit('update', next)
}

function addEnd() {
  if (allDay.value) commit({ endDay: addDays(startDay.value, 1) })
  else {
    const start = new Date(toInstant(startDay.value, startTime.value))
    const end = new Date(start.getTime() + 3_600_000)
    commit({ endDay: dayKey(end), endTime: `${pad(end.getHours())}:${pad(end.getMinutes())}` })
  }
}

// Repeat -------------------------------------------------------------------
const rule = computed(() => parseRepeat(props.value?.rrule))
const unknownRule = computed(() => !!props.value?.rrule && !rule.value)

function setRule(next: RepeatRule | undefined) {
  if (!props.value) return
  const { rrule: _rrule, timeZone: _zone, exceptions, ...rest } = props.value
  // Without a rule there are no occurrences to have changed.
  if (!next) return emit('update', rest)
  emit('update', {
    ...rest,
    rrule: buildRepeat(next),
    ...(rest.resolution === 'time' ? { timeZone: props.value.timeZone ?? viewerTimeZone() } : {}),
    ...(exceptions ? { exceptions } : {}),
  })
}

function setFreq(freq: RepeatFreq | '') {
  if (!freq) return setRule(undefined)
  const current = rule.value
  setRule({ freq, interval: current?.interval ?? 1, byDay: freq === 'WEEKLY' ? (current?.byDay.length ? current.byDay : [WEEKDAY_CODES[weekdayOf(startDay.value)]!]) : [], ...(current?.until ? { until: current.until } : {}), ...(current?.count ? { count: current.count } : {}) })
}

function toggleWeekday(code: string) {
  if (!rule.value) return
  const has = rule.value.byDay.includes(code)
  const byDay = has ? rule.value.byDay.filter((c) => c !== code) : WEEKDAY_CODES.filter((c) => c === code || rule.value!.byDay.includes(c))
  if (byDay.length) setRule({ ...rule.value, byDay })
}

function setEnds(kind: 'never' | 'until' | 'count') {
  if (!rule.value) return
  const { until: _until, count: _count, ...base } = rule.value
  if (kind === 'until') setRule({ ...base, until: addDays(startDay.value, 30) })
  else if (kind === 'count') setRule({ ...base, count: 10 })
  else setRule(base)
}

const ends = computed(() => (rule.value?.until ? 'until' : rule.value?.count ? 'count' : 'never'))
const label = computed(() => (props.value ? formatDate(props.value) : ''))
const repeatLabel = computed(() => describeRepeat(props.value?.rrule))

function setToday() {
  commit({ startDay: dayKey() })
}
</script>

<template>
  <button ref="anchor" class="flex min-h-8 items-center gap-1.5 rounded-md px-2 py-1 text-left hover:bg-hover" @click="open = !open">
    <span v-if="value">{{ label }}</span>
    <span v-else class="text-ink-faint">Empty</span>
    <span v-if="repeatLabel" class="flex items-center gap-1 text-xs text-ink-faint"><AppIcon fallback="ph:repeat" :size="12" />{{ repeatLabel }}</span>
  </button>
  <PopoverMenu v-model:open="open" :anchor="anchor" width="19rem">
    <div class="space-y-3 p-2 text-sm">
      <div v-if="!value" class="flex gap-2">
        <button class="flex-1 rounded-lg bg-hover px-2.5 py-1.5 hover:bg-line" @click="setToday">Today</button>
        <button class="flex-1 rounded-lg bg-hover px-2.5 py-1.5 hover:bg-line" @click="commit({ startDay: addDays(dayKey(), 1) })">Tomorrow</button>
      </div>

      <label class="flex items-center justify-between">
        <span class="text-ink-soft">All day</span>
        <input type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" :checked="allDay" :disabled="!value" @change="commit({ allDay: ($event.target as HTMLInputElement).checked })" />
      </label>

      <div class="space-y-1">
        <div class="text-xs font-medium text-ink-faint">{{ value?.end ? 'Start' : 'Date' }}</div>
        <div class="flex gap-1.5">
          <input type="date" :value="startDay" class="min-w-0 flex-1 rounded-lg bg-hover px-2 py-1 outline-none" @change="commit({ startDay: ($event.target as HTMLInputElement).value })" />
          <input v-if="!allDay" type="time" :value="startTime" class="w-24 rounded-lg bg-hover px-2 py-1 outline-none" @change="commit({ startTime: ($event.target as HTMLInputElement).value })" />
        </div>
      </div>

      <div v-if="value?.end" class="space-y-1">
        <div class="flex items-center text-xs font-medium text-ink-faint">
          End
          <button class="ml-auto rounded px-1 hover:bg-hover hover:text-ink" title="Remove end" @click="commit({ endDay: null })"><AppIcon fallback="ph:x" :size="12" /></button>
        </div>
        <div class="flex gap-1.5">
          <input type="date" :value="endDay" class="min-w-0 flex-1 rounded-lg bg-hover px-2 py-1 outline-none" @change="commit({ endDay: ($event.target as HTMLInputElement).value })" />
          <input v-if="!allDay" type="time" :value="endTime" class="w-24 rounded-lg bg-hover px-2 py-1 outline-none" @change="commit({ endTime: ($event.target as HTMLInputElement).value })" />
        </div>
      </div>
      <button v-else-if="value" class="flex items-center gap-1 text-xs text-ink-faint hover:text-ink" @click="addEnd"><AppIcon fallback="ph:plus" :size="12" /> Add end</button>

      <div v-if="value" class="space-y-2 border-t border-line pt-3">
        <div class="flex items-center gap-2">
          <AppIcon fallback="ph:repeat" class="text-ink-faint" />
          <select
            :value="unknownRule ? 'custom' : (rule?.freq ?? '')"
            class="flex-1 rounded-lg bg-hover px-2 py-1 outline-none"
            @change="setFreq(($event.target as HTMLSelectElement).value as RepeatFreq | '')"
          >
            <option value="">Does not repeat</option>
            <option value="DAILY">Daily</option>
            <option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly</option>
            <option value="YEARLY">Yearly</option>
            <option v-if="unknownRule" value="custom" disabled>Custom ({{ value.rrule }})</option>
          </select>
        </div>
        <template v-if="rule">
          <label class="flex items-center gap-2 text-ink-soft">
            Every
            <input
              type="number"
              min="1"
              :value="rule.interval"
              class="w-14 rounded-lg bg-hover px-2 py-1 outline-none"
              @change="setRule({ ...rule, interval: Math.max(1, Number(($event.target as HTMLInputElement).value) || 1) })"
            />
            {{ { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[rule.freq] }}{{ rule.interval > 1 ? 's' : '' }}
          </label>
          <div v-if="rule.freq === 'WEEKLY'" class="flex gap-1">
            <button
              v-for="(code, i) in WEEKDAY_CODES"
              :key="code"
              class="h-7 flex-1 rounded-md text-xs"
              :class="rule.byDay.includes(code) ? 'bg-accent text-white' : 'bg-hover text-ink-soft hover:bg-line'"
              @click="toggleWeekday(code)"
            >
              {{ formatWeekday(addDays('2026-10-18', i)).slice(0, 2) }}
            </button>
          </div>
          <div class="flex items-center gap-2 text-ink-soft">
            Ends
            <select :value="ends" class="rounded-lg bg-hover px-2 py-1 outline-none" @change="setEnds(($event.target as HTMLSelectElement).value as 'never' | 'until' | 'count')">
              <option value="never">never</option>
              <option value="until">on</option>
              <option value="count">after</option>
            </select>
            <input
              v-if="ends === 'until'"
              type="date"
              :value="rule.until"
              class="min-w-0 flex-1 rounded-lg bg-hover px-2 py-1 outline-none"
              @change="($event.target as HTMLInputElement).value && setRule({ ...rule, until: ($event.target as HTMLInputElement).value })"
            />
            <template v-if="ends === 'count'">
              <input
                type="number"
                min="1"
                :value="rule.count"
                class="w-14 rounded-lg bg-hover px-2 py-1 outline-none"
                @change="setRule({ ...rule, count: Math.max(1, Number(($event.target as HTMLInputElement).value) || 1) })"
              />
              times
            </template>
          </div>
        </template>
      </div>

      <button v-if="value" class="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-red-600 hover:bg-hover" @click="emit('update', undefined), (open = false)">
        <AppIcon fallback="ph:trash" /> Clear date
      </button>
    </div>
  </PopoverMenu>
</template>
