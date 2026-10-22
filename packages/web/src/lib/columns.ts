// Table columns of a view or query: which fields show, in what order, how wide, and whether long
// values wrap. Saved as `TableSettings` on the view (or the query); missing settings give the
// default table (title, tags, the types' properties, last edited).
import type { Id, TableColumn, TableSettings } from '@vasta/core'
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
