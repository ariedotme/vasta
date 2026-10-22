// Formula properties: a value computed from an object's other fields, never stored. Pure
// functions over data, so the server (queries, agents) and the app (tables, the object page) agree.
//
// An expression refers to fields in braces. It is stored with field ids (`{price} * {qty}`), so
// renaming a property does not break it, and shown with names (`{Price} * {Quantity}`) where
// people edit it. `{Author.Country}` reads a field of the objects a relation points to.
import type { DateValue, FormulaPropertyDef, Id, ObjectSummary, ObjectType, PropertyDef } from './model.ts'
import type { QueryContext } from './query.ts'
import { addDays, dayIn, daysBetween } from './time.ts'

/** What a formula computes. Errors are values too, so one bad row does not break a table. */
export type FormulaValue =
  | { kind: 'empty' }
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'checkbox'; value: boolean }
  | { kind: 'date'; value: DateValue }
  | { kind: 'list'; value: FormulaValue[] }
  | { kind: 'error'; message: string }

/** The kind of value a formula gives, known from the expression before running it. */
export type FormulaKind = 'number' | 'text' | 'checkbox' | 'date' | 'list'

/** An object a formula runs on: summaries and full records both do. */
export type FormulaSubject = Omit<ObjectSummary, 'preview'>

export type FormulaContext = Pick<QueryContext, 'types' | 'related' | 'today' | 'timeZone' | 'personName'>

export class FormulaError extends Error {}

/** Built-in fields a formula can read, with the names they go by in expressions. */
export const FORMULA_BUILTIN_FIELDS: Record<string, string> = {
  title: 'Title',
  createdAt: 'Created',
  updatedAt: 'Last edited',
  createdBy: 'Created by',
  updatedBy: 'Last edited by',
  date: 'Date',
  tags: 'Tags',
}

// ---------------------------------------------------------------------------
// Syntax

type BinaryOperator = '+' | '-' | '*' | '/' | '%' | '=' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or'

export type FormulaNode =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'field'; field: string }
  | { kind: 'call'; name: string; args: FormulaNode[] }
  | { kind: 'unary'; operator: '-' | 'not'; operand: FormulaNode }
  | { kind: 'binary'; operator: BinaryOperator; left: FormulaNode; right: FormulaNode }

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'field'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'symbol'; value: string }
  | { kind: 'end' }

const SYMBOLS = ['<=', '>=', '!=', '<>', '==', '&&', '||', '+', '-', '*', '/', '%', '<', '>', '=', '!', '(', ')', ',']

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const char = source[i]!
    if (/\s/.test(char)) {
      i++
      continue
    }
    if (/[0-9.]/.test(char)) {
      const match = /^(\d+\.?\d*|\.\d+)/.exec(source.slice(i))
      if (!match) throw new FormulaError(`Unexpected “${char}”`)
      tokens.push({ kind: 'number', value: Number(match[0]) })
      i += match[0].length
      continue
    }
    if (char === '"' || char === "'") {
      let value = ''
      let j = i + 1
      for (; j < source.length && source[j] !== char; j++) value += source[j] === '\\' && j + 1 < source.length ? source[++j] : source[j]
      if (j >= source.length) throw new FormulaError('A text is missing its closing quote')
      tokens.push({ kind: 'text', value })
      i = j + 1
      continue
    }
    if (char === '{') {
      const close = source.indexOf('}', i)
      if (close < 0) throw new FormulaError('A field is missing its closing “}”')
      const field = source.slice(i + 1, close).trim()
      if (!field) throw new FormulaError('An empty field “{}”')
      tokens.push({ kind: 'field', value: field })
      i = close + 1
      continue
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i))
    if (name) {
      tokens.push({ kind: 'name', value: name[0] })
      i += name[0].length
      continue
    }
    const symbol = SYMBOLS.find((s) => source.startsWith(s, i))
    if (!symbol) throw new FormulaError(`Unexpected “${char}”`)
    tokens.push({ kind: 'symbol', value: symbol })
    i += symbol.length
  }
  tokens.push({ kind: 'end' })
  return tokens
}

const describeToken = (token: Token) => (token.kind === 'end' ? 'the end' : token.kind === 'field' ? `{${token.value}}` : `“${token.value}”`)

/** Turn an expression into a tree. Throws a FormulaError saying what is wrong. */
export function parseFormula(source: string): FormulaNode {
  const tokens = tokenize(source)
  let at = 0
  const peek = () => tokens[at]!
  const isSymbol = (...values: string[]) => {
    const token = peek()
    return (token.kind === 'symbol' || token.kind === 'name') && values.includes(token.kind === 'name' ? token.value.toLowerCase() : token.value)
  }
  const expect = (value: string) => {
    if (!isSymbol(value)) throw new FormulaError(`Expected “${value}” but found ${describeToken(peek())}`)
    at++
  }

  const binary = (next: () => FormulaNode, operators: Record<string, BinaryOperator>) => (): FormulaNode => {
    let left = next()
    while (isSymbol(...Object.keys(operators))) {
      const token = tokens[at++]!
      const key = token.kind === 'name' ? token.value.toLowerCase() : (token as { value: string }).value
      left = { kind: 'binary', operator: operators[key]!, left, right: next() }
    }
    return left
  }

  const primary = (): FormulaNode => {
    const token = tokens[at++]!
    switch (token.kind) {
      case 'number':
        return { kind: 'number', value: token.value }
      case 'text':
        return { kind: 'text', value: token.value }
      case 'field':
        return { kind: 'field', field: token.value }
      case 'name': {
        const name = token.value.toLowerCase()
        if (name === 'true' || name === 'false') return { kind: 'boolean', value: name === 'true' }
        const fn = FUNCTIONS[name]
        if (!fn) throw new FormulaError(isSymbol('(') ? `Unknown function “${token.value}”` : `Unexpected “${token.value}” (fields go in braces: {${token.value}})`)
        expect('(')
        const args: FormulaNode[] = []
        if (!isSymbol(')')) {
          args.push(or())
          while (isSymbol(',')) {
            at++
            args.push(or())
          }
        }
        expect(')')
        if (args.length < fn.min || args.length > fn.max) {
          const count = fn.min === fn.max ? `${fn.min}` : fn.max === Infinity ? `at least ${fn.min}` : `${fn.min} to ${fn.max}`
          throw new FormulaError(`${name}() takes ${count} value${fn.min === 1 && fn.max === 1 ? '' : 's'}`)
        }
        return { kind: 'call', name, args }
      }
      case 'symbol':
        if (token.value === '(') {
          const inner = or()
          expect(')')
          return inner
        }
        throw new FormulaError(`Unexpected ${describeToken(token)}`)
      case 'end':
        throw new FormulaError('The formula ends too soon')
    }
  }
  const unary = (): FormulaNode => {
    if (isSymbol('-')) {
      at++
      return { kind: 'unary', operator: '-', operand: unary() }
    }
    if (isSymbol('+')) {
      at++
      return unary()
    }
    return primary()
  }
  const product = binary(unary, { '*': '*', '/': '/', '%': '%' })
  const sum = binary(product, { '+': '+', '-': '-' })
  const comparison = binary(sum, { '=': '=', '==': '=', '!=': '!=', '<>': '!=', '<': '<', '<=': '<=', '>': '>', '>=': '>=' })
  const not = (): FormulaNode => {
    if (isSymbol('not', '!')) {
      at++
      return { kind: 'unary', operator: 'not', operand: not() }
    }
    return comparison()
  }
  const and = binary(not, { and: 'and', '&&': 'and' })
  const or = binary(and, { or: 'or', '||': 'or' })

  if (peek().kind === 'end') throw new FormulaError('The formula is empty')
  const tree = or()
  if (peek().kind !== 'end') throw new FormulaError(`Unexpected ${describeToken(peek())}`)
  return tree
}

const parsed = new Map<string, FormulaNode | FormulaError>()

function cachedParse(source: string): FormulaNode {
  let tree = parsed.get(source)
  if (!tree) {
    try {
      tree = parseFormula(source)
    } catch (error) {
      if (!(error instanceof FormulaError)) throw error
      tree = error
    }
    if (parsed.size > 500) parsed.clear()
    parsed.set(source, tree)
  }
  if (tree instanceof FormulaError) throw tree
  return tree
}

function walk(node: FormulaNode, visit: (node: FormulaNode) => void) {
  visit(node)
  if (node.kind === 'call') for (const arg of node.args) walk(arg, visit)
  else if (node.kind === 'unary') walk(node.operand, visit)
  else if (node.kind === 'binary') {
    walk(node.left, visit)
    walk(node.right, visit)
  }
}

// ---------------------------------------------------------------------------
// Fields

/** The type a property belongs to. */
function ownerOf(def: PropertyDef, types: Iterable<ObjectType>): ObjectType | undefined {
  for (const type of types) if (type.properties.some((p) => p.id === def.id)) return type
  return undefined
}

/** Types a relation can point to: its targets, or every type. */
function targetsOf(def: PropertyDef, types: Iterable<ObjectType>): ObjectType[] {
  const all = [...types]
  return def.kind === 'relation' && def.targetTypeIds.length ? all.filter((t) => def.targetTypeIds.includes(t.id)) : all
}

function propertyIn(types: Iterable<ObjectType>, id: string): PropertyDef | undefined {
  for (const type of types) {
    const def = type.properties.find((p) => p.id === id)
    if (def) return def
  }
  return undefined
}

/** What a field reference (id form) stands for, from the point of view of objects of `type`. */
type Resolved =
  | { kind: 'builtin'; field: string }
  | { kind: 'property'; def: PropertyDef }
  | { kind: 'path'; relation: PropertyDef; inner: Resolved; targets: ObjectType[] }

function resolveId(field: string, type: ObjectType | undefined, types: Iterable<ObjectType>): Resolved | undefined {
  if (field in FORMULA_BUILTIN_FIELDS) return { kind: 'builtin', field }
  const def = type?.properties.find((p) => p.id === field) ?? (type ? undefined : propertyIn(types, field))
  if (def) return { kind: 'property', def }
  const dot = field.indexOf('.')
  if (dot <= 0) return undefined
  const relation = type?.properties.find((p) => p.id === field.slice(0, dot))
  if (relation?.kind !== 'relation') return undefined
  const targets = targetsOf(relation, types)
  const rest = field.slice(dot + 1)
  const inner: Resolved | undefined = rest in FORMULA_BUILTIN_FIELDS ? { kind: 'builtin', field: rest } : (() => {
    const def = propertyIn(targets, rest)
    return def ? { kind: 'property', def } : undefined
  })()
  return inner ? { kind: 'path', relation, inner, targets } : undefined
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()

/** Apply `map` to every field reference in an expression, leaving the rest (and quoted text) as written. */
function mapFields(source: string, map: (field: string) => string): string {
  let out = ''
  let quote = ''
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (quote) {
      out += char
      if (char === '\\' && i + 1 < source.length) out += source[++i]
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") quote = char
    if (char === '{') {
      const close = source.indexOf('}', i)
      if (close > i) {
        out += `{${map(source.slice(i + 1, close).trim())}}`
        i = close
        continue
      }
    }
    out += char
  }
  return out
}

function nameToId(name: string, scope: ObjectType[], allowBuiltins = true): string | undefined {
  const wanted = fold(name)
  const byName = scope.flatMap((t) => t.properties).find((p) => p.kind !== 'rich-text' && fold(p.name) === wanted)
  if (byName) return byName.id
  if (allowBuiltins) {
    const builtin = Object.entries(FORMULA_BUILTIN_FIELDS).find(([id, label]) => fold(label) === wanted || id === name)
    if (builtin) return builtin[0]
  }
  return scope.flatMap((t) => t.properties).find((p) => p.id === name)?.id
}

/** An expression as people write it (`{Price}`, `{Author.Country}`) turned into the stored form with ids. */
export function formulaFromNames(text: string, type: ObjectType, types: Iterable<ObjectType>): string {
  const all = [...types]
  return mapFields(text, (name) => {
    const own = nameToId(name, [type])
    if (own) return own
    // A relation's field: the relation's name, a dot, then a field of the objects it points to.
    for (let dot = name.indexOf('.'); dot > 0; dot = name.indexOf('.', dot + 1)) {
      const relation = type.properties.find((p) => p.kind === 'relation' && fold(p.name) === fold(name.slice(0, dot)))
      if (!relation) continue
      const inner = nameToId(name.slice(dot + 1), targetsOf(relation, all))
      if (inner) return `${relation.id}.${inner}`
    }
    return name
  })
}

/** A stored expression with field names, for editing. Fields that no longer exist keep their id. */
export function formulaToNames(expression: string, type: ObjectType, types: Iterable<ObjectType>): string {
  const all = [...types]
  const nameOf = (resolved: Resolved): string =>
    resolved.kind === 'builtin'
      ? FORMULA_BUILTIN_FIELDS[resolved.field]!
      : resolved.kind === 'property'
        ? resolved.def.name
        : `${resolved.relation.name}.${nameOf(resolved.inner)}`
  return mapFields(expression, (field) => {
    const resolved = resolveId(field, type, all)
    return resolved ? nameOf(resolved) : field
  })
}

/** What is wrong with a stored expression for objects of `type`, or undefined when it reads fine. */
export function checkFormula(expression: string, type: ObjectType, types: Iterable<ObjectType>): string | undefined {
  let tree: FormulaNode
  try {
    tree = cachedParse(expression)
  } catch (error) {
    return (error as Error).message
  }
  const all = [...types]
  let problem: string | undefined
  walk(tree, (node) => {
    if (problem || node.kind !== 'field') return
    const resolved = resolveId(node.field, type, all)
    if (!resolved) problem = `There is no field “${node.field}”`
    else if (resolved.kind === 'property' && resolved.def.kind === 'rich-text') problem = `Text blocks like “${resolved.def.name}” can't be used in formulas`
  })
  return problem
}

// ---------------------------------------------------------------------------
// Evaluation

const EMPTY: FormulaValue = { kind: 'empty' }

interface Scope {
  context: FormulaContext
  /** Formulas being computed (object:property), to stop a formula that reads itself. */
  visiting: Set<string>
}

const number = (value: number): FormulaValue => (Number.isFinite(value) ? { kind: 'number', value } : EMPTY)
const text = (value: string): FormulaValue => (value ? { kind: 'text', value } : EMPTY)
const day = (value: string): FormulaValue => ({ kind: 'date', value: { start: `${value}T00:00:00.000Z`, resolution: 'day' } })

/** The value a formula property has on an object. */
export function evaluateFormula(object: FormulaSubject, def: FormulaPropertyDef, context: FormulaContext): FormulaValue {
  return run(object, def, { context, visiting: new Set() })
}

function run(object: FormulaSubject, def: FormulaPropertyDef, scope: Scope): FormulaValue {
  const key = `${object.id}:${def.id}`
  if (scope.visiting.has(key)) return { kind: 'error', message: `“${def.name}” uses itself` }
  if (!def.expression.trim()) return EMPTY
  scope.visiting.add(key)
  try {
    return evaluate(cachedParse(def.expression), object, scope)
  } catch (error) {
    if (error instanceof FormulaError) return { kind: 'error', message: error.message }
    throw error
  } finally {
    scope.visiting.delete(key)
  }
}

function titleOf(id: Id, scope: Scope): FormulaValue | undefined {
  const target = scope.context.related?.(id)
  return target && !target.deletedAt ? text(target.title) : undefined
}

/** A person as formulas read them: their name, else their id. */
const personOf = (id: Id, scope: Scope): FormulaValue => text(scope.context.personName?.(id) ?? id)

function readResolved(object: FormulaSubject, resolved: Resolved, scope: Scope): FormulaValue {
  if (resolved.kind === 'builtin') {
    switch (resolved.field) {
      case 'title':
        return text(object.title)
      case 'createdBy':
      case 'updatedBy': {
        const id = object[resolved.field]
        return id ? personOf(id, scope) : EMPTY
      }
      case 'createdAt':
      case 'updatedAt':
        return { kind: 'date', value: { start: object[resolved.field], resolution: 'time' } }
      case 'date':
        return object.date ? { kind: 'date', value: object.date } : EMPTY
      case 'tags':
        return { kind: 'list', value: object.tagIds.flatMap((id) => titleOf(id, scope) ?? []) }
    }
    return EMPTY
  }
  if (resolved.kind === 'path') {
    const value = object.props[resolved.relation.id]
    const ids = value?.kind === 'relation' ? value.value : []
    const values = ids.flatMap((id) => {
      const target = scope.context.related?.(id)
      if (!target || target.deletedAt) return []
      const read = readResolved(target, resolved.inner, scope)
      return read.kind === 'list' ? read.value : [read]
    })
    return resolved.relation.kind === 'relation' && !resolved.relation.multiple ? (values[0] ?? EMPTY) : { kind: 'list', value: values }
  }
  const { def } = resolved
  if (def.kind === 'formula') return run(object, def, scope)
  if (def.kind === 'rich-text') throw new FormulaError(`Text blocks like “${def.name}” can't be used in formulas`)
  const value = object.props[def.id]
  if (!value) return def.kind === 'checkbox' ? { kind: 'checkbox', value: false } : (def.kind === 'relation' || def.kind === 'person') && def.multiple ? { kind: 'list', value: [] } : EMPTY
  switch (value.kind) {
    case 'text':
    case 'url':
      return text(value.value)
    case 'number':
      return number(value.value)
    case 'checkbox':
      return { kind: 'checkbox', value: value.value }
    case 'date':
      return { kind: 'date', value: value.value }
    case 'select': {
      const labels = value.value.map((id) => text((def.kind === 'select' && def.options.find((o) => o.id === id)?.label) || ''))
      return def.kind === 'select' && !def.multiple ? (labels[0] ?? EMPTY) : { kind: 'list', value: labels }
    }
    case 'relation': {
      const titles = value.value.flatMap((id) => titleOf(id, scope) ?? [])
      return def.kind === 'relation' && !def.multiple ? (titles[0] ?? EMPTY) : { kind: 'list', value: titles }
    }
    case 'person': {
      const names = value.value.map((id) => personOf(id, scope))
      return def.kind === 'person' && !def.multiple ? (names[0] ?? EMPTY) : { kind: 'list', value: names }
    }
  }
  // Structured values the app keeps without a property definition (nutrition) are not fields.
  return EMPTY
}

function readField(object: FormulaSubject, field: string, scope: Scope): FormulaValue {
  const resolved = resolveId(field, scope.context.types.get(object.typeId), scope.context.types.values())
  if (!resolved) throw new FormulaError(`There is no field “${field}”`)
  return readResolved(object, resolved, scope)
}

function isEmpty(value: FormulaValue): boolean {
  return value.kind === 'empty' || (value.kind === 'list' && value.value.every(isEmpty))
}

function truthy(value: FormulaValue): boolean {
  switch (value.kind) {
    case 'number':
      return value.value !== 0
    case 'checkbox':
      return value.value
    case 'date':
      return true
    case 'text':
      return !!value.value
    case 'list':
      return value.value.some(truthy)
    default:
      return false
  }
}

/** One value: a list of one is its item, an empty list is empty; a longer list needs a function. */
function single(value: FormulaValue, operation: string): FormulaValue {
  if (value.kind !== 'list') return value
  const items = value.value.filter((v) => !isEmpty(v))
  if (items.length <= 1) return items[0] ?? EMPTY
  throw new FormulaError(`${operation} needs one value but got several; use sum(), join() or another function for a list`)
}

function flatten(values: FormulaValue[]): FormulaValue[] {
  return values.flatMap((v) => (v.kind === 'list' ? flatten(v.value) : [v])).filter((v) => !isEmpty(v))
}

/** The day a date falls on, in the viewer's zone for a date with a time. */
function dayOf(value: DateValue, context: FormulaContext): string {
  return value.resolution === 'day' ? value.start.slice(0, 10) : dayIn(value.start, context.timeZone)
}

function shift(value: DateValue, days: number): FormulaValue {
  if (value.resolution === 'day') return day(addDays(value.start.slice(0, 10), Math.round(days)))
  return { kind: 'date', value: { start: new Date(Date.parse(value.start) + days * 86_400_000).toISOString(), resolution: 'time' } }
}

function formatNumber(value: number): string {
  return String(Math.round(value * 1e10) / 1e10)
}

/** A value as plain text: numbers without float noise, dates as "YYYY-MM-DD" (and "HH:MM"), lists joined. */
export function formulaText(value: FormulaValue, timeZone = 'UTC'): string {
  switch (value.kind) {
    case 'empty':
      return ''
    case 'number':
      return formatNumber(value.value)
    case 'text':
      return value.value
    case 'checkbox':
      return value.value ? 'true' : 'false'
    case 'date': {
      if (value.value.resolution === 'day') return value.value.start.slice(0, 10)
      const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(value.value.start))
      return `${dayIn(value.value.start, timeZone)} ${time}`
    }
    case 'list':
      return value.value.map((v) => formulaText(v, timeZone)).filter(Boolean).join(', ')
    case 'error':
      return ''
  }
}

function toNumber(value: FormulaValue, operation: string): number {
  if (value.kind === 'number') return value.value
  if (value.kind === 'checkbox') return value.value ? 1 : 0
  if (value.kind === 'text' && value.value.trim() && !Number.isNaN(Number(value.value))) return Number(value.value)
  throw new FormulaError(`${operation} needs a number, not ${describe(value)}`)
}

function toDate(value: FormulaValue, operation: string): DateValue {
  if (value.kind === 'date') return value.value
  throw new FormulaError(`${operation} needs a date, not ${describe(value)}`)
}

function describe(value: FormulaValue): string {
  switch (value.kind) {
    case 'text':
      return `the text “${value.value}”`
    case 'checkbox':
      return value.value ? 'true' : 'false'
    case 'date':
      return 'a date'
    case 'list':
      return 'a list'
    case 'number':
      return formatNumber(value.value)
    default:
      return 'nothing'
  }
}

/** Order two values (numbers, texts, dates by day, checkboxes); undefined when they do not compare. */
function order(a: FormulaValue, b: FormulaValue, context: FormulaContext): number | undefined {
  if (a.kind === 'date' && b.kind === 'date') {
    const [da, db] = [dayOf(a.value, context), dayOf(b.value, context)]
    return da === db ? 0 : da < db ? -1 : 1
  }
  if (a.kind === 'number' && b.kind === 'number') return a.value - b.value
  if (a.kind === 'checkbox' && b.kind === 'checkbox') return Number(a.value) - Number(b.value)
  if (a.kind === 'text' || b.kind === 'text') {
    if (a.kind === 'number' || b.kind === 'number') {
      const [na, nb] = [Number(formulaText(a)), Number(formulaText(b))]
      if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
    }
    const [ta, tb] = [fold(formulaText(a, context.timeZone)), fold(formulaText(b, context.timeZone))]
    return ta === tb ? 0 : ta < tb ? -1 : 1
  }
  return undefined
}

function equal(a: FormulaValue, b: FormulaValue, context: FormulaContext): boolean {
  if (isEmpty(a) || isEmpty(b)) return isEmpty(a) && isEmpty(b)
  return order(a, b, context) === 0
}

function arithmetic(operator: '+' | '-' | '*' | '/' | '%', left: FormulaValue, right: FormulaValue, context: FormulaContext): FormulaValue {
  const a = single(left, `“${operator}”`)
  const b = single(right, `“${operator}”`)
  if (operator === '+' && (a.kind === 'text' || b.kind === 'text')) return text(formulaText(a, context.timeZone) + formulaText(b, context.timeZone))
  // A field without a value leaves the result empty, like a spreadsheet cell waiting for input.
  if (a.kind === 'empty' || b.kind === 'empty') return EMPTY
  if (a.kind === 'date' && b.kind === 'date' && operator === '-') return number(daysBetween(dayOf(b.value, context), dayOf(a.value, context)))
  if (a.kind === 'date' && (operator === '+' || operator === '-')) return shift(a.value, operator === '+' ? toNumber(b, 'Adding to a date') : -toNumber(b, 'Taking from a date'))
  if (b.kind === 'date' && operator === '+') return shift(b.value, toNumber(a, 'Adding to a date'))
  const x = toNumber(a, `“${operator}”`)
  const y = toNumber(b, `“${operator}”`)
  switch (operator) {
    case '+':
      return number(x + y)
    case '-':
      return number(x - y)
    case '*':
      return number(x * y)
    case '/':
      if (y === 0) throw new FormulaError('Division by zero')
      return number(x / y)
    case '%':
      if (y === 0) throw new FormulaError('Division by zero')
      return number(x % y)
  }
}

function evaluate(node: FormulaNode, object: FormulaSubject, scope: Scope): FormulaValue {
  const { context } = scope
  switch (node.kind) {
    case 'number':
      return number(node.value)
    case 'text':
      return text(node.value)
    case 'boolean':
      return { kind: 'checkbox', value: node.value }
    case 'field': {
      const value = readField(object, node.field, scope)
      if (value.kind === 'error') throw new FormulaError(value.message)
      return value
    }
    case 'unary': {
      const value = evaluate(node.operand, object, scope)
      if (node.operator === 'not') return { kind: 'checkbox', value: !truthy(value) }
      const one = single(value, '“-”')
      return one.kind === 'empty' ? EMPTY : number(-toNumber(one, '“-”'))
    }
    case 'binary': {
      if (node.operator === 'and') return { kind: 'checkbox', value: truthy(evaluate(node.left, object, scope)) && truthy(evaluate(node.right, object, scope)) }
      if (node.operator === 'or') return { kind: 'checkbox', value: truthy(evaluate(node.left, object, scope)) || truthy(evaluate(node.right, object, scope)) }
      const left = evaluate(node.left, object, scope)
      const right = evaluate(node.right, object, scope)
      switch (node.operator) {
        case '=':
          return { kind: 'checkbox', value: equal(single(left, '“=”'), single(right, '“=”'), context) }
        case '!=':
          return { kind: 'checkbox', value: !equal(single(left, '“!=”'), single(right, '“!=”'), context) }
        case '<':
        case '<=':
        case '>':
        case '>=': {
          const a = single(left, `“${node.operator}”`)
          const b = single(right, `“${node.operator}”`)
          if (isEmpty(a) || isEmpty(b)) return { kind: 'checkbox', value: false }
          const sign = order(a, b, context)
          if (sign === undefined) throw new FormulaError(`Can't compare ${describe(a)} with ${describe(b)}`)
          const result = node.operator === '<' ? sign < 0 : node.operator === '<=' ? sign <= 0 : node.operator === '>' ? sign > 0 : sign >= 0
          return { kind: 'checkbox', value: result }
        }
        default:
          return arithmetic(node.operator, left, right, context)
      }
    }
    case 'call': {
      const fn = FUNCTIONS[node.name]!
      if (fn.lazy) return fn.lazy(node.args, (arg) => evaluate(arg, object, scope))
      return fn.run!(node.args.map((arg) => evaluate(arg, object, scope)), context)
    }
  }
}

// ---------------------------------------------------------------------------
// Functions

interface FormulaFunction {
  min: number
  max: number
  /** "round(number, digits)": how it reads in the help. */
  usage: string
  description: string
  /**
   * The kind of value it gives; a function of its arguments' kinds when that depends on them
   * (`items`: for a list, the kind of its items).
   */
  result: FormulaKind | ((args: (FormulaKind | undefined)[], items: (FormulaKind | undefined)[]) => FormulaKind | undefined)
  run?: (args: FormulaValue[], context: FormulaContext) => FormulaValue
  /** For functions that only compute some arguments (if). */
  lazy?: (args: FormulaNode[], evaluate: (node: FormulaNode) => FormulaValue) => FormulaValue
}

const numeric = (name: string, op: (x: number) => number): FormulaFunction => ({
  min: 1,
  max: 1,
  usage: `${name}(number)`,
  description: '',
  result: 'number',
  run: ([value]) => {
    const one = single(value!, `${name}()`)
    return one.kind === 'empty' ? EMPTY : number(op(toNumber(one, `${name}()`)))
  },
})

/** Numbers among values (lists flattened, empty ones skipped). */
const numbers = (values: FormulaValue[], name: string) => flatten(values).map((v) => toNumber(v, `${name}()`))

function extreme(name: 'min' | 'max'): FormulaFunction {
  return {
    min: 1,
    max: Infinity,
    usage: `${name}(values…)`,
    description: `The ${name === 'min' ? 'smallest' : 'largest'} number or ${name === 'min' ? 'earliest' : 'latest'} date`,
    result: (_, items) => (items.every((k) => k === 'date') ? 'date' : 'number'),
    run: (args, context) => {
      const items = flatten(args)
      if (!items.length) return EMPTY
      if (items.every((v) => v.kind === 'date')) {
        const sorted = [...items].sort((a, b) => order(a, b, context)!)
        return sorted[name === 'min' ? 0 : sorted.length - 1]!
      }
      const values = numbers(items, name)
      return number(name === 'min' ? Math.min(...values) : Math.max(...values))
    },
  }
}

function datePart(name: string, description: string, part: (day: string) => number): FormulaFunction {
  return {
    min: 1,
    max: 1,
    usage: `${name}(date)`,
    description,
    result: 'number',
    run: ([value], context) => {
      const one = single(value!, `${name}()`)
      return one.kind === 'empty' ? EMPTY : number(part(dayOf(toDate(one, `${name}()`), context)))
    },
  }
}

const textFunction = (name: string, description: string, op: (text: string) => string): FormulaFunction => ({
  min: 1,
  max: 1,
  usage: `${name}(text)`,
  description,
  result: 'text',
  run: ([value], context) => text(op(formulaText(value!, context.timeZone))),
})

const FUNCTIONS: Record<string, FormulaFunction> = {
  if: {
    min: 2,
    max: 3,
    usage: 'if(condition, then, otherwise)',
    description: 'One value or the other, depending on the condition',
    result: ([, a, b]) => a ?? b,
    lazy: ([condition, then, otherwise], run) => (truthy(run(condition!)) ? run(then!) : otherwise ? run(otherwise) : EMPTY),
  },
  empty: {
    min: 1,
    max: 1,
    usage: 'empty(value)',
    description: 'Whether a value is missing',
    result: 'checkbox',
    run: ([value]) => ({ kind: 'checkbox', value: isEmpty(value!) }),
  },
  round: {
    min: 1,
    max: 2,
    usage: 'round(number, digits)',
    description: 'Rounded, to whole numbers or to some decimal digits',
    result: 'number',
    run: ([value, digits]) => {
      const one = single(value!, 'round()')
      if (one.kind === 'empty') return EMPTY
      const factor = 10 ** (digits ? toNumber(single(digits, 'round()'), 'round()') : 0)
      return number(Math.round(toNumber(one, 'round()') * factor) / factor)
    },
  },
  floor: { ...numeric('floor', Math.floor), description: 'Rounded down' },
  ceil: { ...numeric('ceil', Math.ceil), description: 'Rounded up' },
  abs: { ...numeric('abs', Math.abs), description: 'Without its sign' },
  min: extreme('min'),
  max: extreme('max'),
  sum: {
    min: 1,
    max: Infinity,
    usage: 'sum(values…)',
    description: 'The numbers added up; for a relation, sum({Tasks.Estimate})',
    result: 'number',
    run: (args) => number(numbers(args, 'sum').reduce((a, b) => a + b, 0)),
  },
  avg: {
    min: 1,
    max: Infinity,
    usage: 'avg(values…)',
    description: 'The average of the numbers',
    result: 'number',
    run: (args) => {
      const values = numbers(args, 'avg')
      return values.length ? number(values.reduce((a, b) => a + b, 0) / values.length) : EMPTY
    },
  },
  count: {
    min: 1,
    max: Infinity,
    usage: 'count(values…)',
    description: 'How many values there are, e.g. count({Tasks})',
    result: 'number',
    run: (args) => number(flatten(args).length),
  },
  concat: {
    min: 1,
    max: Infinity,
    usage: 'concat(texts…)',
    description: 'The texts put together',
    result: 'text',
    run: (args, context) => text(args.map((v) => formulaText(v, context.timeZone)).join('')),
  },
  join: {
    min: 1,
    max: 2,
    usage: 'join(list, separator)',
    description: 'A list as one text, “, ” between items by default',
    result: 'text',
    run: ([list, separator], context) =>
      text(flatten([list!]).map((v) => formulaText(v, context.timeZone)).join(separator ? formulaText(separator, context.timeZone) : ', ')),
  },
  upper: textFunction('upper', 'In capital letters', (t) => t.toUpperCase()),
  lower: textFunction('lower', 'In small letters', (t) => t.toLowerCase()),
  trim: textFunction('trim', 'Without spaces around it', (t) => t.trim()),
  length: {
    min: 1,
    max: 1,
    usage: 'length(text or list)',
    description: 'How many characters a text has, or items a list',
    result: 'number',
    run: ([value], context) => (value!.kind === 'list' ? number(flatten(value!.value).length) : number(formulaText(value!, context.timeZone).length)),
  },
  contains: {
    min: 2,
    max: 2,
    usage: 'contains(text or list, value)',
    description: 'Whether a text has a part, or a list an item (ignoring case and accents)',
    result: 'checkbox',
    run: ([haystack, needle], context) => {
      if (haystack!.kind === 'list') return { kind: 'checkbox', value: flatten(haystack!.value).some((v) => equal(v, single(needle!, 'contains()'), context)) }
      return { kind: 'checkbox', value: fold(formulaText(haystack!, context.timeZone)).includes(fold(formulaText(needle!, context.timeZone))) }
    },
  },
  text: textFunction('text', 'Any value as text', (t) => t),
  number: {
    min: 1,
    max: 1,
    usage: 'number(text)',
    description: 'A text read as a number',
    result: 'number',
    run: ([value]) => {
      const one = single(value!, 'number()')
      if (one.kind === 'empty') return EMPTY
      const parsed = Number(formulaText(one).replace(',', '.'))
      return Number.isNaN(parsed) ? EMPTY : number(parsed)
    },
  },
  today: { min: 0, max: 0, usage: 'today()', description: 'The current day', result: 'date', run: (_, context) => day(context.today) },
  now: {
    min: 0,
    max: 0,
    usage: 'now()',
    description: 'The current day and time',
    result: 'date',
    run: () => ({ kind: 'date', value: { start: new Date().toISOString(), resolution: 'time' } }),
  },
  year: datePart('year', 'The year of a date', (d) => Number(d.slice(0, 4))),
  month: datePart('month', 'The month of a date, 1 to 12', (d) => Number(d.slice(5, 7))),
  day: datePart('day', 'The day of the month of a date', (d) => Number(d.slice(8, 10))),
  weekday: datePart('weekday', 'The day of the week, 1 (Monday) to 7 (Sunday)', (d) => new Date(`${d}T00:00:00.000Z`).getUTCDay() || 7),
  start: {
    min: 1,
    max: 1,
    usage: 'start(date)',
    description: 'Where a date range starts',
    result: 'date',
    run: ([value]) => {
      const one = single(value!, 'start()')
      if (one.kind === 'empty') return EMPTY
      const { start, resolution } = toDate(one, 'start()')
      return { kind: 'date', value: { start, resolution } }
    },
  },
  end: {
    min: 1,
    max: 1,
    usage: 'end(date)',
    description: 'Where a date range ends (its start when it has no end)',
    result: 'date',
    run: ([value]) => {
      const one = single(value!, 'end()')
      if (one.kind === 'empty') return EMPTY
      const date = toDate(one, 'end()')
      return { kind: 'date', value: { start: date.end ?? date.start, resolution: date.resolution } }
    },
  },
}

/** The functions, for help in the app and for agents. */
export const FORMULA_FUNCTIONS = Object.entries(FUNCTIONS).map(([name, fn]) => ({ name, usage: fn.usage, description: fn.description }))

// ---------------------------------------------------------------------------
// Static facts about a formula

/** The kind of value a formula gives, read from its expression; undefined when it can't be told. */
export function formulaKind(def: FormulaPropertyDef, types: Iterable<ObjectType>): FormulaKind | undefined {
  const all = [...types]
  return kindOfDef(def, ownerOf(def, all), all, new Set())
}

function kindOfDef(def: FormulaPropertyDef, type: ObjectType | undefined, types: ObjectType[], visiting: Set<Id>): FormulaKind | undefined {
  if (visiting.has(def.id)) return undefined
  let tree: FormulaNode
  try {
    tree = cachedParse(def.expression)
  } catch {
    return undefined
  }
  visiting.add(def.id)
  try {
    return kindOf(tree, type, types, visiting)
  } finally {
    visiting.delete(def.id)
  }
}

function kindOfResolved(resolved: Resolved, types: ObjectType[], visiting: Set<Id>): FormulaKind | undefined {
  if (resolved.kind === 'builtin') return ['title', 'createdBy', 'updatedBy'].includes(resolved.field) ? 'text' : resolved.field === 'tags' ? 'list' : 'date'
  if (resolved.kind === 'path') {
    const inner = kindOfResolved(resolved.inner, types, visiting)
    return resolved.relation.kind === 'relation' && !resolved.relation.multiple ? inner : 'list'
  }
  const { def } = resolved
  switch (def.kind) {
    case 'number':
      return 'number'
    case 'checkbox':
      return 'checkbox'
    case 'date':
      return 'date'
    case 'text':
    case 'url':
      return 'text'
    case 'select':
    case 'relation':
    case 'person':
      return def.multiple ? 'list' : 'text'
    case 'formula':
      return kindOfDef(def, ownerOf(def, types), types, visiting)
    default:
      return undefined
  }
}

function kindOf(node: FormulaNode, type: ObjectType | undefined, types: ObjectType[], visiting: Set<Id>): FormulaKind | undefined {
  switch (node.kind) {
    case 'number':
      return 'number'
    case 'text':
      return 'text'
    case 'boolean':
      return 'checkbox'
    case 'field': {
      const resolved = resolveId(node.field, type, types)
      return resolved ? kindOfResolved(resolved, types, visiting) : undefined
    }
    case 'unary':
      return node.operator === 'not' ? 'checkbox' : 'number'
    case 'binary': {
      if (!['+', '-', '*', '/', '%'].includes(node.operator)) return 'checkbox'
      if (node.operator !== '+' && node.operator !== '-') return 'number'
      const a = kindOf(node.left, type, types, visiting)
      const b = kindOf(node.right, type, types, visiting)
      if (node.operator === '+' && (a === 'text' || b === 'text')) return 'text'
      if (a === 'date' && b === 'date') return node.operator === '-' ? 'number' : undefined
      if (a === 'date' || (b === 'date' && node.operator === '+')) return 'date'
      return 'number'
    }
    case 'call': {
      const fn = FUNCTIONS[node.name]!
      if (typeof fn.result === 'string') return fn.result
      return fn.result(
        node.args.map((arg) => kindOf(arg, type, types, visiting)),
        node.args.map((arg) => itemKindOf(arg, type, types, visiting))
      )
    }
  }
}

/** The kind of a value, or of its items when it is a list read from fields (`{Tasks.Due}`, `{Tags}`). */
function itemKindOf(node: FormulaNode, type: ObjectType | undefined, types: ObjectType[], visiting: Set<Id>): FormulaKind | undefined {
  const kind = kindOf(node, type, types, visiting)
  if (kind !== 'list' || node.kind !== 'field') return kind
  const resolved = resolveId(node.field, type, types)
  if (resolved?.kind === 'path') return kindOfResolved(resolved.inner, types, visiting)
  return 'text'
}

/**
 * What a formula reads through other objects: relation property ids (`{Author}`, `{Tasks.Estimate}`)
 * and "tags", followed through the other formulas it reads. Callers load those objects first.
 */
export function formulaReferences(def: FormulaPropertyDef, types: Iterable<ObjectType>, into = new Set<string>()): Set<string> {
  const all = [...types]
  const visit = (formula: FormulaPropertyDef, seen: Set<Id>) => {
    if (seen.has(formula.id)) return
    seen.add(formula.id)
    let tree: FormulaNode
    try {
      tree = cachedParse(formula.expression)
    } catch {
      return
    }
    const type = ownerOf(formula, all)
    walk(tree, (node) => {
      if (node.kind !== 'field') return
      const resolved = resolveId(node.field, type, all)
      if (resolved?.kind === 'path') into.add(resolved.relation.id)
      else if (resolved?.kind === 'builtin' && resolved.field === 'tags') into.add('tags')
      else if (resolved?.kind === 'property' && resolved.def.kind === 'relation') into.add(resolved.def.id)
      else if (resolved?.kind === 'property' && resolved.def.kind === 'formula') visit(resolved.def, seen)
    })
  }
  visit(def, new Set())
  return into
}

/** Whether a stored expression reads a field (used before deleting a property). */
export function formulaUses(expression: string, field: string): boolean {
  let found = false
  mapFields(expression, (f) => {
    if (f === field || f.startsWith(`${field}.`)) found = true
    return f
  })
  return found
}
