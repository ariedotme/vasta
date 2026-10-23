// Templates and snippets. A template is an object of its type kept apart from the others
// (ObjectRecord.template): making an object from it copies its title, properties and rich text,
// with placeholders replaced (`{{date}}`, `{{ask:With whom?}}`) and conditional blocks kept or
// dropped. A snippet is the same for a piece of text inserted where the cursor is. Pure functions,
// so the server (typed lines from Telegram and agents, daily notes), the replica and the app make
// the same object from the same template. No code runs: conditions and `{{formula:…}}` are
// formulas (formula.ts), evaluated with the template's variables.
import { Y, newBlockId, writeContent, type JsonDoc } from '@vasta/editor-schema/yjs'
import { BODY_PROPERTY_ID } from './builtin-types.ts'
import { nodeText } from './doc.ts'
import { evaluateFormula, formulaText, type FormulaContext, type FormulaSubject, type FormulaValue } from './formula.ts'
import type { DateValue, Doc, DocNode, Id, IsoDateTime, ObjectRecord, ObjectType, Person, PropertyDef, PropertyValue, SnippetScope } from './model.ts'
import { dailyNoteId } from './operations.ts'
import { parseDay } from './capture-line.ts'
import { addDays, dayIn } from './time.ts'

/** The placeholders, by the name before the colon. */
export const PLACEHOLDERS: { name: string; usage: string; description: string }[] = [
  { name: 'date', usage: 'date, date:+7d, date:next monday, date|D MMM YYYY', description: 'The object’s date (a daily note’s day), else today; shifted and formatted' },
  { name: 'time', usage: 'time, time|h:mm A', description: 'The time it is made' },
  { name: 'title', usage: 'title', description: 'The title typed for it' },
  { name: 'me', usage: 'me', description: 'You, the person making it' },
  { name: 'yesterday', usage: 'yesterday', description: 'A link to the day before’s daily note' },
  { name: 'tomorrow', usage: 'tomorrow', description: 'A link to the next day’s daily note' },
  { name: 'ask', usage: 'ask:With whom?', description: 'Asked when it is made; the same question twice is asked once' },
  { name: 'choose', usage: 'choose:Kind|Bug|Feature', description: 'A choice asked when it is made' },
  { name: 'selection', usage: 'selection', description: 'The text selected when it is made from a selection' },
  { name: 'cursor', usage: 'cursor', description: 'Where the cursor goes afterwards' },
  { name: 'formula', usage: 'formula:if(weekday(date) = 1, "Week starts", "")', description: 'A formula’s value' },
]

const NAMES = new Set(PLACEHOLDERS.map((p) => p.name))
/** Placeholders that may take a format after "|". */
const FORMATTED = new Set(['date', 'time', 'yesterday', 'tomorrow'])

export interface Placeholder {
  name: string
  /** What follows the colon: "+7d", "With whom?", "Kind|Bug|Feature", a formula. */
  arg: string
  /** What follows "|" for dates and times: "D MMM YYYY". */
  format?: string
}

/** A placeholder from what is between its braces; undefined when it names none. */
export function parsePlaceholder(value: string): Placeholder | undefined {
  const match = /^\s*([a-zA-Z]+)\s*(?:([:|])([\s\S]*))?$/.exec(value)
  if (!match) return undefined
  const name = match[1]!.toLowerCase()
  if (!NAMES.has(name)) return undefined
  const rest = match[3] ?? ''
  if (!FORMATTED.has(name)) return match[2] === '|' ? undefined : { name, arg: rest.trim() }
  if (match[2] === '|') return { name, arg: '', format: rest.trim() }
  const bar = rest.indexOf('|')
  return bar < 0 ? { name, arg: rest.trim() } : { name, arg: rest.slice(0, bar).trim(), format: rest.slice(bar + 1).trim() }
}

const PLACEHOLDER_TEXT = /\{\{([^{}]*)\}\}/g

/** A question a template asks when an object is made from it. */
export interface TemplateAsk {
  label: string
  /** For `choose`: the answers to pick from. */
  options?: string[]
}

const FORMULA_STRING = String.raw`(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')`
const FORMULA_ASK = new RegExp(String.raw`\bask\s*\(\s*${FORMULA_STRING}(?:\s*,\s*${FORMULA_STRING})*\s*\)`, 'g')

/** What a formula asks with ask("…"), and its answers with ask("Body", "Yes", "No"). */
function formulaAsks(source: string): TemplateAsk[] {
  return [...source.matchAll(FORMULA_ASK)].map((m) => {
    const [label = '', ...options] = [...m[0].matchAll(new RegExp(FORMULA_STRING, 'g'))].map((s) => s[0].slice(1, -1).replace(/\\(.)/g, '$1'))
    return { label, options: options.map((o) => o.trim()).filter(Boolean) }
  })
}

/** The questions a template or snippet asks, in the order they appear (title, properties, text). */
export function templateAsks(template: ObjectRecord): TemplateAsk[] {
  const asks: TemplateAsk[] = []
  const add = (label: string, options?: string[]) => {
    const trimmed = label.trim()
    if (!trimmed) return
    const known = asks.find((a) => a.label === trimmed)
    // Asked as free text first and with answers later: it gets the answers.
    if (known) {
      if (!known.options && options?.length) known.options = options
      return
    }
    asks.push(options?.length ? { label: trimmed, options } : { label: trimmed })
  }
  const fromPlaceholder = (value: string) => {
    const placeholder = parsePlaceholder(value)
    if (placeholder?.name === 'ask') add(placeholder.arg)
    else if (placeholder?.name === 'choose') {
      const [label = '', ...options] = placeholder.arg.split('|').map((part) => part.trim())
      add(label, options.filter(Boolean))
    } else if (placeholder?.name === 'formula') for (const ask of formulaAsks(placeholder.arg)) add(ask.label, ask.options)
  }
  const fromText = (text: string) => {
    for (const match of text.matchAll(PLACEHOLDER_TEXT)) fromPlaceholder(match[1]!)
  }
  fromText(template.title)
  for (const value of Object.values(template.props)) if (value.kind === 'text' || value.kind === 'url') fromText(value.value)
  if (template.template?.kind === 'template') for (const fill of Object.values(template.template.fills ?? {})) fromPlaceholder(fill)
  const visit = (nodes: DocNode[] | undefined) => {
    for (const node of nodes ?? []) {
      if (node.type === 'templatePlaceholder') fromPlaceholder(String(node.attrs?.value ?? ''))
      if (node.type === 'templateBranch' && typeof node.attrs?.condition === 'string') for (const ask of formulaAsks(node.attrs.condition)) add(ask.label, ask.options)
      if (node.type === 'text' && node.text) fromText(node.text)
      visit(node.content)
    }
  }
  for (const doc of Object.values(template.content)) visit(doc.content)
  return asks
}

/** Everything applying a template or snippet needs besides the template itself. */
export interface TemplateContext {
  /** When the object is made. */
  at: IsoDateTime
  /** Today in the user's calendar ("YYYY-MM-DD"). */
  today: string
  timeZone: string
  /** The object's day (a daily note's), when it has one; `{{date}}` is today otherwise. */
  day?: string
  /** The title the user typed. */
  title?: string
  /** The user making it, and the space's members (for their names). */
  me?: Id
  people?: Person[]
  /** Answers to the template's asks, by label. Missing ones are empty. */
  answers?: Record<string, string>
  /** The blocks selected when the object or snippet is made from a selection. */
  selection?: DocNode[]
  /** The space's types, for conditions that read properties. */
  types: Map<Id, ObjectType>
  /**
   * Leave out what differs between devices (`{{time}}`, `{{me}}`, asks) and give blocks ids
   * derived from `seed`: two devices making the same daily note offline then make the same text.
   */
  seed?: string
}

/** Where the cursor goes after a template is applied: a block and a character offset in its text. */
export interface TemplateCursor {
  field: Id
  blockId: string
  offset: number
}

export interface AppliedTemplate {
  title: string
  props: Record<Id, PropertyValue>
  content: Record<Id, Doc>
  cursor?: TemplateCursor
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * A day or time in a format: YYYY, YY, MMMM (October), MMM (Oct), MM, M, DD, D, dddd (Monday), ddd
 * (Mon), HH, H, hh, h, mm, A (AM/PM). Text in [brackets] is kept as written.
 */
export function formatTemplateDate(day: string, format: string, time?: { hour: number; minute: number }): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay()
  const hour = time?.hour ?? 0
  const minute = time?.minute ?? 0
  const pad = (n: number) => String(n).padStart(2, '0')
  const tokens: Record<string, string> = {
    YYYY: String(year),
    YY: String(year).slice(-2),
    MMMM: MONTHS[month - 1]!,
    MMM: MONTHS[month - 1]!.slice(0, 3),
    MM: pad(month),
    M: String(month),
    DD: pad(date),
    D: String(date),
    dddd: WEEKDAY_NAMES[weekday]!,
    ddd: WEEKDAY_NAMES[weekday]!.slice(0, 3),
    HH: pad(hour),
    H: String(hour),
    hh: pad(hour % 12 || 12),
    h: String(hour % 12 || 12),
    mm: pad(minute),
    A: hour < 12 ? 'AM' : 'PM',
  }
  return format.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|A/g, (token, literal) => literal ?? tokens[token] ?? token)
}

/** A day shifted as a date placeholder says: "+7d", "-1w", "+1m", "+1y", "next monday", "friday", "2026-10-25". */
export function shiftTemplateDay(day: string, arg: string): string | undefined {
  const text = arg.trim().toLowerCase()
  if (!text) return day
  const relative = /^([+-])\s*(\d+)\s*([dwmy])$/.exec(text)
  if (relative) {
    const amount = Number(relative[2]) * (relative[1] === '-' ? -1 : 1)
    if (relative[3] === 'd') return addDays(day, amount)
    if (relative[3] === 'w') return addDays(day, amount * 7)
    const date = new Date(`${day}T00:00:00.000Z`)
    if (relative[3] === 'm') date.setUTCMonth(date.getUTCMonth() + amount)
    else date.setUTCFullYear(date.getUTCFullYear() + amount)
    return date.toISOString().slice(0, 10)
  }
  return parseDay(text.replace(/^next\s+/, ''), day)
}

/** What a placeholder becomes: text, or a mention of a daily note. */
type Resolved = { kind: 'text'; text: string } | { kind: 'day'; day: string; text: string } | { kind: 'cursor' } | { kind: 'selection'; text: string } | { kind: 'date'; value: DateValue } | { kind: 'person'; id: Id; text: string }

interface Resolver {
  placeholder: (value: string) => Resolved | undefined
  text: (text: string) => string
  formula: (expression: string) => FormulaValue
}

/** The person's name, else their username. */
const personName = (people: Person[] | undefined, id: Id) => people?.find((p) => p.id === id)?.name ?? ''

function resolver(context: TemplateContext, type: ObjectType, subject: () => FormulaSubject): Resolver {
  const day = context.day ?? context.today
  const deterministic = context.seed !== undefined
  const answer = (label: string) => (deterministic ? '' : (context.answers?.[label.trim()] ?? ''))
  const me = deterministic ? undefined : context.me
  const formulaContext = (): FormulaContext => ({
    types: context.types,
    today: context.today,
    timeZone: context.timeZone,
    personName: (id) => personName(context.people, id) || undefined,
    template: {
      variables: {
        date: { kind: 'date', value: { start: `${day}T00:00:00.000Z`, resolution: 'day' } },
        me: me ? { kind: 'text', value: personName(context.people, me) || me } : { kind: 'empty' },
        type: { kind: 'text', value: type.name },
        title: context.title ? { kind: 'text', value: context.title } : { kind: 'empty' },
      },
      answer,
    },
  })
  const formula = (expression: string): FormulaValue => (expression.trim() ? evaluateFormula(subject(), { id: '#template', kind: 'formula', name: 'Template', expression }, formulaContext()) : { kind: 'empty' })
  const selectionText = () => (context.selection ?? []).map(nodeText).join('\n')
  const placeholder = (value: string): Resolved | undefined => {
    const p = parsePlaceholder(value)
    if (!p) return undefined
    switch (p.name) {
      case 'date': {
        const shifted = shiftTemplateDay(day, p.arg)
        return shifted ? { kind: 'date', value: { start: `${shifted}T00:00:00.000Z`, resolution: 'day' } } : { kind: 'text', text: '' }
      }
      case 'time':
        return deterministic ? { kind: 'text', text: '' } : { kind: 'date', value: { start: context.at, resolution: 'time' } }
      case 'yesterday':
      case 'tomorrow': {
        const other = addDays(day, p.name === 'yesterday' ? -1 : 1)
        return { kind: 'day', day: other, text: formatTemplateDate(other, p.format || 'dddd, MMMM D, YYYY') }
      }
      case 'title':
        return { kind: 'text', text: context.title ?? '' }
      case 'me':
        return me ? { kind: 'person', id: me, text: personName(context.people, me) } : { kind: 'text', text: '' }
      case 'ask':
        return { kind: 'text', text: answer(p.arg) }
      case 'choose':
        return { kind: 'text', text: answer(p.arg.split('|')[0] ?? '') }
      case 'selection':
        return { kind: 'selection', text: selectionText() }
      case 'cursor':
        return { kind: 'cursor' }
      case 'formula': {
        const result = formula(p.arg)
        return { kind: 'text', text: result.kind === 'error' ? '' : formulaText(result, context.timeZone) }
      }
    }
    return undefined
  }
  const asText = (value: string): string => {
    const resolved = placeholder(value)
    const p = parsePlaceholder(value)
    if (!resolved) return `{{${value}}}`
    switch (resolved.kind) {
      case 'date': {
        if (resolved.value.resolution === 'time') {
          const wall = new Date(resolved.value.start)
          const local = dayIn(resolved.value.start, context.timeZone)
          const [hour, minute] = new Intl.DateTimeFormat('en-GB', { timeZone: context.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(wall).split(':').map(Number) as [number, number]
          return formatTemplateDate(local, p?.format || 'HH:mm', { hour, minute })
        }
        return formatTemplateDate(resolved.value.start.slice(0, 10), p?.format || 'YYYY-MM-DD')
      }
      case 'cursor':
        return ''
      default:
        return resolved.text
    }
  }
  return { placeholder, text: (text) => text.replace(PLACEHOLDER_TEXT, (_, value: string) => asText(value)), formula }
}

/** A deep copy of JSON data (structuredClone refuses the app's reactive proxies). */
const copyJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()

/** A property value from a fill (`date:+7d`, `me`, `ask:Kind`), for the kind of property it fills. */
function fillValue(def: PropertyDef, value: string, resolve: Resolver, context: TemplateContext): PropertyValue | undefined {
  const resolved = resolve.placeholder(value)
  const text = resolved ? resolve.text(`{{${value}}}`).trim() : value.trim()
  switch (def.kind) {
    case 'date':
      if (resolved?.kind === 'date') return { kind: 'date', value: resolved.value }
      if (resolved?.kind === 'day') return { kind: 'date', value: { start: `${resolved.day}T00:00:00.000Z`, resolution: 'day' } }
      return undefined
    case 'person': {
      if (resolved?.kind === 'person') return { kind: 'person', value: [resolved.id] }
      const person = text ? context.people?.find((p) => fold(p.name) === fold(text) || fold(p.username) === fold(text)) : undefined
      return person ? { kind: 'person', value: [person.id] } : undefined
    }
    case 'text':
      return text ? { kind: 'text', value: text } : undefined
    case 'url':
      return text ? { kind: 'url', value: text } : undefined
    case 'number': {
      const number = Number(text.replace(',', '.'))
      return text && Number.isFinite(number) ? { kind: 'number', value: number } : undefined
    }
    case 'checkbox':
      return text ? { kind: 'checkbox', value: ['yes', 'true', '1', 'x'].includes(fold(text)) } : undefined
    case 'select': {
      const option = def.options.find((o) => fold(o.label) === fold(text))
      return option ? { kind: 'select', value: [option.id] } : undefined
    }
    default:
      return undefined
  }
}

/** Ids for the blocks of the text made: random, or derived from the seed (the same on every device). */
function blockIdMaker(seed: string | undefined): () => string {
  if (seed === undefined) return newBlockId
  let n = 0
  return () => {
    let hash = fnv(`${seed}#${n++}`)
    let id = ''
    for (let i = 0; i < 8; i++) {
      id += 'abcdefghijklmnopqrstuvwxyz0123456789'[hash % 36]
      hash = Math.floor(hash / 36) || fnv(`${seed}#${n}#${i}`)
    }
    return id
  }
}

/** 32-bit FNV-1a. */
function fnv(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

const isBlank = (node: DocNode) => node.type === 'paragraph' && !node.content?.length

interface DocResolution {
  resolve: Resolver
  makeId: () => string
  spaceId: Id
  selection?: DocNode[]
  cursor?: { blockId: string; offset: number }
}

/** Inline content with placeholders replaced; `offset` counts characters as the cursor does. */
function resolveInline(nodes: DocNode[], state: DocResolution, block: DocNode): DocNode[] {
  const out: DocNode[] = []
  let offset = 0
  for (const node of nodes) {
    if (node.type === 'templatePlaceholder') {
      const value = String(node.attrs?.value ?? '')
      const resolved = state.resolve.placeholder(value)
      const marks = node.marks?.length ? { marks: node.marks } : {}
      if (resolved?.kind === 'cursor') {
        if (!state.cursor) {
          if (typeof block.attrs?.id !== 'string') block.attrs = { ...block.attrs, id: state.makeId() }
          state.cursor = { blockId: block.attrs!.id as string, offset }
        }
        continue
      }
      if (resolved?.kind === 'day') {
        out.push({ type: 'mention', attrs: { objectId: dailyNoteId(state.spaceId, resolved.day), label: resolved.text } })
        offset += 1
        continue
      }
      const text = state.resolve.text(`{{${value}}}`)
      if (text) out.push({ type: 'text', text, ...marks })
      offset += text.length
      continue
    }
    if (node.type === 'text') {
      const text = state.resolve.text(node.text ?? '')
      if (text) out.push({ ...node, text })
      offset += text.length
      continue
    }
    // A quote's highlight belongs to the passage it was made from, not to copies of it.
    const copy = node.marks?.length ? { ...node, marks: node.marks.map(withoutQuote) } : node
    out.push(copy)
    offset += 1
  }
  return out
}

const withoutQuote = (mark: NonNullable<DocNode['marks']>[number]) => {
  if (mark.type !== 'highlight' || !mark.attrs?.quoteId) return mark
  const { quoteId: _quoteId, ...attrs } = mark.attrs
  return { ...mark, attrs }
}

/** Blocks with conditions decided, placeholders replaced and new ids. */
function resolveBlocks(nodes: DocNode[], state: DocResolution): DocNode[] {
  const out: DocNode[] = []
  for (const node of nodes) {
    if (node.type === 'templateIf') {
      const branch = (node.content ?? []).find((b) => {
        const condition = b.attrs?.condition
        if (typeof condition !== 'string' || !condition.trim()) return true
        const value = state.resolve.formula(condition)
        return value.kind === 'checkbox' ? value.value : value.kind !== 'empty' && value.kind !== 'error' && !(value.kind === 'number' && value.value === 0)
      })
      if (branch) out.push(...resolveBlocks(branch.content ?? [], state))
      continue
    }
    // `{{selection}}` alone in a paragraph takes the selected blocks whole.
    if (node.type === 'paragraph' && node.content?.length === 1 && node.content[0]!.type === 'templatePlaceholder' && parsePlaceholder(String(node.content[0]!.attrs?.value ?? ''))?.name === 'selection') {
      if (state.selection?.length) out.push(...resolveBlocks(copyJson(state.selection), { ...state, resolve: { ...state.resolve, text: (t) => t } }))
      continue
    }
    const copy: DocNode = { ...node }
    if (node.attrs) {
      const { capture: _capture, ...attrs } = node.attrs
      copy.attrs = typeof attrs.id === 'string' ? { ...attrs, id: state.makeId() } : attrs
      if (!Object.keys(copy.attrs).length) delete copy.attrs
    }
    if (node.content) {
      const inline = node.content.some((child) => child.type === 'text' || child.type === 'templatePlaceholder' || child.type === 'mention' || child.type === 'hardBreak')
      copy.content = inline ? resolveInline(node.content, state, copy) : resolveBlocks(node.content, state)
      // A container left empty by its conditions still needs a block.
      if (!inline && !copy.content.length) copy.content = [{ type: 'paragraph' }]
    }
    out.push(copy)
  }
  return out
}

/** The props of a template that are values of its type's properties (not comments or food entries). */
function ownProps(template: ObjectRecord, type: ObjectType): Record<Id, PropertyValue> {
  const ids = new Set(type.properties.map((p) => p.id))
  return Object.fromEntries(Object.entries(copyJson(template.props)).filter(([id]) => ids.has(id)))
}

/**
 * What an object made from a template starts with: its title (the typed title, or the template's
 * title resolved; `{{title}}` puts the typed one where it says), properties and rich text.
 */
export function applyTemplate(template: ObjectRecord, type: ObjectType, context: TemplateContext): AppliedTemplate {
  const subject: FormulaSubject = { ...template, typeId: type.id, title: context.title ?? '', props: ownProps(template, type) }
  delete subject.template
  const resolve = resolver(context, type, () => subject)
  // The title first, then the properties: conditions in the text read both.
  const pattern = template.title
  subject.title = /\{\{\s*title\s*\}\}/.test(pattern) || !context.title?.trim() ? resolve.text(pattern).trim() : context.title.trim()
  for (const [id, value] of Object.entries(subject.props)) {
    if (value.kind === 'text' || value.kind === 'url') {
      const text = resolve.text(value.value).trim()
      if (text) subject.props[id] = { ...value, value: text }
      else delete subject.props[id]
    }
  }
  const fills = template.template?.kind === 'template' ? (template.template.fills ?? {}) : {}
  for (const [id, fill] of Object.entries(fills)) {
    const def = type.properties.find((p) => p.id === id)
    const value = def ? fillValue(def, fill, resolve, context) : undefined
    if (value) subject.props[id] = value
  }
  const state: DocResolution = { resolve, makeId: blockIdMaker(context.seed), spaceId: type.spaceId, ...(context.selection ? { selection: context.selection } : {}) }
  const content: Record<Id, Doc> = {}
  let cursor: TemplateCursor | undefined
  for (const def of type.properties) {
    const doc = template.content[def.id]
    if (def.kind !== 'rich-text' || !doc) continue
    const blocks = resolveBlocks(doc.content, state)
    if (state.cursor && !cursor) cursor = { field: def.id, ...state.cursor }
    if (blocks.length && !blocks.every(isBlank)) content[def.id] = { type: 'doc', content: blocks }
  }
  return { title: subject.title, props: subject.props, content, ...(cursor ? { cursor } : {}) }
}

/** A space's templates of a type, the default one first. */
export function typeTemplates(templates: ObjectRecord[], typeId: Id): ObjectRecord[] {
  return templates
    .filter((t) => t.template?.kind === 'template' && t.typeId === typeId && !t.deletedAt)
    .sort((a, b) => Number(!!(b.template as { default?: boolean }).default) - Number(!!(a.template as { default?: boolean }).default))
}

/** The default template of a type, if it has one. */
export function defaultTemplate(templates: ObjectRecord[], typeId: Id): ObjectRecord | undefined {
  const first = typeTemplates(templates, typeId)[0]
  return first?.template?.kind === 'template' && first.template.default ? first : undefined
}

/** A template of a type by name (case and accents ignored; a prefix is enough when only one starts with it). */
export function findTemplate(templates: ObjectRecord[], typeId: Id, name: string): ObjectRecord | undefined {
  const wanted = fold(name)
  if (!wanted) return undefined
  const own = typeTemplates(templates, typeId)
  const exact = own.find((t) => fold(t.template!.name) === wanted)
  if (exact) return exact
  const prefixed = own.filter((t) => fold(t.template!.name).startsWith(wanted))
  return prefixed.length === 1 ? prefixed[0] : undefined
}

/**
 * A template made from an object ("Save as template"): its title, properties and text, without
 * what belongs to that one object (comments, captures, quote highlights, its date).
 */
export function templateFromObject(source: ObjectRecord, type: ObjectType, name: string, id: Id, at: IsoDateTime): ObjectRecord {
  const props = ownProps(source, type)
  const content: Record<Id, Doc> = {}
  const strip = (nodes: DocNode[]): DocNode[] =>
    nodes.map((node) => {
      const copy: DocNode = { ...node }
      if (node.attrs && 'capture' in node.attrs) {
        const { capture: _capture, ...attrs } = node.attrs
        copy.attrs = attrs
      }
      if (node.marks) copy.marks = node.marks.map(withoutQuote)
      if (node.content) copy.content = strip(node.content)
      return copy
    })
  for (const [field, doc] of Object.entries(source.content)) content[field] = { type: 'doc', content: strip(copyJson(doc.content)) }
  return {
    id,
    spaceId: source.spaceId,
    typeId: source.typeId,
    title: type.system === 'daily-note' ? '' : source.title,
    ...(source.icon ? { icon: source.icon } : {}),
    aliases: [],
    tagIds: [...source.tagIds],
    collectionIds: [],
    props,
    content,
    template: { kind: 'template', name: name.trim() || source.title || type.name },
    createdAt: at,
    updatedAt: at,
  }
}

// Snippets ------------------------------------------------------------------------------------

/** A snippet resolved for the object it goes into: inline content for one paragraph, else blocks. */
export interface AppliedSnippet {
  inline?: DocNode[]
  blocks?: DocNode[]
  /** Where the cursor goes: a block id of the result and an offset, or for inline content an offset into it. */
  cursor?: { blockId?: string; offset: number }
}

/**
 * A snippet's text for the object it is inserted into (`target`, whose values `prop()` reads and
 * whose title and date `{{title}}` and `{{date}}` are). Properties are never changed by a snippet.
 */
export function applySnippet(snippet: ObjectRecord, target: ObjectRecord, type: ObjectType, context: TemplateContext): AppliedSnippet {
  const day = target.date?.start.slice(0, 10) ?? context.day
  const ctx: TemplateContext = { ...context, title: context.title ?? target.title, ...(day ? { day } : {}) }
  const resolve = resolver(ctx, type, () => target)
  const state: DocResolution = { resolve, makeId: blockIdMaker(context.seed), spaceId: type.spaceId, ...(context.selection ? { selection: context.selection } : {}) }
  const body = snippet.content[BODY_PROPERTY_ID]?.content ?? []
  const blocks = resolveBlocks(body, state)
  if (blocks.length === 1 && blocks[0]!.type === 'paragraph') {
    const inline = blocks[0]!.content ?? []
    return { inline, ...(state.cursor ? { cursor: { offset: state.cursor.offset } } : {}) }
  }
  return { blocks, ...(state.cursor ? { cursor: state.cursor } : {}) }
}

/** Whether a snippet applies to an object of a type (its scope), `when` run on the object's current values. */
export function snippetApplies(snippet: ObjectRecord, object: FormulaSubject | undefined, type: ObjectType, context: Pick<TemplateContext, 'today' | 'timeZone' | 'types'>): boolean {
  if (snippet.template?.kind !== 'snippet') return false
  return scopeHolds(snippet.template.scope, object, type, context)
}

/** Whether a snippet's scope holds for an object (or, without one, for its type alone). */
export function scopeHolds(scope: SnippetScope | undefined, object: FormulaSubject | undefined, type: ObjectType, context: Pick<TemplateContext, 'today' | 'timeZone' | 'types'>): boolean {
  if (!scope) return true
  if (scope.typeIds?.length && !scope.typeIds.includes(type.id)) return false
  for (const required of scope.requires ?? []) {
    const def = type.properties.find((p) => p.kind === required.kind && fold(p.name) === fold(required.name))
    if (!def) return false
    if (required.set && object && !hasValue(object.props[def.id], def)) return false
  }
  if (scope.when?.trim() && object) {
    const value = evaluateFormula(object, { id: '#when', kind: 'formula', name: 'When', expression: scope.when }, {
      types: context.types,
      today: context.today,
      timeZone: context.timeZone,
      template: { variables: { date: object.date ? { kind: 'date', value: object.date } : { kind: 'empty' }, type: { kind: 'text', value: type.name }, title: { kind: 'text', value: object.title } }, answer: () => '' },
    })
    if (!(value.kind === 'checkbox' ? value.value : value.kind !== 'empty' && value.kind !== 'error')) return false
  }
  return true
}

const hasValue = (value: PropertyValue | undefined, def: PropertyDef) => {
  if (!value) return false
  if (Array.isArray(value.value)) return value.value.length > 0
  if (def.kind === 'checkbox') return value.value === true
  return value.value !== '' && value.value !== null
}

/** Whether a scope can hold for any object of the space's types ("applies nowhere" otherwise). */
export function scopeAppliesSomewhere(scope: SnippetScope | undefined, types: ObjectType[]): boolean {
  if (!scope) return true
  return types.some((type) => !type.deletedAt && scopeHolds({ ...scope, when: '' }, undefined, type, { today: '', timeZone: 'UTC', types: new Map() }))
}

// Daily notes -------------------------------------------------------------------------------

/**
 * The rich text of a new daily note made from a template, as a Yjs document every device makes
 * byte for byte the same (the same items, under a client id derived from the note and the text):
 * two devices that make the same day's note offline then merge into one copy. A template that
 * differs between them (edited offline on one) gives another client id, and both copies show,
 * which is better than merging items that are not the same.
 */
export function seededText(noteId: Id, content: Record<Id, Doc>): Y.Doc {
  const draft = new Y.Doc({ guid: 'vasta' })
  draft.clientID = 1
  writeContent(draft, content as unknown as Record<string, JsonDoc>)
  const bytes = Y.encodeStateAsUpdate(draft)
  let fingerprint = ''
  for (const byte of bytes) fingerprint += String.fromCharCode(byte)
  const seed = new Y.Doc({ guid: 'vasta' })
  // Yjs client ids are 32-bit; 0 and 1 are left to drafts.
  seed.clientID = (fnv(`${noteId}\n${fingerprint}`) >>> 1) + 2
  writeContent(seed, content as unknown as Record<string, JsonDoc>)
  // Edits made later must not use the seed's client id: a fresh document takes its items.
  const doc = new Y.Doc({ guid: 'vasta' })
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed))
  return doc
}
