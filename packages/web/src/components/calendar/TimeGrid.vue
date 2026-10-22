<script setup lang="ts">
// Week, three-day and day views: an all-day row over hour columns. Timed entries are placed by
// their start and end; overlapping ones share the column width.
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { CalendarEntry, CalendarSource, Id } from '@vasta/core'
import { HOUR_HEIGHT as HOUR, formatClock, formatWeekday, instantAt, isToday, layoutBars, layoutDay, minutesInto } from '../../lib/calendar.ts'
import { drag } from '../../lib/calendar-drag.ts'
import { dayKey } from '../../lib/actions.ts'
import { isPhone } from '../../lib/viewport.ts'
import AppIcon from '../AppIcon.vue'
import CalendarEntryItem from './CalendarEntryItem.vue'

const props = defineProps<{
  days: string[]
  entriesByDay: Map<string, CalendarEntry[]>
  dailyNotes: Map<string, Id>
  sources: Map<Id, CalendarSource>
  /** A slot being created, shown as a placeholder the create popover anchors to. */
  pending?: { day: string; minutes?: number } | null
}>()
const emit = defineEmits<{
  openDay: [day: string]
  openNote: [day: string]
  create: [day: string, minutes: number | undefined]
  details: [entry: CalendarEntry, element: HTMLElement]
}>()

const hours = Array.from({ length: 24 }, (_, h) => h)
const hourFormat = new Intl.DateTimeFormat(typeof navigator !== 'undefined' ? navigator.language : 'en', { hour: 'numeric' })
const hourLabel = (h: number) => hourFormat.format(new Date(2026, 0, 5, h))

const isAllDayRow = (entry: CalendarEntry) => entry.allDay || entry.startDay !== entry.endDay
/** The all-day row: all-day and multi-day entries as bars over the days they cover. */
const allDayBars = computed(() => {
  const entries = new Map<string, CalendarEntry>()
  for (const day of props.days) for (const entry of props.entriesByDay.get(day) ?? []) if (isAllDayRow(entry)) entries.set(entry.key, entry)
  return layoutBars(props.days, [...entries.values()])
})
const allDayLanes = computed(() => Math.max(1, ...allDayBars.value.map((bar) => bar.lane + 1)))
const placed = computed(() => new Map(props.days.map((day) => [day, layoutDay(day, (props.entriesByDay.get(day) ?? []).filter((e) => !isAllDayRow(e)), 25)])))

// Current time line -----------------------------------------------------------
const now = ref(new Date())
const timer = setInterval(() => (now.value = new Date()), 60_000)
onBeforeUnmount(() => clearInterval(timer))
const nowMinutes = computed(() => now.value.getHours() * 60 + now.value.getMinutes())
const today = computed(() => dayKey(now.value))

const scroller = ref<HTMLElement | null>(null)
onMounted(async () => {
  await nextTick()
  const showsToday = props.days.includes(today.value)
  const minutes = showsToday ? Math.max(0, nowMinutes.value - 90) : 7 * 60
  scroller.value?.scrollTo({ top: (minutes / 60) * HOUR })
})

// Creating, and where a dragged entry would land ---------------------------------
const snap = (minutes: number, step: number) => Math.min(1440 - step, Math.max(0, Math.round(minutes / step) * step))

function minutesAt(event: MouseEvent, column: HTMLElement) {
  const top = column.getBoundingClientRect().top
  return ((event.clientY - top) / HOUR) * 60
}

function onColumnClick(event: MouseEvent, day: string) {
  if ((event.target as HTMLElement).closest('a, button, .vasta-entry')) return
  emit('create', day, snap(minutesAt(event, event.currentTarget as HTMLElement) - 15, 30))
}

/** Over the hours: the slot a moved entry would take, or the new end of a resized one. */
const ghost = computed(() => {
  const entry = drag.entry
  const target = drag.target
  if (!drag.active || !entry || target?.minutes === undefined) return null
  if (drag.mode === 'resize') {
    const top = minutesInto(entry.startDay, entry.start)
    return { day: entry.startDay, top, height: target.minutes - top, label: formatClock(instantAt(entry.startDay, target.minutes)) }
  }
  const length = entry.end ? Math.max(15, Math.round((Date.parse(entry.end) - Date.parse(entry.start)) / 60_000)) : 30
  return { day: target.day, top: target.minutes, height: Math.min(length, 1440 - target.minutes), label: formatClock(instantAt(target.day, target.minutes)) }
})
const dropDay = computed(() => (drag.active && drag.mode === 'move' && drag.target && drag.target.minutes === undefined ? drag.target.day : ''))

const style = (item: { top: number; height: number; column: number; columns: number }) => ({
  top: `${(item.top / 60) * HOUR}px`,
  height: `${(item.height / 60) * HOUR - 2}px`,
  left: `calc(${(item.column / item.columns) * 100}% + 2px)`,
  width: `calc(${100 / item.columns}% - 4px)`,
})

const pendingStyle = computed(() => (props.pending?.minutes !== undefined ? { top: `${(props.pending.minutes / 60) * HOUR}px`, height: `${HOUR - 2}px` } : {}))
</script>

<template>
  <div ref="scroller" class="h-full min-h-0 overflow-auto" data-drag-scroll>
    <!-- On phones the week scrolls sideways instead of squeezing seven columns into the screen. -->
    <div :style="{ minWidth: isPhone ? `${3.5 + days.length * 5.5}rem` : undefined }">
    <!-- Day headers and the all-day row stick to the top, inside the scroller so they line up with the columns. -->
    <div class="sticky top-0 z-40 border-b border-line bg-surface">
    <div class="flex">
      <div class="sticky left-0 z-10 w-14 shrink-0 bg-surface" />
      <div class="grid flex-1" :style="{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }">
        <div v-for="day in days" :key="day" class="min-w-0 overflow-hidden border-l border-line px-1 pb-1 pt-2 md:px-2">
          <div class="flex min-w-0 items-center gap-1.5">
            <button class="flex min-w-0 items-baseline gap-1.5 rounded-md px-1 hover:bg-hover" title="Open day" @click="emit('openDay', day)">
              <span class="truncate text-xs font-medium uppercase text-ink-faint">{{ formatWeekday(day) }}</span>
              <span
                class="grid h-7 min-w-7 place-items-center rounded-full text-lg tabular-nums"
                :class="isToday(day) ? 'bg-accent px-1 font-semibold text-white' : 'text-ink'"
                >{{ Number(day.slice(8)) }}</span
              >
            </button>
            <button v-if="dailyNotes.has(day)" class="rounded p-0.5 text-ink-faint hover:bg-hover hover:text-ink" title="Daily note" @click="emit('openNote', day)">
              <AppIcon fallback="ph:calendar-check" :size="14" />
            </button>
          </div>
        </div>
      </div>
    </div>
    <!-- All-day row: day cells (drop targets) under bars that span the days they cover. -->
    <div class="flex">
      <div class="sticky left-0 z-10 w-14 shrink-0 bg-surface" />
      <div class="grid flex-1 gap-y-0.5 pb-1" :style="{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${allDayLanes}, auto)` }">
        <div
          v-for="(day, i) in days"
          :key="day"
          class="min-h-7 border-l border-line"
          :class="dropDay === day ? 'bg-accent/10' : ''"
          :style="{ gridColumn: `${i + 1}`, gridRow: '1 / -1' }"
          :data-day="day"
        />
        <div
          v-for="bar in allDayBars"
          :key="bar.entry.key"
          class="vasta-bar relative min-w-0 px-1"
          :style="{ gridColumn: `${bar.column + 1} / span ${bar.span}`, gridRow: `${bar.lane + 1}` }"
        >
          <CalendarEntryItem
            :entry="bar.entry"
            variant="chip"
            :source="bar.entry.sourceId ? sources.get(bar.entry.sourceId) : undefined"
            :continued="bar.continued"
            :continues="bar.continues"
            @details="(e, el) => emit('details', e, el)"
          />
        </div>
      </div>
    </div>
    </div>

    <div class="flex" :style="{ height: `${24 * HOUR}px` }">
      <div class="sticky left-0 z-[35] w-14 shrink-0 bg-surface">
        <div v-for="h in hours.slice(1)" :key="h" class="absolute right-2 -translate-y-1/2 whitespace-nowrap text-[11px] tabular-nums text-ink-faint" :style="{ top: `${h * HOUR}px` }">
          {{ hourLabel(h) }}
        </div>
      </div>
      <div class="grid flex-1" :style="{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }">
        <div
          v-for="day in days"
          :key="day"
          class="relative min-w-0 border-l border-line"
          :data-day="day"
          data-timed
          @click="onColumnClick($event, day)"
        >
          <div v-for="h in hours" :key="h" class="pointer-events-none absolute inset-x-0 border-t border-line/70" :style="{ top: `${h * HOUR}px` }" />
          <div
            v-for="item in placed.get(day)"
            :key="item.entry.key"
            class="absolute z-10"
            :style="style(item)"
          >
            <CalendarEntryItem
              :entry="item.entry"
              :variant="item.height < 40 ? 'chip' : 'block'"
              class="h-full"
              :source="item.entry.sourceId ? sources.get(item.entry.sourceId) : undefined"
              @details="(e, el) => emit('details', e, el)"
            />
          </div>
          <div
            v-if="ghost?.day === day"
            class="vasta-drop-ghost pointer-events-none absolute inset-x-1 z-20 rounded-md border-2 border-dashed border-accent/70 bg-accent/10 px-1.5 py-0.5 text-xs font-medium tabular-nums text-accent"
            :class="drag.mode === 'resize' ? 'flex items-end' : ''"
            :style="{ top: `${(ghost.top / 60) * HOUR}px`, height: `${Math.max(15, ghost.height) / 60 * HOUR}px` }"
          >
            {{ ghost.label }}
          </div>
          <div
            v-if="pending?.day === day && pending.minutes !== undefined"
            class="vasta-pending-slot absolute inset-x-1 z-20 rounded-md bg-accent/20 px-1.5 py-1 text-xs text-accent ring-1 ring-accent/50"
            :style="pendingStyle"
          >
            {{ formatClock(instantAt(day, pending.minutes)) }}
          </div>
          <div v-if="day === today" class="pointer-events-none absolute inset-x-0 z-30 h-0.5 bg-red-500" :style="{ top: `${(nowMinutes / 60) * HOUR}px` }">
            <div class="absolute -left-1 -top-[3px] h-2 w-2 rounded-full bg-red-500" />
          </div>
        </div>
      </div>
    </div>
    </div>
  </div>
</template>
