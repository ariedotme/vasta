// "/Book Dune author:"Frank Herbert"" in quick capture, ⌘K and the desktop app's capture panel: the
// type a text starts with, what to offer at the cursor (types after "/", objects for a relation,
// options for a select, members for a person), and what the line will set, in words. The line is read by core's
// capture-line.ts, on the server or the replica. "/food" logs food instead (core's nutrition.ts):
// after it the foods and recipes are offered.
import { defaultTemplate, describeValue, findProperty, findTemplate, foodCommand, foodPortions, isCapturable, leadingTemplate, leadingType, lineAnswers, parseCaptureLine, parseDay, readQuickEntry, templateAsks, typeTemplates, type Icon, type Id, type ObjectRecord, type ObjectSummary, type ObjectType, type Person, type PropertyDef } from '@vasta/core'
import { formatLongDay } from './format.ts'

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()

/** This device's zone, which decides times such as "15h" in what is typed. */
export const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** The type "/Book Dune…" names and the rest, when the text starts with "/" and a type matches. */
export function typedLine(types: ObjectType[], text: string): { type: ObjectType; rest: string } | undefined {
  if (!text.startsWith('/') || foodCommand(text) !== undefined) return undefined
  return leadingType(types.filter(offered), text)
}

/** "/Food …" logs food, so the Food type is not one to make objects of from a line. */
const offered = (type: ObjectType) => isCapturable(type) && type.system !== 'food'
const tracksFood = (types: ObjectType[]) => types.some((t) => t.system === 'food' && !t.deletedAt)
const FOOD_COMMANDS = ['food']
const FOOD_ICON: Icon = { kind: 'icon', value: 'ph:bowl-food' }
const PERSON_ICON: Icon = { kind: 'icon', value: 'ph:user' }

/** Types to offer while "/" and the start of a name are all that is typed; names that start with it first. */
export function typeSuggestions(types: ObjectType[], text: string): ObjectType[] {
  const match = /^\/(\S*)$/.exec(text)
  if (!match) return []
  const wanted = fold(match[1]!)
  const names = (t: ObjectType) => [t.name, t.pluralName].map(fold)
  const live = types.filter(offered)
  const starts = live.filter((t) => names(t).some((n) => n.startsWith(wanted)))
  const within = live.filter((t) => !starts.includes(t) && names(t).some((n) => n.includes(wanted)))
  return [...starts, ...within].slice(0, 6)
}

export interface LinePreview {
  title: string
  /** What the line sets, in the type's order: "autor Frank Herbert", "nota 4.5". */
  parts: string[]
  /** Values that could not be read (they stay in the title). */
  errors: string[]
  /** The properties a line can set, for a hint: "autor, nota, gênero". */
  properties: string[]
  /** The template it starts from (the type's default, or the one named after "/Type:"). */
  template?: string
  /** A template named that the type does not have. */
  unknownTemplate?: string
}

/**
 * What the first line of `text` makes for objects of `type`; `people` are the space's members
 * (`me`: the user), `templates` the space's templates (the line's ":Name", else the default).
 */
export function previewLine(type: ObjectType, text: string, today: string, people: Person[] = [], me?: Id, templates: ObjectRecord[] = []): LinePreview {
  let line = text.split('\n')[0] ?? ''
  const named = leadingTemplate(line)
  if (named) line = named.rest
  const template = named ? findTemplate(templates, type.id, named.name) : defaultTemplate(templates, type.id)
  if (template) line = lineAnswers(line, type, templateAsks(template)).rest
  const which = template ? { template: template.template!.name } : named ? { unknownTemplate: named.name } : {}
  const zone = deviceZone()
  const parsed = parseCaptureLine(line, type, { today, timeZone: zone, people, ...(me ? { me } : {}) })
  const nameOf = (id: Id) => people.find((p) => p.id === id)?.name ?? '?'
  const settable = type.properties.filter((p) => p.kind !== 'rich-text' && p.kind !== 'formula')
  const parts = settable.flatMap((def): string[] => {
    const relation = parsed.relations.find((r) => r.propertyId === def.id)
    if (relation) return [`${def.name.toLowerCase()} ${relation.titles.join(', ')}`]
    const value = parsed.props[def.id]
    if (!value) return []
    // Options the line adds are not in the type yet.
    const added = parsed.newOptions.filter((n) => n.propertyId === def.id).map((n) => n.option)
    const withAdded: PropertyDef = def.kind === 'select' ? { ...def, options: [...def.options, ...added] } : def
    return [`${def.name.toLowerCase()} ${describeValue(withAdded, value, zone, () => '', nameOf)}`]
  })
  return { title: parsed.title, parts, errors: parsed.errors, properties: settable.map((p) => p.name.toLowerCase()), ...which }
}

export interface Completion {
  label: string
  /** Shown faded beside it: the object's type, "Daily note"… */
  detail?: string
  icon?: Icon
  /** The whole text once it is picked, and where the cursor goes. */
  text: string
  cursor: number
}

export interface CompletionSource {
  types: ObjectType[]
  /** Objects of these types (any when empty) whose title has `text`; the latest ones for ''. */
  objects(typeIds: Id[], text: string): Promise<ObjectSummary[]>
  today: string
  /** The space's members, for person values. */
  people?: Person[]
  /** The space's templates, for "/Task:" (lib/templates.ts). */
  templates?: () => ObjectRecord[]
}

const LIMIT = 8

/** What to offer at `cursor`: types while "/" and a name are typed, then values for a `name:` of the type. */
export async function complete(text: string, cursor: number, source: CompletionSource): Promise<Completion[]> {
  const before = text.slice(0, cursor)
  // "/Task:Bu": the type's templates.
  const named = /^\/([^\s:]+):(\S*)$/.exec(before)
  const namedType = named ? leadingType(source.types.filter(offered), `/${named[1]}`) : undefined
  if (named && namedType && !namedType.rest) {
    const end = cursor + /^\S*/.exec(text.slice(cursor))![0].length
    const rest = text.slice(end).replace(/^[ \t]+/, '')
    const wanted = fold(named[2]!)
    return typeTemplates(source.templates?.() ?? [], namedType.type.id)
      .filter((t) => fold(t.template!.name).startsWith(wanted))
      .slice(0, LIMIT)
      .map((t) => {
        const name = /\s/.test(t.template!.name) ? `"${t.template!.name}"` : t.template!.name
        const head = `/${named[1]}:${name} `
        return { label: t.template!.name, detail: `${namedType.type.name} template`, icon: { kind: 'icon', value: 'ph:copy-simple' } as Icon, text: head + rest, cursor: head.length }
      })
  }
  if (/^\/\S*$/.test(before)) {
    const end = cursor + /^\S*/.exec(text.slice(cursor))![0].length
    const rest = text.slice(end).replace(/^[ \t]+/, '')
    const word = fold(text.slice(1, end))
    const commands = tracksFood(source.types) ? FOOD_COMMANDS.filter((c) => c.startsWith(word)) : []
    return [
      ...commands.map((command) => ({ label: `/${command}`, detail: 'Log food', icon: FOOD_ICON, text: `/${command} ${rest}`, cursor: command.length + 2 })),
      ...typeSuggestions(source.types, text.slice(0, end)).map((type) => {
        const head = `/${type.name} `
        return { label: type.name, ...(type.icon ? { icon: type.icon } : {}), text: head + rest, cursor: head.length }
      }),
    ]
  }
  if (foodCommand(text) !== undefined) return completeFood(text, cursor, source)
  const typed = typedLine(source.types, text)
  const lineEnd = text.indexOf('\n')
  if (!typed || (lineEnd >= 0 && cursor > lineEnd)) return []
  // The last `name:` before the cursor; unquoted, its value runs to the cursor, spaces included, so
  // "autor:frank her" still looks for Frank Herbert (picking one quotes it).
  const token = /(?:^|\s)([^\s:"“]+):(?:"([^"]*)|“([^”]*)|([^"“:\n]*))$/u.exec(before)
  const def = token ? findProperty(typed.type, token[1]!) : undefined
  if (!token || !def || (def.kind !== 'relation' && def.kind !== 'select' && def.kind !== 'person')) return []
  const quoted = token[2] !== undefined || token[3] !== undefined
  const value = token[2] ?? token[3] ?? token[4] ?? ''
  const start = cursor - value.length - (quoted ? 1 : 0)
  const end = cursor + (quoted ? /^[^"”\n]*["”]?/ : /^\S*/).exec(text.slice(cursor))![0].length
  const parts = def.multiple ? value.split(',') : [value]
  const partial = parts.at(-1)!.trim()
  const kept = parts.slice(0, -1).map((p) => p.trim()).filter(Boolean)
  const pick = (label: string, insert: string, extra: Partial<Completion> = {}): Completion => {
    const joined = [...kept, insert].join(',')
    const written = /[\s"]/.test(joined) ? `"${joined}"` : joined
    const after = text.slice(end).replace(/^[ \t]+/, '')
    return { label, ...extra, text: `${text.slice(0, start)}${written} ${after}`, cursor: start + written.length + 1 }
  }
  const wanted = fold(partial)

  if (def.kind === 'select') {
    const options = def.options.filter((o) => fold(o.label).includes(wanted) && !kept.some((k) => fold(k) === fold(o.label)))
    return options.sort((a, b) => Number(!fold(b.label).startsWith(wanted)) - Number(!fold(a.label).startsWith(wanted))).slice(0, LIMIT).map((o) => pick(o.label, o.label))
  }

  if (def.kind === 'person') {
    const people = (source.people ?? []).filter((p) => (fold(p.name).includes(wanted) || fold(p.username).includes(wanted)) && !kept.some((k) => fold(k) === fold(p.username)))
    // Someone already written whole: Enter should make the object, not pick them again.
    if (people.some((p) => fold(p.username) === wanted || fold(p.name) === wanted)) return []
    return people.slice(0, LIMIT).map((p) => pick(p.name, p.username, { detail: `@${p.username}`, icon: PERSON_ICON }))
  }

  // A relation: the latest objects of its types, or those whose title has what is typed.
  const typesById = new Map(source.types.map((t) => [t.id, t]))
  const daily = source.types.find((t) => t.system === 'daily-note' && def.targetTypeIds.includes(t.id))
  const items: Completion[] = []
  if (daily) {
    // Daily notes have no title: they are named by their day ("today", "19/10", "2026-10-19").
    const day = partial ? parseDay(partial, source.today) : undefined
    const days = new Set<string>(day ? [day] : [])
    const notes = (await source.objects([daily.id], '')).sort((x, y) => (y.date?.start ?? '').localeCompare(x.date?.start ?? ''))
    for (const note of notes) {
      const noteDay = note.date?.start.slice(0, 10)
      if (noteDay && (!wanted || fold(formatLongDay(note.date!.start)).includes(wanted) || noteDay.includes(partial))) days.add(noteDay)
      if (days.size >= LIMIT) break
    }
    for (const d of days) items.push(pick(formatLongDay(`${d}T00:00:00.000Z`), d, { detail: daily.name, ...(daily.icon ? { icon: daily.icon } : {}) }))
  }
  const others = def.targetTypeIds.filter((id) => id !== daily?.id)
  if (!daily || others.length) {
    for (const object of await source.objects(others, partial)) {
      // Picking writes the title, so objects with the same one are one choice.
      const taken = [...kept, ...items.map((i) => i.label)].some((k) => fold(k) === fold(object.title))
      if (!object.title.trim() || object.typeId === daily?.id || taken) continue
      const type = typesById.get(object.typeId)
      const icon = object.icon ?? type?.icon
      items.push(pick(object.title, object.title, { ...(type ? { detail: type.name } : {}), ...(icon ? { icon } : {}) }))
      if (items.length >= LIMIT) break
    }
  }
  return items.slice(0, LIMIT)
}

/** Words that are part of an amount ("2", "150g", "slices of"), not of a food's name. */
const AMOUNT_WORD = /^(?:\d|[½¼¾⅓⅔])|^(?:g|kg|ml|l|of)$/i

/**
 * After /food: the foods and recipes whose name has the words typed at the cursor, after an
 * amount ("2 slices of bre" looks for "bre"); picking one writes its name.
 */
async function completeFood(text: string, cursor: number, source: CompletionSource): Promise<Completion[]> {
  const before = text.slice(0, cursor)
  const command = text.length - foodCommand(text)!.length
  const start = Math.max(command, ...[',', ';', '\n'].map((c) => before.lastIndexOf(c) + 1))
  // "muffin 350 kcal": logged by its numbers, no food to offer.
  if (readQuickEntry(before.slice(start))) return []
  const words = [...before.slice(start).matchAll(/\S+/g)]
  let first = words.length
  while (first > 0 && !AMOUNT_WORD.test(words[first - 1]![0])) first--
  const nameStart = first < words.length ? start + words[first]!.index : cursor
  const partial = text.slice(nameStart, cursor).trim()
  // Typing an amount after the name ("arroz 15"): nothing to offer.
  if (first === words.length && words.length && !/\s$/.test(before)) return []
  const typeIds = source.types.filter((t) => (t.system === 'food' || t.system === 'recipe') && !t.deletedAt).map((t) => t.id)
  if (!typeIds.length) return []
  const wanted = fold(partial)
  const found = (await source.objects(typeIds, partial)).filter((o) => !o.deletedAt && fold(o.title).includes(wanted))
  found.sort((a, b) => Number(!fold(a.title).startsWith(wanted)) - Number(!fold(b.title).startsWith(wanted)))
  // The name is already written whole: Enter should log it, not pick it again.
  if (found.length === 1 && fold(found[0]!.title) === wanted) return []
  const end = cursor + /^\S*/.exec(text.slice(cursor))![0].length
  const types = new Map(source.types.map((t) => [t.id, t]))
  return found.slice(0, LIMIT).map((o) => {
    const portion = foodPortions(o)[0]
    const written = `${o.title} `
    const type = types.get(o.typeId)
    return {
      label: o.title,
      detail: portion ? `1 ${portion.name} = ${portion.grams} g` : (type?.name ?? ''),
      icon: o.icon ?? type?.icon ?? FOOD_ICON,
      text: text.slice(0, nameStart) + written + text.slice(end).replace(/^[ \t]+/, ''),
      cursor: nameStart + written.length,
    }
  })
}
