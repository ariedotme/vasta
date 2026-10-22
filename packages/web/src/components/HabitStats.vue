<script setup lang="ts">
// On a habit's page: today's mark, its streaks and rates, and as many weeks of days as fit (up to a
// year), one square per day in the habit's color, fainter for a goal partly reached. A click marks
// a day (a goal: adds 1); a right click asks for the amount.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { addDays, habitFoodRule, habitProgress, habitStats, habitTarget, habitUnit, habitValue, isHabitDone, isHabitScheduled, type ObjectRecord } from '@vasta/core'
import { dayKey } from '../lib/actions.ts'
import { swatchClasses } from '../lib/colors.ts'
import { askHabitAmount, formatAmount, habitAmountLabel, habitColor, setHabitAmount, stepHabit, useFoodHabits } from '../lib/habits.ts'
import AppIcon from './AppIcon.vue'
import HabitCheck from './HabitCheck.vue'

const props = defineProps<{ habit: ObjectRecord }>()
// A habit done from food has its days from what was logged.
const linked = useFoodHabits(computed(() => [props.habit as ObjectRecord & { preview: string }]))
const habit = computed(() => linked.value[0]!)
const fromFood = computed(() => !!habitFoodRule(props.habit))

const today = dayKey()
const stats = computed(() => habitStats(habit.value, today))
const color = computed(() => habitColor(habit.value))
const target = computed(() => habitTarget(habit.value))
const unit = computed(() => habitUnit(habit.value))

const locale = typeof navigator !== 'undefined' ? navigator.language : 'en'
const monthName = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' })
const longDay = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const utc = (day: string) => new Date(`${day}T00:00:00.000Z`)

// As many weeks as the width allows: 11px squares, 3px apart, a year at most.
const CELL = 11
const GAP = 3
const box = ref<HTMLElement | null>(null)
const width = ref(700)
let observer: ResizeObserver | undefined
onMounted(() => {
  if (!box.value) return
  observer = new ResizeObserver(([entry]) => (width.value = entry?.contentRect.width ?? width.value))
  observer.observe(box.value)
})
onBeforeUnmount(() => observer?.disconnect())

/** Columns of weeks, Monday on top, ending with this week. */
const weeks = computed(() => {
  const count = Math.max(8, Math.min(53, Math.floor((width.value + GAP) / (CELL + GAP))))
  const monday = addDays(today, -((utc(today).getUTCDay() + 6) % 7))
  const start = addDays(monday, -7 * (count - 1))
  return Array.from({ length: count }, (_, w) => Array.from({ length: 7 }, (_, d) => addDays(start, w * 7 + d)))
})
/** A month's name over the week its first day is in; one too close to the one before is left out. */
const monthLabels = computed(() => {
  const labels: { column: number; text: string }[] = []
  weeks.value.forEach((week, column) => {
    const first = week.find((d) => d.endsWith('-01'))
    if (!first) return
    if (labels.length && column - labels.at(-1)!.column < 3) return
    labels.push({ column, text: monthName.format(utc(first)) })
  })
  return labels
})

/** A square: the habit's color fills it from the bottom as far as the day got (all of it once done). */
function cellClass(day: string) {
  if (day > today) return 'invisible'
  if (day < stats.value.since || !isHabitScheduled(habit.value, day)) return 'bg-hover/50 hover:ring-1 hover:ring-line'
  return 'bg-hover hover:ring-1 hover:ring-line-strong'
}

// The hovered (or focused) square's details, shown at once above it.
const hovered = ref<{ day: string; left: number; top: number } | null>(null)
function hover(event: Event, day: string) {
  if (day > today || !box.value) return
  const cell = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const area = box.value.getBoundingClientRect()
  // Kept inside the area, so a square at either end does not push its tooltip out of the page.
  hovered.value = { day, left: Math.min(Math.max(cell.left - area.left + cell.width / 2, 80), area.width - 80), top: cell.top - area.top }
}
const details = computed(() => {
  const day = hovered.value?.day
  if (!day) return null
  const progress = habitProgress(habit.value, day)
  const status = isHabitDone(habit.value, day)
    ? 'Done'
    : day < stats.value.since
      ? 'Before this habit began'
      : !isHabitScheduled(habit.value, day)
        ? 'Day off'
        : progress > 0
          ? `${Math.round(progress * 100)}% of the goal`
          : day === today
            ? 'Not done yet'
            : 'Missed'
  return { date: longDay.format(utc(day)), status, amount: target.value ? habitAmountLabel(habit.value, day) : '', done: isHabitDone(habit.value, day) }
})

const cards = computed(() => [
  { label: 'Current streak', value: stats.value.current, icon: 'ph:fire', tint: 'text-orange-500' },
  { label: 'Best streak', value: stats.value.best, icon: 'ph:trophy', tint: 'text-amber-500' },
  { label: 'This week', value: `${stats.value.weekDone}/${stats.value.weekScheduled}`, icon: 'ph:calendar-check', tint: 'text-sky-500' },
  { label: 'Last 30 days', value: `${Math.round(stats.value.rate30 * 100)}%`, icon: 'ph:chart-line-up', tint: 'text-emerald-500' },
  target.value
    ? { label: 'Average a day', value: `${formatAmount(stats.value.average30)}${unit.value ? ` ${unit.value}` : ''}`, icon: 'ph:gauge', tint: 'text-violet-500' }
    : { label: 'Times done', value: stats.value.total, icon: 'ph:check-circle', tint: 'text-violet-500' },
])
const doneToday = computed(() => isHabitDone(habit.value, today))
</script>

<template>
  <section class="mt-8">
    <div class="mb-4 flex flex-wrap items-center gap-3">
      <div class="flex items-center gap-2.5 rounded-xl border border-line py-1.5 pl-2 pr-3">
        <HabitCheck :habit="habit" :day="today" :size="26" />
        <div class="text-sm">
          <div class="font-medium">{{ doneToday ? 'Done today' : 'Today' }}</div>
          <div v-if="target" class="text-xs tabular-nums text-ink-faint">{{ habitAmountLabel(habit, today) }}</div>
        </div>
        <div v-if="target && !fromFood" class="ml-2 flex items-center gap-1">
          <button class="grid h-7 w-7 place-items-center rounded-md ring-1 ring-line hover:bg-hover" title="Take 1 away" @click="setHabitAmount(habit.id, today, Math.max(0, habitValue(habit, today) - 1), habit)">
            <AppIcon fallback="ph:minus" :size="13" />
          </button>
          <button class="grid h-7 w-7 place-items-center rounded-md ring-1 ring-line hover:bg-hover" title="Add 1" @click="setHabitAmount(habit.id, today, habitValue(habit, today) + 1, habit)">
            <AppIcon fallback="ph:plus" :size="13" />
          </button>
        </div>
      </div>
      <span v-if="!isHabitScheduled(habit, today)" class="text-xs text-ink-faint">Today is a day off for this habit.</span>
      <span v-if="fromFood" class="flex items-center gap-1 text-xs text-ink-faint" data-habit-from-food><AppIcon fallback="ph:bowl-food" :size="13" /> Done from what you log in Food</span>
    </div>

    <div class="grid grid-cols-2 gap-2 sm:grid-cols-5">
      <div v-for="card in cards" :key="card.label" class="rounded-xl border border-line px-3 py-2.5">
        <div class="flex items-center gap-1.5 text-xs text-ink-faint"><AppIcon :fallback="card.icon" :class="card.tint" :size="14" /> {{ card.label }}</div>
        <div class="mt-1 truncate text-xl font-semibold tabular-nums">{{ card.value }}</div>
      </div>
    </div>

    <div ref="box" class="relative mt-6">
      <div class="relative h-4">
        <span
          v-for="label in monthLabels"
          :key="label.column"
          class="absolute top-0 text-[10px] leading-none text-ink-faint first-letter:uppercase"
          :style="{ left: `${label.column * (CELL + GAP)}px` }"
          >{{ label.text }}</span
        >
      </div>
      <div class="grid w-fit gap-[3px]" :style="{ gridTemplateColumns: `repeat(${weeks.length}, ${CELL}px)`, gridTemplateRows: `repeat(7, ${CELL}px)`, gridAutoFlow: 'column' }">
        <template v-for="week in weeks" :key="week[0]">
          <button
            v-for="day in week"
            :key="day"
            class="relative overflow-hidden rounded-[3px]"
            :class="cellClass(day)"
            :aria-label="day"
            :disabled="day > today"
            @click="stepHabit(habit, day)"
            @contextmenu.prevent="askHabitAmount(habit, day)"
            @mouseenter="hover($event, day)"
            @focus="hover($event, day)"
            @mouseleave="hovered = null"
            @blur="hovered = null"
          >
            <span
              v-if="day <= today && habitProgress(habit, day) > 0"
              class="absolute inset-x-0 bottom-0"
              :class="swatchClasses[color]"
              :style="{ height: `${habitProgress(habit, day) * 100}%` }"
            />
          </button>
        </template>
      </div>
      <div
        v-if="hovered && details"
        class="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg bg-ink px-2.5 py-1.5 text-xs text-surface shadow-lg"
        :style="{ left: `${hovered.left}px`, top: `${hovered.top - 6}px` }"
        role="tooltip"
      >
        <div class="font-medium first-letter:uppercase">{{ details.date }}</div>
        <div class="opacity-80">
          <template v-if="details.amount">{{ details.amount }} · </template>{{ details.status }}
        </div>
      </div>
      <p class="mt-2 text-xs text-ink-faint">
        Click a day to {{ target ? 'add 1' : 'mark it' }}, right click to type {{ target ? 'the amount' : 'it' }}. Counting since {{ longDay.format(utc(stats.since)) }}.
      </p>
    </div>
  </section>
</template>
