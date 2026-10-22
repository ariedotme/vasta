// Query helpers for the UI: field menus, operator labels, grouping, and moving an object between
// groups (kanban drops). Filtering and sorting themselves live in @vasta/core (query.ts).
import type { FilterOperator, Id, ObjectRecord, ObjectSummary, ObjectType, PropertyDef, QueryDef } from '@vasta/core'
import { fieldKind, type FieldKind, type QueryContext } from '@vasta/core'
import { api } from './api.ts'
import { dayKey } from './actions.ts'
import { meId, personName, sharedSpace } from './people.ts'
import { current as currentSprint } from './sprints.ts'
import { primeFromObject, summaryOf, typesById, workspace } from './state.ts'

export interface FieldOption {
  field: string
  label: string
  kind: FieldKind
  icon: string
  def?: PropertyDef
  /** For a field of related objects (`author.country`): the relation's label. */
  through?: string
}

const BUILTIN_OPTIONS: FieldOption[] = [
  { field: 'title', label: 'Title', kind: 'text', icon: 'ph:text-aa' },
  { field: 'tags', label: 'Tags', kind: 'ids', icon: 'ph:tag' },
  { field: 'type', label: 'Type', kind: 'ids', icon: 'ph:cube' },
  { field: 'collections', label: 'Collections', kind: 'ids', icon: 'ph:folders' },
  { field: 'createdAt', label: 'Created', kind: 'date', icon: 'ph:calendar-plus' },
  { field: 'updatedAt', label: 'Last edited', kind: 'date', icon: 'ph:clock-counter-clockwise' },
  { field: 'createdBy', label: 'Created by', kind: 'ids', icon: 'ph:user-plus' },
  { field: 'updatedBy', label: 'Last edited by', kind: 'ids', icon: 'ph:user-gear' },
  { field: 'date', label: 'Date', kind: 'date', icon: 'ph:calendar-blank' },
  { field: 'host', label: 'Website', kind: 'text', icon: 'ph:globe-hemisphere-west' },
]

const KIND_ICONS: Record<PropertyDef['kind'], string> = {
  text: 'ph:text-t', 'rich-text': 'ph:article', number: 'ph:hash', checkbox: 'ph:check-square', url: 'ph:link',
  date: 'ph:calendar-blank', relation: 'ph:arrows-left-right', select: 'ph:list-checks', person: 'ph:user', formula: 'ph:function',
}

/** Types a query or view covers: the given ones, or every type in the space. */
export function typesOf(typeIds: Id[]): ObjectType[] {
  return typeIds.length ? typeIds.flatMap((id) => typesById.value.get(id) ?? []) : workspace.types
}

/** Fields offered by filter, sort and group menus for these types. */
export function fieldOptions(typeIds: Id[]): FieldOption[] {
  const seen = new Set<string>()
  const props: FieldOption[] = []
  for (const type of typesOf(typeIds)) {
    for (const def of type.properties) {
      if (def.kind === 'rich-text' || seen.has(def.id)) continue
      seen.add(def.id)
      const label = typeIds.length === 1 ? def.name : `${def.name} · ${type.name}`
      props.push({ field: def.id, label, kind: fieldKind(def.id, def, typesById.value.values()), icon: def.icon?.value ?? KIND_ICONS[def.kind], def })
    }
  }
  // Only weblinks have a website; who made or changed something only matters in a shared space.
  const weblinks = typesOf(typeIds).some((t) => t.system === 'weblink')
  const builtins = BUILTIN_OPTIONS.filter((f) => (f.field !== 'host' || weblinks) && ((f.field !== 'createdBy' && f.field !== 'updatedBy') || sharedSpace.value))
  return [...builtins, ...props]
}

/**
 * Fields offered by filter menus: the types' own fields, then, under each relation, the fields of
 * the objects it points to (`author.country`). A relation to any type offers the built-in fields.
 */
export function filterFieldOptions(typeIds: Id[]): FieldOption[] {
  const own = fieldOptions(typeIds)
  const related = own.flatMap((option) => {
    if (option.def?.kind !== 'relation') return []
    const targets = option.def.targetTypeIds.filter((id) => typesById.value.has(id))
    const fields = targets.length ? fieldOptions(targets) : fieldOptions([]).filter((f) => !f.def && f.field !== 'host')
    return fields.map((f) => ({ ...f, field: `${option.field}.${f.field}`, label: `${option.label} › ${f.label}`, through: option.label }))
  })
  return [...own, ...related]
}

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  is: 'is', 'is-not': 'is not', contains: 'contains', 'not-contains': 'does not contain', 'starts-with': 'starts with',
  'is-empty': 'is empty', 'is-not-empty': 'is not empty', 'is-checked': 'is checked', 'is-not-checked': 'is not checked',
  gt: '>', gte: '≥', lt: '<', lte: '≤', before: 'is before', after: 'is after',
}

/** Labels that read better for lists of ids (tags, selects, relations). */
export const IDS_OPERATOR_LABELS: Partial<Record<FilterOperator, string>> = {
  contains: 'has any of', 'not-contains': 'has none of', is: 'is exactly', 'is-not': 'is not exactly',
}

/** Context for filtering on this thread; related objects come from the summary cache (and load into it). */
export function queryContext(parent?: ObjectSummary): QueryContext {
  const me = meId()
  return {
    types: typesById.value,
    today: dayKey(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    related: summaryOf,
    personName,
    ...(me ? { me } : {}),
    ...(currentSprint.value ? { currentSprint: currentSprint.value.id } : {}),
    ...(parent ? { parent } : {}),
  }
}

export function runServerQuery(query: QueryDef, parentId?: Id): Promise<ObjectSummary[]> {
  if (!workspace.space) return Promise.resolve([])
  return api.query(workspace.space.id, { query, ...(parentId ? { parentId } : {}), today: dayKey(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
}

// ---------------------------------------------------------------------------
// Grouping

export interface Group {
  key: string
  label: string
  color?: string
  /** Set when the group stands for an object (tag, relation target), a type or a person. */
  objectId?: string
  typeId?: string
  personId?: string
  items: ObjectSummary[]
}

export const NO_VALUE = '__none'

export function groupObjects(objects: ObjectSummary[], field: string, types: ObjectType[], keepEmpty = false): Group[] {
  if (!field) return [{ key: 'all', label: '', items: objects }]
  const def = types.flatMap((t) => t.properties).find((p) => p.id === field)
  const buckets = new Map<string, ObjectSummary[]>()
  const keysOf = (o: ObjectSummary): string[] => {
    if (field === 'tags') return o.tagIds
    if (field === 'collections') return o.collectionIds
    if (field === 'type') return [o.typeId]
    if (field === 'createdBy' || field === 'updatedBy') return o[field] ? [o[field]] : []
    const value = o.props[field]
    return value && (value.kind === 'select' || value.kind === 'relation' || value.kind === 'person') ? value.value : []
  }
  for (const object of objects) {
    const keys = keysOf(object)
    for (const key of keys.length ? keys : [NO_VALUE]) buckets.set(key, [...(buckets.get(key) ?? []), object])
  }
  const result: Group[] = []
  if (def?.kind === 'select') {
    for (const option of def.options) result.push({ key: option.id, label: option.label, ...(option.color ? { color: option.color } : {}), items: buckets.get(option.id) ?? [] })
  } else if (def?.kind === 'person' || field === 'createdBy' || field === 'updatedBy') {
    for (const [key, items] of buckets) if (key !== NO_VALUE) result.push({ key, label: personName(key), personId: key, items })
    result.sort((a, b) => a.label.localeCompare(b.label))
  } else if (field === 'type') {
    for (const [key, items] of buckets) {
      const type = typesById.value.get(key)
      result.push({ key, label: type?.pluralName ?? 'Unknown type', typeId: key, ...(type?.color ? { color: type.color } : {}), items })
    }
  } else {
    for (const [key, items] of buckets) if (key !== NO_VALUE) result.push({ key, label: '', objectId: key, items })
    result.sort((a, b) => b.items.length - a.items.length)
  }
  if (field !== 'type') result.push({ key: NO_VALUE, label: 'No value', items: buckets.get(NO_VALUE) ?? [] })
  return result.filter((g) => keepEmpty || g.items.length)
}

/** Fields a collection can be grouped by. */
export function groupOptions(typeIds: Id[]): FieldOption[] {
  return fieldOptions(typeIds).filter((f) => ['tags', 'type', 'createdBy', 'updatedBy'].includes(f.field) || f.def?.kind === 'select' || f.def?.kind === 'relation' || f.def?.kind === 'person')
}

/** Whether objects can be moved between the groups of `field` (its value is not computed or recorded). */
export const movableField = (field: string) => !!field && field !== 'type' && field !== 'createdBy' && field !== 'updatedBy'

/**
 * Give `object` the value of a group of `field` (a board column or lane): a tag among the groups'
 * tags, or the select, relation or person value. Whether it could.
 */
export function placeInGroup(object: Pick<ObjectRecord, 'typeId' | 'props' | 'tagIds'>, field: string, group: Group, groups: Group[]): boolean {
  if (!movableField(field)) return false
  if (field === 'tags') {
    const others = object.tagIds.filter((t) => !groups.some((g) => g.key === t))
    object.tagIds = group.key === NO_VALUE ? others : [...new Set([...others, group.key])]
    return true
  }
  const def = typesById.value.get(object.typeId)?.properties.find((p) => p.id === field)
  if (!def || (def.kind !== 'select' && def.kind !== 'relation' && def.kind !== 'person')) return false
  if (group.key === NO_VALUE) delete object.props[field]
  else object.props[field] = { kind: def.kind, value: [group.key] }
  return true
}

/** Put an object in another group of a grouped view (kanban drop). Returns the saved object. */
export async function moveToGroup(objectId: Id, field: string, group: Group, groups: Group[]) {
  if (!movableField(field)) return undefined
  const object = await api.object(objectId)
  if (!placeInGroup(object, field, group, groups)) return undefined
  const saved = await api.saveObject(object)
  primeFromObject(saved)
  return saved
}
