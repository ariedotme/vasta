// Nutrition: a food diary inside a space (docs/data-model.md, "Nutrition"). Foods and recipes are
// objects of built-in types; what was eaten is a prop of the day's daily note, `food:<entry id>`,
// so each entry is its own synced field and devices logging at once never overwrite each other.
// An entry keeps a snapshot of its name and nutrients, so editing a food later does not rewrite
// past days. Goals are objects too, each starting on its own date: the goal of a day is the latest
// one starting on or before it, so a new goal never changes the days before it.
import {
  BRAND_PROPERTY_ID,
  CARBS_PCT_PROPERTY_ID,
  CARBS_PROPERTY_ID,
  FAT_PCT_PROPERTY_ID,
  FAT_PROPERTY_ID,
  FIBER_PROPERTY_ID,
  HABIT_FOOD_PROPERTY_ID,
  INGREDIENTS_PROPERTY_ID,
  KCAL_PROPERTY_ID,
  NUTRITION_TYPE_KEYS,
  PORTIONS_PROPERTY_ID,
  PROTEIN_PCT_PROPERTY_ID,
  PROTEIN_PROPERTY_ID,
  SERVINGS_PROPERTY_ID,
  WEEKLY_PROPERTY_ID,
  YIELD_PROPERTY_ID,
  builtinTypeId,
  createBuiltinTypes,
  habitFoodProperty,
  weekdayKcalPropertyId,
} from './builtin-types.ts'
import { DONE_VALUE, habitDoneKey, habitOffKey, habitTarget } from './habits.ts'
import type {
  FoodEntry,
  FoodPortion,
  Id,
  IsoDateTime,
  Meal,
  NutritionSettings,
  Nutrients,
  ObjectRecord,
  ObjectSummary,
  ObjectType,
  PropertyValue,
  RecipeIngredient,
  Space,
} from './model.ts'
import { findOrCreateDailyNote, newObject } from './operations.ts'
import type { Store } from './store.ts'
import { addDays, instantOf, wallTimeIn } from './time.ts'

type Props = Pick<ObjectSummary, 'props'>
type Source = Pick<ObjectSummary, 'id' | 'spaceId' | 'typeId' | 'title' | 'props' | 'deletedAt'>
type DayNote = Pick<ObjectSummary, 'props' | 'date'>

const FOOD_ENTRY_PREFIX = 'food:'
export const foodEntryKey = (id: Id) => `${FOOD_ENTRY_PREFIX}${id}`

/** A daily note's checkbox prop for a day that does not count (travel, sick): averages and streaks skip it. */
export const NOT_COUNTED_KEY = 'food-not-counted'

export const DEFAULT_MEALS: Meal[] = [
  { id: 'breakfast', name: 'Breakfast', time: '08:00' },
  { id: 'lunch', name: 'Lunch', time: '12:30' },
  { id: 'snack', name: 'Snack', time: '16:00' },
  { id: 'dinner', name: 'Dinner', time: '20:00' },
]

/** On a day off-target by at most this share of the goal's kcal, the day is on target (as Prato). */
export const ON_TARGET_TOLERANCE = 0.05

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const KCAL_PER_GRAM = { protein: 4, carbs: 4, fat: 9 }

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places
const numberProp = (object: Props, id: string): number | undefined => {
  const value = object.props[id]
  return value?.kind === 'number' && Number.isFinite(value.value) ? value.value : undefined
}

// ---------------------------------------------------------------------------
// Settings

export const isNutritionOn = (space: Pick<Space, 'nutrition'> | undefined): boolean => !!space?.nutrition?.enabled

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/** Settings as given by a client, checked: undefined when they are not settings at all. */
export function normalizeNutritionSettings(input: unknown): NutritionSettings | undefined {
  if (!input || typeof input !== 'object') return undefined
  const { enabled, meals } = input as { enabled?: unknown; meals?: unknown }
  if (!Array.isArray(meals)) return undefined
  const seen = new Set<string>()
  const clean: Meal[] = []
  for (const meal of meals as Partial<Meal>[]) {
    const id = typeof meal?.id === 'string' ? meal.id.trim() : ''
    const name = typeof meal?.name === 'string' ? meal.name.trim() : ''
    if (!id || !name || seen.has(id)) continue
    seen.add(id)
    clean.push({ id, name, ...(typeof meal.time === 'string' && TIME_PATTERN.test(meal.time) ? { time: meal.time } : {}) })
  }
  return { enabled: enabled !== false, meals: clean }
}

const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))

/** The meal whose usual time is nearest a time of day ("HH:MM"); the first meal when none has a time. */
export function mealAt(meals: Meal[], time: string): Meal | undefined {
  let best: Meal | undefined
  let distance = Infinity
  for (const meal of meals) {
    if (!meal.time) continue
    const d = Math.abs(minutes(meal.time) - minutes(time))
    if (d < distance) [best, distance] = [meal, d]
  }
  return best ?? meals[0]
}

/** "HH:MM" of an instant in a zone. */
export function timeOfDay(at: IsoDateTime, timeZone: string): string {
  const wall = wallTimeIn(at, timeZone)
  return `${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Foods and recipes

export const isFood = (object: Pick<ObjectSummary, 'spaceId' | 'typeId'>) => object.typeId === builtinTypeId(object.spaceId, 'food')
export const isRecipe = (object: Pick<ObjectSummary, 'spaceId' | 'typeId'>) => object.typeId === builtinTypeId(object.spaceId, 'recipe')

/** A food's nutrients per 100 g; undefined until it has its kcal (the other numbers default to 0). */
export function foodNutrients(food: Props): Nutrients | undefined {
  const kcal = numberProp(food, KCAL_PROPERTY_ID)
  if (kcal === undefined) return undefined
  const fiber = numberProp(food, FIBER_PROPERTY_ID)
  return {
    kcal,
    protein: numberProp(food, PROTEIN_PROPERTY_ID) ?? 0,
    carbs: numberProp(food, CARBS_PROPERTY_ID) ?? 0,
    fat: numberProp(food, FAT_PROPERTY_ID) ?? 0,
    ...(fiber !== undefined ? { fiber } : {}),
  }
}

export function foodBrand(food: Props): string {
  const value = food.props[BRAND_PROPERTY_ID]
  return value?.kind === 'text' ? value.value.trim() : ''
}

export function foodPortions(food: Props): FoodPortion[] {
  const value = food.props[PORTIONS_PROPERTY_ID]
  return value?.kind === 'portions' ? value.value.filter((p) => p.name.trim() && p.grams > 0) : []
}

export function recipeIngredients(recipe: Props): RecipeIngredient[] {
  const value = recipe.props[INGREDIENTS_PROPERTY_ID]
  return value?.kind === 'ingredients' ? value.value.filter((i) => i.id && i.grams > 0) : []
}

export const portionsValue = (portions: FoodPortion[]): PropertyValue => ({ kind: 'portions', value: portions })
export const ingredientsValue = (ingredients: RecipeIngredient[]): PropertyValue => ({ kind: 'ingredients', value: ingredients })

export function scaleNutrients(per100: Nutrients, grams: number): Nutrients {
  const f = grams / 100
  return {
    kcal: round(per100.kcal * f),
    protein: round(per100.protein * f),
    carbs: round(per100.carbs * f),
    fat: round(per100.fat * f),
    ...(per100.fiber !== undefined ? { fiber: round(per100.fiber * f) } : {}),
  }
}

export function sumNutrients(list: (Nutrients | undefined)[]): Nutrients {
  const total: Nutrients = { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  let fiber: number | undefined
  for (const n of list) {
    if (!n) continue
    total.kcal += n.kcal
    total.protein += n.protein
    total.carbs += n.carbs
    total.fat += n.fat
    if (n.fiber !== undefined) fiber = (fiber ?? 0) + n.fiber
  }
  return {
    kcal: round(total.kcal),
    protein: round(total.protein),
    carbs: round(total.carbs),
    fat: round(total.fat),
    ...(fiber !== undefined ? { fiber: round(fiber) } : {}),
  }
}

export interface RecipeFacts {
  /** The ingredients' total weight. */
  ingredientGrams: number
  /** Its weight once made: the cooked weight, else the ingredients' total. */
  grams: number
  /** The whole recipe, from the ingredients that have nutrition data; undefined when none has. */
  total?: Nutrients
  per100?: Nutrients
  /** The grams of one serving, when it has servings. */
  servingGrams?: number
  /** Ingredients without nutrition data (deleted, or no kcal yet), so the totals are short. */
  missing: Id[]
}

/**
 * A recipe's nutrients, from its ingredients as they are now (a recipe is never snapshotted: it
 * changes with its foods). An ingredient may be another recipe; one that contains itself counts
 * as missing.
 */
export function recipeFacts(recipe: Source, lookup: (id: Id) => Source | undefined, seen: Set<Id> = new Set()): RecipeFacts {
  const inside = new Set([...seen, recipe.id])
  const ingredients = recipeIngredients(recipe)
  const missing: Id[] = []
  const parts: Nutrients[] = []
  for (const ingredient of ingredients) {
    const source = lookup(ingredient.id)
    const per100 = source && !source.deletedAt && !inside.has(source.id) ? sourcePer100(source, lookup, inside) : undefined
    if (per100) parts.push(scaleNutrients(per100, ingredient.grams))
    else missing.push(ingredient.id)
  }
  const ingredientGrams = round(ingredients.reduce((sum, i) => sum + i.grams, 0))
  const cooked = numberProp(recipe, YIELD_PROPERTY_ID)
  const grams = cooked && cooked > 0 ? cooked : ingredientGrams
  const servings = numberProp(recipe, SERVINGS_PROPERTY_ID)
  const total = parts.length ? sumNutrients(parts) : undefined
  return {
    ingredientGrams,
    grams,
    ...(total ? { total } : {}),
    ...(total && grams > 0 ? { per100: scaleNutrients(total, 10_000 / grams) } : {}),
    ...(servings && servings > 0 && grams > 0 ? { servingGrams: round(grams / servings) } : {}),
    missing,
  }
}

function sourcePer100(source: Source, lookup: (id: Id) => Source | undefined, seen: Set<Id>): Nutrients | undefined {
  return isRecipe(source) ? recipeFacts(source, lookup, seen).per100 : foodNutrients(source)
}

/** What a food or recipe can be logged by besides grams: its portions, or a recipe's serving. */
export function sourcePortions(source: Source, lookup: (id: Id) => Source | undefined): FoodPortion[] {
  if (!isRecipe(source)) return foodPortions(source)
  const serving = recipeFacts(source, lookup).servingGrams
  return serving ? [{ name: 'serving', grams: serving }] : []
}

// ---------------------------------------------------------------------------
// Amounts: "150", "150 g", "0.5 kg", "2 slices", "1/2 cup", "half a cup", "1 serving"

const GRAM_UNITS: Record<string, number> = {
  g: 1, gr: 1, grs: 1, gram: 1, grams: 1,
  kg: 1000, kgs: 1000, kilo: 1000, kilos: 1000,
  // Millilitres as grams: close for most drinks; a portion ("1 glass = 250 g") is exact.
  ml: 1, l: 1000, liter: 1000, liters: 1000, litre: 1000, litres: 1000,
}
const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, half: 0.5, two: 2, three: 3,
}
const FRACTIONS: Record<string, number> = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 }
/** Words for a recipe's serving, besides the portion's own name. */
const SERVING_WORDS = new Set(['serving', 'portion'])

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()

/** A word in the singular, roughly, so "2 slices" finds "slice". */
function singular(word: string): string {
  if (word.length <= 3 || word.endsWith('ss')) return word
  for (const [from, to] of [['ies', 'y'], ['sses', 'ss'], ['ches', 'ch'], ['shes', 'sh'], ['oes', 'o']] as const) {
    if (word.endsWith(from)) return word.slice(0, -from.length) + to
  }
  return word.endsWith('s') ? word.slice(0, -1) : word
}

const portionKey = (name: string) => fold(name).split(' ').map(singular).join(' ')

export interface ParsedAmount {
  grams: number
  /** As it is shown: "150 g", "2 slices". */
  amount: string
}

export class AmountError extends Error {}

/** Read the quantity in front: "2", "1.5", "1/2", "1 1/2", "½", "half"; 1 when there is none. */
function readQuantity(text: string): { quantity: number; rest: string; given: boolean } {
  const fraction = /^(\d+)\s+(\d+)\/(\d+)\b\s*/.exec(text) ?? undefined
  if (fraction) return { quantity: Number(fraction[1]) + Number(fraction[2]) / Number(fraction[3]), rest: text.slice(fraction[0].length), given: true }
  const ratio = /^(\d+)\/(\d+)\b\s*/.exec(text)
  if (ratio) return { quantity: Number(ratio[1]) / Number(ratio[2]), rest: text.slice(ratio[0].length), given: true }
  const number = /^(\d+(?:[.,]\d+)?)\s*/.exec(text)
  if (number) return { quantity: Number(number[1]!.replace(',', '.')), rest: text.slice(number[0].length), given: true }
  const symbol = FRACTIONS[text[0] ?? '']
  if (symbol !== undefined) return { quantity: symbol, rest: text.slice(1).trim(), given: true }
  const word = /^(\S+)\s*/.exec(fold(text))
  const value = word ? NUMBER_WORDS[word[1]!] : undefined
  // "half a cup": the article belongs to the number.
  if (word && value !== undefined) return { quantity: value, rest: text.trim().split(/\s+/).slice(1).join(' ').replace(/^an?\s+(?=\S)/i, value === 0.5 ? '' : '$&'), given: true }
  return { quantity: 1, rest: text.trim(), given: false }
}

const formatQuantity = (value: number) => String(round(value, 2))

/**
 * The grams of an amount as typed, against a food's portions. A bare number is grams; a portion
 * matches by name ignoring case, accents and plurals, or by the start of its name when only one
 * portion starts that way. Throws AmountError when the unit is not one of them.
 */
export function parseAmount(text: string, portions: FoodPortion[]): ParsedAmount {
  const typed = text.replace(/\s+/g, ' ').trim()
  if (!typed) throw new AmountError('type an amount, e.g. 150 g')
  const { quantity, rest, given } = readQuantity(typed)
  if (!(quantity > 0) || !Number.isFinite(quantity)) throw new AmountError('the amount must be more than 0')
  const unit = fold(rest).replace(/^of\s+/, '')
  if (!unit) {
    if (!given) throw new AmountError('type an amount, e.g. 150 g')
    return { grams: round(quantity), amount: `${formatQuantity(quantity)} g` }
  }
  const perUnit = GRAM_UNITS[unit]
  if (perUnit !== undefined) return { grams: round(quantity * perUnit), amount: `${formatQuantity(quantity)} ${rest}` }
  const key = portionKey(unit)
  const serving = SERVING_WORDS.has(key) ? portions.find((p) => p.name === 'serving') : undefined
  const exact = serving ?? portions.find((p) => portionKey(p.name) === key)
  const starting = portions.filter((p) => portionKey(p.name).startsWith(key))
  const portion = exact ?? (starting.length === 1 ? starting[0] : undefined)
  if (!portion) {
    const known = portions.map((p) => p.name).join(', ')
    throw new AmountError(known ? `"${rest}" is not a portion of it (${known}); or type grams` : `it has no portion "${rest}"; type grams, or add the portion to it`)
  }
  return { grams: round(quantity * portion.grams), amount: `${formatQuantity(quantity)} ${rest}` }
}

// ---------------------------------------------------------------------------
// Entries

export class NutritionError extends Error {}

/** A new entry of a food or recipe (a snapshot of it as it is now). */
export function entryOf(source: Source, amountText: string, lookup: (id: Id) => Source | undefined, at: IsoDateTime, meal?: Id): FoodEntry {
  if (!isFood(source) && !isRecipe(source)) throw new NutritionError('only foods and recipes can be logged')
  const { grams, amount } = parseAmount(amountText, sourcePortions(source, lookup))
  const per100 = sourcePer100(source, lookup, new Set())
  return {
    sourceId: source.id,
    name: source.title,
    amount,
    grams,
    ...(meal ? { meal } : {}),
    at,
    ...(per100 ? { nutrients: scaleNutrients(per100, grams) } : {}),
  }
}

/**
 * An entry's snapshot taken again from its food as it is now ("Update from the food"): its amount
 * read against the food's portions now (an entry logged before the portion existed gets its
 * grams), and its nutrients.
 */
export function refreshEntry(entry: FoodEntry, lookup: (id: Id) => Source | undefined): FoodEntry {
  const source = entry.sourceId ? lookup(entry.sourceId) : undefined
  if (!source || source.deletedAt) return entry
  let grams = entry.grams
  try {
    grams = parseAmount(entry.amount, sourcePortions(source, lookup)).grams
  } catch {}
  const per100 = sourcePer100(source, lookup, new Set())
  const { nutrients: _old, ...rest } = entry
  return { ...rest, name: source.title, grams, ...(per100 && grams > 0 ? { nutrients: scaleNutrients(per100, grams) } : {}) }
}

export interface DayEntry {
  id: Id
  entry: FoodEntry
}

/** The entries of a daily note, in the order they were eaten. */
export function dayEntries(note: Props): DayEntry[] {
  const entries: DayEntry[] = []
  for (const [key, value] of Object.entries(note.props)) {
    if (key.startsWith(FOOD_ENTRY_PREFIX) && value?.kind === 'food-entry') entries.push({ id: key.slice(FOOD_ENTRY_PREFIX.length), entry: value.value })
  }
  return entries.sort((a, b) => a.entry.at.localeCompare(b.entry.at) || a.id.localeCompare(b.id))
}

export const isDayCounted = (note: Props | undefined) => !(note?.props[NOT_COUNTED_KEY]?.kind === 'checkbox' && note.props[NOT_COUNTED_KEY].value)

export interface MealGroup {
  meal: Meal
  entries: DayEntry[]
  totals: Nutrients
}

/**
 * A day's entries under the space's meals, in the meals' order. An entry whose meal is gone (or
 * that has none) goes to the meal nearest its time.
 */
export function groupByMeal(entries: DayEntry[], meals: Meal[], timeZone: string): MealGroup[] {
  const groups = meals.map((meal) => ({ meal, entries: [] as DayEntry[] }))
  const byId = new Map(groups.map((g) => [g.meal.id, g]))
  for (const item of entries) {
    const group = (item.entry.meal ? byId.get(item.entry.meal) : undefined) ?? byId.get(mealAt(meals, timeOfDay(item.entry.at, timeZone))?.id ?? '')
    group?.entries.push(item)
  }
  return groups.map((g) => ({ ...g, totals: sumNutrients(g.entries.map((e) => e.entry.nutrients)) }))
}

export const dayTotals = (entries: DayEntry[]) => sumNutrients(entries.map((e) => e.entry.nutrients))

/** How often a food or recipe was logged, and the last day, from the space's daily notes. */
export function sourceUsage(notes: DayNote[], sourceId: Id): { count: number; lastDay?: string } {
  let count = 0
  let lastDay: string | undefined
  for (const note of notes) {
    const day = note.date?.start.slice(0, 10)
    const n = dayEntries(note).filter((e) => e.entry.sourceId === sourceId).length
    if (!n || !day) continue
    count += n
    if (!lastDay || day > lastDay) lastDay = day
  }
  return { count, ...(lastDay ? { lastDay } : {}) }
}

/** Foods and recipes logged in the last days, most often first (then most recently). */
export function frequentSources(notes: DayNote[], since: string): Id[] {
  const stats = new Map<Id, { count: number; last: string }>()
  for (const note of notes) {
    const day = note.date?.start.slice(0, 10)
    if (!day || day < since) continue
    for (const { entry } of dayEntries(note)) {
      if (!entry.sourceId) continue
      const s = stats.get(entry.sourceId) ?? { count: 0, last: '' }
      s.count++
      if (entry.at > s.last) s.last = entry.at
      stats.set(entry.sourceId, s)
    }
  }
  return [...stats].sort(([, a], [, b]) => b.count - a.count || b.last.localeCompare(a.last)).map(([id]) => id)
}

// ---------------------------------------------------------------------------
// Goals

export interface NutritionGoal {
  id: Id
  /** The day it starts. */
  start: string
  kcal: number
  /** Kcal on some weekdays ("mon"…) instead of `kcal`. */
  weekdays: Record<string, number>
  /** Percent of the kcal; absent when not set. */
  split?: { protein: number; carbs: number; fat: number }
  /** The week (Monday to Sunday) shares one budget, the sum of its days' goals. */
  weekly: boolean
}

/** A goal object read; undefined without a start date or daily kcal. */
export function readGoal(object: Pick<ObjectSummary, 'id' | 'props' | 'date' | 'deletedAt'>): NutritionGoal | undefined {
  const kcal = numberProp(object, KCAL_PROPERTY_ID)
  const start = object.date?.start.slice(0, 10)
  if (object.deletedAt || !start || !kcal || kcal <= 0) return undefined
  const weekdays: Record<string, number> = {}
  for (const day of WEEKDAYS) {
    const value = numberProp(object, weekdayKcalPropertyId(day))
    if (value && value > 0) weekdays[day] = value
  }
  const protein = numberProp(object, PROTEIN_PCT_PROPERTY_ID)
  const carbs = numberProp(object, CARBS_PCT_PROPERTY_ID)
  const fat = numberProp(object, FAT_PCT_PROPERTY_ID)
  const split = protein !== undefined || carbs !== undefined || fat !== undefined ? { protein: protein ?? 0, carbs: carbs ?? 0, fat: fat ?? 0 } : undefined
  const weekly = object.props[WEEKLY_PROPERTY_ID]
  return { id: object.id, start, kcal, weekdays, ...(split ? { split } : {}), weekly: weekly?.kind === 'checkbox' && weekly.value }
}

/** The goals of a list of goal objects, oldest start first (the same start: the later made wins). */
export const readGoals = (objects: Pick<ObjectSummary, 'id' | 'props' | 'date' | 'deletedAt' | 'createdAt'>[]): NutritionGoal[] =>
  objects
    .filter((o) => readGoal(o))
    .sort((a, b) => a.date!.start.localeCompare(b.date!.start) || a.createdAt.localeCompare(b.createdAt))
    .map((o) => readGoal(o)!)

export const weekdayOf = (day: string) => WEEKDAYS[new Date(`${day}T00:00:00.000Z`).getUTCDay()]!

/** A day's goal: kcal and, with a split, grams of each macronutrient. */
export interface DayGoal {
  goalId: Id
  kcal: number
  protein?: number
  carbs?: number
  fat?: number
  weekly: boolean
}

/** The goal of a day: the latest one starting on or before it (`goals` oldest first, as readGoals). */
export function goalForDay(goals: NutritionGoal[], day: string): DayGoal | undefined {
  let goal: NutritionGoal | undefined
  for (const g of goals) if (g.start <= day) goal = g
  if (!goal) return undefined
  const kcal = goal.weekdays[weekdayOf(day)] ?? goal.kcal
  const grams = (pct: number, perGram: number) => round((kcal * pct) / 100 / perGram, 1)
  return {
    goalId: goal.id,
    kcal,
    ...(goal.split
      ? { protein: grams(goal.split.protein, KCAL_PER_GRAM.protein), carbs: grams(goal.split.carbs, KCAL_PER_GRAM.carbs), fat: grams(goal.split.fat, KCAL_PER_GRAM.fat) }
      : {}),
    weekly: goal.weekly,
  }
}

export const isOnTarget = (kcal: number, goal: number) => goal > 0 && Math.abs(kcal - goal) / goal <= ON_TARGET_TOLERANCE

/** Monday of the week a day is in. */
export const weekStart = (day: string) => addDays(day, -((new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7))

export interface WeekBudget {
  /** Monday and Sunday. */
  start: string
  end: string
  /** The sum of the week's daily goals. */
  target: number
  /** Eaten in the whole week so far, and on the days before `day`. */
  eaten: number
  eatenBefore: number
  remaining: number
  /**
   * What `day` may take so the week ends on budget: what is left for the week from `day` on,
   * shared among the days left in proportion to their own goals.
   */
  allowance: number
}

/**
 * The week's budget around a day, when the day's goal shares its week (`weekly`). Days not
 * counted still count here: what was eaten was eaten (as Prato).
 */
export function weekBudget(goals: NutritionGoal[], day: string, kcalOn: (day: string) => number): WeekBudget | undefined {
  if (!goalForDay(goals, day)?.weekly) return undefined
  const start = weekStart(day)
  const end = addDays(start, 6)
  let target = 0
  let eaten = 0
  let eatenBefore = 0
  let goalsLeft = 0
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const goal = goalForDay(goals, d)?.kcal ?? 0
    const kcal = kcalOn(d)
    target += goal
    eaten += kcal
    if (d < day) eatenBefore += kcal
    else goalsLeft += goal
  }
  const todayGoal = goalForDay(goals, day)!.kcal
  const allowance = goalsLeft > 0 ? ((target - eatenBefore) * todayGoal) / goalsLeft : 0
  return { start, end, target: round(target), eaten: round(eaten), eatenBefore: round(eatenBefore), remaining: round(target - eaten), allowance: round(Math.max(0, allowance), 0) }
}

// ---------------------------------------------------------------------------
// History

export interface NutritionDay {
  day: string
  totals: Nutrients
  entries: number
  counted: boolean
  goal?: DayGoal
}

/** Every day from `from` to `to`, from the space's daily notes (any order; days without one are empty). */
export function nutritionDays(notes: DayNote[], goals: NutritionGoal[], from: string, to: string): NutritionDay[] {
  const byDay = new Map<string, DayNote>()
  for (const note of notes) {
    const day = note.date?.start.slice(0, 10)
    if (day && day >= from && day <= to) byDay.set(day, note)
  }
  const days: NutritionDay[] = []
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const note = byDay.get(day)
    const entries = note ? dayEntries(note) : []
    const goal = goalForDay(goals, day)
    days.push({ day, totals: dayTotals(entries), entries: entries.length, counted: isDayCounted(note), ...(goal ? { goal } : {}) })
  }
  return days
}

export interface NutritionStats {
  /** Days counted with something logged. */
  loggedDays: number
  /** Their average. */
  average: Nutrients
  /** Of them, the days with a goal that were on target. */
  onTarget: number
  /** Days on target in a row up to today; days not counted are skipped, today not on target yet does not break it. */
  currentStreak: number
  bestStreak: number
}

/** Averages and streaks over days from nutritionDays (oldest first). */
export function nutritionStats(days: NutritionDay[], today: string): NutritionStats {
  const logged = days.filter((d) => d.counted && d.entries > 0 && d.day <= today)
  const sum = sumNutrients(logged.map((d) => d.totals))
  const n = logged.length || 1
  const hit = (d: NutritionDay) => d.entries > 0 && !!d.goal && isOnTarget(d.totals.kcal, d.goal.kcal)
  let best = 0
  let run = 0
  for (const d of days) {
    if (d.day > today || !d.counted) continue
    if (hit(d)) best = Math.max(best, ++run)
    else if (d.day !== today) run = 0
  }
  let current = 0
  for (const d of [...days].reverse()) {
    if (d.day > today || !d.counted) continue
    if (hit(d)) current++
    else if (d.day !== today) break
  }
  return {
    loggedDays: logged.length,
    average: {
      kcal: round(sum.kcal / n, 0),
      protein: round(sum.protein / n, 1),
      carbs: round(sum.carbs / n, 1),
      fat: round(sum.fat / n, 1),
      ...(sum.fiber !== undefined ? { fiber: round(sum.fiber / n, 1) } : {}),
    },
    onTarget: logged.filter(hit).length,
    currentStreak: current,
    bestStreak: best,
  }
}

// ---------------------------------------------------------------------------
// Store operations, shared by the server's routes and the device's local store.

/**
 * Turn food tracking on in a space: the Food, Recipe and Nutrition goal types are made (or come
 * back from the trash) and the space keeps its meals (the default ones the first time). Turning
 * it off only hides it: the types and everything logged stay.
 */
export function setNutritionEnabled(store: Store, spaceId: Id, enabled: boolean, at: IsoDateTime): { space: Space; types: ObjectType[] } {
  return store.transaction(() => {
    const space = store.getSpace(spaceId)
    if (!space) throw new NutritionError('not found')
    const types: ObjectType[] = []
    if (enabled) {
      for (const made of createBuiltinTypes(spaceId, at, NUTRITION_TYPE_KEYS)) {
        const existing = store.getType(made.id)
        if (!existing) store.putType(made)
        else if (existing.deletedAt) store.restoreType(made.id, at)
        types.push(store.getType(made.id)!)
      }
      // Habits can be done from what is logged ("Protein, at least" 150 g): the first time only, so
      // a property the user deleted stays deleted.
      const habit = !space.nutrition ? addHabitFoodProperty(store, spaceId, at) : undefined
      if (habit) types.push(habit)
    }
    const next: Space = { ...space, nutrition: { enabled, meals: space.nutrition?.meals ?? structuredClone(DEFAULT_MEALS) } }
    store.putSpace(next)
    return { space: next, types }
  })
}

/** Give a space's Habit type the "From food" property, when it lacks it. Returns the type changed. */
export function addHabitFoodProperty(store: Store, spaceId: Id, at: IsoDateTime): ObjectType | undefined {
  const habit = store.getType(builtinTypeId(spaceId, 'habit'))
  if (!habit || habit.properties.some((p) => p.id === HABIT_FOOD_PROPERTY_ID)) return undefined
  const properties = [...habit.properties]
  const body = properties.findIndex((p) => p.kind === 'rich-text')
  properties.splice(body < 0 ? properties.length : body, 0, habitFoodProperty())
  store.putType({ ...habit, properties, updatedAt: at })
  return store.getType(habit.id)
}

export interface LogFoodInput {
  /** The food or recipe. */
  sourceId: Id
  /** "150 g", "2 slices"… */
  amount: string
  /** The day's daily note it goes to ("YYYY-MM-DD"). */
  day: string
  /** A meal id; by default the meal nearest the time it was eaten. */
  meal?: Id
  /** When it was eaten; now by default. */
  at?: IsoDateTime
  timeZone: string
}

/** Log something eaten on a day's daily note (made if needed). Returns the note and the entry's id. */
export function logFood(store: Store, spaceId: Id, input: LogFoodInput, now: IsoDateTime, id: Id = crypto.randomUUID()): { note: ObjectRecord; entryId: Id; entry: FoodEntry } {
  const space = store.getSpace(spaceId)
  if (!space) throw new NutritionError('not found')
  const meals = space.nutrition?.meals ?? DEFAULT_MEALS
  const source = store.getObjectSummaries([input.sourceId])[0]
  if (!source || source.spaceId !== spaceId || source.deletedAt) throw new NutritionError('food not found')
  const lookup = (ref: Id) => store.getObjectSummaries([ref])[0]
  const at = input.at ?? now
  const meal = input.meal && meals.some((m) => m.id === input.meal) ? input.meal : mealAt(meals, timeOfDay(at, input.timeZone))?.id
  let entry: FoodEntry
  try {
    entry = entryOf(source, input.amount, lookup, at, meal)
  } catch (error) {
    if (error instanceof AmountError) throw new NutritionError(error.message)
    throw error
  }
  return store.transaction(() => {
    const { note } = findOrCreateDailyNote(store, spaceId, input.day, now)
    const saved = store.putObject({ ...note, props: { ...note.props, [foodEntryKey(id)]: { kind: 'food-entry', value: entry } }, updatedAt: now })
    return { note: saved, entryId: id, entry }
  })
}

/** Remove an entry from its daily note. Undefined when it is not there. */
export function deleteFoodEntry(store: Store, noteId: Id, entryId: Id, now: IsoDateTime): ObjectRecord | undefined {
  const note = store.getObject(noteId)
  const key = foodEntryKey(entryId)
  if (!note || !note.props[key]) return undefined
  const { [key]: _gone, ...props } = note.props
  return store.putObject({ ...note, props, updatedAt: now })
}

// ---------------------------------------------------------------------------
// A line of food: "/food 2 slices of bread, coffee 200 ml at breakfast" or "/food rice 150g lunch
// yesterday". Items are separated by commas, semicolons or lines; each is a food or recipe and an
// amount, before ("2 slices of bread", "150 g rice", "2 eggs") or after it ("rice 150g", "bread 2
// slices"). A meal at the end ("at lunch", "dinner") or in front ("lunch: …") and
// "yesterday"/"today" at the end set where and when. A food the space does not have is made
// without nutrition data; an amount that can't be worked out yet (no such portion) is logged
// without grams: both show as needing data until the food is filled in and the entry updated from
// it. An item with kcal ("muffin ~350 kcal") is a quick entry, without a food.

const FOOD_COMMAND = /^\/food(?:@\w+)?(?:\s+|$)/i
const BARE_COUNT = /^[\d.,/½¼¾⅓⅔\s]+$/

/** The rest of a text that starts with /food; undefined for any other text. */
export function foodCommand(text: string): string | undefined {
  const match = FOOD_COMMAND.exec(text.trimStart())
  return match ? text.trimStart().slice(match[0].length) : undefined
}

/** Other names for the default meals, which still work after they are renamed. */
const MEAL_ALIASES: Record<Id, string[]> = {
  breakfast: ['breakfast'],
  lunch: ['lunch'],
  snack: ['snack'],
  dinner: ['dinner', 'supper'],
}
const MEAL_PREPOSITIONS = ['at', 'for', 'in', 'at the', 'for the']
const LINE_DAYS: Record<string, number> = { today: 0, yesterday: -1 }
const CONNECTORS = new Set(['of'])

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean)

function mealNames(meal: Meal): string[] {
  return [...new Set([fold(meal.name), ...(MEAL_ALIASES[meal.id] ?? [])])].sort((a, b) => b.length - a.length)
}

/**
 * A meal named at the end of a line, with what comes before it. Without "at"/"for" in front, a
 * name that is also a food or follows "and" is the food.
 */
function trailingMeal(text: string, meals: Meal[], isFoodName: (name: string) => boolean): { meal: Meal; rest: string } | undefined {
  const folded = fold(text)
  let best: { meal: Meal; rest: string; length: number } | undefined
  for (const meal of meals) {
    for (const name of mealNames(meal)) {
      if (!(folded === name || folded.endsWith(` ${name}`))) continue
      let cut = folded.length - name.length
      let before = folded.slice(0, cut).trimEnd()
      const prep = MEAL_PREPOSITIONS.find((p) => before === p || before.endsWith(` ${p}`))
      if (prep) before = before.slice(0, before.length - prep.length).trimEnd()
      else if (isFoodName(name) || /(^|\s)and$|,$/.test(before)) continue
      cut = before.length
      // The meal must leave something to eat: "/food snack" is a food called snack.
      if (!before.replace(/[,;\s]/g, '')) continue
      const length = folded.length - cut
      if (!best || length > best.length) best = { meal, rest: text.slice(0, cut), length }
    }
  }
  return best && { meal: best.meal, rest: best.rest }
}

/** A meal named in front, "lunch: …" or "lunch - …". */
function leadingMeal(text: string, meals: Meal[]): { meal: Meal; rest: string } | undefined {
  const match = /^([^:,;\n]{1,30})\s*(?::|\s-)\s+/.exec(text)
  if (!match) return undefined
  const meal = meals.find((m) => mealNames(m).includes(fold(match[1]!)))
  return meal && { meal, rest: text.slice(match[0].length) }
}

type Resolved = { source?: Source; candidates: Source[] }

/** The food or recipe a name means: the same name (or alias) ignoring case, accents and plurals, else the only one that starts with it or has all its words. */
function resolveSource(name: string, sources: Source[]): Resolved {
  const key = portionKey(name)
  if (!key) return { candidates: [] }
  const names = (s: Source & { aliases?: string[] }) => [s.title, ...(s.aliases ?? [])].map(portionKey)
  const exact = sources.filter((s) => names(s).includes(key))
  if (exact.length) return { source: exact.find(isFood) ?? exact[0]!, candidates: exact }
  const starting = sources.filter((s) => names(s).some((n) => n.startsWith(`${key} `)))
  if (starting.length === 1) return { source: starting[0]!, candidates: starting }
  const parts = key.split(' ')
  const containing = sources.filter((s) => names(s).some((n) => parts.every((p) => n.split(' ').includes(p))))
  if (containing.length === 1) return { source: containing[0]!, candidates: containing }
  return { candidates: starting.length ? starting : containing }
}

/** Whether `unit` is something an amount of `source` can be in: grams, a serving, one of its portions. */
function knownUnit(unit: string, source: Source | undefined, lookup: (id: Id) => Source | undefined): boolean {
  const key = portionKey(unit)
  if (GRAM_UNITS[fold(unit)] !== undefined || SERVING_WORDS.has(key)) return true
  return !!source && sourcePortions(source, lookup).some((p) => portionKey(p.name) === key || portionKey(p.name).startsWith(key))
}

export interface FoodLineItem {
  /** The item as written. */
  text: string
  /** The food it names, as written. */
  name: string
  /** The amount as written ("2 slices", "150g"); a count alone ("2") means that many of its first portion. */
  amount: string
  source?: Source
  /** Several foods match the name and none exactly: the item is not logged. */
  ambiguous?: Source[]
  /** A quick entry ("muffin 350 kcal"): these numbers, logged without a food. */
  nutrients?: Nutrients
}

export interface ParsedFoodLine {
  items: FoodLineItem[]
  meal?: Meal
  day: string
}

/** Split one item into the food it names and its amount. */
function readItem(text: string, sources: Source[], lookup: (id: Id) => Source | undefined): FoodLineItem {
  const all = words(text)
  const { given, rest } = readQuantity(text.trim())
  // In front: "2 slices of bread", "150 g rice", "2 eggs", "half a cup of rice".
  if (given && rest) {
    const quantity = text.trim().slice(0, text.trim().length - rest.length).trim()
    const restWords = words(rest)
    let fallback: FoodLineItem | undefined
    for (let u = 0; u <= Math.min(3, restWords.length - 1); u++) {
      const unit = restWords.slice(0, u).join(' ')
      let nameWords = restWords.slice(u)
      const connected = CONNECTORS.has(fold(nameWords[0] ?? '')) && nameWords.length > 1
      if (connected) nameWords = nameWords.slice(1)
      const name = nameWords.join(' ')
      const { source, candidates } = resolveSource(name, sources)
      const item: FoodLineItem = { text, name, amount: u ? `${quantity} ${unit}` : quantity, ...(source ? { source } : {}), ...(!source && candidates.length > 1 ? { ambiguous: candidates } : {}) }
      if (source && (u === 0 || knownUnit(unit, source, lookup))) return item
      // Not found: "2 slices of bread" (a connector after the unit) or "150 g rice" (a weight) read best.
      if (!fallback && u > 0 && (connected || GRAM_UNITS[fold(unit)] !== undefined)) fallback = item
    }
    return fallback ?? { text, name: rest, amount: quantity, ...ambiguity(rest, sources) }
  }
  // After it: "rice 150g", "bread 2 slices", "coffee 200 ml".
  const at = all.findIndex((w, i) => i > 0 && /^(\d|[½¼¾⅓⅔])/.test(w))
  if (at > 0) {
    const name = all.slice(0, at).join(' ')
    const { source } = resolveSource(name, sources)
    return { text, name, amount: all.slice(at).join(' '), ...(source ? { source } : ambiguity(name, sources)) }
  }
  // No amount: one of its first portion (or serving), when it has one.
  const { source } = resolveSource(text, sources)
  return { text, name: text.trim(), amount: '', ...(source ? { source } : ambiguity(text, sources)) }
}

function ambiguity(name: string, sources: Source[]): Partial<FoodLineItem> {
  const { candidates } = resolveSource(name, sources)
  return candidates.length > 1 ? { ambiguous: candidates } : {}
}

// Quick entries: "muffin ~350 kcal", "300 kcal", "lunch plate 650 kcal 35 g of protein" log the
// numbers as they are, without a food, for when what it was exactly is not known.

const KCAL_WORDS = new Set(['kcal', 'kcals', 'cal', 'cals', 'calorie', 'calories'])
const MACRO_WORDS: Record<string, 'protein' | 'carbs' | 'fat' | 'fiber'> = {}
for (const [key, names] of Object.entries({
  protein: ['prot', 'protein', 'proteins'],
  carbs: ['carb', 'carbs', 'carbohydrate', 'carbohydrates'],
  fat: ['fat', 'fats'],
  fiber: ['fiber', 'fibre'],
}) as ['protein' | 'carbs' | 'fat' | 'fiber', string[]][]) {
  for (const name of names) MACRO_WORDS[name] = key
}
const APPROXIMATELY = new Set(['~', '≈', 'about', 'around', 'approx'])

/** "350", "~350", "1,200" (thousands), "12.5"; undefined when the word is not a number. */
function quickNumber(word: string): number | undefined {
  const digits = word.replace(/^[~≈]/, '')
  if (/^\d{1,3}(,\d{3})+$/.test(digits)) return Number(digits.replace(/,/g, ''))
  return /^\d+([.,]\d+)?$/.test(digits) ? Number(digits.replace(',', '.')) : undefined
}

/**
 * The numbers of a quick entry and the name around them: a kcal ("350 kcal", "~350kcal") and,
 * optionally, grams of protein, carbs, fat or fiber ("35 g of protein", "20g carbs", "fat 10g").
 * Undefined without a kcal: then it is a food and an amount.
 */
export function readQuickEntry(text: string): { name: string; nutrients: Nutrients } | undefined {
  const all = words(text)
  const keep: string[] = []
  const nutrients: Nutrients = { kcal: 0, protein: 0, carbs: 0, fat: 0 }
  let kcal: number | undefined
  // Words without the brackets around them: "cake (~420 kcal)".
  const bare = (index: number) => fold(all[index] ?? '').replace(/^[(\[]+|[)\].!]+$/g, '')
  for (let i = 0; i < all.length; i++) {
    const word = bare(i)
    const next = bare(i + 1)
    // "350 kcal", "350kcal"
    const joined = /^([~≈]?[\d.,]+)([a-z]+)$/.exec(word)
    const value = quickNumber(word) ?? (joined ? quickNumber(joined[1]!) : undefined)
    const unit = joined && quickNumber(word) === undefined ? joined[2]! : next
    if (value !== undefined && KCAL_WORDS.has(unit)) {
      kcal = (kcal ?? 0) + value
      if (unit === next) i++
      continue
    }
    // "35 g of protein", "35g protein", "35 protein"
    const attached = joined && quickNumber(word) === undefined ? joined[2] : undefined
    if (value !== undefined && (attached === undefined || attached === 'g')) {
      let j = i + 1
      if (attached === undefined && bare(j) === 'g') j++
      if (CONNECTORS.has(bare(j))) j++
      const macro = MACRO_WORDS[bare(j)]
      if (macro) {
        nutrients[macro] = (nutrients[macro] ?? 0) + value
        i = j
        continue
      }
    }
    // "protein 35g", "protein 35 g"
    const macro = MACRO_WORDS[word]
    const after = /^(\d+(?:[.,]\d+)?)g?$/.exec(next)
    if (macro && after) {
      nutrients[macro] = (nutrients[macro] ?? 0) + Number(after[1]!.replace(',', '.'))
      i += bare(i + 2) === 'g' && !next.endsWith('g') ? 2 : 1
      continue
    }
    keep.push(all[i]!)
  }
  if (kcal === undefined) return undefined
  // What is left names it: "muffin", "about" and "~" dropped, "(…)" and "-" around it too.
  while (keep.length && (APPROXIMATELY.has(fold(keep.at(-1)!)) || CONNECTORS.has(fold(keep.at(-1)!)) || ['with', 'and'].includes(fold(keep.at(-1)!)))) keep.pop()
  while (keep.length && (APPROXIMATELY.has(fold(keep[0]!)) || CONNECTORS.has(fold(keep[0]!)))) keep.shift()
  const name = keep.join(' ').replace(/^[\s(\[\-–:]+|[\s)\]\-–:]+$/g, '').replace(/\(\s*\)/g, '').trim()
  return { name: name.replace(/^./, (c) => c.toUpperCase()), nutrients: { ...nutrients, kcal } }
}

/** An entry made from numbers alone. */
export const quickEntry = (name: string, nutrients: Nutrients, at: IsoDateTime, meal?: Id): FoodEntry => ({
  name: name.trim(),
  amount: '',
  grams: 0,
  ...(meal ? { meal } : {}),
  at,
  nutrients: { kcal: round(nutrients.kcal), protein: round(nutrients.protein), carbs: round(nutrients.carbs), fat: round(nutrients.fat), ...(nutrients.fiber ? { fiber: round(nutrients.fiber) } : {}) },
  quick: true,
})

/** What an entry is called where it is listed: its name, or "Quick entry" for numbers without one. */
export const entryLabel = (entry: Pick<FoodEntry, 'name' | 'quick'>) => entry.name || (entry.quick ? 'Quick entry' : 'Untitled')

const startsWithAmount = (text: string) => readQuantity(text.trim()).given
const endsWithAmount = (text: string) => {
  const last = fold(words(text).at(-1) ?? '')
  return /^\d/.test(last) || GRAM_UNITS[last] !== undefined || KCAL_WORDS.has(last) || /\dkcal$/.test(last) || MACRO_WORDS[last] !== undefined
}

/**
 * "half a cup of rice and 2 eggs", "rice 100g and beans 80g": "and" between two items, where one
 * side is clearly an amount; "mac and cheese 200g" stays one food.
 */
function splitAnd(part: string): string[] {
  const pieces = part.split(/\s+and\s+/i)
  const out: string[] = [pieces[0]!]
  for (const piece of pieces.slice(1)) {
    if (endsWithAmount(out.at(-1)!) || startsWithAmount(piece)) out.push(piece)
    else out[out.length - 1] += ` and ${piece}`
  }
  return out
}

/** Read a line of food (without the /food in front) against the space's foods, meals and today. */
export function parseFoodLine(text: string, context: { sources: Source[]; meals: Meal[]; today: string; lookup: (id: Id) => Source | undefined }): ParsedFoodLine {
  let rest = text.replace(/\s+$/, '')
  let day = context.today
  let meal: Meal | undefined
  const takeDay = () => {
    const last = words(rest).at(-1)
    const offset = last !== undefined ? LINE_DAYS[fold(last)] : undefined
    if (offset === undefined || words(rest).length < 2) return
    day = addDays(context.today, offset)
    rest = rest.slice(0, rest.toLowerCase().lastIndexOf(last!.toLowerCase())).trimEnd()
  }
  takeDay()
  const trailing = trailingMeal(rest, context.meals, (name) => resolveSource(name, context.sources).candidates.some((s) => portionKey(s.title) === portionKey(name)))
  if (trailing) [meal, rest] = [trailing.meal, trailing.rest.trimEnd()]
  takeDay()
  const leading = meal ? undefined : leadingMeal(rest, context.meals)
  if (leading) [meal, rest] = [leading.meal, leading.rest]
  const items = rest
    .split(/[,;\n]+/)
    .flatMap(splitAnd)
    .map((part) => part.trim().replace(/^(e|and)\s+/i, ''))
    .filter(Boolean)
    .map((part): FoodLineItem => {
      const quick = readQuickEntry(part)
      return quick ? { text: part, name: quick.name, amount: '', nutrients: quick.nutrients } : readItem(part, context.sources, context.lookup)
    })
  return { items, ...(meal ? { meal } : {}), day }
}

/** The instant of a time of day ("HH:MM") on a day in a zone. */
export function timeOn(day: string, time: string, timeZone: string): IsoDateTime {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  const [hour, minute] = time.split(':').map(Number) as [number, number]
  return new Date(instantOf({ year, month, day: date, hour, minute, second: 0 }, timeZone)).toISOString()
}

export interface FoodLineResult {
  /** The day's note, once something was logged. */
  note?: ObjectRecord
  day: string
  meal?: Meal
  logged: { entryId: Id; entry: FoodEntry }[]
  /** Foods made because the space had none by that name. */
  created: ObjectRecord[]
  /** Items not logged, and why. */
  problems: string[]
  /** The day's kcal after it, its goal, and the week's budget when the goal shares its week. */
  dayKcal: number
  goal?: DayGoal
  week?: WeekBudget
}

/**
 * Log a line of food on a day's note (parseFoodLine), making the foods it names that the space
 * lacks. Throws NutritionError when nothing in it could be logged.
 */
export function logFoodLine(store: Store, spaceId: Id, text: string, context: { today: string; timeZone: string }, now: IsoDateTime): FoodLineResult {
  const space = store.getSpace(spaceId)
  if (!space) throw new NutritionError('not found')
  if (!isNutritionOn(space)) throw new NutritionError('food tracking is off in this space (Settings › Food tracking)')
  const meals = space.nutrition?.meals ?? DEFAULT_MEALS
  const foodType = store.getType(builtinTypeId(spaceId, 'food'))
  if (!foodType || foodType.deletedAt) throw new NutritionError('this space has no Food type')
  const sources: Source[] = [...store.listObjects(foodType.id), ...store.listObjects(builtinTypeId(spaceId, 'recipe'))].filter((s) => !s.deletedAt)
  const made = new Map<Id, Source>()
  const lookup = (id: Id) => made.get(id) ?? sources.find((s) => s.id === id) ?? store.getObjectSummaries([id])[0]
  const parsed = parseFoodLine(text, { sources, meals, today: context.today, lookup })
  if (!parsed.items.length) throw new NutritionError('say what you ate, e.g. /food 2 slices of bread, coffee 200 ml')
  const at = parsed.day === context.today ? now : timeOn(parsed.day, parsed.meal?.time ?? '12:00', context.timeZone)
  const meal = parsed.meal ?? mealAt(meals, timeOfDay(at, context.timeZone))
  const created: ObjectRecord[] = []
  const logged: { entryId: Id; entry: FoodEntry }[] = []
  const problems: string[] = []
  for (const item of parsed.items) {
    if (item.nutrients) {
      logged.push({ entryId: crypto.randomUUID(), entry: quickEntry(item.name, item.nutrients, new Date(Date.parse(at) + logged.length).toISOString(), meal?.id) })
      continue
    }
    if (item.ambiguous) {
      problems.push(`“${item.name}” could be ${item.ambiguous.slice(0, 4).map((s) => s.title).join(', ')}: write the whole name`)
      continue
    }
    let source = item.source
    if (!source) {
      const name = item.name.trim().replace(/^./, (c) => c.toUpperCase())
      const food = newObject(foodType, { title: name }, crypto.randomUUID(), now)
      created.push(food)
      source = { ...food }
      made.set(food.id, source)
      sources.push(source)
    }
    const portions = sourcePortions(source, lookup)
    // A count alone ("2 eggs", or nothing: "banana") is that many of its first portion; without
    // one, the count and the name are kept ("2 eggs") for a portion added later to work out.
    const count = !item.amount || BARE_COUNT.test(item.amount)
    const amount = count ? `${item.amount || '1'} ${portions[0]?.name ?? item.name}` : item.amount
    // A millisecond apart, so the entries keep the line's order.
    const eaten = new Date(Date.parse(at) + logged.length).toISOString()
    let entry: FoodEntry
    try {
      entry = entryOf(source, amount, lookup, eaten, meal?.id)
    } catch (error) {
      if (!(error instanceof AmountError)) throw error
      // Not worked out yet: logged as written, without grams, to fill in from the food later.
      entry = { sourceId: source.id, name: source.title, amount, grams: 0, ...(meal ? { meal: meal.id } : {}), at: eaten }
    }
    logged.push({ entryId: crypto.randomUUID(), entry })
  }
  if (!logged.length) throw new NutritionError(problems.join('; '))
  const note = store.transaction(() => {
    for (const food of created) store.putObject(food)
    const { note: day } = findOrCreateDailyNote(store, spaceId, parsed.day, now)
    const props = { ...day.props }
    for (const { entryId, entry } of logged) props[foodEntryKey(entryId)] = { kind: 'food-entry', value: entry }
    return store.putObject({ ...day, props, updatedAt: now })
  })
  const goals = readGoals(store.listObjects(builtinTypeId(spaceId, 'nutrition-goal')))
  const kcalOn = (d: string) => {
    const dayNote = d === parsed.day ? note : store.findObjectOnDay(builtinTypeId(spaceId, 'daily-note'), d)
    return dayNote ? dayTotals(dayEntries(dayNote)).kcal : 0
  }
  const goal = goalForDay(goals, parsed.day)
  const week = weekBudget(goals, parsed.day, kcalOn)
  return { note, day: parsed.day, ...(meal ? { meal } : {}), logged, created, problems, dayKcal: kcalOn(parsed.day), ...(goal ? { goal } : {}), ...(week ? { week } : {}) }
}

const kcalText = (value: number) => Math.round(value).toLocaleString('en-US').replace(/,/g, ' ')

/** A reply for a channel: "Logged in Lunch: Bread 2 slices (125 kcal), Rice 150g (195 kcal). Today 1 240 of 2 000 kcal; this week 6 390 left." */
export function describeFoodLine(result: FoodLineResult, today: string): string {
  const items = result.logged.map(({ entry }) =>
    entry.quick
      ? entry.name ? `${entry.name} (${kcalText(entry.nutrients!.kcal)} kcal)` : `${kcalText(entry.nutrients!.kcal)} kcal`
      : `${entry.name} ${entry.amount}${entry.nutrients ? ` (${kcalText(entry.nutrients.kcal)} kcal)` : ' (needs nutrition data)'}`
  )
  const when = result.day === today ? '' : result.day === addDays(today, -1) ? ' yesterday' : ` on ${result.day}`
  const lines = [`Logged${when}${result.meal ? ` in ${result.meal.name}` : ''}: ${items.join(', ')}.`]
  const totals = [`${result.day === today ? 'Today' : 'That day'} ${kcalText(result.dayKcal)}${result.goal ? ` of ${kcalText(result.goal.kcal)}` : ''} kcal`]
  if (result.week) totals.push(result.week.remaining < 0 ? `this week ${kcalText(-result.week.remaining)} over` : `this week ${kcalText(result.week.remaining)} left`)
  lines.push(`${totals.join('; ')}.`)
  if (result.created.length) lines.push(`New ${result.created.length === 1 ? 'food' : 'foods'} without nutrition data: ${result.created.map((f) => f.title).join(', ')}. Fill ${result.created.length === 1 ? 'it' : 'them'} in in Vasta.`)
  if (result.problems.length) lines.push(`Not logged: ${result.problems.join('; ')}.`)
  return lines.join('\n')
}

/** What logging a line of food answers, over HTTP or from the device's store. */
export interface FoodLineAnswer {
  dailyNoteId?: Id
  day: string
  entries: (FoodEntry & { id: Id })[]
  created: { id: Id; title: string }[]
  problems: string[]
  /** describeFoodLine's words. */
  summary: string
}

export function foodLineAnswer(result: FoodLineResult, today: string): FoodLineAnswer {
  return {
    ...(result.note ? { dailyNoteId: result.note.id } : {}),
    day: result.day,
    entries: result.logged.map(({ entryId, entry }) => ({ id: entryId, ...entry })),
    created: result.created.map((o) => ({ id: o.id, title: o.title })),
    problems: result.problems,
    summary: describeFoodLine(result, today),
  }
}

// ---------------------------------------------------------------------------
// Reminders about food (server/src/reminders.ts): late in a day, what is left of it; at the end of
// a week, how it went; a meal with nothing logged a while after its time.

export interface FoodNudge {
  title: string
  message: string
}

const gramsText = (value: number) => `${Math.round(value)} g`

/**
 * What is left of a day: "600 kcal left today", "40 g protein to go · the week is on track".
 * `days` are its week up to it (nutritionDays from its Monday, or earlier). With a weekly budget,
 * the day's share of what the week has left (weekBudget's allowance) is what it is measured
 * against. Undefined without a goal, or on a day not counted.
 */
export function foodDayNudge(days: NutritionDay[], goals: NutritionGoal[], day: string): FoodNudge | undefined {
  const today = days.find((d) => d.day === day)
  const goal = goalForDay(goals, day)
  if (!today || !goal || !today.counted) return undefined
  const kcal = new Map(days.map((d) => [d.day, d.totals.kcal]))
  const week = weekBudget(goals, day, (d) => kcal.get(d) ?? 0)
  const target = week ? week.allowance : goal.kcal
  const eaten = today.totals.kcal
  const left = Math.round(target - eaten)
  const parts: string[] = []
  const protein = goal.protein !== undefined ? Math.round(goal.protein - today.totals.protein) : undefined
  let title: string
  if (!today.entries) {
    title = 'Nothing logged today'
    parts.push(`${kcalText(target)} kcal${protein !== undefined ? ` and ${gramsText(protein)} protein` : ''} to go`)
  } else {
    title = isOnTarget(eaten, target) ? 'On target today' : left > 0 ? `${kcalText(left)} kcal left today` : `${kcalText(-left)} kcal over today`
    if (protein !== undefined) parts.push(protein > 0 ? `${gramsText(protein)} protein to go` : `protein done (${gramsText(today.totals.protein)})`)
  }
  if (week && week.start < day) {
    let goalsBefore = 0
    for (let d = week.start; d < day; d = addDays(d, 1)) goalsBefore += goalForDay(goals, d)?.kcal ?? 0
    const ahead = week.eatenBefore - goalsBefore
    parts.push(ahead <= goalsBefore * ON_TARGET_TOLERANCE ? 'the week is on track' : `the week is ${kcalText(ahead)} kcal over so far`)
  }
  return { title, message: parts.join(' · ') || `${kcalText(eaten)} of ${kcalText(target)} kcal` }
}

/**
 * How a week went (Monday to Sunday, the one `end` is in): within the weekly budget or over it
 * (or the average against the goal), protein a day, days on target, the streak. `history` is
 * nutritionDays up to `end`, going back far enough for the streak. Undefined when nothing was
 * logged that week.
 */
export function foodWeekNudge(history: NutritionDay[], goals: NutritionGoal[], end: string): FoodNudge | undefined {
  const start = weekStart(end)
  const week = history.filter((d) => d.day >= start && d.day <= end)
  if (!week.some((d) => d.entries)) return undefined
  const stats = nutritionStats(week, end)
  const streak = nutritionStats(history.filter((d) => d.day <= end), end).currentStreak
  const logged = week.filter((d) => d.counted && d.entries && d.goal)
  const average = (pick: (goal: DayGoal) => number | undefined) => {
    const values = logged.map((d) => pick(d.goal!)).filter((v): v is number => v !== undefined)
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : undefined
  }
  const kcal = new Map(week.map((d) => [d.day, d.totals.kcal]))
  const budget = goalForDay(goals, end)?.weekly ? weekBudget(goals, end, (d) => kcal.get(d) ?? 0) : undefined
  const parts: string[] = []
  let title = 'Your week of food'
  if (budget) {
    title = budget.remaining >= 0 ? 'Within budget this week' : 'Over budget this week'
    parts.push(`${kcalText(budget.eaten)} of ${kcalText(budget.target)} kcal (${kcalText(Math.abs(budget.remaining))} ${budget.remaining >= 0 ? 'left' : 'over'})`)
  } else {
    const goal = average((g) => g.kcal)
    parts.push(`${kcalText(stats.average.kcal)} kcal a day${goal !== undefined ? ` (goal ${kcalText(goal)})` : ''}`)
  }
  const proteinGoal = average((g) => g.protein)
  if (stats.loggedDays) parts.push(`protein ${gramsText(stats.average.protein)} a day${proteinGoal !== undefined ? ` (goal ${gramsText(proteinGoal)})` : ''}`)
  if (logged.length) parts.push(`on target ${stats.onTarget} of ${stats.loggedDays} ${stats.loggedDays === 1 ? 'day' : 'days'}`)
  if (streak) parts.push(`${streak} ${streak === 1 ? 'day' : 'days'} on target in a row`)
  const skipped = week.filter((d) => !d.counted).length
  if (skipped) parts.push(`${skipped} not counted`)
  return { title, message: parts.join(' · ') }
}

/** A meal of a day with nothing logged in it yet ("Lunch not logged"), with what the day has so far. */
export function foodMealNudge(note: Props | undefined, meal: Meal, meals: Meal[], timeZone: string, goal: DayGoal | undefined): FoodNudge | undefined {
  if (!isDayCounted(note)) return undefined
  const entries = note ? dayEntries(note) : []
  if (groupByMeal(entries, meals, timeZone).find((g) => g.meal.id === meal.id)?.entries.length) return undefined
  const eaten = dayTotals(entries).kcal
  return {
    title: `${meal.name} not logged`,
    message: `${entries.length ? `${kcalText(eaten)} kcal today so far` : 'Nothing logged today yet'}${goal ? ` (goal ${kcalText(goal.kcal)})` : ''}`,
  }
}

// ---------------------------------------------------------------------------
// Habits done from what is logged: a habit whose "From food" names a nutrient and a side
// ("Protein, at least") is done on a day by that day's totals against its daily goal (else the
// day's nutrition goal); "Day on target" and "Food logged" by the day itself. Its days are worked
// out from the daily notes each time and never stored, so changing what was eaten changes them;
// days not counted are days off.

export const habitFoodRule = (habit: Pick<ObjectSummary, 'props'>): string | undefined => {
  const value = habit.props[HABIT_FOOD_PROPERTY_ID]
  return value?.kind === 'select' ? value.value[0] : undefined
}

/** A habit with its days from food, as the habit functions (habits.ts) read them; others as they are. */
export function withFood<T extends Pick<ObjectSummary, 'props' | 'createdAt'>>(habit: T, days: NutritionDay[]): T {
  const rule = habitFoodRule(habit)
  if (!rule) return habit
  const props: Record<Id, PropertyValue> = Object.fromEntries(Object.entries(habit.props).filter(([key]) => !key.startsWith('done:')))
  const target = habitTarget(habit)
  for (const day of days) {
    if (!day.counted) {
      props[habitOffKey(day.day)] = { kind: 'checkbox', value: true }
      continue
    }
    if (!day.entries) continue
    let done = false
    let amount: number | undefined
    if (rule === 'logged') done = true
    else if (rule === 'on-target') done = !!day.goal && isOnTarget(day.totals.kcal, day.goal.kcal)
    else {
      const [key, side] = rule.split('-') as [keyof Nutrients, 'min' | 'max']
      const total = day.totals[key] ?? 0
      const limit = target ?? (key === 'fiber' ? undefined : day.goal?.[key])
      // At least, toward a daily goal: the amount fills it, as typed amounts do.
      if (side === 'min' && target) amount = total
      else done = side === 'min' ? (limit !== undefined ? total >= limit : total > 0) : limit !== undefined && total <= limit
    }
    if (amount !== undefined && amount > 0) props[habitDoneKey(day.day)] = { kind: 'number', value: round(amount, 1) }
    else if (done) props[habitDoneKey(day.day)] = DONE_VALUE
  }
  return { ...habit, props }
}

/** How far back a habit's days from food go. */
export const FOOD_HABIT_DAYS = 400

/** The habits of a space with their days from food (a store's daily notes and goals), up to `today`. */
export function habitsWithFood<T extends ObjectSummary>(store: Store, spaceId: Id, habits: T[], today: string): T[] {
  if (!habits.some((h) => habitFoodRule(h))) return habits
  const from = addDays(today, -FOOD_HABIT_DAYS)
  const notes = store.listObjects(builtinTypeId(spaceId, 'daily-note')).filter((n) => (n.date?.start.slice(0, 10) ?? '') >= from)
  const goals = readGoals(store.listObjects(builtinTypeId(spaceId, 'nutrition-goal')))
  const days = nutritionDays(notes, goals, from, today)
  return habits.map((h) => withFood(h, days))
}
