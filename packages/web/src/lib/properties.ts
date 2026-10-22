import { evaluateFormula, type FormulaSubject, type FormulaValue, type PropertyDef } from '@vasta/core'
import { formatDate } from './format.ts'
import { queryContext } from './query.ts'

export const PROPERTY_KINDS: { kind: PropertyDef['kind']; label: string; icon: string }[] = [
  { kind: 'text', label: 'Text', icon: 'ph:text-t' },
  { kind: 'number', label: 'Number', icon: 'ph:hash' },
  { kind: 'checkbox', label: 'Checkbox', icon: 'ph:check-square' },
  { kind: 'url', label: 'URL', icon: 'ph:link' },
  { kind: 'date', label: 'Date', icon: 'ph:calendar-blank' },
  { kind: 'select', label: 'Select', icon: 'ph:caret-circle-down' },
  { kind: 'relation', label: 'Relation', icon: 'ph:arrows-left-right' },
  { kind: 'person', label: 'Person', icon: 'ph:user' },
  { kind: 'formula', label: 'Formula', icon: 'ph:function' },
  { kind: 'rich-text', label: 'Text block', icon: 'ph:article' },
]

export const kindIcon = (kind: PropertyDef['kind']) => PROPERTY_KINDS.find((k) => k.kind === kind)?.icon ?? 'ph:circle'
export const kindLabel = (kind: PropertyDef['kind']) => PROPERTY_KINDS.find((k) => k.kind === kind)?.label ?? kind

/** A new property definition of the given kind with sensible defaults. */
export function newPropertyDef(name: string, kind: PropertyDef['kind']): PropertyDef {
  const base = { id: crypto.randomUUID(), name }
  if (kind === 'select') return { ...base, kind, options: [], multiple: false }
  if (kind === 'relation') return { ...base, kind, targetTypeIds: [], multiple: true }
  if (kind === 'person') return { ...base, kind, multiple: false }
  if (kind === 'formula') return { ...base, kind, expression: '' }
  return { ...base, kind } as PropertyDef
}

/** A formula property's value on an object; related objects come from the summary cache. */
export function formulaValue(object: FormulaSubject, def: PropertyDef): FormulaValue {
  return def.kind === 'formula' ? evaluateFormula(object, def, queryContext()) : { kind: 'empty' }
}

const locale = typeof navigator !== 'undefined' ? navigator.language : 'en'
const numberFormat = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 })

/** A formula's value as text for tables and cards (checkboxes and errors are drawn by PropertyDisplay). */
export function formatFormula(value: FormulaValue): string {
  switch (value.kind) {
    case 'number':
      return numberFormat.format(value.value)
    case 'text':
      return value.value
    case 'checkbox':
      return value.value ? '✓' : ''
    case 'date':
      return formatDate(value.value)
    case 'list':
      return value.value.map(formatFormula).filter(Boolean).join(', ')
    default:
      return ''
  }
}
