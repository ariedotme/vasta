<script setup lang="ts">
// The week's budget when the goal shares its week: eaten of the target, what is left, and on
// today what today may take so the week ends on budget. In the Food block and the Nutrition page.
import type { WeekBudget } from '@vasta/core'
import { formatKcal } from '../../lib/nutrition.ts'

defineProps<{ budget: WeekBudget; today: boolean }>()
const fill = (value: number, target: number) => (target > 0 ? Math.min(1, value / target) : 0)
</script>

<template>
  <div class="rounded-lg bg-hover/60 px-3 py-2" data-food-week>
    <div class="flex items-baseline gap-2">
      <span class="font-medium">This week</span>
      <span class="tabular-nums text-ink-soft">{{ formatKcal(budget.eaten) }} of {{ formatKcal(budget.target) }} kcal</span>
      <span class="ml-auto tabular-nums" :class="budget.remaining < 0 ? 'text-amber-700 dark:text-amber-400' : 'text-ink-soft'">
        {{ budget.remaining < 0 ? `${formatKcal(-budget.remaining)} over` : `${formatKcal(budget.remaining)} left` }}
      </span>
    </div>
    <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line">
      <div class="h-full rounded-full" :class="budget.remaining < 0 ? 'bg-amber-500' : 'bg-emerald-500'" :style="{ width: `${fill(budget.eaten, budget.target) * 100}%` }" />
    </div>
    <!-- Only today: on a past day, what it "may take" would count the days after it as empty. -->
    <div v-if="today" class="mt-1 text-xs text-ink-faint">
      Today up to <span class="tabular-nums text-ink-soft">{{ formatKcal(budget.allowance) }} kcal</span> to end the week on budget
    </div>
  </div>
</template>
