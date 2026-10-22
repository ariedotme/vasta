import type { IsoDateTime, ObjectType, PropertyDef, SystemTypeKey, Id, ViewLayout } from './model.ts'

/** Property id of the main rich-text field every built-in type has. */
export const BODY_PROPERTY_ID = 'body'

const body: PropertyDef = { id: BODY_PROPERTY_ID, kind: 'rich-text', name: 'Notes' }

/** Property id of a weblink's readable copy of the page (kept apart from the user's notes). */
export const ARTICLE_PROPERTY_ID = 'article'

export const articleProperty: PropertyDef = { id: ARTICLE_PROPERTY_ID, kind: 'rich-text', name: 'Readable text', hideWhenEmpty: true }

/** Property id of a quote's relation to what it was highlighted in. */
export const SOURCE_PROPERTY_ID = 'source'

/** Who a task is for (a person property). */
export const ASSIGNEE_PROPERTY_ID = 'assignee'
/** A task that cannot move on (boards show a flag). */
export const BLOCKED_PROPERTY_ID = 'blocked'

/** A sprint's first and last day (a date range) and what it is for. */
export const SPRINT_DATES_PROPERTY_ID = 'dates'
export const SPRINT_GOAL_PROPERTY_ID = 'goal'
/** A task's sprint: a relation to the space's Sprint type, added when sprints are turned on. */
export const SPRINT_PROPERTY_ID = 'sprint'

/** A habit's weekdays ("Repeat on"; none means every day) and whether it is paused. */
export const HABIT_DAYS_PROPERTY_ID = 'days'
export const HABIT_PAUSED_PROPERTY_ID = 'paused'
/** A numeric goal per day ("8", with the unit "glasses"); none means done or not done. */
export const HABIT_TARGET_PROPERTY_ID = 'target'
export const HABIT_UNIT_PROPERTY_ID = 'unit'
/** When to be reminded, "HH:MM" in the user's time zone (the server's reminders). */
export const HABIT_REMIND_PROPERTY_ID = 'remind'
/** A habit done from what is logged in Food (nutrition.ts, `habitsWithFood`); spaces that track food get it. */
export const HABIT_FOOD_PROPERTY_ID = 'food'

const foodRules: [string, string][] = [
  ['protein-min', 'Protein, at least'], ['protein-max', 'Protein, at most'],
  ['kcal-max', 'kcal, at most'], ['kcal-min', 'kcal, at least'],
  ['carbs-max', 'Carbs, at most'], ['carbs-min', 'Carbs, at least'],
  ['fat-max', 'Fat, at most'], ['fat-min', 'Fat, at least'],
  ['fiber-min', 'Fiber, at least'],
  ['on-target', 'Day on target'], ['logged', 'Food logged'],
]

/** The habit property a space gets when it turns food tracking on. */
export const habitFoodProperty = (): PropertyDef => ({
  id: HABIT_FOOD_PROPERTY_ID,
  kind: 'select',
  name: 'From food',
  description: 'Done from what is logged in Food; the daily goal is the amount (else the nutrition goal)',
  multiple: false,
  options: foodRules.map(([id, label]) => ({ id, label, color: 'gray' })),
})

const weekdays: [string, string][] = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']]

/** A food's nutrients per 100 g (nutrition.ts); also a goal's daily kcal. */
export const KCAL_PROPERTY_ID = 'kcal'
export const PROTEIN_PROPERTY_ID = 'protein'
export const CARBS_PROPERTY_ID = 'carbs'
export const FAT_PROPERTY_ID = 'fat'
export const FIBER_PROPERTY_ID = 'fiber'
export const BRAND_PROPERTY_ID = 'brand'
/** A food's named portions, a `portions` value without a property definition (edited on its page). */
export const PORTIONS_PROPERTY_ID = 'portions'
/** A recipe's ingredients, an `ingredients` value without a property definition. */
export const INGREDIENTS_PROPERTY_ID = 'ingredients'
/** A recipe's weight once cooked, in grams (the ingredients' total when empty), and its servings. */
export const YIELD_PROPERTY_ID = 'yield'
export const SERVINGS_PROPERTY_ID = 'servings'
/** A nutrition goal's macro split, in percent of its kcal, and whether its weeks share one budget. */
export const PROTEIN_PCT_PROPERTY_ID = 'protein-pct'
export const CARBS_PCT_PROPERTY_ID = 'carbs-pct'
export const FAT_PCT_PROPERTY_ID = 'fat-pct'
export const WEEKLY_PROPERTY_ID = 'weekly'
/** A goal's kcal for one weekday instead of the daily one: `kcal-mon`… */
export const weekdayKcalPropertyId = (weekday: string) => `kcal-${weekday}`

const per100 = (id: string, name: string, unit: string): PropertyDef => ({ id, kind: 'number', name, description: `${unit} per 100 g` })
const weekdayNames: Record<string, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }

interface BuiltinSpec {
  name: string
  pluralName: string
  icon: string
  properties: PropertyDef[]
}

const DEFAULT_LAYOUTS: Partial<Record<SystemTypeKey, ViewLayout>> = { image: 'gallery', weblink: 'gallery' }

const specs: Record<SystemTypeKey, BuiltinSpec> = {
  page: { name: 'Page', pluralName: 'Pages', icon: 'ph:file-text', properties: [body] },
  'daily-note': { name: 'Daily note', pluralName: 'Daily notes', icon: 'ph:calendar-check', properties: [body] },
  tag: { name: 'Tag', pluralName: 'Tags', icon: 'ph:tag', properties: [body] },
  collection: { name: 'Collection', pluralName: 'Collections', icon: 'ph:folders', properties: [body] },
  query: { name: 'Query', pluralName: 'Queries', icon: 'ph:funnel', properties: [body] },
  task: {
    name: 'Task',
    pluralName: 'Tasks',
    icon: 'ph:check-circle',
    properties: [
      body,
      {
        id: 'status',
        kind: 'select',
        name: 'Status',
        multiple: false,
        options: [
          { id: 'todo', label: 'To do', status: 'todo', color: 'gray' },
          { id: 'doing', label: 'In progress', status: 'doing', color: 'blue' },
          { id: 'done', label: 'Done', status: 'done', color: 'green' },
        ],
      },
      { id: 'due', kind: 'date', name: 'Due', withTime: true },
      { id: ASSIGNEE_PROPERTY_ID, kind: 'person', name: 'Assignee', multiple: false },
      {
        id: 'priority',
        kind: 'select',
        name: 'Priority',
        multiple: false,
        options: [
          { id: 'high', label: 'High', color: 'red' },
          { id: 'medium', label: 'Medium', color: 'amber' },
          { id: 'low', label: 'Low', color: 'sky' },
        ],
      },
      { id: BLOCKED_PROPERTY_ID, kind: 'checkbox', name: 'Blocked', hideWhenEmpty: true },
    ],
  },
  weblink: { name: 'Weblink', pluralName: 'Weblinks', icon: 'ph:globe-hemisphere-west', properties: [body, articleProperty] },
  date: { name: 'Date', pluralName: 'Dates', icon: 'ph:calendar-blank', properties: [body] },
  image: { name: 'Image', pluralName: 'Images', icon: 'ph:image', properties: [body] },
  pdf: { name: 'PDF', pluralName: 'PDFs', icon: 'ph:file-pdf', properties: [body] },
  audio: { name: 'Audio', pluralName: 'Audio', icon: 'ph:waveform', properties: [body] },
  video: { name: 'Video', pluralName: 'Videos', icon: 'ph:video', properties: [body] },
  file: { name: 'File', pluralName: 'Files', icon: 'ph:file', properties: [body] },
  // The passage is the title; the note goes in the body.
  // Check-ins are the habit's own `done:<day>` props (habits.ts).
  habit: {
    name: 'Habit',
    pluralName: 'Habits',
    icon: 'ph:target',
    properties: [
      { id: HABIT_DAYS_PROPERTY_ID, kind: 'select', name: 'Repeat on', multiple: true, options: weekdays.map(([id, label]) => ({ id, label, color: 'gray' })) },
      { id: HABIT_TARGET_PROPERTY_ID, kind: 'number', name: 'Daily goal' },
      { id: HABIT_UNIT_PROPERTY_ID, kind: 'text', name: 'Unit' },
      { id: HABIT_REMIND_PROPERTY_ID, kind: 'text', name: 'Remind at' },
      { id: HABIT_PAUSED_PROPERTY_ID, kind: 'checkbox', name: 'Paused' },
      body,
    ],
  },
  quote: { name: 'Quote', pluralName: 'Quotes', icon: 'ph:quotes', properties: [{ id: SOURCE_PROPERTY_ID, kind: 'relation', name: 'Source', targetTypeIds: [], multiple: false }, body] },
  // Nutrition (nutrition.ts): made in a space when it turns food tracking on.
  food: {
    name: 'Food',
    pluralName: 'Foods',
    icon: 'ph:bowl-food',
    properties: [
      per100(KCAL_PROPERTY_ID, 'Calories', 'kcal'),
      per100(PROTEIN_PROPERTY_ID, 'Protein', 'Grams'),
      per100(CARBS_PROPERTY_ID, 'Carbs', 'Grams'),
      per100(FAT_PROPERTY_ID, 'Fat', 'Grams'),
      { ...per100(FIBER_PROPERTY_ID, 'Fiber', 'Grams'), hideWhenEmpty: true },
      { id: BRAND_PROPERTY_ID, kind: 'text', name: 'Brand', hideWhenEmpty: true },
      body,
    ],
  },
  recipe: {
    name: 'Recipe',
    pluralName: 'Recipes',
    icon: 'ph:cooking-pot',
    properties: [
      { id: YIELD_PROPERTY_ID, kind: 'number', name: 'Cooked weight', description: "Grams once made; the ingredients' total when empty" },
      { id: SERVINGS_PROPERTY_ID, kind: 'number', name: 'Servings' },
      body,
    ],
  },
  // A time box for tasks (sprints.ts), named as the space calls it; its dates are a range.
  sprint: {
    name: 'Sprint',
    pluralName: 'Sprints',
    icon: 'ph:flag-banner',
    properties: [
      { id: SPRINT_DATES_PROPERTY_ID, kind: 'date', name: 'Dates', allowRange: true },
      { id: SPRINT_GOAL_PROPERTY_ID, kind: 'text', name: 'Goal' },
      body,
    ],
  },
  // Starts on its own date; the goal of a day is the latest one starting on or before it.
  'nutrition-goal': {
    name: 'Nutrition goal',
    pluralName: 'Nutrition goals',
    icon: 'ph:chart-pie-slice',
    properties: [
      { id: KCAL_PROPERTY_ID, kind: 'number', name: 'Daily kcal' },
      { id: PROTEIN_PCT_PROPERTY_ID, kind: 'number', name: 'Protein %', description: 'Of the kcal' },
      { id: CARBS_PCT_PROPERTY_ID, kind: 'number', name: 'Carbs %', description: 'Of the kcal' },
      { id: FAT_PCT_PROPERTY_ID, kind: 'number', name: 'Fat %', description: 'Of the kcal' },
      { id: WEEKLY_PROPERTY_ID, kind: 'checkbox', name: 'Weekly budget', description: 'Days of a week (Monday to Sunday) share their kcal' },
      ...weekdays.map(([id]): PropertyDef => ({ id: weekdayKcalPropertyId(id), kind: 'number', name: `${weekdayNames[id]} kcal`, description: 'Instead of the daily kcal', hideWhenEmpty: true })),
      body,
    ],
  },
}

/** The types food tracking brings. */
export const NUTRITION_TYPE_KEYS: SystemTypeKey[] = ['food', 'recipe', 'nutrition-goal']

/** Built-in types a space only gets when it turns on what they are for (food tracking, sprints). */
export const OPTIONAL_TYPE_KEYS: SystemTypeKey[] = [...NUTRITION_TYPE_KEYS, 'sprint']

/** Capacities' built-in task status ids and the Task status options they correspond to. */
export const CAPACITIES_TASK_STATUS: Record<string, string> = { 'not-started': 'todo', 'in-progress': 'doing', done: 'done' }

/** The built-in types every space has. */
export const systemTypeKeys = (Object.keys(specs) as SystemTypeKey[]).filter((key) => !OPTIONAL_TYPE_KEYS.includes(key))

export function builtinTypeId(spaceId: Id, key: SystemTypeKey): Id {
  return `${key}:${spaceId}`
}

/** The built-in type a type id is the id of in a space (e.g. a Food type a device made offline). */
export function builtinTypeKey(spaceId: Id, typeId: Id): SystemTypeKey | undefined {
  return (Object.keys(specs) as SystemTypeKey[]).find((key) => builtinTypeId(spaceId, key) === typeId)
}

export function createBuiltinTypes(spaceId: Id, now: IsoDateTime, keys: SystemTypeKey[] = systemTypeKeys): ObjectType[] {
  return keys.map((key) => {
    const spec = specs[key]
    return {
      id: builtinTypeId(spaceId, key),
      spaceId,
      system: key,
      name: spec.name,
      pluralName: spec.pluralName,
      icon: { kind: 'icon', value: spec.icon },
      properties: structuredClone(spec.properties),
      views: [{ id: `${key}:all`, name: 'All', layout: DEFAULT_LAYOUTS[key] ?? 'list' }],
      createdAt: now,
      updatedAt: now,
    }
  })
}

/**
 * Properties added to a built-in type after spaces had it, by migration key: each reaches a type
 * once (ensureBuiltinTypes records the key), so one the user deletes later stays deleted.
 */
export const ADDED_BUILTIN_PROPERTIES: { key: string; system: SystemTypeKey; ids: string[]; after?: string }[] = [
  { key: 'habit-goal-remind-2026-10-20', system: 'habit', ids: [HABIT_TARGET_PROPERTY_ID, HABIT_UNIT_PROPERTY_ID, HABIT_REMIND_PROPERTY_ID] },
  { key: 'task-assignee-2026-10-21', system: 'task', ids: [ASSIGNEE_PROPERTY_ID], after: 'due' },
  { key: 'task-blocked-2026-10-21', system: 'task', ids: [BLOCKED_PROPERTY_ID], after: 'priority' },
]

/** A built-in type's property as it is made today, to add to an older copy of the type. */
export function builtinProperty(system: SystemTypeKey, id: string): PropertyDef | undefined {
  const def = specs[system].properties.find((p) => p.id === id)
  return def && structuredClone(def)
}

/** The built-in types a space lacks (ones added to Vasta after the space was made). */
export function missingBuiltinTypes(spaceId: Id, existing: ObjectType[], now: IsoDateTime): ObjectType[] {
  const ids = new Set(existing.map((t) => t.id))
  return createBuiltinTypes(spaceId, now, systemTypeKeys.filter((key) => !ids.has(builtinTypeId(spaceId, key))))
}
