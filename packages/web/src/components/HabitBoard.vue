<script setup lang="ts">
// The Habits page's Tracker view: one row per habit, the last two weeks (one on phones) to check
// off, and each habit's streak and last-30-days rate. Paused habits sit at the bottom, faded.
import { computed, toRef } from 'vue'
import { addDays, habitStats, habitTarget, habitUnit, isHabitDone, isHabitPaused, isHabitScheduled, type ObjectSummary } from '@vasta/core'
import { dayKey } from '../lib/actions.ts'
import { swatchClasses } from '../lib/colors.ts'
import { habitColor, useFoodHabits } from '../lib/habits.ts'
import { isPhone } from '../lib/viewport.ts'
import AppIcon from './AppIcon.vue'
import HabitCheck from './HabitCheck.vue'
import ObjectLink from './ObjectLink.vue'

const props = defineProps<{ habits: ObjectSummary[]; filter?: string }>()
const emit = defineEmits<{ menu: [event: MouseEvent, object: ObjectSummary] }>()

const today = dayKey()
const days = computed(() => Array.from({ length: isPhone.value ? 7 : 14 }, (_, i) => addDays(today, i - (isPhone.value ? 6 : 13))))
const locale = typeof navigator !== 'undefined' ? navigator.language : 'en'
const weekday = new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' })
const utc = (day: string) => new Date(`${day}T00:00:00.000Z`)

const habits = useFoodHabits(toRef(props, 'habits'))
const rows = computed(() => {
  const q = props.filter?.trim().toLowerCase()
  return habits.value
    .filter((h) => !q || h.title.toLowerCase().includes(q))
    .map((habit) => ({ habit, paused: isHabitPaused(habit), stats: habitStats(habit, today) }))
    .sort((a, b) => Number(a.paused) - Number(b.paused) || a.habit.title.localeCompare(b.habit.title))
})
</script>

<template>
  <div class="mt-4 overflow-x-auto">
    <table class="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr class="text-[11px] text-ink-faint">
          <th class="sticky left-0 z-10 bg-surface pb-2 text-left font-medium">Habit</th>
          <th v-for="day in days" :key="day" class="w-8 pb-2 text-center font-normal" :class="day === today ? 'text-accent' : ''">
            <div class="first-letter:uppercase">{{ weekday.format(utc(day)) }}</div>
            <div class="tabular-nums" :class="day === today ? 'font-semibold' : ''">{{ Number(day.slice(8)) }}</div>
          </th>
          <th class="w-16 pb-2 pl-3 text-right font-medium">Streak</th>
          <th class="w-16 pb-2 pl-3 text-right font-medium max-sm:hidden">30 days</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.habit.id" class="group" :class="row.paused ? 'opacity-50' : ''" @contextmenu.prevent="emit('menu', $event, row.habit)">
          <td class="sticky left-0 z-10 max-w-[14rem] border-t border-line/70 bg-surface py-1.5 pr-3">
            <ObjectLink :id="row.habit.id" class="flex min-w-0 items-center gap-2 hover:underline">
              <span class="h-2.5 w-2.5 shrink-0 rounded-full" :class="swatchClasses[habitColor(row.habit)]" />
              <span class="truncate font-medium">{{ row.habit.title || 'Untitled' }}</span>
              <span v-if="row.paused" class="text-xs text-ink-faint">paused</span>
              <span v-else-if="habitTarget(row.habit)" class="shrink-0 text-xs text-ink-faint">{{ habitTarget(row.habit) }} {{ habitUnit(row.habit) }}</span>
            </ObjectLink>
          </td>
          <td v-for="day in days" :key="day" class="border-t border-line/70 py-1.5 text-center">
            <HabitCheck :habit="row.habit" :day="day" :size="24" square class="mx-auto" :class="isHabitScheduled(row.habit, day) || isHabitDone(row.habit, day) ? '' : 'opacity-40'" />
          </td>
          <td class="border-t border-line/70 py-1.5 pl-3 text-right tabular-nums">
            <span v-if="row.stats.current" class="inline-flex items-center gap-0.5 text-orange-600 dark:text-orange-400"><AppIcon fallback="ph:fire-fill" :size="12" />{{ row.stats.current }}</span>
            <span v-else class="text-ink-faint">0</span>
          </td>
          <td class="border-t border-line/70 py-1.5 pl-3 text-right tabular-nums text-ink-soft max-sm:hidden">{{ Math.round(row.stats.rate30 * 100) }}%</td>
        </tr>
      </tbody>
    </table>
    <p v-if="!rows.length" class="py-10 text-center text-sm text-ink-faint">No habits match the filter.</p>
  </div>
</template>
