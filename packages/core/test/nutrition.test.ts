import { describe, expect, it } from 'vitest'
import {
  AmountError,
  DEFAULT_MEALS,
  NOT_COUNTED_KEY,
  builtinTypeId,
  createBuiltinTypes,
  dayEntries,
  deleteFoodEntry,
  describeFoodLine,
  foodCommand,
  foodDayNudge,
  foodMealNudge,
  foodWeekNudge,
  ensureBuiltinTypes,
  entryOf,
  foodEntryKey,
  goalForDay,
  groupByMeal,
  ingredientsValue,
  logFood,
  logFoodLine,
  parseFoodLine,
  readQuickEntry,
  mealAt,
  normalizeNutritionSettings,
  nutritionDays,
  nutritionStats,
  objectLinks,
  parseAmount,
  portionsValue,
  readGoals,
  recipeFacts,
  refreshEntry,
  setNutritionEnabled,
  sourceUsage,
  weekBudget,
  habitStats,
  habitValue,
  isHabitDone,
  isHabitScheduled,
  withFood,
  type FoodEntry,
  type NutritionDay,
  type ObjectRecord,
  type ObjectSummary,
  type PropertyValue,
} from '../src/index.ts'
import { NodeStore } from '../src/store-node.ts'

const AT = '2026-10-20T12:00:00.000Z'
const num = (value: number): PropertyValue => ({ kind: 'number', value })

function object(id: string, system: 'food' | 'recipe' | 'nutrition-goal', props: Record<string, PropertyValue>, extra: Partial<ObjectSummary> = {}): ObjectSummary {
  return {
    id, spaceId: 's', typeId: builtinTypeId('s', system), title: id, aliases: [], tagIds: [], collectionIds: [], props,
    createdAt: AT, updatedAt: AT, preview: '', ...extra,
  }
}

const rice = object('rice', 'food', { kcal: num(130), protein: num(2.5), carbs: num(28), fat: num(0.3) })
const bread = object('bread', 'food', {
  kcal: num(250), protein: num(9), carbs: num(48), fat: num(3), fiber: num(2.4),
  portions: portionsValue([{ name: 'slice', grams: 30 }, { name: 'cup', grams: 120 }, { name: 'tablespoon', grams: 15 }]),
})
const beans = object('beans', 'food', { kcal: num(76), protein: num(4.8), carbs: num(13.6), fat: num(0.5) })
const unknown = object('mystery', 'food', {})
const lunch = object('lunch', 'recipe', { ingredients: ingredientsValue([{ id: 'rice', grams: 200 }, { id: 'beans', grams: 100 }]), yield: num(400), servings: num(2) })
const all = new Map([rice, bread, beans, unknown, lunch].map((o) => [o.id, o]))
const lookup = (id: string) => all.get(id)

describe('amounts', () => {
  it('reads grams, kilos and millilitres', () => {
    expect(parseAmount('150', [])).toEqual({ grams: 150, amount: '150 g' })
    expect(parseAmount('150g', []).grams).toBe(150)
    expect(parseAmount(' 150  grams ', []).grams).toBe(150)
    expect(parseAmount('0.5 kg', [])).toEqual({ grams: 500, amount: '0.5 kg' })
    expect(parseAmount('0,5 kg', []).grams).toBe(500)
    expect(parseAmount('200 ml', []).grams).toBe(200)
  })

  it('reads portions by name, ignoring case, accents and plurals', () => {
    const portions = [{ name: 'slice', grams: 30 }, { name: 'crêpe', grams: 60 }, { name: 'cup', grams: 120 }, { name: 'tablespoon', grams: 15 }, { name: 'peach', grams: 150 }]
    expect(parseAmount('2 slices', portions)).toEqual({ grams: 60, amount: '2 slices' })
    expect(parseAmount('1/2 Slice', portions).grams).toBe(15)
    expect(parseAmount('1 1/2 slice', portions).grams).toBe(45)
    expect(parseAmount('2 crepes', portions).grams).toBe(120)
    expect(parseAmount('½ cup', portions).grams).toBe(60)
    expect(parseAmount('half a cup', portions).grams).toBe(60)
    expect(parseAmount('2 tablespoons', portions).grams).toBe(30)
    expect(parseAmount('2 peaches', portions).grams).toBe(300)
    expect(parseAmount('slice', portions).grams).toBe(30)
    // The start of a name, when only one portion starts that way.
    expect(parseAmount('2 tbsp', [{ name: 'tbsp (15 g)', grams: 15 }]).grams).toBe(30)
  })

  it('refuses units it does not know', () => {
    expect(() => parseAmount('2 cups', [{ name: 'slice', grams: 30 }])).toThrow(/not a portion of it \(slice\)/)
    expect(() => parseAmount('2 cups', [])).toThrow(AmountError)
    expect(() => parseAmount('0 g', [])).toThrow(AmountError)
    expect(() => parseAmount('', [])).toThrow(AmountError)
  })
})

describe('foods and recipes', () => {
  it('works out a recipe per 100 g and per serving from its ingredients', () => {
    const facts = recipeFacts(lunch, lookup)
    // 200 g rice (260 kcal) + 100 g beans (76 kcal) = 336 kcal, cooked to 400 g.
    expect(facts).toMatchObject({ ingredientGrams: 300, grams: 400, servingGrams: 200, missing: [] })
    expect(facts.total!.kcal).toBe(336)
    expect(facts.per100!.kcal).toBe(84)
  })

  it('counts ingredients without data as missing, and a recipe inside itself too', () => {
    const loop = object('loop', 'recipe', { ingredients: ingredientsValue([{ id: 'rice', grams: 100 }, { id: 'loop', grams: 50 }, { id: 'mystery', grams: 10 }]) })
    const facts = recipeFacts(loop, (id) => (id === 'loop' ? loop : lookup(id)))
    expect(facts.missing).toEqual(['loop', 'mystery'])
    expect(facts.total!.kcal).toBe(130)
  })

  it('links a recipe to its foods, so their backlinks list it', () => {
    const record = { ...lunch, content: {} } as unknown as ObjectRecord
    expect(objectLinks(record).map((l) => [l.toId, l.kind, l.via])).toEqual([['rice', 'relation', 'ingredients'], ['beans', 'relation', 'ingredients']])
  })
})

describe('entries', () => {
  it('snapshots a food for the amount eaten', () => {
    const entry = entryOf(bread, '2 slices', lookup, AT, 'breakfast')
    expect(entry).toEqual({
      sourceId: 'bread', name: 'bread', amount: '2 slices', grams: 60, meal: 'breakfast', at: AT,
      nutrients: { kcal: 150, protein: 5.4, carbs: 28.8, fat: 1.8, fiber: 1.44 },
    })
  })

  it('logs a recipe by its serving', () => {
    expect(entryOf(lunch, '1 portion', lookup, AT)).toMatchObject({ grams: 200, nutrients: { kcal: 168 } })
    expect(entryOf(lunch, '1 serving', lookup, AT).grams).toBe(200)
  })

  it('logs a food without data yet, and fills it in later from the food', () => {
    const entry = entryOf(unknown, '100 g', lookup, AT)
    expect(entry.nutrients).toBeUndefined()
    const filled = { ...unknown, title: 'Mystery bar', props: { kcal: num(400) } }
    expect(refreshEntry(entry, () => filled)).toMatchObject({ name: 'Mystery bar', nutrients: { kcal: 400, protein: 0 } })
  })

  it('groups a day by meal; an entry without a meal goes to the nearest one', () => {
    const at = (time: string) => `2026-10-20T${time}:00.000Z`
    const entry = (time: string, kcal: number, meal?: string): FoodEntry => ({ name: 'x', amount: '1 g', grams: 1, at: at(time), ...(meal ? { meal } : {}), nutrients: { kcal, protein: 0, carbs: 0, fat: 0 } })
    const note = { props: { [foodEntryKey('a')]: { kind: 'food-entry', value: entry('07:30', 300) }, [foodEntryKey('b')]: { kind: 'food-entry', value: entry('13:10', 700) }, [foodEntryKey('c')]: { kind: 'food-entry', value: entry('15:00', 100, 'dinner') }, other: num(1) } as Record<string, PropertyValue> }
    const groups = groupByMeal(dayEntries(note), DEFAULT_MEALS, 'UTC')
    expect(groups.map((g) => [g.meal.id, g.entries.map((e) => e.id), g.totals.kcal])).toEqual([['breakfast', ['a'], 300], ['lunch', ['b'], 700], ['snack', [], 0], ['dinner', ['c'], 100]])
    expect(mealAt(DEFAULT_MEALS, '22:00')?.id).toBe('dinner')
    expect(mealAt([{ id: 'only', name: 'Only' }], '22:00')?.id).toBe('only')
  })
})

describe('goals', () => {
  const goal = (id: string, start: string, props: Record<string, PropertyValue>) =>
    object(id, 'nutrition-goal', props, { date: { start: `${start}T00:00:00.000Z`, resolution: 'day' } })
  const goals = readGoals([
    goal('g2', '2026-10-15', { kcal: num(2000), 'protein-pct': num(30), 'carbs-pct': num(40), 'fat-pct': num(30), 'kcal-sat': num(2600), weekly: { kind: 'checkbox', value: true } }),
    goal('g1', '2026-10-01', { kcal: num(2400) }),
    goal('no-kcal', '2026-10-10', {}),
  ])

  it('takes the latest goal starting on or before the day, with its weekday kcal and macro grams', () => {
    expect(goalForDay(goals, '2026-09-30')).toBeUndefined()
    expect(goalForDay(goals, '2026-10-14')).toEqual({ goalId: 'g1', kcal: 2400, weekly: false })
    expect(goalForDay(goals, '2026-10-20')).toEqual({ goalId: 'g2', kcal: 2000, protein: 150, carbs: 200, fat: 66.7, weekly: true })
    expect(goalForDay(goals, '2026-10-24')!.kcal).toBe(2600)
  })

  it('shares a week’s budget among the days left', () => {
    // Week of Monday 19 October: six days of 2000 and Saturday 2600 = 14600.
    const eaten: Record<string, number> = { '2026-10-19': 2500, '2026-10-20': 800 }
    const budget = weekBudget(goals, '2026-10-20', (day) => eaten[day] ?? 0)!
    expect(budget).toMatchObject({ start: '2026-10-19', end: '2026-10-25', target: 14600, eaten: 3300, eatenBefore: 2500, remaining: 11300 })
    // 12100 left for six days whose goals add to 12600: today gets 2000 × 12100 / 12600.
    expect(budget.allowance).toBe(1921)
    expect(weekBudget(goals, '2026-10-14', () => 0)).toBeUndefined()
  })

  it('averages counted days and counts streaks on target', () => {
    const note = (day: string, kcal: number, counted = true) => ({
      date: { start: `${day}T00:00:00.000Z`, resolution: 'day' as const },
      props: {
        [foodEntryKey(day)]: { kind: 'food-entry', value: { name: 'x', amount: '1 g', grams: 1, at: `${day}T12:00:00.000Z`, nutrients: { kcal, protein: 10, carbs: 0, fat: 0 } } },
        ...(counted ? {} : { [NOT_COUNTED_KEY]: { kind: 'checkbox', value: true } }),
      } as Record<string, PropertyValue>,
    })
    const notes = [note('2026-10-15', 2000), note('2026-10-16', 2050), note('2026-10-17', 3500, false), note('2026-10-18', 1980), note('2026-10-19', 1500), note('2026-10-20', 600)]
    const days = nutritionDays(notes, goals, '2026-10-14', '2026-10-20')
    expect(days.map((d) => [d.day, d.totals.kcal, d.counted])[0]).toEqual(['2026-10-14', 0, true])
    const stats = nutritionStats(days, '2026-10-20')
    expect(stats).toMatchObject({ loggedDays: 5, onTarget: 3, bestStreak: 3, currentStreak: 0 })
    expect(stats.average.kcal).toBe(1626)
    // Up to the 18th: the 17th was not counted and does not break the run.
    expect(nutritionStats(days.slice(0, 5), '2026-10-18').currentStreak).toBe(3)
    // Today not on target yet does not break it either.
    expect(nutritionStats([...days.slice(0, 5), { ...days[5]!, day: '2026-10-19' }], '2026-10-19').currentStreak).toBe(3)
  })

  it('says what is left of a day, how a week went, and which meal has nothing yet', () => {
    const note = (day: string, kcal: number, protein = 10, meal = 'lunch') => ({
      date: { start: `${day}T00:00:00.000Z`, resolution: 'day' as const },
      props: { [foodEntryKey(day)]: { kind: 'food-entry', value: { name: 'x', amount: '1 g', grams: 1, meal, at: `${day}T12:00:00.000Z`, nutrients: { kcal, protein, carbs: 0, fat: 0 } } } } as Record<string, PropertyValue>,
    })
    // The week's budget: Monday took 2500 of its 2000; today (Tuesday) may take 1921.
    const notes = [note('2026-10-19', 2500), note('2026-10-20', 800)]
    expect(foodDayNudge(nutritionDays(notes, goals, '2026-10-19', '2026-10-20'), goals, '2026-10-20')).toEqual({ title: '1 121 kcal left today', message: '140 g protein to go · the week is 500 kcal over so far' })
    expect(foodDayNudge(nutritionDays(notes.slice(0, 1), goals, '2026-10-19', '2026-10-20'), goals, '2026-10-20')).toEqual({ title: 'Nothing logged today', message: '1 921 kcal and 150 g protein to go · the week is 500 kcal over so far' })
    expect(foodDayNudge(nutritionDays([note('2026-10-19', 1900, 160)], goals, '2026-10-19', '2026-10-19'), goals, '2026-10-19')).toEqual({ title: 'On target today', message: 'protein done (160 g)' })
    // Without a goal, nothing to say.
    expect(foodDayNudge(nutritionDays([], goals, '2026-09-29', '2026-09-29'), goals, '2026-09-29')).toBeUndefined()

    const week = [note('2026-10-19', 2500), note('2026-10-20', 2000, 120), note('2026-10-21', 1990, 140)]
    expect(foodWeekNudge(nutritionDays(week, goals, '2026-10-01', '2026-10-25'), goals, '2026-10-25')).toEqual({
      title: 'Within budget this week',
      message: '6 490 of 14 600 kcal (8 110 left) · protein 90 g a day (goal 150 g) · on target 2 of 3 days',
    })
    expect(foodWeekNudge(nutritionDays(week, goals, '2026-10-01', '2026-10-21'), goals, '2026-10-21')!.message).toMatch(/· 2 days on target in a row$/)
    expect(foodWeekNudge(nutritionDays([], goals, '2026-10-19', '2026-10-25'), goals, '2026-10-25')).toBeUndefined()

    const [breakfast, lunchMeal] = DEFAULT_MEALS
    const day = note('2026-10-20', 800)
    expect(foodMealNudge(day, lunchMeal!, DEFAULT_MEALS, 'UTC', goalForDay(goals, '2026-10-20'))).toBeUndefined()
    expect(foodMealNudge(day, breakfast!, DEFAULT_MEALS, 'UTC', goalForDay(goals, '2026-10-20'))).toEqual({ title: 'Breakfast not logged', message: '800 kcal today so far (goal 2 000)' })
  })
})

describe('nutrition in a space', () => {
  function space() {
    const store = new NodeStore(':memory:')
    store.putSpace({ id: 's', name: 'Space', sidebar: [], createdAt: AT })
    for (const type of createBuiltinTypes('s', AT)) store.putType(type)
    return store
  }

  it('is off until turned on: the types come then, and only then', () => {
    const store = space()
    ensureBuiltinTypes(store, AT)
    expect(store.getType(builtinTypeId('s', 'food'))).toBeUndefined()
    const { space: on, types } = setNutritionEnabled(store, 's', true, AT)
    expect(types.map((t) => t.system)).toEqual(['food', 'recipe', 'nutrition-goal', 'habit'])
    expect(on.nutrition).toEqual({ enabled: true, meals: DEFAULT_MEALS })
    expect(store.getSpace('s')!.nutrition).toEqual(on.nutrition)
    // Off keeps the types and the meals.
    store.putSpace({ ...store.getSpace('s')!, nutrition: { enabled: true, meals: [{ id: 'm', name: 'Meal' }] } })
    setNutritionEnabled(store, 's', false, AT)
    expect(store.getSpace('s')!.nutrition).toEqual({ enabled: false, meals: [{ id: 'm', name: 'Meal' }] })
    expect(store.getType(builtinTypeId('s', 'food'))!.deletedAt).toBeUndefined()
  })

  it('logs to the day’s note, one prop per entry, and deletes an entry', () => {
    const store = space()
    setNutritionEnabled(store, 's', true, AT)
    store.putObject({ ...bread, content: {} })
    const first = logFood(store, 's', { sourceId: 'bread', amount: '2 slices', day: '2026-10-20', timeZone: 'America/Sao_Paulo' }, AT, 'e1')
    // 12:00 UTC is 09:00 in São Paulo: breakfast.
    expect(first.entry).toMatchObject({ meal: 'breakfast', grams: 60 })
    const second = logFood(store, 's', { sourceId: 'bread', amount: '30', day: '2026-10-20', meal: 'dinner', timeZone: 'UTC' }, AT, 'e2')
    expect(second.note.id).toBe(first.note.id)
    expect(dayEntries(store.getObject(first.note.id)!).map((e) => [e.id, e.entry.meal])).toEqual([['e1', 'breakfast'], ['e2', 'dinner']])
    expect(store.syncRow('objects', first.note.id)!.clock).toHaveProperty(`props.${foodEntryKey('e1')}`)
    expect(sourceUsage(store.listObjects(builtinTypeId('s', 'daily-note')), 'bread')).toEqual({ count: 2, lastDay: '2026-10-20' })
    deleteFoodEntry(store, first.note.id, 'e1', AT)
    expect(dayEntries(store.getObject(first.note.id)!).map((e) => e.id)).toEqual(['e2'])
    expect(() => logFood(store, 's', { sourceId: 'nope', amount: '1', day: '2026-10-20', timeZone: 'UTC' }, AT)).toThrow('food not found')
    expect(() => logFood(store, 's', { sourceId: 'bread', amount: '2 bowls', day: '2026-10-20', timeZone: 'UTC' }, AT)).toThrow(/portion/)
  })

  it('checks settings sent by a client', () => {
    expect(normalizeNutritionSettings({ enabled: true, meals: [{ id: 'a', name: ' Brunch ', time: '07:00' }, { id: 'a', name: 'Again' }, { id: 'b', name: '' }, { id: 'c', name: 'Supper', time: '25:00' }] })).toEqual({
      enabled: true,
      meals: [{ id: 'a', name: 'Brunch', time: '07:00' }, { id: 'c', name: 'Supper' }],
    })
    expect(normalizeNutritionSettings({ meals: 'no' })).toBeUndefined()
  })
})

describe('a line of food (/food)', () => {
  const meals = DEFAULT_MEALS
  const food = (id: string, title: string, props: Record<string, PropertyValue> = {}) => object(id, 'food', { kcal: num(100), ...props }, { title })
  const sources = [
    food('white', 'White bread', { portions: portionsValue([{ name: 'slice', grams: 25 }]) }),
    food('coffee', 'Coffee'),
    food('rice', 'Rice', { portions: portionsValue([{ name: 'cup', grams: 160 }]) }),
    food('egg', 'Egg', { portions: portionsValue([{ name: 'piece', grams: 50 }]) }),
    food('rye', 'Rye bread'),
    food('snack', 'Snack'),
    object('lasagna', 'recipe', { ingredients: ingredientsValue([{ id: 'rice', grams: 800 }]), servings: num(4) }, { title: 'Lasagna' }),
  ]
  const lookup = (id: string) => sources.find((s) => s.id === id)
  const parse = (text: string) => parseFoodLine(text, { sources, meals, today: '2026-10-20', lookup })
  const items = (text: string) => parse(text).items.map((i) => [i.source?.id ?? i.name, i.amount])

  it('finds the command', () => {
    expect(foodCommand('/food bread')).toBe('bread')
    expect(foodCommand('/FOOD rice 100g')).toBe('rice 100g')
    expect(foodCommand('/foods')).toBeUndefined()
    expect(foodCommand('food bread')).toBeUndefined()
  })

  it('reads amounts before or after the food, and a meal and a day at the end', () => {
    expect(parse('2 slices of white bread, coffee 200 ml at breakfast')).toMatchObject({ meal: { id: 'breakfast' }, day: '2026-10-20' })
    expect(items('2 slices of white bread, coffee 200 ml at breakfast')).toEqual([['white', '2 slices'], ['coffee', '200 ml']])
    expect(parse('rice 150g lunch yesterday')).toMatchObject({ meal: { id: 'lunch' }, day: '2026-10-19' })
    expect(items('rice 150g lunch yesterday')).toEqual([['rice', '150g']])
    expect(items('150 g of rice; half a cup of rice and 2 eggs')).toEqual([['rice', '150 g'], ['rice', 'half a cup'], ['egg', '2']])
    expect(items('rice 100g and egg 50 g; rye bread and coffee')).toEqual([['rice', '100g'], ['egg', '50 g'], ['rye bread and coffee', '']])
    expect(items('2 eggs')).toEqual([['egg', '2']])
    expect(parse('lunch: rice 100g, egg').meal?.id).toBe('lunch')
  })

  it('does not take the food for a meal, and leaves unknown and unclear names', () => {
    expect(parse('snack')).toMatchObject({ items: [{ source: { id: 'snack' } }] })
    expect(parse('snack').meal).toBeUndefined()
    expect(items('tapioca 100g')).toEqual([['tapioca', '100g']])
    expect(parse('bread 50g').items[0]!.ambiguous?.map((s) => s.id)).toEqual(['white', 'rye'])
  })

  it('logs it, making the foods the space lacks, and says what it did', () => {
    const store = new NodeStore(':memory:')
    store.putSpace({ id: 's', name: 'Space', sidebar: [], createdAt: AT })
    for (const type of createBuiltinTypes('s', AT)) store.putType(type)
    expect(() => logFoodLine(store, 's', 'bread', { today: '2026-10-20', timeZone: 'UTC' }, AT)).toThrow(/off/)
    setNutritionEnabled(store, 's', true, AT)
    for (const source of sources) store.putObject({ ...source, content: {} })
    store.putObject({ ...object('goal', 'nutrition-goal', { kcal: num(2000), weekly: { kind: 'checkbox', value: true } }, { date: { start: '2026-10-19T00:00:00.000Z', resolution: 'day' } }), content: {} })

    const result = logFoodLine(store, 's', '2 eggs, lasagna, tapioca 100g, bread 50g at lunch', { today: '2026-10-20', timeZone: 'UTC' }, AT)
    expect(result.logged.map(({ entry }) => [entry.name, entry.amount, entry.grams, entry.meal])).toEqual([
      ['Egg', '2 piece', 100, 'lunch'],
      ['Lasagna', '1 serving', 200, 'lunch'],
      ['Tapioca', '100 g', 100, 'lunch'],
    ])
    expect(result.created.map((f) => f.title)).toEqual(['Tapioca'])
    expect(result.problems).toEqual(['“bread” could be White bread, Rye bread: write the whole name'])
    // 100 g of egg (100 kcal) and a serving of 200 g of rice (200 kcal); tapioca has no data.
    expect(result.dayKcal).toBe(300)
    expect(describeFoodLine(result, '2026-10-20')).toBe(
      'Logged in Lunch: Egg 2 piece (100 kcal), Lasagna 1 serving (200 kcal), Tapioca 100 g (needs nutrition data).\n' +
        'Today 300 of 2 000 kcal; this week 13 700 left.\n' +
        'New food without nutrition data: Tapioca. Fill it in in Vasta.\n' +
        'Not logged: “bread” could be White bread, Rye bread: write the whole name.'
    )
    expect(dayEntries(store.getObject(result.note!.id)!)).toHaveLength(3)
    expect(() => logFoodLine(store, 's', '', { today: '2026-10-20', timeZone: 'UTC' }, AT)).toThrow(/say what you ate/)
  })

  it('reads a quick entry: kcal, optional macros, and the name around them', () => {
    const nothing = { protein: 0, carbs: 0, fat: 0 }
    expect(readQuickEntry('muffin ~350 kcal')).toEqual({ name: 'Muffin', nutrients: { kcal: 350, ...nothing } })
    expect(readQuickEntry('300 kcal')).toEqual({ name: '', nutrients: { kcal: 300, ...nothing } })
    expect(readQuickEntry('about 350kcal of pizza')).toEqual({ name: 'Pizza', nutrients: { kcal: 350, ...nothing } })
    expect(readQuickEntry('lunch plate 1,200 kcal 35 g of protein 80g carbs fat 20 g')).toEqual({ name: 'Lunch plate', nutrients: { kcal: 1200, protein: 35, carbs: 80, fat: 20 } })
    expect(readQuickEntry('cake (~420 calories)')).toMatchObject({ name: 'Cake', nutrients: { kcal: 420 } })
    expect(readQuickEntry('rice 150g')).toBeUndefined()
    expect(readQuickEntry('30 g protein')).toBeUndefined()
  })

  it('logs quick entries without making foods, alongside foods', () => {
    expect(items('300 kcal at snack')).toEqual([['', '']])
    expect(parse('300 kcal at snack').meal?.id).toBe('snack')
    expect(parse('muffin 350 kcal and juice 120 kcal, 2 eggs').items.map((i) => [i.name, i.nutrients?.kcal ?? i.source?.id])).toEqual([['Muffin', 350], ['Juice', 120], ['eggs', 'egg']])

    const store = new NodeStore(':memory:')
    store.putSpace({ id: 's', name: 'Space', sidebar: [], createdAt: AT })
    for (const type of createBuiltinTypes('s', AT)) store.putType(type)
    setNutritionEnabled(store, 's', true, AT)
    for (const source of sources) store.putObject({ ...source, content: {} })
    const result = logFoodLine(store, 's', 'muffin ~350 kcal 12g protein, 2 eggs at snack', { today: '2026-10-20', timeZone: 'UTC' }, AT)
    expect(result.created).toEqual([])
    expect(result.logged.map(({ entry }) => entry)).toEqual([
      { name: 'Muffin', amount: '', grams: 0, meal: 'snack', at: AT, nutrients: { kcal: 350, protein: 12, carbs: 0, fat: 0 }, quick: true },
      expect.objectContaining({ sourceId: 'egg', meal: 'snack' }),
    ])
    expect(result.dayKcal).toBe(450)
    expect(describeFoodLine(result, '2026-10-20').split('\n')[0]).toBe('Logged in Snack: Muffin (350 kcal), Egg 2 piece (100 kcal).')
    expect(describeFoodLine(logFoodLine(store, 's', '300 kcal', { today: '2026-10-20', timeZone: 'UTC' }, AT), '2026-10-20').split('\n')[0]).toMatch(/: 300 kcal\.$/)
  })

  it('counts a food without its portion yet, and works its grams out once the portion exists', () => {
    const banana = food('banana', 'Banana')
    const entry: FoodEntry = { sourceId: 'banana', name: 'Banana', amount: '2 bananas', grams: 0, at: AT }
    expect(refreshEntry(entry, () => banana)).toMatchObject({ grams: 0 })
    expect(refreshEntry(entry, () => ({ ...banana, props: { ...banana.props, portions: portionsValue([{ name: 'banana', grams: 120 }]) } }))).toMatchObject({ grams: 240, nutrients: { kcal: 240 } })
  })
})

describe('habits done from food', () => {
  const day = (d: string, kcal: number, protein: number, extra: Partial<NutritionDay> = {}): NutritionDay => ({
    day: d, totals: { kcal, protein, carbs: 0, fat: 0 }, entries: 1, counted: true, goal: { goalId: 'g', kcal: 2000, protein: 150, weekly: false }, ...extra,
  })
  const days = [day('2026-10-17', 1990, 160), day('2026-10-18', 2400, 90), day('2026-10-19', 0, 0, { entries: 0 }), day('2026-10-20', 1500, 120, { counted: false })]
  const habit = (rule: string, props: Record<string, PropertyValue> = {}) => ({ createdAt: AT, props: { food: { kind: 'select', value: [rule] }, 'done:2026-10-16': { kind: 'checkbox', value: true }, ...props } as Record<string, PropertyValue> })
  const done = (h: ReturnType<typeof habit>) => ['2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'].filter((d) => isHabitDone(withFood(h, days), d))

  it('fills toward the daily goal, or the nutrition goal without one; ignores days checked by hand', () => {
    const protein = withFood(habit('protein-min', { target: num(150) }), days)
    expect([habitValue(protein, '2026-10-17'), habitValue(protein, '2026-10-18'), habitValue(protein, '2026-10-16')]).toEqual([160, 90, 0])
    expect(done(habit('protein-min', { target: num(150) }))).toEqual(['2026-10-17'])
    expect(done(habit('protein-min'))).toEqual(['2026-10-17'])
    expect(done(habit('kcal-max'))).toEqual(['2026-10-17'])
    expect(done(habit('kcal-max', { target: num(2500) }))).toEqual(['2026-10-17', '2026-10-18'])
    expect(done(habit('on-target'))).toEqual(['2026-10-17'])
    expect(done(habit('logged'))).toEqual(['2026-10-17', '2026-10-18'])
  })

  it('makes days not counted days off, so they keep a streak', () => {
    const h = withFood(habit('logged'), days)
    expect(isHabitScheduled(h, '2026-10-20')).toBe(false)
    expect(habitStats(h, '2026-10-18').current).toBe(2)
  })

  it('reaches spaces that track food, once', () => {
    const store = new NodeStore(':memory:')
    store.putSpace({ id: 's', name: 'Space', sidebar: [], createdAt: AT })
    for (const type of createBuiltinTypes('s', AT)) store.putType(type)
    const names = () => store.getType(builtinTypeId('s', 'habit'))!.properties.map((p) => p.id)
    expect(names()).not.toContain('food')
    setNutritionEnabled(store, 's', true, AT)
    expect(names()).toEqual(['days', 'target', 'unit', 'remind', 'paused', 'food', 'body'])
  })
})
