<script setup lang="ts">
// Month view: whole weeks, each day listing its entries. Entries over several days are bars that
// span their days, one per week row, in lanes above the single-day entries. Click a day's number
// to open the day view, empty space to create something.
import { computed } from 'vue'
import { formatKcal } from '../../lib/nutrition.ts'
import type { CalendarEntry, CalendarSource, Id } from '@vasta/core'
import { addDays, daysBetween } from '@vasta/core'
import { formatWeekday, isToday, layoutBars, monthOf } from '../../lib/calendar.ts'
import { drag } from '../../lib/calendar-drag.ts'
import AppIcon from '../AppIcon.vue'
import CalendarEntryItem from './CalendarEntryItem.vue'

const props = defineProps<{
  days: string[]
  anchor: string
  entriesByDay: Map<string, CalendarEntry[]>
  dailyNotes: Map<string, Id>
  /** Kcal eaten on days with food logged (a space that tracks food). */
  dayKcal?: Map<string, number>
  sources: Map<Id, CalendarSource>
}>()
const emit = defineEmits<{
  openDay: [day: string]
  openNote: [day: string]
  create: [day: string, element: HTMLElement]
  details: [entry: CalendarEntry, element: HTMLElement]
}>()

/** Rows a cell shows: bar lanes plus single-day entries. */
const MAX_VISIBLE = 4
const MAX_LANES = 3
/** Height of a bar lane in pixels, and where the lanes start in a week row (below the day numbers). */
const LANE = 22
const LANES_TOP = 30

const multiDay = (entry: CalendarEntry) => entry.startDay !== entry.endDay

/** Multi-day entries of a week, once each, as bars. */
function barsOf(week: string[]) {
  const entries = new Map<string, CalendarEntry>()
  for (const day of week) for (const entry of props.entriesByDay.get(day) ?? []) if (multiDay(entry)) entries.set(entry.key, entry)
  return layoutBars(week, [...entries.values()])
}

const weeks = computed(() =>
  Array.from({ length: props.days.length / 7 }, (_, i) => {
    const days = props.days.slice(i * 7, i * 7 + 7)
    const bars = barsOf(days)
    const lanes = Math.min(MAX_LANES, bars.reduce((most, bar) => Math.max(most, bar.lane + 1), 0))
    const cells = days.map((day, column) => {
      const singles = (props.entriesByDay.get(day) ?? []).filter((e) => !multiDay(e))
      const shown = Math.max(1, MAX_VISIBLE - lanes)
      const hiddenBars = bars.filter((b) => b.lane >= lanes && b.column <= column && column < b.column + b.span).length
      return { day, singles: singles.slice(0, shown), more: hiddenBars + Math.max(0, singles.length - shown) }
    })
    return { days, bars: bars.filter((b) => b.lane < lanes), lanes, cells }
  })
)

/** Days a moved entry would cover. */
const dropDays = computed(() => {
  const entry = drag.entry
  if (!drag.active || drag.mode !== 'move' || !entry || !drag.target) return new Set<string>()
  const length = daysBetween(entry.startDay, entry.endDay)
  return new Set(Array.from({ length: length + 1 }, (_, i) => addDays(drag.target!.day, i)))
})

function onCellClick(event: MouseEvent, day: string) {
  // Only clicks on the cell's empty space create; entries and buttons handle their own.
  if ((event.target as HTMLElement).closest('a, button, .vasta-entry')) return
  emit('create', day, event.currentTarget as HTMLElement)
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="grid grid-cols-7 border-b border-line">
      <div v-for="day in weeks[0]?.days" :key="day" class="truncate px-1 py-1.5 text-xs font-medium text-ink-faint md:px-2">{{ formatWeekday(day) }}</div>
    </div>
    <div class="grid min-h-0 flex-1" :style="{ gridTemplateRows: `repeat(${weeks.length}, minmax(6.5rem, 1fr))` }">
      <div v-for="week in weeks" :key="week.days[0]" class="relative grid min-h-0 grid-cols-7 border-b border-line last:border-b-0">
        <div
          v-for="cell in week.cells"
          :key="cell.day"
          class="group/cell flex min-h-0 min-w-0 cursor-default flex-col gap-0.5 overflow-hidden border-r border-line p-1 last:border-r-0"
          :class="[monthOf(cell.day) !== monthOf(anchor) ? 'bg-canvas/60' : '', dropDays.has(cell.day) ? 'bg-accent/10' : '']"
          :data-day="cell.day"
          @click="onCellClick($event, cell.day)"
        >
          <div class="flex h-6 shrink-0 items-center gap-1">
            <button
              class="grid h-6 min-w-6 place-items-center rounded-full px-1 text-xs tabular-nums"
              :class="isToday(cell.day) ? 'bg-accent font-semibold text-white' : monthOf(cell.day) !== monthOf(anchor) ? 'text-ink-faint hover:bg-hover' : 'text-ink-soft hover:bg-hover'"
              title="Open day"
              @click="emit('openDay', cell.day)"
            >
              {{ Number(cell.day.slice(8)) }}
            </button>
            <button
              v-if="dailyNotes.has(cell.day)"
              class="rounded p-0.5 text-ink-faint hover:bg-hover hover:text-ink"
              title="Daily note"
              @click="emit('openNote', cell.day)"
            >
              <AppIcon fallback="ph:calendar-check" :size="13" />
            </button>
            <span v-if="dayKcal?.has(cell.day)" class="text-[11px] tabular-nums text-ink-faint" :title="`${formatKcal(dayKcal.get(cell.day)!)} kcal eaten`" data-day-kcal>{{ formatKcal(dayKcal.get(cell.day)!) }}</span>
            <button
              class="ml-auto hidden rounded p-0.5 text-ink-faint hover:bg-hover hover:text-ink group-hover/cell:block"
              title="New on this day"
              @click="emit('create', cell.day, ($event.currentTarget as HTMLElement).closest('.group\\/cell') as HTMLElement)"
            >
              <AppIcon fallback="ph:plus" :size="13" />
            </button>
          </div>
          <!-- Room for the bars laid over the week. -->
          <div v-if="week.lanes" class="shrink-0" :style="{ height: `${week.lanes * LANE - 2}px` }" />
          <CalendarEntryItem
            v-for="entry in cell.singles"
            :key="entry.key"
            :entry="entry"
            variant="chip"
            :source="entry.sourceId ? sources.get(entry.sourceId) : undefined"
            @details="(e, el) => emit('details', e, el)"
          />
          <button
            v-if="cell.more"
            class="shrink-0 rounded px-1.5 text-left text-xs text-ink-faint hover:bg-hover hover:text-ink"
            @click="emit('openDay', cell.day)"
          >
            {{ cell.more }} more
          </button>
        </div>
        <div class="pointer-events-none absolute inset-x-0" :style="{ top: `${LANES_TOP}px` }">
          <div
            v-for="bar in week.bars"
            :key="bar.entry.key"
            class="vasta-bar pointer-events-auto absolute h-5"
            :style="{ top: `${bar.lane * LANE}px`, left: `calc(${(bar.column / 7) * 100}% + 3px)`, width: `calc(${(bar.span / 7) * 100}% - 6px)` }"
          >
            <CalendarEntryItem
              :entry="bar.entry"
              variant="chip"
              class="h-full"
              :source="bar.entry.sourceId ? sources.get(bar.entry.sourceId) : undefined"
              :continued="bar.continued"
              :continues="bar.continues"
              @details="(e, el) => emit('details', e, el)"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
