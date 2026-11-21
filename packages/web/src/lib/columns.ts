// Table columns of a view or query: which fields show, in what order, how wide, and whether long
// values wrap. Saved as `TableSettings` on the view (or the query); missing settings give the
// default table (title, tags, the types' properties, last edited).
import type { Id, ListSettings, ObjectSummary, ObjectType, TableColumn, TableSettings } from '@vasta/core'
import { formulaValue } from './properties.ts'
import { fieldOptions, type FieldOption } from './query.ts'

export interface Column extends FieldOption {
  width?: number
  hidden: boolean
  wrap: boolean
}

export const MIN_COLUMN_WIDTH = 64
const DEFAULT_WIDTHS: Record<string, number> = { title: 260, updatedAt: 120, createdAt: 120, type: 140, date: 160, checkbox: 90, number: 110 }

export const columnWidth = (column: Column) => column.width ?? DEFAULT_WIDTHS[column.field] ?? DEFAULT_WIDTHS[column.def?.kind ?? ''] ?? 180

/** The columns for these types, in order, the title always first and shown. */
export function tableColumns(table: TableSettings | undefined, typeIds: Id[]): Column[] {
  const byField = new Map(fieldOptions(typeIds).map((f) => [f.field, f]))
  const columns: Column[] = []
  const add = (option: FieldOption, saved?: TableColumn) => {
    columns.push({
      ...option,
      ...(saved?.width ? { width: saved.width } : {}),
      hidden: saved ? !!saved.hidden : !(option.def || option.field === 'tags' || option.field === 'updatedAt'),
      wrap: saved?.wrap ?? table?.wrap ?? false,
    })
    byField.delete(option.field)
  }
  for (const saved of table?.columns ?? []) {
    const option = byField.get(saved.field)
    if (option) add(option, saved)
  }
  // Not saved yet: title, tags, the properties, last edited, then the other built-in fields (hidden).
  const rest = [...byField.values()]
  const rank = (f: FieldOption) => (f.field === 'title' ? 0 : f.field === 'tags' ? 1 : f.def ? 2 : f.field === 'updatedAt' ? 3 : 4)
  for (const option of rest.sort((a, b) => rank(a) - rank(b))) add(option)
  const title = columns.findIndex((c) => c.field === 'title')
  if (title > 0) columns.unshift(...columns.splice(title, 1))
  if (columns[0]) columns[0].hidden = false
  return columns
}

/** Settings to save for these columns, every one listed so the order holds. */
export function tableSettings(columns: Column[]): TableSettings {
  return {
    columns: columns.map((c) => ({ field: c.field, ...(c.width ? { width: Math.round(c.width) } : {}), ...(c.hidden ? { hidden: true } : {}), ...(c.wrap ? { wrap: true } : {}) })),
  }
}

export interface ListField extends FieldOption {
  on: boolean
}

// Shown on a list row like in a table cell; who made or changed an object is not drawn there.
const NOT_IN_ROWS = new Set(['title', 'createdBy', 'updatedBy'])
const DEFAULT_ROW = ['tags', 'updatedAt']

/** The fields a list row can show after its title: the chosen ones first, in order, then the rest (off). Unset settings tick what the default row shows. */
export function listFields(list: ListSettings | undefined, typeIds: Id[]): ListField[] {
  const options = fieldOptions(typeIds).filter((f) => !NOT_IN_ROWS.has(f.field))
  const chosen = list?.fields ?? DEFAULT_ROW
  const byField = new Map(options.map((f) => [f.field, f]))
  const on = [...new Set(chosen)].flatMap((field) => byField.get(field) ?? [])
  const ticked = new Set(on.map((f) => f.field))
  return [...on.map((f) => ({ ...f, on: true })), ...options.filter((f) => !ticked.has(f.field)).map((f) => ({ ...f, on: false }))]
}

/** Settings to save for these fields (the ticked ones, in order), keeping whether titles wrap. */
export function listSettings(fields: ListField[], wrap: boolean | undefined): ListSettings {
  return { fields: fields.filter((f) => f.on).map((f) => f.field), ...(wrap ? { wrap: true } : {}) }
}

/** The fields a row shows for this object, in order: those its type has (properties) and that have a value. */
export function rowFields(object: ObjectSummary, type: ObjectType | undefined, fields: ListField[]): ListField[] {
  return fields.flatMap((field) => {
    if (!field.on) return []
    if (!field.def) return hasBuiltin(object, field.field) ? [field] : []
    const def = type?.properties.find((p) => p.id === field.field)
    if (!def) return []
    const value = object.props[def.id]
    const filled =
      def.kind === 'formula' ? formulaValue(object, def).kind !== 'empty'
      : !value ? false
      : value.kind === 'checkbox' ? value.value
      : Array.isArray(value.value) || typeof value.value === 'string' ? value.value.length > 0
      : true
    return filled ? [{ ...field, def }] : []
  })
}

function hasBuiltin(object: ObjectSummary, field: string): boolean {
  switch (field) {
    case 'tags': return object.tagIds.length > 0
    case 'collections': return object.collectionIds.length > 0
    case 'date': return !!object.date
    case 'host': return !!object.media?.host
    case 'createdVia': return !!object.createdVia
    case 'updatedVia': return !!object.updatedVia
    default: return true
  }
}
