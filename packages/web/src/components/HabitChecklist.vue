<script setup lang="ts">
// The habits of a day, to check off: a column beside the calendar's day (Today), or a row of pills
// in a daily note. Days a habit does not repeat on show it faded; paused habits are left out.
import { computed } from 'vue'
import { habitStats, isHabitDone, isHabitPaused, isHabitScheduled } from '@vasta/core'
import { createObject, dayKey } from '../lib/actions.ts'
import { chip } from '../lib/colors.ts'
import { askHabitAmount, habitAmountLabel, habitColor, stepHabit, useHabits } from '../lib/habits.ts'
import { promptDialog } from '../lib/overlays.ts'
import { lastError, systemType } from '../lib/state.ts'
import AppIcon from './AppIcon.vue'
import HabitCheck from './HabitCheck.vue'
import ObjectLink from './ObjectLink.vue'

const props = defineProps<{ day: string; variant?: 'column' | 'inline' }>()
const { habits, loaded, load } = useHabits()

const rows = computed(() =>
  habits.value
    .filter((h) => !isHabitPaused(h))
    .map((habit) => ({
      habit,
      scheduled: isHabitScheduled(habit, props.day),
      done: isHabitDone(habit, props.day),
      amount: habitAmountLabel(habit, props.day),
      streak: habitStats(habit, dayKey()).current,
    }))
    .sort((a, b) => Number(b.scheduled) - Number(a.scheduled))
)
const doneCount = computed(() => rows.value.filter((r) => r.scheduled && r.done).length)
const scheduledCount = computed(() => rows.value.filter((r) => r.scheduled).length)
const future = computed(() => props.day > dayKey())


async function newHabit() {
  const type = systemType('habit')
  const title = await promptDialog({ title: 'New habit', message: 'Something to do every day, or on the days you choose on its page.', placeholder: 'Read 20 pages', confirmLabel: 'Create' })
  if (!title?.trim() || !type) return
  try {
    await createObject(type.id, { title: title.trim() }, false)
    await load()
  } catch (error) {
    lastError.value = (error as Error).message
  }
}
</script>

<template>
  <section v-if="loaded && systemType('habit')" :class="variant === 'inline' ? '' : 'text-sm'">
    <div class="mb-2 flex items-center gap-2">
      <h2 class="flex items-center gap-1.5 text-sm font-semibold text-ink-soft"><AppIcon fallback="ph:target" /> Habits</h2>
      <span v-if="scheduledCount" class="text-xs tabular-nums text-ink-faint">{{ doneCount }}/{{ scheduledCount }}</span>
      <RouterLink :to="`/t/${systemType('habit')!.id}`" class="ml-auto rounded-md px-1.5 py-0.5 text-xs text-ink-faint hover:bg-hover hover:text-ink">All</RouterLink>
    </div>

    <p v-if="!rows.length" class="mb-2 text-xs text-ink-faint">Track what you want to do regularly: check it off here each day.</p>

    <!-- Column: one row per habit. -->
    <div v-if="variant !== 'inline'" class="space-y-0.5">
      <div v-for="row in rows" :key="row.habit.id" class="group flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-hover" :class="row.scheduled ? '' : 'opacity-50'">
        <HabitCheck :habit="row.habit" :day="day" />
        <ObjectLink :id="row.habit.id" class="min-w-0 flex-1 truncate hover:underline" :class="row.done ? 'text-ink-soft line-through decoration-ink-faint/50' : ''">
          {{ row.habit.title || 'Untitled' }}
        </ObjectLink>
        <span v-if="row.amount" class="shrink-0 text-[11px] tabular-nums text-ink-faint">{{ row.amount }}</span>
        <span v-if="!row.scheduled" class="text-[11px] text-ink-faint">day off</span>
        <span v-else-if="row.streak > 1" class="flex items-center gap-0.5 text-[11px] tabular-nums text-orange-600 dark:text-orange-400" :title="`${row.streak} in a row`">
          <AppIcon fallback="ph:fire-fill" :size="11" />{{ row.streak }}
        </span>
      </div>
    </div>

    <!-- Inline: pills. -->
    <div v-else class="flex flex-wrap gap-1.5">
      <button
        v-for="row in rows"
        :key="row.habit.id"
        class="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm transition-colors disabled:cursor-not-allowed max-md:py-1.5"
        :class="[row.done ? chip(habitColor(row.habit)) : 'text-ink-soft ring-1 ring-line hover:bg-hover hover:text-ink', row.scheduled ? '' : 'opacity-50']"
        :disabled="future"
        :aria-pressed="row.done"
        :title="row.amount ? 'Click to add 1, right click to type the amount' : undefined"
        @click="stepHabit(row.habit, day)"
        @contextmenu.prevent="askHabitAmount(row.habit, day)"
      >
        <AppIcon :fallback="row.done ? 'ph:check-circle-fill' : 'ph:circle'" :size="15" />
        {{ row.habit.title || 'Untitled' }}
        <span v-if="row.amount" class="text-xs tabular-nums opacity-70">{{ row.amount }}</span>
        <span v-if="row.scheduled && row.streak > 1" class="flex items-center text-[11px] tabular-nums opacity-70"><AppIcon fallback="ph:fire-fill" :size="10" />{{ row.streak }}</span>
      </button>
    </div>

    <button class="mt-1.5 flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-faint hover:bg-hover hover:text-ink" @click="newHabit">
      <AppIcon fallback="ph:plus" :size="12" /> New habit
    </button>
  </section>
</template>
