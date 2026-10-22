<script setup lang="ts">
// The calendar's Day view, which is also Today: what is scheduled that day, its daily note
// (edited in place, with what refers to the day), and what was created that day.
import { computed, provide } from 'vue'
import type { CalendarEntry, CalendarSource, Id, ObjectSummary } from '@vasta/core'
import { ENTRY_DRAGGING } from '../../lib/calendar-drag.ts'
import { formatClock, isToday, isoWeek } from '../../lib/calendar.ts'
import { displayTitle } from '../../lib/format.ts'
import { typesById } from '../../lib/state.ts'
import ObjectPage from '../../views/ObjectPage.vue'
import AppIcon from '../AppIcon.vue'
import TipsCard from '../TipsCard.vue'
import TypeIcon from '../TypeIcon.vue'
import CalendarEntryItem from './CalendarEntryItem.vue'
import HabitChecklist from '../HabitChecklist.vue'
import FoodDay from '../nutrition/FoodDay.vue'

const props = defineProps<{
  day: string
  noteId?: Id | undefined
  entries: CalendarEntry[]
  sources: Map<Id, CalendarSource>
  created: ObjectSummary[]
  /** The daily note is being made. */
  starting?: boolean
  /** Show the day's habits here (when the calendar's side column, which has them, is hidden). */
  habits?: boolean
}>()
const emit = defineEmits<{ details: [entry: CalendarEntry, element: HTMLElement]; create: [element: HTMLElement]; 'start-note': [] }>()

// A list is no place to drag entries to another day or time.
provide(ENTRY_DRAGGING, { movable: () => false, resizable: () => false, drop: () => {} })

const locale = typeof navigator !== 'undefined' ? navigator.language : 'en'
const weekday = computed(() => new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${props.day}T00:00:00.000Z`)))
const date = computed(() => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${props.day}T00:00:00.000Z`)))

/** All-day entries first, then by time. */
const scheduled = computed(() => [...props.entries].sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start)))
const heading = 'flex items-center gap-2 text-sm font-semibold text-ink-soft'
</script>

<template>
  <div class="mx-auto max-w-3xl px-6 pb-32 pt-8 md:px-10 md:pt-12">
    <div class="flex items-center gap-2 text-sm font-medium">
      <span class="text-accent first-letter:uppercase">{{ weekday }}</span>
      <span v-if="isToday(day)" class="rounded-md bg-accent/10 px-1.5 py-0.5 text-xs text-accent">Today</span>
    </div>
    <h1 class="mt-1 flex flex-wrap items-baseline gap-x-3 text-[1.8rem] font-bold leading-tight tracking-tight md:text-[2.1rem]">
      <span>{{ date }}</span>
      <span class="text-sm font-normal tracking-normal text-ink-faint">Week {{ isoWeek(day) }}</span>
    </h1>

    <TipsCard v-if="isToday(day)" class="mt-6" />
    <HabitChecklist v-if="habits" :day="day" variant="inline" class="mt-8" />
    <FoodDay :key="day" :day="day" class="mt-8" />

    <section class="mt-8">
      <div class="mb-2 flex items-center">
        <h2 :class="heading"><AppIcon fallback="ph:clock" /> On this day</h2>
        <button class="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-soft ring-1 ring-line hover:bg-hover hover:text-ink max-md:py-1.5" @click="emit('create', $event.currentTarget as HTMLElement)">
          <AppIcon fallback="ph:plus" :size="13" /> Add
        </button>
      </div>
      <p v-if="!scheduled.length" class="rounded-lg border border-dashed border-line px-3 py-3 text-sm text-ink-faint">Nothing scheduled. Tasks due, dated objects and events show here.</p>
      <div v-else class="space-y-1">
        <div v-for="entry in scheduled" :key="entry.key" class="flex items-stretch gap-3">
          <span class="w-14 shrink-0 pt-1 text-right text-xs tabular-nums text-ink-faint">{{ entry.allDay ? 'All day' : formatClock(entry.start) }}</span>
          <div class="min-w-0 flex-1 text-sm">
            <CalendarEntryItem :entry="entry" variant="block" :source="sources.get(entry.sourceId ?? '')" @details="(e, el) => emit('details', e, el)" />
          </div>
        </div>
      </div>
    </section>

    <section class="mt-10">
      <div class="mb-3 flex items-center">
        <h2 :class="heading"><AppIcon fallback="ph:calendar-check" /> Daily note</h2>
        <RouterLink v-if="noteId" :to="`/o/${noteId}`" class="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-faint hover:bg-hover hover:text-ink">
          Open <AppIcon fallback="ph:arrow-up-right" :size="12" />
        </RouterLink>
      </div>
      <ObjectPage v-if="noteId" :id="noteId" :key="noteId" embedded backlinks-title="References to this day" />
      <button
        v-else
        class="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink-soft ring-1 ring-line hover:bg-hover hover:text-ink"
        :disabled="starting"
        @click="emit('start-note')"
      >
        <AppIcon fallback="ph:plus" /> {{ starting ? 'Starting…' : 'Start the daily note' }}
      </button>
    </section>

    <section v-if="created.length" class="mt-10">
      <h2 :class="heading" class="mb-2"><AppIcon fallback="ph:sparkle" /> Created on this day <span class="font-normal text-ink-faint">{{ created.length }}</span></h2>
      <RouterLink v-for="object in created" :key="object.id" :to="`/o/${object.id}`" class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-hover">
        <TypeIcon :icon="object.icon ?? typesById.get(object.typeId)?.icon" fallback="ph:file-text" :color="typesById.get(object.typeId)?.color" />
        <span class="min-w-0 flex-1 truncate">{{ displayTitle(object, typesById.get(object.typeId)) }}</span>
        <span class="shrink-0 text-xs text-ink-faint">{{ typesById.get(object.typeId)?.name }}</span>
      </RouterLink>
    </section>
  </div>
</template>
