// Food tracking in the app (core's nutrition.ts): whether the open space has it, its meals, the
// foods and recipes to log, a day's entries with its goal and week, and writing entries. An entry
// is a prop of the day's daily note (`food:<id>`); a change writes only those props, on top of the
// note as stored, so it never undoes what was typed in the note meanwhile.
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import {
  DEFAULT_MEALS,
  addDays,
  builtinTypeId,
  dayEntries,
  entryOf,
  foodEntryKey,
  goalForDay,
  instantOf,
  isFood,
  parseFoodLine,
  isNutritionOn,
  isRecipe,
  readGoals,
  refreshEntry,
  scaleNutrients,
  parseAmount,
  weekBudget,
  weekStart,
  type FoodEntry,
  type Id,
  type Meal,
  type ObjectRecord,
  type ObjectSummary,
  type ObjectType,
  type PropertyValue,
  type Space,
} from '@vasta/core'
import { api } from './api.ts'
import { dayKey } from './actions.ts'
import { clone } from './clone.ts'
import { onChange } from './events.ts'
import { primeFromObject, primeSummaries, systemType, workspace } from './state.ts'

export const nutritionOn = computed(() => isNutritionOn(workspace.space ?? undefined))
export const meals = computed<Meal[]>(() => workspace.space?.nutrition?.meals ?? DEFAULT_MEALS)

export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

export type NutrientKey = 'kcal' | 'protein' | 'carbs' | 'fat' | 'fiber'
/** Each nutrient's color (style.css), for its bar, dot or mark; its name always goes beside it. */
export const nutrientColor = (key: NutrientKey) => `var(--color-${key})`
export const NUTRIENT_KEYS: NutrientKey[] = ['kcal', 'protein', 'carbs', 'fat', 'fiber']
export const isNutrientKey = (key: string): key is NutrientKey => (NUTRIENT_KEYS as string[]).includes(key)

const round = (value: number, places = 0) => Math.round(value * 10 ** places) / 10 ** places
/** "1 240" style kcal and "12.5" grams: whole above 10, one decimal below. */
export const formatKcal = (value: number) => Math.round(value).toLocaleString('en-US').replace(/,/g, ' ')
export const formatGrams = (value: number) => String(Math.abs(value) >= 10 ? Math.round(value) : round(value, 1))

/** Turn food tracking on or off in the open space, and keep the workspace in step. */
export async function setNutrition(enabled: boolean) {
  const space = workspace.space
  if (!space) return
  const { space: saved, types } = await api.setNutrition(space.id, enabled)
  workspace.space = { ...space, nutrition: saved.nutrition! }
  const index = workspace.spaces.findIndex((s) => s.id === saved.id)
  if (index >= 0) workspace.spaces[index] = { ...workspace.spaces[index]!, nutrition: saved.nutrition! }
  for (const type of types) {
    const at = workspace.types.findIndex((t) => t.id === type.id)
    if (at >= 0) workspace.types[at] = type
    else workspace.types.push(type)
  }
}

export async function saveMeals(next: Meal[]) {
  const space = workspace.space
  if (!space) return
  const nutrition = { enabled: space.nutrition?.enabled ?? true, meals: next }
  const saved = await api.updateSpace(space.id, { nutrition })
  workspace.space = { ...space, nutrition: saved.nutrition ?? nutrition }
}

/** Reload `load` (debounced) when an object of one of `systems`' types changes anywhere. */
function reloadOn(systems: Parameters<typeof systemType>[0][], load: () => unknown) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = onChange((event) => {
    if (event.kind !== 'object' || !systems.some((s) => systemType(s)?.id === event.typeId)) return
    clearTimeout(timer)
    timer = setTimeout(load, 250)
  })
  onBeforeUnmount(() => {
    stop()
    clearTimeout(timer)
  })
}

/** The space's foods and recipes, kept fresh, for logging and for working out recipes. */
export function useFoodLibrary() {
  const sources = ref<ObjectSummary[]>([])
  const loaded = ref(false)
  async function load() {
    const types = [systemType('food'), systemType('recipe')].filter((t) => !!t)
    const lists = await Promise.all(types.map((t) => api.objectsOfType(t.id)))
    sources.value = lists.flat().sort((a, b) => a.title.localeCompare(b.title))
    primeSummaries(sources.value)
    loaded.value = true
  }
  const byId = computed(() => new Map(sources.value.map((s) => [s.id, s])))
  reloadOn(['food', 'recipe'], load)
  void load()
  return { sources, byId, loaded, load, lookup: (id: Id) => byId.value.get(id) }
}

/** The space's goals, oldest first. */
export function useGoals() {
  const objects = ref<ObjectSummary[]>([])
  async function load() {
    const type = systemType('nutrition-goal')
    objects.value = type ? await api.objectsOfType(type.id) : []
  }
  reloadOn(['nutrition-goal'], load)
  void load()
  return { objects, goals: computed(() => readGoals(objects.value)), load }
}

/** The space's daily notes from one day to another (inclusive), by day. */
export async function dailyNotesBetween(from: string, to: string): Promise<Map<string, ObjectSummary>> {
  const type = systemType('daily-note')
  if (!workspace.space || !type) return new Map()
  const notes = await api.query(workspace.space.id, {
    query: {
      typeIds: [type.id],
      filter: {
        kind: 'group',
        operator: 'and',
        items: [
          { kind: 'filter', field: 'date', operator: 'after', value: { kind: 'literal', value: addDays(from, -1) } },
          { kind: 'filter', field: 'date', operator: 'before', value: { kind: 'literal', value: addDays(to, 1) } },
        ],
      },
    },
    today: dayKey(),
    timeZone: 'UTC',
  })
  return new Map(notes.flatMap((n) => (n.date ? [[n.date.start.slice(0, 10), n] as const] : [])))
}

/**
 * A day of food: its note's entries, the goal of the day and, when the goal shares its week, the
 * week's budget. Reloaded when a daily note or a goal changes anywhere.
 */
export function useFoodDay(day: Ref<string>) {
  const week = ref(new Map<string, ObjectSummary>())
  const { goals } = useGoals()
  const loaded = ref(false)
  async function load() {
    const start = weekStart(day.value)
    week.value = await dailyNotesBetween(start, addDays(start, 6))
    loaded.value = true
  }
  watch(day, load, { immediate: true })
  reloadOn(['daily-note'], load)
  const note = computed(() => week.value.get(day.value))
  const entries = computed(() => (note.value ? dayEntries(note.value) : []))
  const goal = computed(() => goalForDay(goals.value, day.value))
  const kcalOn = (d: string) => {
    const n = week.value.get(d)
    return n ? dayEntries(n).reduce((sum, e) => sum + (e.entry.nutrients?.kcal ?? 0), 0) : 0
  }
  const budget = computed(() => weekBudget(goals.value, day.value, kcalOn))
  /** Show a note just written at once (the reload that follows its change event confirms it). */
  function setNote(written: ObjectRecord) {
    const { content: _content, ...rest } = written
    week.value = new Map(week.value).set(day.value, { ...rest, preview: '' })
  }
  return { note, entries, goal, goals, budget, loaded, load, setNote }
}

/** When something logged on `day` for `meal` was eaten: now on today, else the meal's usual time that day. */
export function entryTime(day: string, meal: Meal | undefined): string {
  if (day === dayKey()) return new Date().toISOString()
  const [hour, minute] = (meal?.time ?? '12:00').split(':').map(Number) as [number, number]
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  return new Date(instantOf({ year, month, day: date, hour, minute, second: 0 }, timeZone())).toISOString()
}

export async function logEntry(day: string, sourceId: Id, amount: string, meal: Meal | undefined): Promise<ObjectRecord> {
  const space = workspace.space!
  const result = await api.logFood(space.id, { sourceId, amount, day, ...(meal ? { meal: meal.id } : {}), at: entryTime(day, meal), timeZone: timeZone() })
  primeFromObject(result.note)
  return result.note
}

/**
 * Write entries of a day's note (made if needed): each id to an entry, or null to remove it. Only
 * those props are written.
 */
export async function writeEntries(day: string, noteId: Id | undefined, changes: Record<Id, FoodEntry | null>): Promise<ObjectRecord> {
  const base = noteId ? await api.object(noteId) : await api.dailyNote(workspace.space!.id, day)
  const next = clone(base)
  for (const [id, entry] of Object.entries(changes)) {
    const key = foodEntryKey(id)
    if (entry) next.props[key] = { kind: 'food-entry', value: entry } satisfies PropertyValue
    else delete next.props[key]
  }
  const saved = await api.saveObject(next, base)
  primeFromObject(saved)
  return saved
}

/**
 * An entry with another amount: the food's portions and nutrients as they are now, or, when the
 * food is gone, its snapshot scaled to the new grams. Throws AmountError for an unknown unit.
 */
export function withAmount(entry: FoodEntry, amount: string, lookup: (id: Id) => ObjectSummary | undefined): FoodEntry {
  const source = entry.sourceId ? lookup(entry.sourceId) : undefined
  if (source && !source.deletedAt && (isFood(source) || isRecipe(source))) return entryOf(source, amount, lookup, entry.at, entry.meal)
  const parsed = parseAmount(amount, [])
  const { nutrients, ...rest } = entry
  const scaled = nutrients && entry.grams > 0 ? scaleNutrients(nutrients, (parsed.grams / entry.grams) * 100) : undefined
  return { ...rest, amount: parsed.amount, grams: parsed.grams, ...(scaled ? { nutrients: scaled } : {}) }
}

/** A copy of an entry eaten again: a new snapshot of its food when it still exists. */
export function eatenAgain(entry: FoodEntry, lookup: (id: Id) => ObjectSummary | undefined, at: string, meal: Id | undefined): FoodEntry {
  const fresh = refreshEntry(entry, lookup)
  const { meal: _meal, ...rest } = fresh
  return { ...rest, at, ...(meal ? { meal } : {}) }
}

/** The Food, Recipe and goal type ids of the open space. */
export const nutritionTypeId = (key: 'food' | 'recipe' | 'nutrition-goal') => (workspace.space ? builtinTypeId(workspace.space.id, key) : '')

/** The foods and recipes of a space (of its `types`), for reading a line of food before it is sent. */
export async function foodSourcesOf(types: ObjectType[]): Promise<ObjectSummary[]> {
  const ids = types.filter((t) => (t.system === 'food' || t.system === 'recipe') && !t.deletedAt).map((t) => t.id)
  return (await Promise.all(ids.map((id) => api.objectsOfType(id)))).flat()
}

/**
 * What a line of food (after /food) will log, in words, for quick capture, ⌘K and the desktop
 * panel: "Logs in Lunch: White bread 2 slices, Rice 150 g. New food: Tapioca."
 */
export function previewFoodLine(text: string, space: Pick<Space, 'name' | 'nutrition'>, sources: ObjectSummary[], today: string): { text: string; problem?: string } {
  if (!isNutritionOn(space)) return { text: '', problem: `${space.name} does not track food (Settings › Food tracking).` }
  const lookup = (id: Id) => sources.find((s) => s.id === id)
  const parsed = parseFoodLine(text, { sources, meals: space.nutrition?.meals ?? DEFAULT_MEALS, today, lookup })
  if (!parsed.items.length) return { text: 'What did you eat? e.g. 2 slices of bread, coffee 200 ml at breakfast' }
  const when = parsed.day === today ? '' : parsed.day === addDays(today, -1) ? ' yesterday' : ` on ${parsed.day}`
  const known = parsed.items.flatMap((i) =>
    i.nutrients ? [`${i.name ? `${i.name} ` : ''}${formatKcal(i.nutrients.kcal)} kcal`] : i.source ? [`${i.source.title}${i.amount ? ` ${i.amount}` : ''}`] : []
  )
  const fresh = parsed.items.filter((i) => !i.source && !i.ambiguous && !i.nutrients).map((i) => i.name)
  const unclear = parsed.items.filter((i) => i.ambiguous).map((i) => `“${i.name}” (${i.ambiguous!.slice(0, 3).map((s) => s.title).join(', ')})`)
  const parts = [`Logs${when}${parsed.meal ? ` in ${parsed.meal.name}` : ''}: ${[...known, ...fresh].join(', ') || 'nothing yet'}.`]
  if (fresh.length) parts.push(`New ${fresh.length === 1 ? 'food' : 'foods'}, without nutrition data: ${fresh.join(', ')}.`)
  return { text: parts.join(' '), ...(unclear.length ? { problem: `Which one? ${unclear.join('; ')}` } : {}) }
}
