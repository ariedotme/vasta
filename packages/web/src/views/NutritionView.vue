<script setup lang="ts">
// The Nutrition page: the week's budget with its days, the last 7/30/90 days against the goal
// (averages and streaks skip days not counted), and the goals over time with "New goal". The day
// itself is logged in the Food block of each day; this page is for looking back and setting goals.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  addDays,
  goalForDay,
  isOnTarget,
  nutritionDays,
  nutritionStats,
  readGoal,
  weekBudget,
  weekStart,
  weekdayKcalPropertyId,
  type NutritionDay,
  type ObjectSummary,
  type PropertyValue,
} from '@vasta/core'
import { createObject, dayKey } from '../lib/actions.ts'
import { formatLongDay } from '../lib/format.ts'
import { dailyNotesBetween, formatGrams, formatKcal, nutrientColor, nutritionOn, nutritionTypeId, setNutrition, useGoals } from '../lib/nutrition.ts'
import { onChange } from '../lib/events.ts'
import { lastError, systemType, workspace } from '../lib/state.ts'
import AppIcon from '../components/AppIcon.vue'
import BarChart, { type Bar } from '../components/charts/BarChart.vue'
import WeekBudgetCard from '../components/nutrition/WeekBudgetCard.vue'
import ObjectLink from '../components/ObjectLink.vue'

const today = dayKey()
const RANGES = [7, 30, 90] as const
const RANGE_KEY = 'vasta.nutrition-range'
const range = ref<number>(Number((() => { try { return localStorage.getItem(RANGE_KEY) } catch { return null } })()) || 30)
watch(range, (value) => { try { localStorage.setItem(RANGE_KEY, String(value)) } catch {} })

const { objects: goalObjects, goals, load: loadGoals } = useGoals()
const notes = ref<ObjectSummary[]>([])
const loaded = ref(false)
async function load() {
  const from = [addDays(today, -89), weekStart(today)].sort()[0]!
  notes.value = [...(await dailyNotesBetween(from, addDays(weekStart(today), 6))).values()]
  loaded.value = true
}
void load()
let timer: ReturnType<typeof setTimeout> | undefined
const stop = onChange((event) => {
  if (event.kind !== 'object' || event.typeId !== systemType('daily-note')?.id) return
  clearTimeout(timer)
  timer = setTimeout(load, 300)
})
onBeforeUnmount(() => (stop(), clearTimeout(timer)))

const short = new Intl.DateTimeFormat('en-GB', { day: 'numeric', timeZone: 'UTC' })
const weekdayShort = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' })
const shortDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const at = (day: string) => new Date(`${day}T00:00:00.000Z`)
const toBar = (d: NutritionDay, label: string): Bar => ({
  key: d.day,
  label,
  title: formatLongDay(`${d.day}T00:00:00.000Z`),
  value: d.totals.kcal,
  ...(d.goal ? { target: d.goal.kcal } : {}),
  over: !!d.goal && d.totals.kcal > d.goal.kcal * 1.05,
  faded: !d.counted || d.day > today,
  ...(!d.counted ? { note: 'Not counted' } : d.goal && d.entries ? { note: isOnTarget(d.totals.kcal, d.goal.kcal) ? 'On target' : d.totals.kcal > d.goal.kcal ? 'Over the goal' : 'Under the goal' } : !d.entries && d.day <= today ? { note: 'Nothing logged' } : {}),
})

// The week ----------------------------------------------------------------------------
const weekDays = computed(() => nutritionDays(notes.value, goals.value, weekStart(today), addDays(weekStart(today), 6)))
const budget = computed(() => weekBudget(goals.value, today, (day) => weekDays.value.find((d) => d.day === day)?.totals.kcal ?? 0))
const weekBars = computed(() => weekDays.value.map((d) => toBar(d, weekdayShort.format(at(d.day)))))

// The range -----------------------------------------------------------------------------
const days = computed(() => nutritionDays(notes.value, goals.value, addDays(today, -(range.value - 1)), today))
const stats = computed(() => nutritionStats(days.value, today))
const rangeBars = computed(() => days.value.map((d) => toBar(d, range.value <= 7 ? weekdayShort.format(at(d.day)) : short.format(at(d.day)))))
/** The average goal of the days counted, to set the averages against. */
const averageGoal = computed(() => {
  const counted = days.value.filter((d) => d.counted && d.entries && d.day <= today && d.goal)
  if (!counted.length) return undefined
  const sum = (key: 'kcal' | 'protein' | 'carbs' | 'fat') => counted.reduce((s, d) => s + (d.goal?.[key] ?? 0), 0) / counted.length
  return { kcal: sum('kcal'), protein: sum('protein'), carbs: sum('carbs'), fat: sum('fat') }
})
/** The share of each macronutrient in the average day's kcal. */
const split = computed(() => {
  const a = stats.value.average
  const kcal = a.protein * 4 + a.carbs * 4 + a.fat * 9
  if (!kcal) return undefined
  return { protein: (a.protein * 4) / kcal, carbs: (a.carbs * 4) / kcal, fat: (a.fat * 9) / kcal }
})
const currentGoal = computed(() => goalForDay(goals.value, today))
const currentSplit = computed(() => goals.value.filter((g) => g.start <= today).at(-1)?.split)

// Goals ---------------------------------------------------------------------------------
const WEEKDAYS: [string, string][] = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']]
const history = computed(() =>
  goalObjects.value
    .flatMap((o) => {
      const goal = readGoal(o)
      return goal ? [{ object: o, goal }] : []
    })
    .sort((a, b) => b.goal.start.localeCompare(a.goal.start) || b.object.createdAt.localeCompare(a.object.createdAt))
)
const unfinished = computed(() => goalObjects.value.filter((o) => !o.deletedAt && !readGoal(o)))
const currentId = computed(() => currentGoal.value?.goalId)

const form = ref<{ start: string; kcal: string; protein: string; carbs: string; fat: string; weekly: boolean; weekdays: Record<string, string>; byDay: boolean } | null>(null)
function newGoal() {
  const last = goals.value.filter((g) => g.start <= today).at(-1)
  form.value = {
    start: today,
    kcal: last ? String(last.kcal) : '',
    protein: last?.split ? String(last.split.protein) : '30',
    carbs: last?.split ? String(last.split.carbs) : '40',
    fat: last?.split ? String(last.split.fat) : '30',
    weekly: last?.weekly ?? true,
    weekdays: Object.fromEntries(WEEKDAYS.map(([id]) => [id, last?.weekdays[id] ? String(last.weekdays[id]) : ''])),
    byDay: !!last && Object.keys(last.weekdays).length > 0,
  }
}
const num = (text: string) => {
  const value = Number(text.replace(',', '.'))
  return text.trim() && Number.isFinite(value) && value >= 0 ? value : undefined
}
const percentTotal = computed(() => (form.value ? ['protein', 'carbs', 'fat'].reduce((s, k) => s + (num(form.value![k as 'protein'] ) ?? 0), 0) : 0))
const formError = computed(() => {
  if (!form.value) return ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.value.start)) return 'Pick the day it starts.'
  if (!num(form.value.kcal)) return 'Set the daily kcal.'
  if (Math.round(percentTotal.value) !== 100) return `Protein, carbs and fat add up to ${Math.round(percentTotal.value)}%, not 100%.`
  return ''
})
async function saveGoal() {
  const f = form.value
  if (!f || formError.value) return
  const props: Record<string, PropertyValue> = {
    kcal: { kind: 'number', value: num(f.kcal)! },
    'protein-pct': { kind: 'number', value: num(f.protein) ?? 0 },
    'carbs-pct': { kind: 'number', value: num(f.carbs) ?? 0 },
    'fat-pct': { kind: 'number', value: num(f.fat) ?? 0 },
    weekly: { kind: 'checkbox', value: f.weekly },
  }
  if (f.byDay) for (const [id] of WEEKDAYS) {
    const value = num(f.weekdays[id] ?? '')
    if (value) props[weekdayKcalPropertyId(id)] = { kind: 'number', value }
  }
  try {
    await createObject(nutritionTypeId('nutrition-goal'), { title: `Goal from ${f.start}`, date: { start: `${f.start}T00:00:00.000Z`, resolution: 'day' }, props }, false)
    form.value = null
    await loadGoals()
  } catch (error) {
    lastError.value = (error as Error).message
  }
}

const pct = (value: number) => `${Math.round(value * 100)}%`
const goalLine = (goal: NonNullable<ReturnType<typeof readGoal>>) =>
  [
    `${formatKcal(goal.kcal)} kcal`,
    goal.split ? `protein ${goal.split.protein}% · carbs ${goal.split.carbs}% · fat ${goal.split.fat}%` : '',
    goal.weekly ? 'weekly budget' : '',
    Object.entries(goal.weekdays).map(([d, k]) => `${WEEKDAYS.find(([id]) => id === d)?.[1]} ${formatKcal(k)}`).join(', '),
  ].filter(Boolean).join(' · ')

const turningOn = ref(false)
async function turnOn() {
  turningOn.value = true
  try {
    await setNutrition(true)
  } catch (error) {
    lastError.value = (error as Error).message
  } finally {
    turningOn.value = false
  }
}

const input = 'w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm tabular-nums outline-none focus:border-line-strong max-md:py-2 max-md:text-base'
const heading = 'mb-3 flex items-center gap-2 text-sm font-semibold text-ink-soft'
</script>

<template>
  <div class="mx-auto max-w-3xl px-6 pb-32 pt-8 md:px-10 md:pt-12">
    <h1 class="flex items-center gap-2.5 text-[1.8rem] font-bold leading-tight tracking-tight md:text-[2.1rem]">Nutrition</h1>
    <p class="mt-1 text-sm text-ink-faint">{{ workspace.space?.name }} · log food in each day’s Food block, or with /food</p>

    <div v-if="!nutritionOn" class="mt-8 rounded-xl border border-dashed border-line p-5 text-sm text-ink-soft">
      <p>This space does not track food. Turning it on adds a Food block to each day, and Foods, Recipes and Nutrition goals.</p>
      <button class="mt-3 rounded-lg bg-ink px-3 py-1.5 font-medium text-surface disabled:opacity-40" :disabled="turningOn" @click="turnOn">Track food in {{ workspace.space?.name }}</button>
    </div>

    <template v-else-if="loaded">
      <!-- The week: what matters most when the goal shares its week. -->
      <section class="mt-8" data-nutrition-week>
        <WeekBudgetCard v-if="budget" :budget="budget" :today="true" class="mb-4" />
        <template v-else>
          <h2 :class="heading"><AppIcon fallback="ph:calendar-dots" /> This week</h2>
          <p v-if="currentGoal" class="mb-3 text-xs text-ink-faint">The goal is per day. Turn on "Weekly budget" in a new goal to share it across the week.</p>
        </template>
        <BarChart :bars="weekBars" :format="formatKcal" unit=" kcal" label="Kcal each day of this week against the day's goal" :height="150" />
      </section>

      <section class="mt-10" data-nutrition-range>
        <div class="mb-3 flex flex-wrap items-center gap-2">
          <h2 :class="heading" class="!mb-0"><AppIcon fallback="ph:chart-bar" /> Last days</h2>
          <div class="ml-auto flex rounded-lg bg-hover p-0.5 text-xs">
            <button v-for="r in RANGES" :key="r" class="rounded-md px-2.5 py-1 max-md:py-1.5" :class="range === r ? 'bg-surface font-medium text-ink shadow-sm' : 'text-ink-soft hover:text-ink'" @click="range = r">{{ r }} days</button>
          </div>
        </div>
        <div class="mb-4 grid grid-cols-4 gap-3 max-md:grid-cols-2" data-nutrition-stats>
          <div class="rounded-lg border border-line px-3 py-2">
            <div class="flex items-center gap-1.5 text-xs text-ink-faint"><span class="h-2 w-2 rounded-full" :style="{ background: nutrientColor('kcal') }" />Average a day</div>
            <div class="text-lg font-semibold">{{ formatKcal(stats.average.kcal) }} <span class="text-xs font-normal text-ink-faint">kcal</span></div>
            <div v-if="averageGoal" class="text-xs text-ink-faint">goal {{ formatKcal(averageGoal.kcal) }}</div>
          </div>
          <div class="rounded-lg border border-line px-3 py-2">
            <div class="flex items-center gap-1.5 text-xs text-ink-faint"><span class="h-2 w-2 rounded-full" :style="{ background: nutrientColor('protein') }" />Protein a day</div>
            <div class="text-lg font-semibold">{{ formatGrams(stats.average.protein) }} <span class="text-xs font-normal text-ink-faint">g</span></div>
            <div v-if="averageGoal?.protein" class="text-xs text-ink-faint">goal {{ formatGrams(averageGoal.protein) }} g</div>
          </div>
          <div class="rounded-lg border border-line px-3 py-2">
            <div class="text-xs text-ink-faint">On target</div>
            <div class="text-lg font-semibold">{{ stats.onTarget }} <span class="text-xs font-normal text-ink-faint">of {{ stats.loggedDays }} days</span></div>
            <div class="text-xs text-ink-faint">within 5% of the goal</div>
          </div>
          <div class="rounded-lg border border-line px-3 py-2">
            <div class="text-xs text-ink-faint">Streak</div>
            <div class="text-lg font-semibold">{{ stats.currentStreak }} <span class="text-xs font-normal text-ink-faint">{{ stats.currentStreak === 1 ? 'day' : 'days' }}</span></div>
            <div class="text-xs text-ink-faint">best {{ stats.bestStreak }}</div>
          </div>
        </div>
        <BarChart :bars="rangeBars" :format="formatKcal" unit=" kcal" :label="`Kcal each day of the last ${range} days against the day's goal`" />
        <div v-if="split" class="mt-4 text-sm" data-nutrition-split>
          <div class="mb-1.5 text-xs text-ink-faint">Where the kcal came from, on average</div>
          <div class="grid grid-cols-3 gap-3">
            <div v-for="[key, label] in [['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat']] as const" :key="key">
              <div class="flex items-baseline gap-1.5 text-xs">
                <span class="h-2 w-2 shrink-0 self-center rounded-full" :style="{ background: nutrientColor(key) }" />
                <span class="mr-auto text-ink-soft">{{ label }}</span>
                <span class="tabular-nums text-ink">{{ pct(split[key]) }}<span v-if="currentSplit" class="text-ink-faint"> / {{ currentSplit[key] }}%</span></span>
              </div>
              <div class="relative mt-1 h-1.5 rounded-full bg-line">
                <div class="h-full rounded-full" :style="{ width: `${Math.min(1, split[key]) * 100}%`, background: nutrientColor(key) }" />
                <div v-if="currentSplit" class="absolute -top-0.5 h-2.5 w-0.5 rounded bg-ink-soft" :style="{ left: `calc(${Math.min(100, currentSplit[key])}% - 1px)` }" />
              </div>
            </div>
          </div>
        </div>
        <p class="mt-3 text-xs text-ink-faint">Days not counted (a day's ⋯ menu in its Food block) are left out of the averages and streaks; the week's budget still counts what was eaten.</p>
      </section>

      <section id="goals" class="mt-10 scroll-mt-6" data-nutrition-goals>
        <div class="mb-3 flex items-center gap-2">
          <h2 :class="heading" class="!mb-0"><AppIcon fallback="ph:chart-pie-slice" /> Goals</h2>
          <button v-if="!form" class="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-soft ring-1 ring-line hover:bg-hover hover:text-ink max-md:py-1.5" @click="newGoal">
            <AppIcon fallback="ph:plus" :size="13" /> New goal
          </button>
        </div>

        <form v-if="form" class="mb-4 space-y-3 rounded-xl border border-line p-4" @submit.prevent="saveGoal">
          <div class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-sm max-md:grid-cols-1">
            <label class="text-ink-soft" for="goal-start">Starts on</label>
            <input id="goal-start" v-model="form.start" type="date" :class="input" class="max-w-44" />
            <label class="text-ink-soft" for="goal-kcal">Daily kcal</label>
            <input id="goal-kcal" v-model="form.kcal" :class="input" class="max-w-32" inputmode="numeric" placeholder="2000" />
            <span class="text-ink-soft">Split</span>
            <div class="flex flex-wrap items-center gap-2">
              <label v-for="[key, label] in [['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat']] as const" :key="key" class="flex items-center gap-1.5 text-xs text-ink-faint">
                {{ label }} <input v-model="form[key]" :class="input" class="w-16" inputmode="decimal" :aria-label="`${label} %`" /> %
              </label>
            </div>
          </div>
          <label class="flex items-start gap-2.5 text-sm">
            <input v-model="form.weekly" type="checkbox" class="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
            <span>Weekly budget <span class="block text-xs text-ink-faint">The days of a week (Monday to Sunday) share their kcal: a big Saturday is fine if the week stays on budget.</span></span>
          </label>
          <label class="flex items-center gap-2.5 text-sm">
            <input v-model="form.byDay" type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" /> Different kcal on some weekdays
          </label>
          <div v-if="form.byDay" class="grid grid-cols-7 gap-1.5 max-md:grid-cols-4">
            <label v-for="[id, label] in WEEKDAYS" :key="id" class="text-xs text-ink-faint">
              {{ label }}
              <input v-model="form.weekdays[id]" :class="input" class="mt-0.5" inputmode="numeric" :placeholder="form.kcal || 'kcal'" />
            </label>
          </div>
          <p v-if="formError" class="text-xs text-amber-700 dark:text-amber-400">{{ formError }}</p>
          <div class="flex gap-2">
            <button type="submit" class="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-surface disabled:opacity-40" :disabled="!!formError">Save goal</button>
            <button type="button" class="rounded-lg px-3 py-1.5 text-sm text-ink-soft hover:bg-hover" @click="form = null">Cancel</button>
          </div>
          <p class="text-xs text-ink-faint">A goal applies from its day on; the days before keep the goal they had.</p>
        </form>

        <p v-if="!history.length && !form" class="rounded-lg border border-dashed border-line px-3 py-3 text-sm text-ink-faint">No goal yet. Set one to see each day and week against it.</p>
        <ObjectLink v-for="{ object, goal } in history" :key="object.id" :id="object.id" class="flex items-baseline gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-hover" :class="goal.start > today ? 'opacity-70' : ''">
          <span class="w-28 shrink-0 tabular-nums text-ink-soft">{{ shortDay.format(at(goal.start)) }}</span>
          <span class="min-w-0 flex-1 text-ink">{{ goalLine(goal) }}</span>
          <span v-if="goal.id === currentId" class="shrink-0 rounded-md bg-accent/10 px-1.5 py-0.5 text-[11px] text-accent">current</span>
          <span v-else-if="goal.start > today" class="shrink-0 text-[11px] text-ink-faint">from then on</span>
        </ObjectLink>
        <p v-if="unfinished.length" class="mt-2 text-xs text-ink-faint">
          {{ unfinished.length }} {{ unfinished.length === 1 ? 'goal has' : 'goals have' }} no start day or kcal yet and {{ unfinished.length === 1 ? 'does' : 'do' }} not count:
          <template v-for="(o, i) in unfinished" :key="o.id"><ObjectLink :id="o.id" class="text-ink-soft hover:underline">{{ o.title || 'Untitled' }}</ObjectLink>{{ i < unfinished.length - 1 ? ', ' : '.' }}</template>
        </p>
      </section>
    </template>
  </div>
</template>
