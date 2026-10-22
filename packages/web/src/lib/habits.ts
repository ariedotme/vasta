// Habits (core's habits.ts): the space's habits, kept fresh, and logging a day: checked on or off,
// or an amount toward a daily goal. A change writes only that day's prop (`done:<day>`), on top of
// the habit as stored. A habit done from food ("From food") has its days worked out from what is
// logged (core's withFood) and is not checked by hand.
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import {
  FOOD_HABIT_DAYS,
  addDays,
  habitAmountText,
  habitDayValue,
  habitDoneKey,
  habitFoodRule,
  habitTarget,
  habitUnit,
  habitValue,
  isHabitDone,
  nutritionDays,
  withFood,
  type ColorName,
  type NutritionDay,
  type ObjectSummary,
} from '@vasta/core'
import { api } from './api.ts'
import { clone } from './clone.ts'
import { onChange } from './events.ts'
import { dayKey } from './actions.ts'
import { formatLongDay } from './format.ts'
import { dailyNotesBetween, useGoals } from './nutrition.ts'
import { promptDialog } from './overlays.ts'
import { lastError, notice, primeFromObject, primeSummaries, systemType } from './state.ts'

export const DEFAULT_HABIT_COLOR: ColorName = 'emerald'

export const habitColor = (habit: Pick<ObjectSummary, 'color'> | undefined): ColorName => habit?.color ?? systemType('habit')?.color ?? DEFAULT_HABIT_COLOR

/**
 * Habits with their days from food, for those done from it (the last FOOD_HABIT_DAYS days of
 * daily notes, loaded when one is in the list and again when a daily note changes).
 */
export function useFoodHabits(habits: Ref<ObjectSummary[]>) {
  const days = ref<NutritionDay[]>([])
  const { goals } = useGoals()
  const linked = computed(() => habits.value.some((h) => habitFoodRule(h)))
  const notes = ref<ObjectSummary[]>([])
  async function load() {
    if (!linked.value) return
    const today = dayKey()
    notes.value = [...(await dailyNotesBetween(addDays(today, -FOOD_HABIT_DAYS), today)).values()]
  }
  watch(linked, load, { immediate: true })
  watch([notes, goals], () => {
    const today = dayKey()
    days.value = linked.value ? nutritionDays(notes.value, goals.value, addDays(today, -FOOD_HABIT_DAYS), today) : []
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = onChange((event) => {
    if (!linked.value || event.kind !== 'object' || event.typeId !== systemType('daily-note')?.id) return
    clearTimeout(timer)
    timer = setTimeout(load, 300)
  })
  onBeforeUnmount(() => {
    stop()
    clearTimeout(timer)
  })
  return computed(() => (days.value.length ? habits.value.map((h) => withFood(h, days.value)) : habits.value))
}

/** A habit done from food can't be checked by hand: say so. */
function fromFood(habit: Pick<ObjectSummary, 'props' | 'title'> | undefined): boolean {
  if (!habit || !habitFoodRule(habit)) return false
  notice.value = { message: `“${habit.title || 'This habit'}” is done from what you log in Food.` }
  return true
}

/** The space's habits, reloaded when one changes anywhere (another page, another device). */
export function useHabits() {
  const habits = ref<ObjectSummary[]>([])
  const loaded = ref(false)
  async function load() {
    const type = systemType('habit')
    if (!type) return
    habits.value = (await api.objectsOfType(type.id)).sort((a, b) => a.title.localeCompare(b.title))
    primeSummaries(habits.value)
    loaded.value = true
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = onChange((event) => {
    if (event.kind !== 'object' || event.typeId !== systemType('habit')?.id) return
    clearTimeout(timer)
    timer = setTimeout(load, 250)
  })
  onBeforeUnmount(() => {
    stop()
    clearTimeout(timer)
  })
  void load()
  return { habits: useFoodHabits(habits), loaded, load }
}

/**
 * Set the amount a habit reached on a day (a plain habit: 1 done, 0 not); `local` (a habit shown on
 * screen) changes at once and goes back if the save fails.
 */
export async function setHabitAmount(habitId: string, day: string, amount: number, local?: ObjectSummary) {
  if (fromFood(local)) return
  const key = habitDoneKey(day)
  const apply = (habit: Pick<ObjectSummary, 'props' | 'createdAt'>, value: number) => {
    const next = habitDayValue(habit, value)
    if (next) habit.props[key] = next
    else delete habit.props[key]
  }
  const before = local ? habitValue(local, day) : 0
  if (local) apply(local, amount)
  try {
    const base = await api.object(habitId)
    const next = clone(base)
    apply(next, amount)
    primeFromObject(await api.saveObject(next, base))
  } catch (error) {
    if (local) apply(local, before)
    lastError.value = (error as Error).message
  }
}

/** Check a plain habit on or off; a goal habit goes to its goal, or back to nothing. */
export function setHabitDone(habit: ObjectSummary, day: string, done: boolean) {
  return setHabitAmount(habit.id, day, done ? (habitTarget(habit) ?? 1) : 0, habit)
}

/** One click on a habit for a day: a plain one toggles, a goal one adds 1 (past the goal it starts over). */
export function stepHabit(habit: ObjectSummary, day: string) {
  if (fromFood(habit)) return
  const target = habitTarget(habit)
  if (!target) return setHabitDone(habit, day, !isHabitDone(habit, day))
  const value = habitValue(habit, day)
  return setHabitAmount(habit.id, day, value >= target ? 0 : value + 1, habit)
}

/** Ask for a day's exact amount (goal habits; right click or long press). */
export async function askHabitAmount(habit: ObjectSummary, day: string) {
  if (fromFood(habit)) return
  const target = habitTarget(habit)
  const unit = habitUnit(habit)
  const answer = await promptDialog({
    title: habit.title || 'Habit',
    message: target ? `How much on ${formatLongDay(`${day}T00:00:00.000Z`)}? The goal is ${target}${unit ? ` ${unit}` : ''}.` : `Done on ${formatLongDay(`${day}T00:00:00.000Z`)}? 1 for yes, 0 for no.`,
    value: String(habitValue(habit, day) || ''),
    placeholder: '0',
    confirmLabel: 'Save',
  })
  if (answer === null) return
  const amount = Number(answer.replace(',', '.'))
  if (!Number.isFinite(amount) || amount < 0) {
    lastError.value = 'Type a number, 0 or more.'
    return
  }
  await setHabitAmount(habit.id, day, target ? amount : amount > 0 ? 1 : 0, habit)
}

/** "3/8 glasses" for a goal habit's day; '' for a plain one. */
export const habitAmountLabel = habitAmountText

export const formatAmount = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1))
