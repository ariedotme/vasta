<script setup lang="ts">
// A habit's mark for a day: a circle that fills when done, or a ring that fills toward a daily
// goal (a square, in the Tracker, fills from the bottom). A click toggles it (a goal: adds 1); a
// right click or long press asks for the exact amount.
import { computed } from 'vue'
import { habitFoodRule, habitProgress, habitTarget, isHabitDone, type ObjectSummary } from '@vasta/core'
import { dayKey } from '../lib/actions.ts'
import { iconTextClasses, swatchClasses } from '../lib/colors.ts'
import { askHabitAmount, habitAmountLabel, habitColor, stepHabit } from '../lib/habits.ts'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ habit: ObjectSummary; day: string; size?: number; square?: boolean }>()

const size = computed(() => props.size ?? 20)
const done = computed(() => isHabitDone(props.habit, props.day))
const progress = computed(() => habitProgress(props.habit, props.day))
const goal = computed(() => !!habitTarget(props.habit))
const future = computed(() => props.day > dayKey())
const color = computed(() => habitColor(props.habit))
const longDay = new Intl.DateTimeFormat(typeof navigator !== 'undefined' ? navigator.language : 'en', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
const title = computed(() => {
  const date = longDay.format(new Date(`${props.day}T00:00:00.000Z`))
  if (future.value) return `${date} · not yet`
  if (habitFoodRule(props.habit)) return `${date} · ${goal.value ? habitAmountLabel(props.habit, props.day) : done.value ? 'done' : 'not done'} · from what you log in Food`
  if (goal.value) return `${date} · ${habitAmountLabel(props.habit, props.day)} (${Math.round(progress.value * 100)}%) · click to add 1, right click to type the amount`
  return `${date} · ${done.value ? 'done · click to undo' : 'click to mark as done'}`
})
const radius = computed(() => size.value / 2 - 2)
const circumference = computed(() => 2 * Math.PI * radius.value)
</script>

<template>
  <button
    class="relative grid shrink-0 place-items-center transition-colors disabled:cursor-not-allowed disabled:opacity-40"
    :class="[
      square ? 'rounded-md' : 'rounded-full',
      done
        ? [swatchClasses[color], 'text-white']
        : goal && progress > 0
          ? square
            ? 'overflow-hidden bg-hover'
            : iconTextClasses[color]
          : 'text-ink-faint/0 ring-2 ring-inset ring-line-strong hover:text-ink-faint hover:ring-ink-faint',
    ]"
    :style="{ width: `${size}px`, height: `${size}px` }"
    :disabled="future"
    :title="title"
    :aria-label="title"
    :aria-pressed="done"
    @click.stop.prevent="stepHabit(habit, day)"
    @contextmenu.stop.prevent="askHabitAmount(habit, day)"
  >
    <!-- Partway to a goal: a ring filling clockwise from the top. -->
    <span v-if="square && goal && !done && progress > 0" class="absolute inset-x-0 bottom-0" :class="swatchClasses[color]" :style="{ height: `${progress * 100}%` }" />
    <svg v-else-if="goal && !done && progress > 0" class="absolute inset-0 -rotate-90" :width="size" :height="size">
      <circle :cx="size / 2" :cy="size / 2" :r="radius" fill="none" stroke-width="2.5" class="stroke-line-strong" />
      <circle :cx="size / 2" :cy="size / 2" :r="radius" fill="none" stroke-width="2.5" stroke="currentColor" stroke-linecap="round" :stroke-dasharray="`${circumference * progress} ${circumference}`" />
    </svg>
    <AppIcon v-if="done || !goal || progress === 0" fallback="ph:check-bold" :size="Math.round(size * 0.55)" />
  </button>
</template>
