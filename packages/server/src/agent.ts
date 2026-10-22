// What agents (Claude Code, Codex, the Claude app…) can do in Vasta, as one user: the tools of the
// MCP endpoint (mcp.ts), which the remote CLI calls too. Rich text goes in and out as Markdown
// (@vasta/core/markdown). Every write goes through the store and the change feed like the HTTP
// routes, so open apps and synced devices see it. See docs/agents.md.
import { randomUUID } from 'node:crypto'
import type { DateValue, Doc, Filter, FilterOperator, FormulaValue, Id, ObjectRecord, ObjectSummary, ObjectType, PropertyDef, PropertyValue, QueryDef, User } from '@vasta/core'
import {
  BODY_PROPERTY_ID,
  addDays,
  builtinTypeId,
  CommentError,
  addComment,
  commentsOf,
  evaluateFormula,
  findPerson,
  formulaText,
  formulaToNames,
  habitDayValue,
  habitDoneKey,
  habitRemindAt,
  habitStats,
  habitTarget,
  habitUnit,
  habitValue,
  habitWeekdays,
  isHabitDone,
  isHabitPaused,
  isHabitScheduled,
  newObject,
  parseProperties,
  querySpace,
  AmountError,
  NutritionError,
  dayEntries,
  entryLabel,
  dayTotals,
  deleteFoodEntry,
  foodBrand,
  foodLineAnswer,
  foodNutrients,
  foodPortions,
  habitFoodRule,
  habitsWithFood,
  goalForDay,
  groupByMeal,
  isDayCounted,
  isFood,
  isNutritionOn,
  isRecipe,
  logFood,
  logFoodLine,
  portionsValue,
  readGoals,
  recipeFacts,
  recipeIngredients,
  sourceUsage,
  weekBudget,
  DEFAULT_MEALS,
  type FoodEntry,
  type FoodPortion,
  type Nutrients,
} from '@vasta/core'
import { docToMarkdown, markdownToDoc } from '@vasta/core/markdown'
import type { NodeStore } from '@vasta/core/node'
import { checkDoc } from '@vasta/editor-schema/yjs'
import type { AccountService } from './accounts.ts'
import type { CaptureService } from './capture.ts'
import { findOrCreateDailyNote, isValidDay } from './daily.ts'
import type { ChangeFeed } from './events.ts'
import { listInbox } from './inbox.ts'

export class AgentError extends Error {}

export interface AgentOptions {
  store: NodeStore
  accounts: AccountService
  feed: ChangeFeed
  now: () => string
  user: User
  /** The web app's address, for links to objects. */
  webUrl: string
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()

export class AgentTools {
  private readonly options: AgentOptions
  private readonly captures: CaptureService

  constructor(options: AgentOptions) {
    this.options = options
    this.captures = options.accounts.captureFor(options.user)
  }

  private get store() {
    return this.options.store
  }

  private url(id: Id) {
    return `${this.options.webUrl.replace(/\/$/, '')}/o/${id}`
  }

  private changed(object: ObjectRecord) {
    this.options.feed.emit({ kind: 'object', id: object.id, spaceId: object.spaceId, typeId: object.typeId, updatedAt: object.updatedAt })
  }

  /** A space of the user by id or name; their capture space when not given. */
  private space(query?: string) {
    const spaces = this.options.accounts.spacesOf(this.options.user)
    if (!query) {
      const id = this.options.accounts.captureSpaceId(this.options.user)
      const space = spaces.find((s) => s.id === id) ?? spaces[0]
      if (!space) throw new AgentError('you have no spaces')
      return space
    }
    const space = spaces.find((s) => s.id === query) ?? spaces.find((s) => fold(s.name) === fold(query))
    if (!space) throw new AgentError(`unknown space "${query}" (list_spaces shows yours)`)
    return space
  }

  private type(spaceId: Id, query: string): ObjectType {
    const type = this.captures.resolveType(spaceId, query)
    if (!type || type.deletedAt) throw new AgentError(`unknown type "${query}" (list_types shows the space's types)`)
    return type
  }

  /** An object the user can reach (not in the trash). */
  private object(id: Id): ObjectRecord {
    const object = this.store.getObject(id)
    if (!object || object.deletedAt || !this.options.accounts.canUse(this.options.user.id, object.spaceId)) throw new AgentError(`no object ${id}`)
    return object
  }

  private context(spaceId?: Id) {
    return spaceId ? this.captures.lineContext(spaceId) : { today: this.captures.today(), timeZone: this.captures.timeZone }
  }

  private titleOf = (id: Id) => this.store.getObjectSummaries([id])[0]?.title

  /** A person as agents see them: "Name (username)". */
  private personName = (id: Id) => {
    const user = this.store.getUser(id)
    return user ? `${user.name} (${user.username})` : id
  }

  // Reading -------------------------------------------------------------------

  spaces() {
    const captureSpace = this.options.accounts.captureSpaceId(this.options.user)
    return this.options.accounts.spacesOf(this.options.user).map((s) => ({ id: s.id, name: s.name, ...(s.id === captureSpace ? { default: true } : {}) }))
  }

  types(spaceQuery?: string) {
    const space = this.space(spaceQuery)
    const all = this.store.listTypes(space.id)
    const typeNames = new Map(all.map((t) => [t.id, t.name]))
    const counts = this.store.typeCounts(space.id)
    return this.store
      .listTypes(space.id)
      .filter((t) => !t.deletedAt)
      .map((t) => ({
        id: t.id,
        name: t.name,
        plural: t.pluralName,
        ...(t.system ? { builtIn: t.system } : {}),
        ...(t.description ? { description: t.description } : {}),
        objects: counts[t.id] ?? 0,
        properties: t.properties.map((p) => describeProperty(p, typeNames, t, all)),
      }))
  }

  private summary(object: ObjectSummary) {
    const type = this.store.getType(object.typeId)
    return {
      id: object.id,
      title: object.title,
      type: type?.name ?? '',
      updatedAt: object.updatedAt,
      ...(object.date ? { date: dateText(object.date) } : {}),
      ...(object.preview ? { preview: object.preview } : {}),
      url: this.url(object.id),
    }
  }

  search(text: string, options: { space?: string; limit?: number } = {}) {
    const space = this.space(options.space)
    return this.store.search(space.id, text, Math.min(Math.max(options.limit ?? 20, 1), 100)).map((o) => this.summary(o))
  }

  /** An object with its properties in words and its text as Markdown. */
  getObject(id: Id) {
    const object = this.object(id)
    const type = this.store.getType(object.typeId)
    const titles = (ids: Id[]) => ids.map((i) => ({ id: i, title: this.titleOf(i) ?? '' }))
    const properties: Record<string, unknown> = {}
    const text: Record<string, string> = {}
    const types = new Map(this.store.listTypes(object.spaceId).map((t) => [t.id, t]))
    for (const def of type?.properties ?? []) {
      if (def.kind === 'formula') {
        const related = (id: Id) => this.store.getObjectSummaries([id]).find((o) => o.spaceId === object.spaceId)
        const value = evaluateFormula(object, def, { types, related, personName: (id) => this.store.getUser(id)?.name, ...this.context() })
        if (value.kind !== 'empty') properties[def.name] = formulaOutput(value, this.captures.timeZone)
        continue
      }
      if (def.kind === 'rich-text') {
        const markdown = docToMarkdown(object.content[def.id], { titleOf: this.titleOf })
        if (markdown.trim()) text[def.name] = markdown
        continue
      }
      const value = object.props[def.id]
      if (value) properties[def.name] = valueOf(def, value, titles, this.personName)
    }
    const backlinks = this.store
      .backlinks(object.id)
      .filter((b) => this.options.accounts.canUse(this.options.user.id, b.object.spaceId) && !b.object.deletedAt)
      .map((b) => ({ id: b.object.id, title: b.object.title, kind: b.kind }))
    return {
      id: object.id,
      title: object.title,
      type: type?.name ?? '',
      space: this.store.getSpace(object.spaceId)?.name ?? '',
      url: this.url(object.id),
      createdAt: object.createdAt,
      updatedAt: object.updatedAt,
      ...(object.createdBy ? { createdBy: this.personName(object.createdBy) } : {}),
      ...(object.updatedBy ? { updatedBy: this.personName(object.updatedBy) } : {}),
      ...(object.date ? { date: dateText(object.date) } : {}),
      ...(object.tagIds.length ? { tags: titles(object.tagIds).map((t) => t.title) } : {}),
      ...(object.media?.url ? { link: object.media.url } : {}),
      ...(Object.keys(properties).length ? { properties } : {}),
      ...(commentsOf(object).length ? { comments: commentsOf(object).map((c) => ({ by: this.personName(c.author), at: c.at, text: c.text })) } : {}),
      ...this.foodFacts(object),
      text,
      ...(backlinks.length ? { backlinks } : {}),
    }
  }

  /** A day's note ("YYYY-MM-DD", today by default, in the user's calendar), created if needed. */
  dailyNote(options: { day?: string; space?: string } = {}) {
    const space = this.space(options.space)
    const day = options.day ?? this.captures.today()
    if (!isValidDay(day)) throw new AgentError('day must be YYYY-MM-DD')
    const { note, created } = findOrCreateDailyNote(this.store, space.id, day, this.options.now())
    if (created) this.changed(note)
    return { day, ...this.getObject(note.id) }
  }

  /**
   * Objects of some types (names or ids; all types when empty), filtered and sorted like a query
   * in the app. Fields are property names (or ids), a relation's field as "Author.Country", or
   * built-in fields: title, tags, createdAt, updatedAt, createdBy, updatedBy, date, type. Select values
   * are option labels; people are usernames or names ("me": the user).
   */
  query(options: { space?: string; types?: string[]; where?: AgentFilter[]; match?: 'all' | 'any'; sort?: { field: string; direction?: 'asc' | 'desc' }[]; limit?: number } = {}) {
    const space = this.space(options.space)
    const types = (options.types ?? []).map((t) => this.type(space.id, t))
    const all = this.store.listTypes(space.id).filter((t) => !t.deletedAt)
    const field = (name: string) => resolveField(name, types.length ? types : all, all)
    const query: QueryDef = {
      typeIds: types.map((t) => t.id),
      ...(options.where?.length
        ? {
            filter: {
              kind: 'group',
              operator: options.match === 'any' ? 'or' : 'and',
              items: options.where.map((w): Filter => {
                const { path, def } = field(w.field)
                const person = def?.kind === 'person' || path === 'createdBy' || path === 'updatedBy'
                const value = def?.kind === 'select' ? selectValue(def, w.value) : person ? this.personValue(space.id, w.value) : w.value
                return { kind: 'filter', field: path, operator: w.operator, ...(value !== undefined ? { value: { kind: 'literal', value } } : {}) }
              }),
            },
          }
        : {}),
      ...(options.sort?.length ? { sort: options.sort.map((r) => ({ field: field(r.field).path, direction: r.direction ?? 'asc' })) } : {}),
    }
    const rows = querySpace(this.store, space.id, { query, today: this.captures.today(), timeZone: this.captures.timeZone, me: this.options.user.id, people: this.store.people(space.id) }, this.options.now())
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500)
    return { total: rows.length, objects: rows.slice(0, limit).map((o) => this.summary(o)) }
  }

  /** Usernames or names (or "me") as the user ids a person filter compares; unknown ones stay as given. */
  private personValue(spaceId: Id, value: AgentFilter['value']) {
    if (value === undefined) return value
    const people = this.store.people(spaceId)
    const id = (name: string) => findPerson(people, name, this.options.user.id)?.id ?? name
    return Array.isArray(value) ? value.map(id) : [id(String(value))]
  }

  /** What was captured in the last days (newest first), with the objects in each item. */
  inbox(options: { space?: string; days?: number; includeDone?: boolean } = {}) {
    const space = this.space(options.space)
    const items = listInbox(this.store, space.id, this.captures.today(), Math.min(Math.max(options.days ?? 7, 1), 365)).filter((i) => options.includeDone || !i.done)
    return items.map((item) => ({
      id: item.id,
      day: item.day,
      at: item.at,
      channel: item.channel,
      done: item.done,
      dailyNoteId: item.noteId,
      text: docToMarkdown({ type: 'doc', content: item.content }, { titleOf: this.titleOf }),
      objects: item.objectIds.map((id) => ({ id, title: this.titleOf(id) ?? '' })),
    }))
  }

  // Writing -------------------------------------------------------------------

  private doc(markdown: string): Doc {
    try {
      return checkDoc(markdownToDoc(markdown) as never) as Doc
    } catch (error) {
      throw new AgentError(`the Markdown does not make a valid document: ${(error as Error).message}`)
    }
  }

  /** Values by property name; select options and related objects are created when missing. */
  private props(type: ObjectType, values: Record<string, unknown>) {
    const toClear = Object.entries(values).flatMap(([key, value]) => (value === null || value === '' ? [key] : []))
    const parsed = parseProperties(type, Object.fromEntries(Object.entries(values).filter(([key]) => !toClear.includes(key))), this.context(type.spaceId))
    if (parsed.errors.length) throw new AgentError(`could not set ${parsed.errors.join('; ')}`)
    const cleared = toClear.map((key) => {
      const def = type.properties.find((p) => p.id === key || fold(p.name) === fold(key))
      if (!def) throw new AgentError(`could not set ${key}: no such property`)
      return def.id
    })
    const { props, related } = this.captures.applyLine(type.spaceId, type, parsed)
    return { props, related, cleared }
  }

  private textField(type: ObjectType, field?: string): Id {
    const fields = type.properties.filter((p) => p.kind === 'rich-text')
    if (!field) return fields[0]?.id ?? BODY_PROPERTY_ID
    const def = fields.find((p) => p.id === field || fold(p.name) === fold(field))
    if (!def) throw new AgentError(`${type.name} has no text field "${field}" (it has ${fields.map((p) => p.name).join(', ') || 'none'})`)
    return def.id
  }

  createObject(input: { type: string; title?: string; space?: string; properties?: Record<string, unknown>; markdown?: string }) {
    const space = this.space(input.space)
    const type = this.type(space.id, input.type)
    if (type.system === 'daily-note') throw new AgentError('daily notes are made by get_daily_note')
    const { props, related } = this.props(type, input.properties ?? {})
    const content = input.markdown?.trim() ? { [this.textField(type)]: this.doc(input.markdown) } : {}
    const object = newObject(type, { title: input.title?.trim() ?? '', props, content }, randomUUID(), this.options.now())
    const stored = this.store.transaction(() => {
      for (const other of related) this.store.putObject(other)
      return this.store.putObject(object)
    })
    for (const other of related) this.changed(other)
    this.changed(stored)
    return this.getObject(stored.id)
  }

  /**
   * Change an object: its title, properties (null clears one), and text: Markdown appended to a
   * text field (the first by default), put before it, or replacing it.
   */
  /** A comment on an object, as the user (@username mentions a member). */
  addComment(input: { id: Id; text: string }) {
    const existing = this.object(input.id)
    const object: ObjectRecord = { ...existing, props: { ...existing.props }, updatedAt: this.options.now() }
    try {
      addComment(object, this.options.user.id, input.text, this.options.now())
    } catch (error) {
      if (error instanceof CommentError) throw new AgentError(error.message)
      throw error
    }
    const saved = this.store.putObject(object)
    this.changed(saved)
    return { id: saved.id, comments: commentsOf(saved).length, url: this.url(saved.id) }
  }

  updateObject(input: { id: Id; title?: string; properties?: Record<string, unknown>; markdown?: string; mode?: 'append' | 'prepend' | 'replace'; field?: string }) {
    const existing = this.object(input.id)
    const type = this.store.getType(existing.typeId)
    if (!type) throw new AgentError(`no type for ${input.id}`)
    const object: ObjectRecord = { ...existing, props: { ...existing.props }, content: { ...existing.content } }
    if (input.title !== undefined) object.title = input.title.trim()
    let related: ObjectRecord[] = []
    if (input.properties) {
      const changes = this.props(type, input.properties)
      Object.assign(object.props, changes.props)
      for (const id of changes.cleared) delete object.props[id]
      related = changes.related
    }
    if (input.markdown !== undefined) {
      const field = this.textField(type, input.field)
      const mode = input.mode ?? 'append'
      if (mode === 'replace') {
        if (input.markdown.trim()) object.content[field] = this.doc(input.markdown)
        else delete object.content[field]
      } else {
        const added = this.doc(input.markdown).content
        const current = [...(object.content[field]?.content ?? [])]
        // An empty last (or first) line is where the editor's cursor waits; the new text takes it.
        const blank = (node: (typeof current)[number] | undefined) => node?.type === 'paragraph' && !node.content?.length
        if (mode === 'append') while (blank(current.at(-1))) current.pop()
        else while (blank(current[0])) current.shift()
        object.content[field] = { type: 'doc', content: mode === 'append' ? [...current, ...added] : [...added, ...current] }
      }
    }
    object.updatedAt = this.options.now()
    const stored = this.store.transaction(() => {
      for (const other of related) this.store.putObject(other)
      return this.store.putObject(object)
    })
    for (const other of related) this.changed(other)
    this.changed(stored)
    return this.getObject(stored.id)
  }

  // Habits --------------------------------------------------------------------

  /** A habit by id or title (accents and case ignored) in a space. */
  private habit(query: string, spaceId: Id): ObjectRecord {
    const byId = this.store.getObject(query)
    if (byId && !byId.deletedAt && byId.spaceId === spaceId && this.store.getType(byId.typeId)?.system === 'habit') return byId
    const type = this.store.getType(builtinTypeId(spaceId, 'habit'))
    const match = type ? this.store.listObjects(type.id).find((h) => fold(h.title) === fold(query)) : undefined
    if (!match) throw new AgentError(`no habit "${query}" (list_habits shows them)`)
    return this.object(match.id)
  }

  private habitInfo(habit: Pick<ObjectSummary, 'id' | 'title' | 'props' | 'createdAt'>, day: string, recent: number) {
    const stats = habitStats(habit, this.captures.today())
    const target = habitTarget(habit)
    const weekdays = habitWeekdays(habit)
    return {
      id: habit.id,
      title: habit.title,
      url: this.url(habit.id),
      ...(weekdays.length ? { repeatsOn: weekdays } : { repeatsOn: 'every day' }),
      ...(target ? { dailyGoal: target, unit: habitUnit(habit) || undefined } : {}),
      ...(habitFoodRule(habit) ? { fromFood: habitFoodRule(habit) } : {}),
      ...(habitRemindAt(habit) ? { remindAt: habitRemindAt(habit) } : {}),
      ...(isHabitPaused(habit) ? { paused: true } : {}),
      day: { day, scheduled: isHabitScheduled(habit, day), done: isHabitDone(habit, day), ...(target ? { amount: habitValue(habit, day) } : {}) },
      stats: {
        currentStreak: stats.current,
        bestStreak: stats.best,
        thisWeek: `${stats.weekDone}/${stats.weekScheduled}`,
        last30Days: `${Math.round(stats.rate30 * 100)}%`,
        timesDone: stats.total,
        ...(target ? { averagePerDay: Math.round(stats.average30 * 10) / 10 } : {}),
      },
      ...(recent > 0
        ? {
            recent: Array.from({ length: recent }, (_, i) => addDays(day, i - recent + 1)).map((d) =>
              target ? { day: d, amount: habitValue(habit, d), done: isHabitDone(habit, d) } : { day: d, done: isHabitDone(habit, d) }
            ),
          }
        : {}),
    }
  }

  /** The habits of a space with a day's state (today by default), streaks and rates, and the last `recent` days. */
  habits(options: { space?: string; day?: string; recent?: number } = {}) {
    const space = this.space(options.space)
    const day = options.day ?? this.captures.today()
    if (!isValidDay(day)) throw new AgentError('day must be YYYY-MM-DD')
    const type = this.store.getType(builtinTypeId(space.id, 'habit'))
    if (!type) return []
    const recent = Math.min(Math.max(options.recent ?? 7, 0), 60)
    const habits = habitsWithFood(this.store, space.id, this.store.listObjects(type.id), this.captures.today())
    return habits.sort((a, b) => a.title.localeCompare(b.title)).map((habit) => this.habitInfo(habit, day, recent))
  }

  /**
   * Log a habit on a day (today by default): done or not, or for a habit with a daily goal an
   * amount (set it, or `add` to what is there).
   */
  logHabit(input: { habit: string; space?: string; day?: string; done?: boolean; amount?: number; add?: number }) {
    const space = this.space(input.space)
    const day = input.day ?? this.captures.today()
    if (!isValidDay(day)) throw new AgentError('day must be YYYY-MM-DD')
    const habit = this.habit(input.habit, space.id)
    if (habitFoodRule(habit)) throw new AgentError(`"${habit.title}" is done from what is logged in Food; log food instead (log_food)`)
    const target = habitTarget(habit)
    let amount: number
    if (input.add !== undefined) amount = habitValue(habit, day) + input.add
    else if (input.amount !== undefined) amount = input.amount
    else amount = input.done === false ? 0 : (target ?? 1)
    if (!Number.isFinite(amount) || amount < 0) throw new AgentError('the amount must be 0 or more')
    if (!target) amount = amount > 0 ? 1 : 0
    const object: ObjectRecord = { ...habit, props: { ...habit.props }, updatedAt: this.options.now() }
    const value = habitDayValue(habit, amount)
    if (value) object.props[habitDoneKey(day)] = value
    else delete object.props[habitDoneKey(day)]
    const stored = this.store.putObject(object)
    this.changed(stored)
    return this.habitInfo(stored, day, 7)
  }

  // Nutrition -------------------------------------------------------------------

  /** A food's nutrients per 100 g and portions, or a recipe's ingredients and what it comes to, for get_object. */
  private foodFacts(object: ObjectRecord): Record<string, unknown> {
    if (isFood(object)) {
      const per100 = foodNutrients(object)
      return { nutrition: { per100g: per100 ?? 'no data yet', portions: foodPortions(object), ...(foodBrand(object) ? { brand: foodBrand(object) } : {}) } }
    }
    if (!isRecipe(object)) return {}
    const lookup = (id: Id) => this.store.getObjectSummaries([id])[0]
    const facts = recipeFacts(object, lookup)
    return {
      nutrition: {
        ingredients: recipeIngredients(object).map((i) => ({ id: i.id, title: this.titleOf(i.id) ?? '(deleted)', grams: i.grams })),
        grams: facts.grams,
        ...(facts.per100 ? { per100g: facts.per100 } : {}),
        ...(facts.servingGrams ? { servingGrams: facts.servingGrams } : {}),
        ...(facts.missing.length ? { missingData: facts.missing.map((id) => this.titleOf(id) ?? id) } : {}),
      },
    }
  }

  private nutritionSpace(query?: string) {
    const space = this.space(query)
    if (!isNutritionOn(space)) throw new AgentError(`${space.name} does not track food (Settings › Food tracking in the app turns it on)`)
    return space
  }

  /** A food or recipe by id or title (accents, case and plurals ignored). */
  private foodSource(query: string, spaceId: Id): ObjectSummary {
    const sources = [...this.store.listObjects(builtinTypeId(spaceId, 'food')), ...this.store.listObjects(builtinTypeId(spaceId, 'recipe'))].filter((s) => !s.deletedAt)
    const found = sources.find((s) => s.id === query) ?? sources.find((s) => fold(s.title) === fold(query))
    if (!found) throw new AgentError(`no food or recipe "${query}" (search for it, or save_food makes one)`)
    return found
  }

  /**
   * Log what was eaten: a line as after /food ("2 slices of bread, coffee 200 ml at breakfast"),
   * or one food or recipe with an amount. Today by default.
   */
  logFood(input: { text?: string; food?: string; amount?: string; meal?: string; day?: string; space?: string }) {
    const space = this.nutritionSpace(input.space)
    const today = this.captures.today()
    const day = input.day ?? today
    if (!isValidDay(day)) throw new AgentError('day must be YYYY-MM-DD')
    const now = this.options.now()
    try {
      if (input.food) {
        const meals = space.nutrition?.meals ?? DEFAULT_MEALS
        const meal = input.meal ? meals.find((m) => m.id === input.meal || fold(m.name) === fold(input.meal!)) : undefined
        if (input.meal && !meal) throw new AgentError(`no meal "${input.meal}" (${meals.map((m) => m.name).join(', ')})`)
        const source = this.foodSource(input.food, space.id)
        const result = logFood(this.store, space.id, { sourceId: source.id, amount: input.amount ?? '', day, ...(meal ? { meal: meal.id } : {}), timeZone: this.captures.timeZone }, now)
        this.changed(result.note)
        return { logged: [{ id: result.entryId, ...result.entry }], ...this.nutritionDay({ space: space.id, day }) }
      }
      if (!input.text?.trim()) throw new AgentError('give text (as after /food) or a food and an amount')
      const result = logFoodLine(this.store, space.id, input.text, { today: day, timeZone: this.captures.timeZone }, now)
      for (const food of result.created) this.changed(food)
      if (result.note) this.changed(result.note)
      const answer = foodLineAnswer(result, today)
      return { day: result.day, logged: answer.entries, created: answer.created, problems: answer.problems, summary: answer.summary }
    } catch (error) {
      if (error instanceof NutritionError || error instanceof AmountError) throw new AgentError(error.message)
      throw error
    }
  }

  /** A day of food: its meals with their entries, totals, the goal and the week's budget. Today by default. */
  nutritionDay(input: { day?: string; space?: string } = {}) {
    const space = this.nutritionSpace(input.space)
    const day = input.day ?? this.captures.today()
    if (!isValidDay(day)) throw new AgentError('day must be YYYY-MM-DD')
    const dailyType = builtinTypeId(space.id, 'daily-note')
    const noteOn = (d: string) => this.store.findObjectOnDay(dailyType, d)
    const note = noteOn(day)
    const entries = note ? dayEntries(note) : []
    const goals = readGoals(this.store.listObjects(builtinTypeId(space.id, 'nutrition-goal')))
    const goal = goalForDay(goals, day)
    const week = weekBudget(goals, day, (d) => {
      const n = noteOn(d)
      return n ? dayTotals(dayEntries(n)).kcal : 0
    })
    const entry = (id: Id, e: FoodEntry) => ({ id, name: entryLabel(e), amount: e.amount, grams: e.grams, ...(e.nutrients ? { nutrients: e.nutrients } : { needsData: true }), ...(e.sourceId ? { foodId: e.sourceId } : {}), ...(e.quick ? { quick: true } : {}) })
    return {
      day,
      ...(note ? { dailyNoteId: note.id, url: this.url(note.id) } : {}),
      counted: isDayCounted(note),
      totals: dayTotals(entries),
      ...(goal ? { goal } : {}),
      ...(week ? { week } : {}),
      meals: groupByMeal(entries, space.nutrition?.meals ?? DEFAULT_MEALS, this.captures.timeZone).map((g) => ({
        meal: g.meal.name,
        totals: g.totals,
        entries: g.entries.map((e) => entry(e.id, e.entry)),
      })),
    }
  }

  /** Take an entry off a day (its id from nutrition_day). */
  deleteFoodEntry(input: { day?: string; entry: string; space?: string }) {
    const space = this.nutritionSpace(input.space)
    const day = input.day ?? this.captures.today()
    const note = this.store.findObjectOnDay(builtinTypeId(space.id, 'daily-note'), day)
    const stored = note ? deleteFoodEntry(this.store, note.id, input.entry, this.options.now()) : undefined
    if (!stored) throw new AgentError(`no entry ${input.entry} on ${day} (nutrition_day lists them)`)
    this.changed(stored)
    return this.nutritionDay({ space: space.id, day })
  }

  /**
   * Make a food or change one (by id or title): nutrients as on a label, per `per` grams (100 by
   * default; kept per 100 g), its brand and portions. Portions given replace the ones it had.
   */
  saveFood(input: { food: string; space?: string; per?: number; nutrients?: Partial<Nutrients>; brand?: string; portions?: FoodPortion[] }) {
    const space = this.nutritionSpace(input.space)
    const type = this.store.getType(builtinTypeId(space.id, 'food'))!
    let existing: ObjectSummary | undefined
    try {
      existing = this.foodSource(input.food, space.id)
    } catch {}
    if (existing && !isFood(existing)) throw new AgentError(`"${existing.title}" is a recipe; edit its ingredients in the app`)
    const now = this.options.now()
    const object: ObjectRecord = existing ? { ...this.object(existing.id), updatedAt: now } : newObject(type, { title: input.food.trim() }, randomUUID(), now)
    object.props = { ...object.props }
    const per = input.per && input.per > 0 ? input.per : 100
    for (const [key, value] of Object.entries(input.nutrients ?? {})) {
      if (!['kcal', 'protein', 'carbs', 'fat', 'fiber'].includes(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue
      object.props[key] = { kind: 'number', value: Math.round(((value * 100) / per) * 100) / 100 }
    }
    if (input.brand !== undefined) {
      if (input.brand.trim()) object.props.brand = { kind: 'text', value: input.brand.trim() }
      else delete object.props.brand
    }
    if (input.portions) {
      const portions = input.portions.filter((p) => p.name?.trim() && p.grams > 0).map((p) => ({ name: p.name.trim(), grams: p.grams }))
      if (portions.length) object.props.portions = portionsValue(portions)
      else delete object.props.portions
    }
    const stored = this.store.putObject(object)
    this.changed(stored)
    const usage = sourceUsage(this.store.listObjects(builtinTypeId(space.id, 'daily-note')), stored.id)
    return { ...this.getObject(stored.id), timesEaten: usage.count }
  }

  /** A note into today's daily note, like the quick capture (links in it are saved as weblinks). */
  async capture(input: { text: string; space?: string }) {
    const space = this.space(input.space)
    const result = await this.captures.note({ text: input.text, spaceId: space.id, channel: 'agent' })
    return { dailyNoteId: result.dailyNote.id, url: this.url(result.dailyNote.id), objects: result.objects.map((o) => ({ id: o.id, title: o.title })) }
  }
}

export interface AgentFilter {
  field: string
  operator: FilterOperator
  value?: string | number | boolean | string[]
}

const BUILT_IN_FIELDS = ['title', 'tags', 'collections', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'date', 'type']

/** A query field path from names: a property of `types`, or "Relation.Field" through a relation. */
function resolveField(name: string, types: ObjectType[], all: ObjectType[]): { path: string; def?: PropertyDef } {
  const find = (among: ObjectType[], wanted: string) =>
    among.flatMap((t) => t.properties).find((p) => p.id === wanted) ?? among.flatMap((t) => t.properties).find((p) => fold(p.name) === fold(wanted))
  const builtIn = BUILT_IN_FIELDS.find((f) => fold(f) === fold(name))
  if (builtIn) return { path: builtIn }
  const direct = find(types, name)
  if (direct) return { path: direct.id, def: direct }
  const dot = name.indexOf('.')
  if (dot > 0) {
    const relation = find(types, name.slice(0, dot))
    if (relation?.kind === 'relation') {
      const targets = relation.targetTypeIds.length ? all.filter((t) => relation.targetTypeIds.includes(t.id)) : all
      const rest = name.slice(dot + 1)
      const inner = BUILT_IN_FIELDS.find((f) => fold(f) === fold(rest))
      if (inner) return { path: `${relation.id}.${inner}` }
      const def = find(targets, rest)
      if (def) return { path: `${relation.id}.${def.id}`, def }
    }
  }
  throw new AgentError(`unknown field "${name}"`)
}

/** Option labels as the option ids a select filter compares. */
function selectValue(def: PropertyDef, value: AgentFilter['value']) {
  if (def.kind !== 'select' || value === undefined) return value
  const id = (label: string) => def.options.find((o) => o.id === label || fold(o.label) === fold(label))?.id ?? label
  return Array.isArray(value) ? value.map(id) : [id(String(value))]
}

function describeProperty(def: PropertyDef, typeNames: Map<Id, string>, type: ObjectType, types: ObjectType[]) {
  const base = { id: def.id, name: def.name, kind: def.kind }
  if (def.kind === 'formula') return { ...base, formula: formulaToNames(def.expression, type, types) }
  if (def.kind === 'select') return { ...base, multiple: def.multiple, options: def.options.map((o) => o.label) }
  if (def.kind === 'relation') return { ...base, multiple: def.multiple, ...(def.targetTypeIds.length ? { targets: def.targetTypeIds.map((id) => typeNames.get(id) ?? id) } : {}) }
  if (def.kind === 'person') return { ...base, multiple: def.multiple }
  if (def.kind === 'date') return { ...base, ...(def.withTime ? { withTime: true } : {}) }
  return base
}

function dateText(date: DateValue): string {
  const one = (iso: string) => (date.resolution === 'day' ? iso.slice(0, 10) : iso)
  return [one(date.start), date.end ? ` – ${one(date.end)}` : '', date.rrule ? ` (repeats: ${date.rrule})` : ''].join('')
}

/** A formula's value for agents: numbers, booleans and lists as JSON, dates as text, errors said. */
function formulaOutput(value: FormulaValue, timeZone: string): unknown {
  switch (value.kind) {
    case 'number':
    case 'checkbox':
      return value.value
    case 'date':
      return dateText(value.value)
    case 'list':
      return value.value.map((item) => formulaOutput(item, timeZone))
    case 'error':
      return { error: value.message }
    default:
      return formulaText(value, timeZone)
  }
}

function valueOf(def: PropertyDef, value: PropertyValue, titles: (ids: Id[]) => { id: Id; title: string }[], personName: (id: Id) => string): unknown {
  switch (value.kind) {
    case 'date':
      return dateText(value.value)
    case 'select': {
      const labels = value.value.map((id) => (def.kind === 'select' ? def.options.find((o) => o.id === id)?.label : undefined) ?? id)
      return def.kind === 'select' && def.multiple ? labels : labels[0]
    }
    case 'relation':
      return titles(value.value)
    case 'person': {
      const names = value.value.map(personName)
      return def.kind === 'person' && def.multiple ? names : names[0]
    }
    default:
      return value.value
  }
}
