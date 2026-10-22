// Query engine: filters and sorts object summaries by a QueryDef or a view's filter. Pure
// functions over data, so the server (embedded queries) and the web app (type views) share it.
import type {
  Filter,
  FilterGroup,
  FilterOperator,
  FilterValue,
  Id,
  IsoDateTime,
  ObjectSummary,
  ObjectType,
  PropertyDef,
  SortRule,
} from './model.ts'
import { evaluateFormula, formulaKind, formulaReferences, type FormulaValue } from './formula.ts'
import type { Bounds } from './store.ts'
import { addDays, dayIn } from './time.ts'

/** Fields every object has, usable in filters, sorting and grouping next to property ids. */
export const BUILTIN_FIELDS = ['title', 'tags', 'collections', 'type', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'date', 'host'] as const
export type BuiltinField = (typeof BUILTIN_FIELDS)[number]

/** How a field compares: the filter operators and value editor depend on it. */
export type FieldKind = 'text' | 'number' | 'checkbox' | 'date' | 'ids'

export interface QueryContext {
  /** Every type that can appear, to read property definitions. */
  types: Map<Id, ObjectType>
  /** The object a query is embedded in; the `parent` variable. */
  parent?: ObjectSummary
  /** The current day ("YYYY-MM-DD"); the `today` variable. */
  today: string
  /** Zone used to turn instants (createdAt, timed dates) into days. */
  timeZone: string
  /** Objects reached through relations, for filters on a related object's field (`author.country`). */
  related?: (id: Id) => ObjectSummary | undefined
  /** A tag's parent tag: an object tagged #recipe/breakfast counts as tagged #recipe too. */
  tagParent?: (id: Id) => Id | undefined
  /** The user looking; the `me` variable ("assigned to me"). */
  me?: Id
  /** The sprint whose dates hold today; the `current-sprint` variable. */
  currentSprint?: Id
  /** A person's name, to sort person fields by it (their id otherwise). */
  personName?: (id: Id) => string | undefined
}

/** A field's value, normalized for comparison. */
type FieldValue =
  | { kind: 'empty' }
  | { kind: 'text'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'checkbox'; value: boolean }
  | { kind: 'date'; day: string; instant: string }
  /** `implied`: ids it also counts as having for contains (the parents of its tags). */
  | { kind: 'ids'; value: Id[]; implied?: Id[] }

const EMPTY: FieldValue = { kind: 'empty' }

/**
 * A field path through a relation: `author.country` is the field `country` of the objects the
 * relation property `author` points to. One level only.
 */
export function splitPath(field: string): { relation: string; field: string } | undefined {
  const dot = field.indexOf('.')
  return dot > 0 ? { relation: field.slice(0, dot), field: field.slice(dot + 1) } : undefined
}

/** Relation property ids that a filter reaches through, so callers can load the related objects. */
export function filterRelations(filter: Filter | FilterGroup | undefined, into = new Set<string>()): Set<string> {
  if (!filter) return into
  if (filter.kind === 'group') for (const item of filter.items) filterRelations(item, into)
  else {
    const path = splitPath(filter.field)
    if (path) into.add(path.relation)
  }
  return into
}

/**
 * Relation property ids (and "tags") that a query's filter and sort read through, so callers can
 * load the related objects: relation paths, and what the formulas they use read.
 */
export function queryRelations(query: { filter?: FilterGroup; sort?: SortRule[] }, types: Iterable<ObjectType>): Set<string> {
  const into = filterRelations(query.filter)
  const fields = new Set<string>((query.sort ?? []).map((rule) => rule.field))
  const collect = (filter: Filter | FilterGroup) => (filter.kind === 'group' ? filter.items.forEach(collect) : fields.add(filter.field))
  if (query.filter) collect(query.filter)
  const all = [...types]
  for (const field of fields) {
    const def = findPropertyDef(field, all)
    if (def?.kind === 'formula') formulaReferences(def, all, into)
  }
  return into
}

/** Ids of the objects these objects point to through the given relation properties (and "tags"). */
export function relatedIds(objects: ObjectSummary[], relations: Set<string>): Id[] {
  const ids = new Set<Id>()
  for (const object of objects) {
    for (const relation of relations) {
      if (relation === 'tags') for (const id of object.tagIds) ids.add(id)
      const value = object.props[relation]
      if (value?.kind === 'relation') for (const id of value.value) ids.add(id)
    }
  }
  return [...ids]
}

/** The property definition behind a field id, looked up in the object's type or any given type. */
export function findPropertyDef(field: string, types: Iterable<ObjectType>, typeId?: Id): PropertyDef | undefined {
  const all = [...types]
  const own = all.find((t) => t.id === typeId)?.properties.find((p) => p.id === field)
  if (own) return own
  for (const type of all) {
    const def = type.properties.find((p) => p.id === field)
    if (def) return def
  }
  return undefined
}

/** How a field compares; a formula's kind is read from its expression, which needs the types. */
export function fieldKind(field: string, def?: PropertyDef, types: Iterable<ObjectType> = []): FieldKind {
  switch (field) {
    case 'title':
    case 'host':
      return 'text'
    case 'tags':
    case 'collections':
    case 'type':
    case 'createdBy':
    case 'updatedBy':
      return 'ids'
    case 'createdAt':
    case 'updatedAt':
    case 'date':
      return 'date'
  }
  switch (def?.kind) {
    case 'number':
      return 'number'
    case 'checkbox':
      return 'checkbox'
    case 'date':
      return 'date'
    case 'relation':
    case 'select':
    case 'person':
      return 'ids'
    case 'formula': {
      const kind = formulaKind(def, types)
      return kind === 'number' || kind === 'checkbox' || kind === 'date' ? kind : 'text'
    }
    default:
      return 'text'
  }
}

/** Operators that make sense for a kind of field, in menu order. */
export const OPERATORS: Record<FieldKind, FilterOperator[]> = {
  text: ['contains', 'not-contains', 'is', 'is-not', 'starts-with', 'is-empty', 'is-not-empty'],
  number: ['is', 'is-not', 'gt', 'gte', 'lt', 'lte', 'is-empty', 'is-not-empty'],
  checkbox: ['is-checked', 'is-not-checked'],
  date: ['is', 'is-not', 'before', 'after', 'is-empty', 'is-not-empty'],
  ids: ['contains', 'not-contains', 'is', 'is-not', 'is-empty', 'is-not-empty'],
}

/** Operators that take no value. */
export const UNARY_OPERATORS: FilterOperator[] = ['is-empty', 'is-not-empty', 'is-checked', 'is-not-checked']

function dateValue(start: IsoDateTime, resolution: 'day' | 'time', timeZone: string): FieldValue {
  // Day-resolution dates are stored at midnight UTC, so their day is the UTC date.
  return { kind: 'date', day: resolution === 'day' ? start.slice(0, 10) : dayIn(start, timeZone), instant: start }
}

/** The parents, grandparents… of some tags, not counting the tags themselves (a cycle stops). */
export function tagAncestors(tagIds: Id[], context: Pick<QueryContext, 'tagParent'>): Id[] {
  if (!context.tagParent || !tagIds.length) return []
  const seen = new Set(tagIds)
  const ancestors: Id[] = []
  for (const id of tagIds) {
    for (let parent = context.tagParent(id); parent && !seen.has(parent); parent = context.tagParent(parent)) {
      seen.add(parent)
      ancestors.push(parent)
    }
  }
  return ancestors
}

function readField(object: ObjectSummary, field: string, context: QueryContext): FieldValue {
  switch (field) {
    case 'title':
      return { kind: 'text', value: object.title }
    case 'tags':
      return { kind: 'ids', value: object.tagIds, implied: tagAncestors(object.tagIds, context) }
    case 'collections':
      return { kind: 'ids', value: object.collectionIds }
    case 'type':
      return { kind: 'ids', value: [object.typeId] }
    case 'createdAt':
    case 'updatedAt':
      return dateValue(object[field], 'time', context.timeZone)
    case 'createdBy':
    case 'updatedBy':
      return object[field] ? { kind: 'ids', value: [object[field]] } : EMPTY
    case 'date':
      return object.date ? dateValue(object.date.start, object.date.resolution, context.timeZone) : EMPTY
    case 'host':
      // The site a weblink points to, without "www.".
      return object.media?.host ? { kind: 'text', value: object.media.host.replace(/^www\./, '') } : EMPTY
  }
  const own = context.types.get(object.typeId)?.properties.find((p) => p.id === field)
  if (own?.kind === 'formula') return formulaField(evaluateFormula(object, own, context), context.timeZone)
  const value = object.props[field]
  if (!value) {
    const def = own ?? findPropertyDef(field, context.types.values(), object.typeId)
    return def?.kind === 'checkbox' ? { kind: 'checkbox', value: false } : EMPTY
  }
  switch (value.kind) {
    case 'text':
    case 'url':
      return value.value ? { kind: 'text', value: value.value } : EMPTY
    case 'number':
      return { kind: 'number', value: value.value }
    case 'checkbox':
      return { kind: 'checkbox', value: value.value }
    case 'date':
      return dateValue(value.value.start, value.value.resolution, context.timeZone)
    case 'relation':
    case 'select':
    case 'person':
      return { kind: 'ids', value: value.value }
  }
  // Structured values the app keeps without a property definition (nutrition) are not fields.
  return EMPTY
}

/** A formula's result as a field value; a list compares as its items joined, an error as empty. */
function formulaField(value: FormulaValue, timeZone: string): FieldValue {
  switch (value.kind) {
    case 'number':
    case 'checkbox':
      return value
    case 'text':
      return { kind: 'text', value: value.value }
    case 'date':
      return dateValue(value.value.start, value.value.resolution, timeZone)
    case 'list': {
      const items = value.value.map((item) => formulaField(item, timeZone)).flatMap((item) => (item.kind === 'text' ? [item.value] : item.kind === 'number' ? [String(item.value)] : item.kind === 'date' ? [item.day] : []))
      return items.length ? { kind: 'text', value: items.join(', ') } : EMPTY
    }
    default:
      return EMPTY
  }
}

/** Resolve a filter value against the context: literals as given, variables to values. */
function resolveValue(value: FilterValue | undefined, context: QueryContext): FieldValue | string | number | boolean | Id[] | undefined {
  if (!value) return undefined
  if (value.kind === 'literal') return value.value
  if (value.name === 'today') {
    const day = addDays(context.today, value.offsetDays ?? 0)
    return { kind: 'date', day, instant: `${day}T00:00:00.000Z` }
  }
  if (value.name === 'me') return context.me ? { kind: 'ids', value: [context.me] } : { kind: 'empty' }
  if (value.name === 'current-sprint') return context.currentSprint ? { kind: 'ids', value: [context.currentSprint] } : { kind: 'empty' }
  const parent = context.parent
  if (!parent) return { kind: 'empty' }
  if (!value.field) return { kind: 'ids', value: [parent.id] }
  // Daily notes and date objects stand for their date, even when created on another day
  // (Capacities dates daily notes by createdAt, so imported queries compare against it).
  if (value.field === 'createdAt' && parent.date?.resolution === 'day') return dateValue(parent.date.start, 'day', context.timeZone)
  return readField(parent, value.field, context)
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

function asIds(target: ReturnType<typeof resolveValue>): Id[] {
  if (target === undefined) return []
  if (Array.isArray(target)) return target
  if (typeof target === 'object') return target.kind === 'ids' ? target.value : target.kind === 'text' ? [target.value] : []
  return [String(target)]
}

function asText(target: ReturnType<typeof resolveValue>): string {
  if (target === undefined) return ''
  if (typeof target === 'object' && !Array.isArray(target)) {
    if (target.kind === 'text') return target.value
    if (target.kind === 'number') return String(target.value)
    if (target.kind === 'date') return target.day
    if (target.kind === 'ids') return target.value[0] ?? ''
    return ''
  }
  return Array.isArray(target) ? (target[0] ?? '') : String(target)
}

function asDay(target: ReturnType<typeof resolveValue>, timeZone: string): string | undefined {
  if (target && typeof target === 'object' && !Array.isArray(target)) return target.kind === 'date' ? target.day : undefined
  const text = asText(target)
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  return Number.isNaN(Date.parse(text)) ? undefined : dayIn(text, timeZone)
}

function compare(a: number | string, b: number | string, operator: FilterOperator): boolean {
  switch (operator) {
    case 'is':
      return a === b
    case 'is-not':
      return a !== b
    case 'gt':
    case 'after':
      return a > b
    case 'gte':
      return a >= b
    case 'lt':
    case 'before':
      return a < b
    case 'lte':
      return a <= b
    default:
      return false
  }
}

/** Negative operators and the positive ones they negate. */
const NEGATED: Partial<Record<FilterOperator, FilterOperator>> = {
  'is-not': 'is',
  'not-contains': 'contains',
  'is-empty': 'is-not-empty',
  'is-not-checked': 'is-checked',
}

function matchesOne(object: ObjectSummary, filter: Filter, context: QueryContext): boolean {
  const path = splitPath(filter.field)
  if (!path) return matchesValue(readField(object, filter.field, context), filter, context)
  if (!UNARY_OPERATORS.includes(filter.operator)) {
    if (!filter.value) return true
    const target = resolveValue(filter.value, context)
    if (target && typeof target === 'object' && !Array.isArray(target) && target.kind === 'empty') return false
  }
  // Through a relation with several targets, a positive filter matches when any related object
  // matches it, and a negative one ("is not", "is empty"…) when none matches its positive form.
  const relation = object.props[path.relation]
  const targets = (relation?.kind === 'relation' ? relation.value : [])
    .map((id) => context.related?.(id))
    .filter((target): target is ObjectSummary => !!target && !target.deletedAt)
  const positive = NEGATED[filter.operator]
  const inner: Filter = { ...filter, field: path.field, operator: positive ?? filter.operator }
  const any = targets.some((target) => matchesValue(readField(target, path.field, context), inner, context))
  return positive ? !any : any
}

function matchesValue(value: FieldValue, filter: Filter, context: QueryContext): boolean {
  const { operator } = filter
  if (operator === 'is-empty') return value.kind === 'empty' || (value.kind === 'ids' && !value.value.length) || (value.kind === 'checkbox' && !value.value)
  if (operator === 'is-not-empty') return !matchesValue(value, { ...filter, operator: 'is-empty' }, context)
  if (operator === 'is-checked') return value.kind === 'checkbox' && value.value
  if (operator === 'is-not-checked') return !(value.kind === 'checkbox' && value.value)

  // A filter still being set up (no value yet) does not narrow the results.
  if (!filter.value) return true
  const target = resolveValue(filter.value, context)
  // A variable that resolves to nothing (no parent) matches nothing, rather than everything.
  if (target && typeof target === 'object' && !Array.isArray(target) && target.kind === 'empty') return false
  const negative = operator === 'is-not' || operator === 'not-contains'

  switch (value.kind) {
    case 'empty':
      return negative
    case 'ids': {
      const wanted = asIds(target)
      const has = value.value
      const reached = value.implied?.length ? [...has, ...value.implied] : has
      if (operator === 'contains') return wanted.some((id) => reached.includes(id))
      if (operator === 'not-contains') return !wanted.some((id) => reached.includes(id))
      const same = wanted.length === has.length && wanted.every((id) => has.includes(id))
      return operator === 'is' ? same : operator === 'is-not' ? !same : false
    }
    case 'text': {
      const text = fold(value.value)
      const wanted = fold(asText(target))
      if (operator === 'contains') return text.includes(wanted)
      if (operator === 'not-contains') return !text.includes(wanted)
      if (operator === 'starts-with') return text.startsWith(wanted)
      return compare(text, wanted, operator)
    }
    case 'number': {
      const wanted = Number(asText(target))
      return !Number.isNaN(wanted) && compare(value.value, wanted, operator)
    }
    case 'checkbox':
      return operator === 'is' ? value.value === (asText(target) === 'true') : false
    case 'date': {
      const day = asDay(target, context.timeZone)
      return day !== undefined && compare(value.day, day, operator)
    }
  }
}

export function matchesFilter(object: ObjectSummary, filter: Filter | FilterGroup | undefined, context: QueryContext): boolean {
  if (!filter) return true
  if (filter.kind === 'filter') return matchesOne(object, filter, context)
  if (!filter.items.length) return true
  return filter.operator === 'and'
    ? filter.items.every((item) => matchesFilter(object, item, context))
    : filter.items.some((item) => matchesFilter(object, item, context))
}

/** A value to sort by; '' sorts last whatever the direction. */
export function sortKey(object: ObjectSummary, field: string, context: QueryContext): string | number {
  const value = readField(object, field, context)
  switch (value.kind) {
    case 'empty':
      return ''
    case 'text':
      return fold(value.value)
    case 'number':
      return value.value
    case 'checkbox':
      return value.value ? 1 : 0
    case 'date':
      return value.instant
    case 'ids': {
      const def = findPropertyDef(field, context.types.values(), object.typeId)
      if (def?.kind === 'select') return def.options.findIndex((o) => o.id === value.value[0])
      if (def?.kind === 'person' || field === 'createdBy' || field === 'updatedBy') return value.value.map((id) => fold(context.personName?.(id) ?? id)).join(',')
      return value.value.join(',')
    }
  }
}

export function sortObjects(objects: ObjectSummary[], rules: SortRule[] | undefined, context: QueryContext): ObjectSummary[] {
  if (!rules?.length) return [...objects]
  // Keys are read once per object: formulas would otherwise run at every comparison.
  const keyed = objects.map((object) => ({ object, keys: rules.map((rule) => sortKey(object, rule.field, context)) }))
  keyed.sort((a, b) => {
    for (const [i, { direction }] of rules.entries()) {
      const ka = a.keys[i]!
      const kb = b.keys[i]!
      if (ka === kb) continue
      if (ka === '') return 1
      if (kb === '') return -1
      const factor = direction === 'asc' ? 1 : -1
      return ka < kb ? -factor : factor
    }
    return 0
  })
  return keyed.map((k) => k.object)
}

/**
 * When the objects a filter can match were created and last changed, as far as its filters on
 * createdAt and updatedAt joined by "and" at the top say, a couple of days wider (the filter
 * compares days in the viewer's zone, the store instants in UTC): a store reads only the objects
 * within these bounds, and the filter decides.
 */
export function timeBounds(filter: FilterGroup | undefined, context: Pick<QueryContext, 'today' | 'timeZone'>): { created?: Bounds; updated?: Bounds } {
  const bounds: { created?: Bounds; updated?: Bounds } = {}
  if (filter?.operator !== 'and') return bounds
  for (const item of filter.items) {
    if (item.kind !== 'filter' || (item.field !== 'createdAt' && item.field !== 'updatedAt') || !item.value) continue
    const value = item.value
    const day =
      value.kind === 'literal' ? asDay(value.value, context.timeZone) : value.name === 'today' ? addDays(context.today, value.offsetDays ?? 0) : undefined
    if (!day) continue
    const from = item.operator === 'is' ? addDays(day, -2) : item.operator === 'after' ? addDays(day, -1) : undefined
    const to = item.operator === 'is' ? addDays(day, 3) : item.operator === 'before' ? addDays(day, 2) : undefined
    const range = (bounds[item.field === 'createdAt' ? 'created' : 'updated'] ??= {})
    if (from && (!range.from || from > range.from)) range.from = from
    if (to && (!range.to || to < range.to)) range.to = to
  }
  return bounds
}

/** Objects matching a filter, sorted (newest first when no sort is given). */
export function runQuery(objects: ObjectSummary[], query: { filter?: FilterGroup; sort?: SortRule[] }, context: QueryContext): ObjectSummary[] {
  const matched = objects.filter((object) => !object.deletedAt && matchesFilter(object, query.filter, context))
  return sortObjects(matched, query.sort?.length ? query.sort : [{ field: 'createdAt', direction: 'desc' }], context)
}
