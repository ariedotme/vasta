import { newId } from '@vasta/core'
import { evaluateFormula, type FormulaSubject, type FormulaValue, type PropertyDef } from '@vasta/core'
import { formatDate } from './format.ts'
import { locale, t } from './i18n.ts'
import { queryContext } from './query.ts'

const KIND_SPECS: { kind: PropertyDef['kind']; icon: string }[] = [
  { kind: 'text', icon: 'ph:text-t' },
  { kind: 'number', icon: 'ph:hash' },
  { kind: 'checkbox', icon: 'ph:check-square' },
  { kind: 'url', icon: 'ph:link' },
  { kind: 'date', icon: 'ph:calendar-blank' },
  { kind: 'select', icon: 'ph:caret-circle-down' },
  { kind: 'relation', icon: 'ph:arrows-left-right' },
  { kind: 'person', icon: 'ph:user' },
  { kind: 'formula', icon: 'ph:function' },
  { kind: 'rich-text', icon: 'ph:article' },
]

export const PROPERTY_KINDS: { kind: PropertyDef['kind']; readonly label: string; icon: string }[] = KIND_SPECS.map((spec) => ({
  ...spec,
  get label() {
    return t(`propKind.${spec.kind}`)
  },
}))

export const kindIcon = (kind: PropertyDef['kind']) => KIND_SPECS.find((k) => k.kind === kind)?.icon ?? 'ph:circle'
export const kindLabel = (kind: PropertyDef['kind']) => t(`propKind.${kind}`)

/** A new property definition of the given kind with sensible defaults. */
export function newPropertyDef(name: string, kind: PropertyDef['kind']): PropertyDef {
  const base = { id: newId(), name }
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

const numberFormats = new Map<string, Intl.NumberFormat>()
function numberFormat() {
  const loc = locale.value
  let fmt = numberFormats.get(loc)
  if (!fmt) {
    fmt = new Intl.NumberFormat(loc, { maximumFractionDigits: 6 })
    numberFormats.set(loc, fmt)
  }
  return fmt
}

/** A formula's value as text for tables and cards (checkboxes and errors are drawn by PropertyDisplay). */
export function formatFormula(value: FormulaValue): string {
  switch (value.kind) {
    case 'number':
      return numberFormat().format(value.value)
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
