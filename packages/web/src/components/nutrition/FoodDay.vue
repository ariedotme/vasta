<script setup lang="ts">
// A day's food, where the day is (the calendar's day, a daily note): the week's budget when the
// goal shares its week, the day against its goal, and the meals with what was eaten. "+" on a meal
// logs into it (FoodPicker); an entry opens to change its amount or meal; right click (long press)
// for more. Shown only once the space tracks food; a past day without entries is a single line.
import { computed, ref, toRef } from 'vue'
import {
  AmountError,
  NOT_COUNTED_KEY,
  addDays,
  dayEntries,
  dayTotals,
  entryLabel,
  groupByMeal,
  ingredientsValue,
  isDayCounted,
  parseAmount,
  quickEntry,
  refreshEntry,
  sourcePortions,
  type DayEntry,
  type FoodEntry,
  type Id,
  type Meal,
  type ObjectRecord,
} from '@vasta/core'
import { api } from '../../lib/api.ts'
import { createObject, dayKey } from '../../lib/actions.ts'
import { clone } from '../../lib/clone.ts'
import {
  dailyNotesBetween,
  eatenAgain,
  entryTime,
  formatGrams,
  formatKcal,
  meals,
  nutrientColor,
  type NutrientKey,
  nutritionOn,
  nutritionTypeId,
  timeZone,
  useFoodDay,
  useFoodLibrary,
  withAmount,
  writeEntries,
} from '../../lib/nutrition.ts'
import { openContextMenu, promptDialog, type MenuItem } from '../../lib/overlays.ts'
import { lastError, notice, primeFromObject, workspace } from '../../lib/state.ts'
import { router } from '../../router.ts'
import AppIcon from '../AppIcon.vue'
import ModalDialog from '../ModalDialog.vue'
import FoodPicker from './FoodPicker.vue'
import NutrientLine from './NutrientLine.vue'
import WeekBudgetCard from './WeekBudgetCard.vue'

const props = defineProps<{ day: string }>()
const { note, entries, goal, budget, loaded, setNote } = useFoodDay(toRef(props, 'day'))
const library = useFoodLibrary()

const today = computed(() => props.day === dayKey())
const future = computed(() => props.day > dayKey())
const groups = computed(() => groupByMeal(entries.value, meals.value, timeZone()))
const totals = computed(() => dayTotals(entries.value))
const counted = computed(() => isDayCounted(note.value))
const missingData = computed(() => entries.value.filter((e) => !e.entry.nutrients).length)
/** A day before today with nothing logged shows as one line until opened. */
const opened = ref(false)
const compact = computed(() => !entries.value.length && !today.value && !opened.value)

const bars = computed(() => {
  const g = goal.value
  const rows: { key: NutrientKey; label: string; value: number; target?: number; unit: string }[] = [{ key: 'kcal', label: 'kcal', value: totals.value.kcal, ...(g ? { target: g.kcal } : {}), unit: '' }]
  for (const [key, label] of [['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat']] as const) {
    const target = g?.[key]
    rows.push({ key, label, value: totals.value[key], ...(target !== undefined ? { target } : {}), unit: 'g' })
  }
  return rows
})
const over = (value: number, target?: number) => !!target && value > target * 1.05
/** The bar's scale: the goal, or what was eaten when past it (the goal then shows as a tick). */
const scale = (value: number, target?: number) => Math.max(target ?? 0, value, 1)

// Logging ------------------------------------------------------------------------
const picker = ref<{ meal?: Meal } | null>(null)
const openPicker = (meal?: Meal) => (picker.value = meal ? { meal } : {})
const written = (saved: ObjectRecord) => setNote(saved)

async function write(changes: Record<Id, FoodEntry | null>) {
  try {
    written(await writeEntries(props.day, note.value?.id, changes))
  } catch (error) {
    lastError.value = (error as Error).message
  }
}

// Editing an entry ------------------------------------------------------------------
// A quick entry (numbers without a food) edits its name and numbers instead of an amount.
const QUICK_FIELDS = [['kcal', 'kcal'], ['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat']] as const
type QuickForm = { name: string; kcal: string; protein: string; carbs: string; fat: string }
const editing = ref<{ id: Id; entry: FoodEntry; amount: string; meal: Id; quick?: QuickForm } | null>(null)
function edit(item: DayEntry, meal: Meal) {
  const n = item.entry.nutrients
  const text = (value: number | undefined) => (value ? String(value) : '')
  const quick = item.entry.quick ? { name: item.entry.name, kcal: text(n?.kcal), protein: text(n?.protein), carbs: text(n?.carbs), fat: text(n?.fat) } : undefined
  editing.value = { id: item.id, entry: item.entry, amount: item.entry.amount, meal: meal.id, ...(quick ? { quick } : {}) }
}
const quickNumber = (text: string) => {
  const value = Number(text.replace(',', '.'))
  return text.trim() && Number.isFinite(value) && value >= 0 ? value : undefined
}
const editPortions = computed(() => {
  const source = editing.value?.entry.sourceId ? library.lookup(editing.value.entry.sourceId) : undefined
  return source ? sourcePortions(source, library.lookup) : []
})
const editError = computed(() => {
  if (!editing.value) return ''
  if (editing.value.quick) return quickNumber(editing.value.quick.kcal) === undefined ? 'type its kcal' : ''
  try {
    parseAmount(editing.value.amount, editPortions.value)
    return ''
  } catch (error) {
    return error instanceof AmountError ? error.message : String(error)
  }
})

async function saveEdit() {
  const e = editing.value
  if (!e || editError.value) return
  let next: FoodEntry = e.entry
  if (e.quick) {
    const q = e.quick
    next = quickEntry(q.name, { kcal: quickNumber(q.kcal)!, protein: quickNumber(q.protein) ?? 0, carbs: quickNumber(q.carbs) ?? 0, fat: quickNumber(q.fat) ?? 0 }, e.entry.at)
  } else if (e.amount.trim() !== e.entry.amount) next = withAmount(e.entry, e.amount, library.lookup)
  next = { ...next, meal: e.meal }
  editing.value = null
  await write({ [e.id]: next })
}

const remove = (id: Id) => write({ [id]: null })
const moveTo = (item: DayEntry, meal: Meal) => write({ [item.id]: { ...item.entry, meal: meal.id } })
const refresh = (item: DayEntry) => write({ [item.id]: refreshEntry(item.entry, library.lookup) })

function entryMenu(event: MouseEvent, item: DayEntry, meal: Meal) {
  const items: MenuItem[] = [
    { label: item.entry.quick ? 'Change kcal or meal' : 'Change amount or meal', icon: 'ph:pencil-simple', run: () => edit(item, meal) },
    ...meals.value.filter((m) => m.id !== meal.id).map((m): MenuItem => ({ label: `Move to ${m.name}`, icon: 'ph:arrow-right', run: () => moveTo(item, m) })),
    { kind: 'separator' },
    { label: 'Update from the food', icon: 'ph:arrows-clockwise', disabled: !item.entry.sourceId || !library.lookup(item.entry.sourceId), run: () => refresh(item) },
    { label: 'Open the food', icon: 'ph:arrow-up-right', disabled: !item.entry.sourceId || !library.lookup(item.entry.sourceId), run: () => router.push(`/o/${item.entry.sourceId}`) },
    { kind: 'separator' },
    { label: 'Delete', icon: 'ph:trash', danger: true, run: () => remove(item.id) },
  ]
  openContextMenu(event, items)
}

// A meal ------------------------------------------------------------------------
/** Log again what a meal had on another day (yesterday by default), with today's nutrition of each food. */
async function copyMeal(meal: Meal, from = addDays(props.day, -1)) {
  const notes = await dailyNotesBetween(from, from)
  const source = notes.get(from)
  const items = source ? groupByMeal(dayEntries(source), meals.value, timeZone()).find((g) => g.meal.id === meal.id)?.entries ?? [] : []
  if (!items.length) {
    notice.value = { message: `Nothing in ${meal.name} on ${from === addDays(props.day, -1) ? 'the day before' : from}.` }
    return
  }
  const at = entryTime(props.day, meal)
  await write(Object.fromEntries(items.map((item) => [crypto.randomUUID(), eatenAgain(item.entry, library.lookup, at, meal.id)])))
  notice.value = { message: `Copied ${items.length} ${items.length === 1 ? 'item' : 'items'} into ${meal.name}.` }
}

async function copyMealFrom(meal: Meal) {
  const answer = await promptDialog({ title: `Copy ${meal.name} from`, message: 'The day to copy it from.', value: addDays(props.day, -1), placeholder: 'YYYY-MM-DD', confirmLabel: 'Copy' })
  if (answer && /^\d{4}-\d{2}-\d{2}$/.test(answer.trim())) await copyMeal(meal, answer.trim())
}

/** A recipe of the meal's foods and amounts, one serving: "Usual breakfast". */
async function saveAsRecipe(meal: Meal, items: DayEntry[]) {
  const ingredients = items.flatMap((i) => (i.entry.sourceId ? [{ id: i.entry.sourceId, grams: i.entry.grams }] : []))
  if (!ingredients.length) return
  const title = await promptDialog({ title: 'Save as recipe', message: `A recipe of the ${ingredients.length} ${ingredients.length === 1 ? 'item' : 'items'} in ${meal.name}, to log in one go.`, value: `Usual ${meal.name.toLowerCase()}`, confirmLabel: 'Save recipe' })
  if (!title?.trim()) return
  try {
    const recipe = await createObject(nutritionTypeId('recipe'), { title: title.trim(), props: { ingredients: ingredientsValue(ingredients), servings: { kind: 'number', value: 1 } } }, false)
    notice.value = { message: `Saved “${recipe.title}”.`, action: { label: 'Open', run: () => router.push(`/o/${recipe.id}`) } }
  } catch (error) {
    lastError.value = (error as Error).message
  }
}

function mealMenu(event: MouseEvent, meal: Meal, items: DayEntry[]) {
  openContextMenu(event, [
    { label: `Log into ${meal.name}`, icon: 'ph:plus', disabled: future.value, run: () => openPicker(meal) },
    { label: 'Copy from the day before', icon: 'ph:copy', disabled: future.value, run: () => copyMeal(meal) },
    { label: 'Copy from another day…', icon: 'ph:calendar-blank', disabled: future.value, run: () => copyMealFrom(meal) },
    { label: 'Save as recipe', icon: 'ph:cooking-pot', disabled: !items.some((i) => i.entry.sourceId), run: () => saveAsRecipe(meal, items) },
  ])
}

// The day ------------------------------------------------------------------------
async function setCounted(value: boolean) {
  try {
    const base = note.value ? await api.object(note.value.id) : await api.dailyNote(workspace.space!.id, props.day)
    const next = clone(base)
    if (value) delete next.props[NOT_COUNTED_KEY]
    else next.props[NOT_COUNTED_KEY] = { kind: 'checkbox', value: true }
    const saved = await api.saveObject(next, base)
    primeFromObject(saved)
    written(saved)
  } catch (error) {
    lastError.value = (error as Error).message
  }
}

function dayMenu(event: MouseEvent) {
  openContextMenu(event, [
    counted.value
      ? { label: "Don't count this day", icon: 'ph:prohibit', hint: 'travel, sick…', run: () => setCounted(false) }
      : { label: 'Count this day again', icon: 'ph:check', run: () => setCounted(true) },
    { label: goal.value ? 'Goals' : 'Set a goal', icon: 'ph:chart-pie-slice', run: () => router.push('/nutrition#goals') },
    { label: 'Nutrition', icon: 'ph:chart-bar', run: () => router.push('/nutrition') },
    { label: 'Foods', icon: 'ph:bowl-food', run: () => router.push(`/t/${nutritionTypeId('food')}`) },
    { label: 'Recipes', icon: 'ph:cooking-pot', run: () => router.push(`/t/${nutritionTypeId('recipe')}`) },
  ])
}
</script>

<template>
  <section v-if="nutritionOn && loaded" class="text-sm" data-food-day>
    <div class="mb-2 flex items-center gap-2">
      <h2 class="flex items-center gap-1.5 font-semibold text-ink-soft"><AppIcon fallback="ph:bowl-food" /> Food</h2>
      <span v-if="!compact" class="text-xs tabular-nums text-ink-faint">
        {{ formatKcal(totals.kcal) }}<template v-if="goal"> / {{ formatKcal(goal.kcal) }}</template> kcal
      </span>
      <span v-if="!counted" class="rounded-md bg-hover px-1.5 py-0.5 text-[11px] text-ink-faint">not counted</span>
      <div class="ml-auto flex items-center gap-1">
        <button
          v-if="!future"
          class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-soft ring-1 ring-line hover:bg-hover hover:text-ink max-md:py-1.5"
          @click="compact ? (opened = true) : openPicker()"
        >
          <AppIcon fallback="ph:plus" :size="13" /> Log food
        </button>
        <button class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink max-md:p-1.5" title="More" @click="dayMenu($event)" @contextmenu="dayMenu($event)">
          <AppIcon fallback="ph:dots-three" />
        </button>
      </div>
    </div>

    <template v-if="!compact">
      <!-- The week's budget comes first: it is what the day is measured against. -->
      <WeekBudgetCard v-if="budget" :budget="budget" :today="today" class="mb-3" />

      <div class="mb-3 grid grid-cols-4 gap-3 max-md:grid-cols-2">
        <div v-for="bar in bars" :key="bar.label" :data-nutrient="bar.key">
          <div class="flex items-baseline gap-1 text-xs">
            <span class="h-2 w-2 shrink-0 self-center rounded-full" :style="{ background: nutrientColor(bar.key) }" />
            <span class="text-ink-soft">{{ bar.label }}</span>
            <span class="ml-auto tabular-nums" :class="over(bar.value, bar.target) ? 'text-amber-700 dark:text-amber-400' : 'text-ink-faint'" :title="over(bar.value, bar.target) ? 'Past the goal' : undefined">
              {{ bar.unit ? formatGrams(bar.value) : formatKcal(bar.value) }}<template v-if="bar.target">/{{ bar.unit ? formatGrams(bar.target) : formatKcal(bar.target) }}</template>{{ bar.unit ? ` ${bar.unit}` : '' }}
            </span>
          </div>
          <div class="relative mt-1 h-1.5 rounded-full bg-line">
            <div class="h-full rounded-full" :style="{ width: `${(bar.target ? bar.value / scale(bar.value, bar.target) : bar.value > 0 ? 1 : 0) * 100}%`, background: nutrientColor(bar.key), opacity: bar.target ? 1 : 0.35 }" />
            <div v-if="bar.target && bar.value > bar.target" class="absolute -top-0.5 h-2.5 w-0.5 rounded bg-ink" :style="{ left: `calc(${(bar.target / scale(bar.value, bar.target)) * 100}% - 1px)` }" title="The goal" />
          </div>
        </div>
      </div>
      <p v-if="missingData" class="mb-2 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
        <AppIcon fallback="ph:warning" :size="13" /> {{ missingData }} {{ missingData === 1 ? 'item needs' : 'items need' }} nutrition data: fill in the food, then "Update from the food".
      </p>

      <div class="space-y-1">
        <div v-for="group in groups" :key="group.meal.id" class="rounded-lg" data-food-meal @contextmenu="mealMenu($event, group.meal, group.entries)">
          <div class="flex items-center gap-2 px-1.5 py-1">
            <span class="font-medium" :class="group.entries.length ? '' : 'text-ink-faint'">{{ group.meal.name }}</span>
            <span v-if="group.entries.length" class="text-xs tabular-nums text-ink-faint">{{ formatKcal(group.totals.kcal) }} kcal</span>
            <div class="ml-auto flex items-center">
              <button class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink max-md:p-2" :title="`More for ${group.meal.name}`" @click="mealMenu($event, group.meal, group.entries)">
                <AppIcon fallback="ph:dots-three" :size="15" />
              </button>
              <button v-if="!future" class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink max-md:p-2" :title="`Log into ${group.meal.name}`" @click="openPicker(group.meal)">
                <AppIcon fallback="ph:plus" :size="15" />
              </button>
            </div>
          </div>
          <button
            v-for="item in group.entries"
            :key="item.id"
            class="flex w-full items-center gap-2 rounded-md py-1 pl-4 pr-1.5 text-left hover:bg-hover max-md:py-2"
            data-food-entry
            @click="edit(item, group.meal)"
            @contextmenu.stop="entryMenu($event, item, group.meal)"
          >
            <span class="min-w-0 flex-1 truncate" :class="item.entry.quick && !item.entry.name ? 'text-ink-soft' : ''">{{ entryLabel(item.entry) }} <span class="text-ink-faint">{{ item.entry.amount }}</span></span>
            <AppIcon v-if="!item.entry.nutrients" fallback="ph:warning" class="shrink-0 text-amber-600" :size="13" title="Needs nutrition data" />
            <span v-else class="shrink-0 text-xs tabular-nums text-ink-faint">{{ formatKcal(item.entry.nutrients.kcal) }}</span>
          </button>
        </div>
      </div>
    </template>

    <FoodPicker v-if="picker" :day="day" :meal="picker.meal" :sources="library.sources.value" :lookup="library.lookup" @logged="written" @close="picker = null" />

    <ModalDialog v-if="editing" :title="entryLabel(editing.entry)" width="26rem" @close="editing = null">
      <form class="space-y-3" @submit.prevent="saveEdit">
        <template v-if="editing.quick">
          <label class="block text-xs text-ink-faint">
            Name <span class="text-ink-faint">(optional)</span>
            <input v-model="editing.quick.name" class="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-line-strong max-md:text-base" placeholder="Muffin" />
          </label>
          <div class="grid grid-cols-4 gap-2">
            <label v-for="[key, name] in QUICK_FIELDS" :key="key" class="text-xs text-ink-faint">
              {{ name }}
              <input v-model="editing.quick[key]" class="mt-1 w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm tabular-nums outline-none focus:border-line-strong max-md:text-base" inputmode="decimal" :placeholder="key === 'kcal' ? '0' : 'g'" :autofocus="key === 'kcal'" />
            </label>
          </div>
          <p class="text-xs text-ink-faint">Logged without a food: only these numbers count.</p>
        </template>
        <label v-else class="block text-xs text-ink-faint">
          Amount
          <input v-model="editing.amount" class="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-line-strong max-md:text-base" autofocus />
        </label>
        <p v-if="editError" class="text-xs text-red-600 dark:text-red-400">{{ editError }}</p>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="m in meals"
            :key="m.id"
            type="button"
            class="rounded-full px-2.5 py-1 text-xs ring-1 max-md:py-1.5 max-md:text-sm"
            :class="editing.meal === m.id ? 'bg-ink text-surface ring-ink' : 'text-ink-soft ring-line hover:bg-hover'"
            @click="editing.meal = m.id"
          >
            {{ m.name }}
          </button>
        </div>
        <p v-if="editing.entry.nutrients && !editing.quick" class="text-xs tabular-nums text-ink-faint">
          {{ formatGrams(editing.entry.grams) }} g · <NutrientLine :nutrients="editing.entry.nutrients" />
        </p>
        <div class="flex items-center gap-2">
          <button type="submit" class="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-surface disabled:opacity-40" :disabled="!!editError">Save</button>
          <button type="button" class="rounded-lg px-3 py-1.5 text-sm text-red-600 hover:bg-hover dark:text-red-400" @click="remove(editing.id); editing = null">Delete</button>
        </div>
      </form>
    </ModalDialog>
  </section>
</template>
