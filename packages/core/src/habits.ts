// Habits: objects of the built-in Habit type. A check-in is a prop of the habit itself,
// `done:<YYYY-MM-DD>`, so each day is its own synced field: two devices checking different days
// (or different habits) never overwrite each other. The value is checkbox true, or for a habit with
// a daily goal ("8 glasses") the amount reached that day, a number; the day is done once the
// amount reaches the goal. "Repeat on" (weekdays) decides which days count; a day off neither
// adds to nor breaks a streak.
import { HABIT_DAYS_PROPERTY_ID, HABIT_PAUSED_PROPERTY_ID, HABIT_REMIND_PROPERTY_ID, HABIT_TARGET_PROPERTY_ID, HABIT_UNIT_PROPERTY_ID } from './builtin-types.ts'
import type { ObjectSummary, PropertyValue } from './model.ts'
import { addDays } from './time.ts'

type Habit = Pick<ObjectSummary, 'props' | 'createdAt'>

const DONE_PREFIX = 'done:'
/** A day off for the habit whatever its weekdays: set by `habitsWithFood` on days not counted, never stored. */
const OFF_PREFIX = 'off:'
export const habitOffKey = (day: string) => `${OFF_PREFIX}${day}`
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export const habitDoneKey = (day: string) => `${DONE_PREFIX}${day}`
export const DONE_VALUE: PropertyValue = { kind: 'checkbox', value: true }

/** The daily goal of a habit that has one (a number above zero). */
export function habitTarget(habit: Habit): number | undefined {
  const value = habit.props[HABIT_TARGET_PROPERTY_ID]
  return value?.kind === 'number' && value.value > 0 ? value.value : undefined
}

export function habitUnit(habit: Habit): string {
  const value = habit.props[HABIT_UNIT_PROPERTY_ID]
  return value?.kind === 'text' ? value.value.trim() : ''
}

/** The reminder time, "HH:MM", read loosely ("8", "8h", "8:5", "08h30"); undefined without one. */
export function habitRemindAt(habit: Habit): string | undefined {
  const value = habit.props[HABIT_REMIND_PROPERTY_ID]
  const match = value?.kind === 'text' ? /^\s*(\d{1,2})(?:\s*[:hH.]\s*(\d{1,2})?)?\s*$/.exec(value.value) : null
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2] ?? 0)
  if (hours > 23 || minutes > 59) return undefined
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** The amount reached on a day: a number for goals, 1 for a plain check (the goal, once one is set later). */
export function habitValue(habit: Habit, day: string): number {
  return valueOf(habit.props[habitDoneKey(day)], habitTarget(habit))
}

function valueOf(value: PropertyValue | undefined, target: number | undefined): number {
  if (value?.kind === 'number') return Math.max(0, value.value)
  if (value?.kind === 'checkbox' && value.value) return target ?? 1
  return 0
}

/** The prop a day's amount is stored as; undefined clears the day. */
export function habitDayValue(habit: Habit, amount: number): PropertyValue | undefined {
  if (amount <= 0) return undefined
  return habitTarget(habit) ? { kind: 'number', value: amount } : DONE_VALUE
}

export function isHabitDone(habit: Habit, day: string): boolean {
  const target = habitTarget(habit)
  const value = habitValue(habit, day)
  return target ? value >= target : value > 0
}

/** How far along a day is, 0 to 1 (a plain habit is 0 or 1). */
export function habitProgress(habit: Habit, day: string): number {
  const target = habitTarget(habit)
  const value = habitValue(habit, day)
  return target ? Math.min(1, value / target) : value > 0 ? 1 : 0
}

/** Every day the habit was done (the goal reached), oldest first. */
export function habitDays(habit: Habit): string[] {
  const target = habitTarget(habit)
  return Object.entries(habit.props)
    .filter(([key, value]) => key.startsWith(DONE_PREFIX) && (target ? valueOf(value, target) >= target : valueOf(value, target) > 0))
    .map(([key]) => key.slice(DONE_PREFIX.length))
    .sort()
}

/** Every day with something logged, done or not (partial amounts too). */
function loggedDays(habit: Habit): string[] {
  return Object.keys(habit.props)
    .filter((key) => key.startsWith(DONE_PREFIX) && valueOf(habit.props[key], undefined) > 0)
    .map((key) => key.slice(DONE_PREFIX.length))
    .sort()
}

/** Weekday ids ("mon"…) it repeats on; empty means every day. */
export function habitWeekdays(habit: Habit): string[] {
  const value = habit.props[HABIT_DAYS_PROPERTY_ID]
  return value?.kind === 'select' ? value.value : []
}

export function isHabitPaused(habit: Habit): boolean {
  const value = habit.props[HABIT_PAUSED_PROPERTY_ID]
  return value?.kind === 'checkbox' && value.value
}

export function isHabitScheduled(habit: Habit, day: string): boolean {
  if (habit.props[habitOffKey(day)]) return false
  const days = habitWeekdays(habit)
  return !days.length || days.includes(WEEKDAYS[new Date(`${day}T00:00:00.000Z`).getUTCDay()]!)
}

export interface HabitStats {
  /** Scheduled days done in a row up to today (today not done yet does not break it). */
  current: number
  best: number
  total: number
  /** Done / scheduled over the last 30 days (since the habit began, if later); today counts once done. */
  rate30: number
  /** This week (Monday to Sunday): done and scheduled. */
  weekDone: number
  weekScheduled: number
  /** Goals: the average amount per scheduled day over the last 30 days. */
  average30: number
  /** The first day it counts from: the earlier of its creation and its first check-in. */
  since: string
}

/** `createdDay` is the day the habit was made, in the viewer's calendar. */
export function habitStats(habit: Habit, today: string, createdDay = habit.createdAt.slice(0, 10)): HabitStats {
  const done = new Set(habitDays(habit))
  const first = loggedDays(habit)[0]
  const since = first && first < createdDay ? first : createdDay
  const scheduled = (day: string) => isHabitScheduled(habit, day)

  let current = 0
  for (let day = today; day >= since; day = addDays(day, -1)) {
    if (!scheduled(day)) continue
    if (done.has(day)) current++
    else if (day !== today) break
  }

  let best = 0
  let run = 0
  for (let day = since; day <= today; day = addDays(day, 1)) {
    if (!scheduled(day)) continue
    if (done.has(day)) best = Math.max(best, ++run)
    else if (day !== today) run = 0
  }

  let windowDone = 0
  let windowScheduled = 0
  let windowAmount = 0
  for (let day = addDays(today, -29); day <= today; day = addDays(day, 1)) {
    if (day < since || !scheduled(day)) continue
    if (done.has(day)) windowDone++
    if (done.has(day) || day !== today) windowScheduled++
    windowAmount += habitValue(habit, day)
  }

  const monday = addDays(today, -((new Date(`${today}T00:00:00.000Z`).getUTCDay() + 6) % 7))
  let weekDone = 0
  let weekScheduled = 0
  for (let day = monday; day <= addDays(monday, 6); day = addDays(day, 1)) {
    if (!scheduled(day)) continue
    weekScheduled++
    if (done.has(day)) weekDone++
  }

  return {
    current,
    best,
    total: done.size,
    rate30: windowScheduled ? windowDone / windowScheduled : 0,
    weekDone,
    weekScheduled,
    average30: windowScheduled ? windowAmount / windowScheduled : 0,
    since,
  }
}

const amountText = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1))

/** "3/8 glasses" for a day of a habit with a daily goal; '' for a plain one. */
export function habitAmountText(habit: Habit, day: string): string {
  const target = habitTarget(habit)
  if (!target) return ''
  const unit = habitUnit(habit)
  return `${amountText(habitValue(habit, day))}/${amountText(target)}${unit ? ` ${unit}` : ''}`
}
