// Properties written into a capture's first line, e.g. `/task Buy coffee due:fri priority:high`
// or `/new Book Dune author:"Frank Herbert" rating:5`. A `key:value` word whose key names a property
// of the type (case and accents ignored, a prefix is enough when only one property starts with it)
// sets that property; every other word stays in the title, so "Re: meeting" is left alone. Quotes
// allow spaces in a value. Used by the Telegram bot, the capture API (`line`), agents, and the app's
// quick capture and ⌘K (`/Book Dune author:…`), online and offline.
import { BODY_PROPERTY_ID, builtinTypeId } from './builtin-types.ts'
import type { DateValue, Doc, Id, IsoDateTime, ObjectRecord, ObjectType, Person, PropertyDef, PropertyValue, SelectOption } from './model.ts'
import { findOrCreateDailyNote, newObject } from './operations.ts'
import { currentSprint } from './sprints.ts'
import type { Store } from './store.ts'
import { textToBlocks } from './text-doc.ts'
import { addDays, dayIn, instantOf, isValidDay } from './time.ts'

export interface LineContext {
  /** Today in the capturing user's calendar ("YYYY-MM-DD"), for "tomorrow", "friday", "25/10". */
  today: string
  /** Zone of times such as "15h". */
  timeZone: string
  /** The space's members, for person values (`assignee:ana`); none: person values are refused. */
  people?: Person[]
  /** The capturing user, for `assignee:me`. */
  me?: Id
}

const ME_WORDS = new Set(['me'])

/** A member named by username (with or without "@"), full name or first name, ignoring case and accents. */
export function findPerson(people: Person[], text: string, me?: Id): Person | undefined {
  const wanted = fold(text.replace(/^@/, ''))
  if (!wanted) return undefined
  if (me && ME_WORDS.has(wanted)) return people.find((p) => p.id === me)
  return (
    people.find((p) => fold(p.username) === wanted) ??
    people.find((p) => fold(p.name) === wanted) ??
    people.find((p) => fold(p.name).split(/\s+/)[0] === wanted)
  )
}

export interface ParsedLine {
  title: string
  props: Record<Id, PropertyValue>
  /** Select options the line named that the type does not have yet; the capture adds them to the type. */
  newOptions: { propertyId: Id; option: SelectOption }[]
  /** Relation values by title; the capture finds those objects or creates them. */
  relations: { propertyId: Id; titles: string[] }[]
  /** Pairs that named a property but whose value could not be read (left in the title). */
  errors: string[]
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()
const keyOf = (text: string) => fold(text).replace(/[^a-z0-9]/g, '')

/** Other names for the built-in task fields. */
const TASK_KEY_ALIASES: Record<Id, string[]> = {
  due: ['when', 'date'],
  priority: ['prio'],
}

/** Other names for the built-in task options. */
const OPTION_ALIASES: Record<Id, string[]> = {
  medium: ['normal'],
  todo: ['to do'],
  doing: ['in progress'],
}

const WEEKDAYS: [number, string[]][] = [
  [0, ['sunday', 'sun']],
  [1, ['monday', 'mon']],
  [2, ['tuesday', 'tue', 'tues']],
  [3, ['wednesday', 'wed']],
  [4, ['thursday', 'thu', 'thurs']],
  [5, ['friday', 'fri']],
  [6, ['saturday', 'sat']],
]

const RELATIVE_DAYS: Record<string, number> = { today: 0, tomorrow: 1, yesterday: -1 }

const TIME = /^(\d{1,2})(?:(?:h|:)(\d{2})?|(?=am|pm))(am|pm)?$/

const YES = new Set(['yes', 'y', 'true', '1', 'x'])
const NO = new Set(['no', 'n', 'false', '0'])

/** A day ("YYYY-MM-DD") from a word: today, tomorrow, friday, fri, 25/10, 25/10/2026, 2026-10-25. */
export function parseDay(text: string, today: string): string | undefined {
  const word = keyOf(text)
  if (word in RELATIVE_DAYS) return addDays(today, RELATIVE_DAYS[word]!)
  const weekday = WEEKDAYS.find(([, names]) => names.includes(word))?.[0]
  if (weekday !== undefined) {
    const current = new Date(`${today}T00:00:00.000Z`).getUTCDay()
    // The next one: "friday" on a Friday is a week later ("today" is today).
    return addDays(today, (weekday - current + 7) % 7 || 7)
  }
  if (isValidDay(text)) return text
  const dm = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?$/.exec(text.trim())
  if (dm) {
    const pad = (n: string) => n.padStart(2, '0')
    const year = dm[3] ? (dm[3].length === 2 ? `20${dm[3]}` : dm[3]) : today.slice(0, 4)
    let day = `${year}-${pad(dm[2]!)}-${pad(dm[1]!)}`
    // Without a year, a day that has passed this year is next year's.
    if (!dm[3] && isValidDay(day) && day < today) day = `${Number(year) + 1}-${pad(dm[2]!)}-${pad(dm[1]!)}`
    return isValidDay(day) ? day : undefined
  }
  return undefined
}

/** Hours and minutes from "15h", "15h30", "15:30", "3pm", "3:30pm". */
export function parseTime(text: string): { hour: number; minute: number } | undefined {
  const match = TIME.exec(text.trim().toLowerCase())
  if (!match) return undefined
  let hour = Number(match[1])
  const minute = Number(match[2] ?? 0)
  if (match[3] === 'pm' && hour < 12) hour += 12
  if (match[3] === 'am' && hour === 12) hour = 0
  return hour < 24 && minute < 60 ? { hour, minute } : undefined
}

/** A date property value from "friday", "fri 15h", "25/10 9:30", "15h" (today), "2026-10-25". */
export function parseDateValue(text: string, context: LineContext): DateValue | undefined {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const time = words.length ? parseTime(words.at(-1)!) : undefined
  const dayWords = time ? words.slice(0, -1) : words
  const day = dayWords.length ? parseDay(dayWords.join(' '), context.today) : time ? context.today : undefined
  if (!day) return undefined
  if (!time) return { start: `${day}T00:00:00.000Z`, resolution: 'day' }
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  const instant = instantOf({ year, month, day: date, hour: time.hour, minute: time.minute, second: 0 }, context.timeZone)
  return { start: new Date(instant).toISOString(), resolution: 'time' }
}

/** The property a key names: its name (or a built-in alias), else the only one starting with it. */
export function findProperty(type: ObjectType, key: string): PropertyDef | undefined {
  const wanted = keyOf(key)
  if (!wanted) return undefined
  const candidates = type.properties.filter((p) => p.kind !== 'rich-text' && p.kind !== 'formula')
  const names = (p: PropertyDef) => [p.name, ...(type.system === 'task' ? (TASK_KEY_ALIASES[p.id] ?? []) : [])].map(keyOf)
  const exact = candidates.filter((p) => names(p).includes(wanted))
  if (exact.length === 1) return exact[0]
  const prefix = candidates.filter((p) => names(p).some((name) => name.startsWith(wanted)))
  return prefix.length === 1 ? prefix[0] : undefined
}

/** The option a value names: its label, a built-in alias, else the only label starting with it. */
function findOption(options: SelectOption[], value: string): SelectOption | undefined {
  const wanted = fold(value)
  const exact = options.find((o) => fold(o.label) === wanted || (OPTION_ALIASES[o.id] ?? []).includes(wanted))
  if (exact) return exact
  const prefix = options.filter((o) => fold(o.label).startsWith(wanted))
  return prefix.length === 1 ? prefix[0] : undefined
}

interface Token {
  raw: string
  key?: string
  value?: string
}

const TOKEN = /(\S+?):(?:"([^"]*)"|“([^”]*)”|(\S+))|(\S+)/gu

function tokenize(line: string): Token[] {
  const tokens: Token[] = []
  for (const match of line.matchAll(TOKEN)) {
    const value = match[2] ?? match[3] ?? match[4]
    // "https://…" is a link, not a property called https.
    if (match[1] !== undefined && value !== undefined && !value.startsWith('//')) tokens.push({ raw: match[0], key: match[1], value })
    else tokens.push({ raw: match[0] })
  }
  return tokens
}

/** Split a line into the title and the properties it sets for objects of `type`. */
export function parseCaptureLine(line: string, type: ObjectType, context: LineContext): ParsedLine {
  const result: ParsedLine = { title: '', props: {}, newOptions: [], relations: [], errors: [] }
  const title: string[] = []
  const tokens = tokenize(line)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    const def = token.key !== undefined ? findProperty(type, token.key) : undefined
    if (!def || token.value === undefined) {
      title.push(token.raw)
      continue
    }
    let text = token.value.trim()
    // "due:fri 15h": a time right after a date belongs to it.
    const next = tokens[i + 1]
    if (def.kind === 'date' && next && next.key === undefined && parseTime(next.raw) && !parseTime(text)) {
      text = `${text} ${next.raw}`
      i++
    }
    if (!applyValue(result, def, text, context)) {
      result.errors.push(`${def.name}: “${text}”`)
      title.push(token.raw)
    }
  }
  result.title = title.join(' ').trim()
  return result
}

/**
 * Property values given by name (or id) with plain values, as agents send them: text, numbers,
 * yes/no, dates as the line takes them ("2026-10-25", "friday 15h"), option labels and relation
 * titles (a list for several). Unknown names and unreadable values are reported in `errors`.
 */
export function parseProperties(type: ObjectType, values: Record<string, unknown>, context: LineContext): ParsedLine {
  const result: ParsedLine = { title: '', props: {}, newOptions: [], relations: [], errors: [] }
  for (const [key, raw] of Object.entries(values)) {
    const def = type.properties.find((p) => p.id === key && p.kind !== 'rich-text') ?? findProperty(type, key)
    if (!def) {
      result.errors.push(`${key}: no such property`)
      continue
    }
    if (def.kind === 'formula') {
      result.errors.push(`${def.name}: computed by a formula, it can't be set`)
      continue
    }
    const text = Array.isArray(raw) ? raw.map(String).join(',') : typeof raw === 'boolean' ? (raw ? 'yes' : 'no') : String(raw ?? '')
    if (def.kind === 'date' && /^\d{4}-\d{2}-\d{2}T/.test(text) && !Number.isNaN(Date.parse(text))) {
      result.props[def.id] = { kind: 'date', value: { start: new Date(text).toISOString(), resolution: 'time' } }
      continue
    }
    if (!applyValue(result, def, text.trim(), context)) result.errors.push(`${def.name}: “${text}”`)
  }
  return result
}

function applyValue(result: ParsedLine, def: PropertyDef, text: string, context: LineContext): boolean {
  if (!text) return false
  switch (def.kind) {
    case 'text':
      result.props[def.id] = { kind: 'text', value: text }
      return true
    case 'url':
      result.props[def.id] = { kind: 'url', value: text }
      return true
    case 'number': {
      const value = Number(text.replace(',', '.'))
      if (!Number.isFinite(value)) return false
      result.props[def.id] = { kind: 'number', value }
      return true
    }
    case 'checkbox': {
      const word = fold(text)
      if (!YES.has(word) && !NO.has(word)) return false
      result.props[def.id] = { kind: 'checkbox', value: YES.has(word) }
      return true
    }
    case 'date': {
      const value = parseDateValue(text, context)
      if (!value) return false
      result.props[def.id] = { kind: 'date', value }
      return true
    }
    case 'select': {
      const labels = (def.multiple ? text.split(',') : [text]).map((l) => l.trim()).filter(Boolean)
      const ids: Id[] = []
      for (const label of labels) {
        const pending = result.newOptions.find((n) => n.propertyId === def.id && fold(n.option.label) === fold(label))?.option
        const option = findOption(def.options, label) ?? pending
        if (option) {
          ids.push(option.id)
          continue
        }
        // An option the type does not have yet is created, like typing it in the app.
        const created: SelectOption = { id: crypto.randomUUID(), label, color: 'gray' }
        result.newOptions.push({ propertyId: def.id, option: created })
        ids.push(created.id)
      }
      if (!ids.length) return false
      result.props[def.id] = { kind: 'select', value: [...new Set(ids)] }
      return true
    }
    case 'relation': {
      const titles = (def.multiple ? text.split(',') : [text]).map((t) => t.trim()).filter(Boolean)
      if (!titles.length) return false
      result.relations = [...result.relations.filter((r) => r.propertyId !== def.id), { propertyId: def.id, titles }]
      return true
    }
    case 'person': {
      const names = (def.multiple ? text.split(',') : [text]).map((t) => t.trim()).filter(Boolean)
      const ids = names.map((name) => findPerson(context.people ?? [], name, context.me)?.id)
      if (!ids.length || ids.some((id) => !id)) return false
      result.props[def.id] = { kind: 'person', value: [...new Set(ids as Id[])] }
      return true
    }
    default:
      return false
  }
}

const dayLabel = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

/** A property value in words, for a channel's reply: "Fri 24 Oct", "Fri 24 Oct 15:00", "High". */
export function describeValue(def: PropertyDef, value: PropertyValue, timeZone: string, titleOf: (id: Id) => string, personName: (id: Id) => string = (id) => id): string {
  switch (value.kind) {
    case 'date': {
      if (value.value.resolution === 'day') return dayLabel.format(new Date(value.value.start))
      const at = new Date(value.value.start)
      const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone }).format(at)
      return `${dayLabel.format(new Date(`${dayIn(at.toISOString(), timeZone)}T00:00:00.000Z`))} ${time}`
    }
    case 'select': {
      const options = def.kind === 'select' ? def.options : []
      return value.value.map((id) => options.find((o) => o.id === id)?.label ?? id).join(', ')
    }
    case 'relation':
      return value.value.map(titleOf).join(', ')
    case 'person':
      return value.value.map(personName).join(', ')
    case 'checkbox':
      return value.value ? 'yes' : 'no'
    default:
      return String(value.value)
  }
}

// Types and objects ------------------------------------------------------------

/** Match a type by id, built-in key, or (folded) name or plural name. */
export function findType(types: ObjectType[], query: string): ObjectType | undefined {
  const wanted = fold(query)
  if (!wanted) return undefined
  return (
    types.find((t) => t.id === query) ??
    types.find((t) => t.system === wanted) ??
    types.find((t) => fold(t.name) === wanted || fold(t.pluralName) === wanted)
  )
}

/**
 * The type a text starts with and the rest: "Book Dune author:x" or "/Book Dune" with a type
 * called Book. The longest leading run of words that names a type wins ("Reading list Dune").
 */
export function leadingType(types: ObjectType[], text: string): { type: ObjectType; rest: string } | undefined {
  const words = text.replace(/^\//, '').trimStart().split(/(\s+)/)
  for (let i = words.length; i >= 1; i -= 2) {
    const type = findType(types, words.slice(0, i).join('').replace(/:$/, ''))
    if (type) return { type, rest: words.slice(i).join('').replace(/^[ \t]+/, '') }
  }
  return undefined
}

/** Types the app's quick capture and ⌘K offer after "/": the ones made from a title and properties alone. */
export function isCapturable(type: ObjectType): boolean {
  return !type.deletedAt && !['daily-note', 'date', 'query', 'weblink', 'image', 'pdf', 'audio', 'video', 'file', 'quote'].includes(type.system ?? '')
}

/**
 * Make what a parsed line needs: new select options go into a copy of the type (returned as
 * `type`, for the caller to write), relation titles become the matching objects of the space or
 * new ones (returned in `related`, to be written). Where the relation takes daily notes, a day
 * ("today", "19/10", "2026-10-19") is that day's note, made now when missing (daily notes have no
 * title to match).
 */
export function applyCaptureLine(store: Store, spaceId: Id, type: ObjectType, parsed: ParsedLine, at: IsoDateTime, context: LineContext): { props: Record<Id, PropertyValue>; related: ObjectRecord[]; type?: ObjectType } {
  let updated: ObjectType | undefined
  if (parsed.newOptions.length) {
    const properties = type.properties.map((def) => {
      const added = parsed.newOptions.filter((n) => n.propertyId === def.id).map((n) => n.option)
      return def.kind === 'select' && added.length ? { ...def, options: [...def.options, ...added] } : def
    })
    updated = { ...type, properties, updatedAt: at }
  }
  const props = { ...parsed.props }
  const related: ObjectRecord[] = []
  for (const { propertyId, titles } of parsed.relations) {
    const def = type.properties.find((p) => p.id === propertyId)
    if (def?.kind !== 'relation') continue
    const takesDays = def.targetTypeIds.includes(builtinTypeId(spaceId, 'daily-note'))
    const sprintType = builtinTypeId(spaceId, 'sprint')
    const ids = titles.map((title) => {
      const day = takesDays ? parseDay(title, context.today) : undefined
      if (day) return findOrCreateDailyNote(store, spaceId, day, at).note.id
      // "sprint:current": the sprint whose dates hold today.
      if (def.targetTypeIds.includes(sprintType) && fold(title) === 'current') {
        const current = currentSprint(store.listObjects(sprintType), context.today, context.timeZone)
        if (current) return current.id
      }
      const existing =
        store.search(spaceId, title, 50).find((o) => fold(o.title) === fold(title) && (!def.targetTypeIds.length || def.targetTypeIds.includes(o.typeId))) ??
        related.find((o) => fold(o.title) === fold(title))
      if (existing) return existing.id
      const target = def.targetTypeIds.map((id) => store.getType(id)).find((t) => t && !t.deletedAt && t.spaceId === spaceId) ?? store.getType(builtinTypeId(spaceId, 'page'))
      if (!target) return undefined
      const created = newObject(target, { title }, crypto.randomUUID(), at)
      related.push(created)
      return created.id
    })
    props[propertyId] = { kind: 'relation', value: [...new Set(ids.filter((id): id is Id => !!id))] }
  }
  return { props, related, ...(updated ? { type: updated } : {}) }
}

export interface LineObjectInput {
  type: ObjectType
  title?: string
  /** A first line to read the title and properties from. */
  line?: string
  /** Body text. */
  text?: string
  /** Values by property id; they win over the line. */
  props?: Record<Id, PropertyValue>
  at: IsoDateTime
  context: LineContext
}

export interface LineObject {
  object: ObjectRecord
  /** Objects the line's relations named that did not exist yet. */
  related: ObjectRecord[]
  /** The type with the select options the line added, when it added any. */
  type?: ObjectType
  parsed?: ParsedLine
}

/** A new object of a type from a title and properties written in a line; nothing is written yet. A task starts as "To do". */
export function objectFromLine(store: Store, input: LineObjectInput): LineObject {
  const { type } = input
  const parsed = input.line ? parseCaptureLine(input.line, type, input.context) : undefined
  const line = parsed ? applyCaptureLine(store, type.spaceId, type, parsed, input.at, input.context) : { props: {}, related: [] }
  const status: Record<Id, PropertyValue> = type.system === 'task' ? { status: { kind: 'select', value: ['todo'] } } : {}
  const blocks = input.text?.trim() ? textToBlocks(input.text) : []
  const content: Record<Id, Doc> = blocks.length ? { [BODY_PROPERTY_ID]: { type: 'doc', content: blocks } } : {}
  const object = newObject(type, { title: (input.title ?? parsed?.title ?? '').trim(), props: { ...status, ...line.props, ...input.props }, content }, crypto.randomUUID(), input.at)
  return { object, related: line.related, ...(line.type ? { type: line.type } : {}), ...(parsed ? { parsed } : {}) }
}

/** What a capture made, in words, for a reply or a notice: "Task “Buy coffee”, due Fri 24 Oct, priority High". */
export function describeCapture(type: ObjectType, object: ObjectRecord, parsed: ParsedLine | undefined, timeZone: string, titleOf: (id: Id) => string, personName?: (id: Id) => string): string {
  const parts = type.properties.flatMap((def) => {
    const value = object.props[def.id]
    // Only what the capture set: a task's default status is not news.
    if (!value || (def.id === 'status' && type.system === 'task' && !parsed?.props.status)) return []
    return [`${def.name.toLowerCase()} ${describeValue(def, value, timeZone, titleOf, personName)}`]
  })
  const name = object.title ? `${type.name} “${object.title}”` : type.name
  return [name, ...parts].join(', ')
}
