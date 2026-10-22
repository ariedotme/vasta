import { describe, expect, it } from 'vitest'
import {
  checkFormula,
  evaluateFormula,
  fieldKind,
  formulaFromNames,
  formulaKind,
  formulaReferences,
  formulaText,
  formulaToNames,
  formulaUses,
  parseFormula,
  queryRelations,
  runQuery,
  type FormulaPropertyDef,
  type FormulaValue,
  type ObjectSummary,
  type ObjectType,
  type QueryContext,
} from '../src/index.ts'

const at = '2026-10-01T12:00:00.000Z'

function type(id: string, name: string, properties: ObjectType['properties']): ObjectType {
  return { id, spaceId: 's', name, pluralName: `${name}s`, properties, views: [], createdAt: at, updatedAt: at }
}

const formula = (id: string, name: string, expression: string): FormulaPropertyDef => ({ id, kind: 'formula', name, expression })

const task = type('task', 'Task', [
  { id: 'estimate', kind: 'number', name: 'Estimate' },
  { id: 'due', kind: 'date', name: 'Due' },
])
const order = type('order', 'Order', [
  { id: 'price', kind: 'number', name: 'Price' },
  { id: 'qty', kind: 'number', name: 'Quantity' },
  { id: 'paid', kind: 'checkbox', name: 'Paid' },
  { id: 'status', kind: 'select', name: 'Status', multiple: false, options: [{ id: 'o1', label: 'Open' }, { id: 'o2', label: 'Done' }] },
  { id: 'due', kind: 'date', name: 'Due date' },
  { id: 'tasks', kind: 'relation', name: 'Tasks', targetTypeIds: ['task'], multiple: true },
  { id: 'owner', kind: 'relation', name: 'Owner', targetTypeIds: ['task'], multiple: false },
  { id: 'body', kind: 'rich-text', name: 'Notes' },
  formula('total', 'Total', '{price} * {qty}'),
  formula('label', 'Label', '{title} + ": " + {total}'),
])
const types = new Map([task, order].map((t) => [t.id, t]))

function obj(id: string, typeId: string, data: Partial<ObjectSummary> = {}): ObjectSummary {
  return { id, spaceId: 's', typeId, title: id, aliases: [], tagIds: [], collectionIds: [], props: {}, createdAt: at, updatedAt: at, preview: '', ...data }
}

const related = new Map<string, ObjectSummary>([
  ['t1', obj('Write', 'task', { props: { estimate: { kind: 'number', value: 3 }, due: { kind: 'date', value: { start: '2026-10-05T00:00:00.000Z', resolution: 'day' } } } })],
  ['t2', obj('Review', 'task', { props: { estimate: { kind: 'number', value: 2 }, due: { kind: 'date', value: { start: '2026-10-09T00:00:00.000Z', resolution: 'day' } } } })],
  ['t3', obj('Gone', 'task', { props: { estimate: { kind: 'number', value: 100 } }, deletedAt: at })],
  ['tag1', obj('urgent', 'tag')],
])
const ctx = (extra: Partial<QueryContext> = {}): QueryContext => ({ types, today: '2026-10-03', timeZone: 'America/Sao_Paulo', related: (id) => related.get(id), ...extra })

const anOrder = obj('Coffee', 'order', {
  props: {
    price: { kind: 'number', value: 2.5 },
    qty: { kind: 'number', value: 4 },
    status: { kind: 'select', value: ['o2'] },
    due: { kind: 'date', value: { start: '2026-10-10T00:00:00.000Z', resolution: 'day' } },
    tasks: { kind: 'relation', value: ['t1', 't2', 't3'] },
    owner: { kind: 'relation', value: ['t2'] },
  },
  tagIds: ['tag1'],
})

/** Run an expression written with ids on an order. */
function run(expression: string, object: ObjectSummary = anOrder, extra?: Partial<QueryContext>): FormulaValue {
  return evaluateFormula(object, formula('f', 'F', expression), ctx(extra))
}
const value = (expression: string, object?: ObjectSummary) => {
  const result = run(expression, object)
  return result.kind === 'error' ? `error: ${result.message}` : formulaText(result, 'America/Sao_Paulo')
}

describe('formula syntax', () => {
  it('respects precedence and parentheses', () => {
    expect(value('1 + 2 * 3')).toBe('7')
    expect(value('(1 + 2) * 3')).toBe('9')
    expect(value('-2 * 3 + 10 % 4')).toBe('-4')
    expect(value('1 < 2 and not (2 < 1) or false')).toBe('true')
    expect(value('1 = 1 && 2 != 3 || 0')).toBe('true')
  })

  it('reads texts with either quote and escapes', () => {
    expect(value(`"a" + 'b' + "c\\"d"`)).toBe('abc"d')
  })

  it('says what is wrong', () => {
    expect(() => parseFormula('')).toThrow('empty')
    expect(() => parseFormula('1 +')).toThrow('ends too soon')
    expect(() => parseFormula('(1 + 2')).toThrow('Expected “)”')
    expect(() => parseFormula('foo(1)')).toThrow('Unknown function “foo”')
    expect(() => parseFormula('price * 2')).toThrow('fields go in braces')
    expect(() => parseFormula('round()')).toThrow('round() takes 1 to 2 values')
    expect(() => parseFormula('{price')).toThrow('closing “}”')
    expect(() => parseFormula('"open')).toThrow('closing quote')
    expect(() => parseFormula('1 2')).toThrow('Unexpected “2”')
  })
})

describe('formula values', () => {
  it('computes from properties and other formulas', () => {
    expect(run('{price} * {qty}')).toEqual({ kind: 'number', value: 10 })
    expect(value('{label}')).toBe('Coffee: 10')
    expect(value('{status}')).toBe('Done')
    expect(value('{status} = "done"')).toBe('true')
    expect(value('{paid}')).toBe('false')
  })

  it('leaves arithmetic empty while a field has no value', () => {
    expect(run('{price} * {qty}', obj('Empty', 'order'))).toEqual({ kind: 'empty' })
    expect(value('if(empty({price}), "no price", "priced")', obj('Empty', 'order'))).toBe('no price')
  })

  it('reads related objects, skipping trashed ones', () => {
    expect(value('{tasks}')).toBe('Write, Review')
    expect(value('sum({tasks.estimate})')).toBe('5')
    expect(value('count({tasks})')).toBe('2')
    expect(value('avg({tasks.estimate})')).toBe('2.5')
    expect(value('max({tasks.due})')).toBe('2026-10-09')
    expect(value('{owner.estimate} * 10')).toBe('20')
    expect(value('{tags}')).toBe('urgent')
  })

  it('asks for a function when a list is used as one value', () => {
    expect(value('{tasks.estimate} + 1')).toMatch(/^error: .*sum\(\)/)
  })

  it('does arithmetic on dates by day', () => {
    expect(value('{due} - today()')).toBe('7')
    expect(value('{due} + 3')).toBe('2026-10-13')
    expect(value('{due} > today()')).toBe('true')
    expect(value('year({due}) * 100 + month({due})')).toBe('202610')
    expect(value('weekday({due})')).toBe('6')
  })

  it('rounds and formats numbers without float noise', () => {
    expect(value('0.1 + 0.2')).toBe('0.3')
    expect(value('round(2 / 3, 2)')).toBe('0.67')
    expect(value('floor(-1.5) + ceil(1.2) + abs(-3)')).toBe('3')
  })

  it('works on text', () => {
    expect(value('upper("ação") + lower("B")')).toBe('AÇÃOb')
    expect(value('length("four") + length({tasks})')).toBe('6')
    expect(value('contains({title}, "COF")')).toBe('true')
    expect(value('contains({tasks}, "review")')).toBe('true')
    expect(value('join({tasks}, " / ")')).toBe('Write / Review')
    expect(value('number("2,5") * 2')).toBe('5')
  })

  it('returns errors as values', () => {
    expect(run('1 / 0')).toEqual({ kind: 'error', message: 'Division by zero' })
    expect(run('{missing}')).toMatchObject({ kind: 'error' })
    expect(run('{body}')).toMatchObject({ kind: 'error' })
    expect(run('"a" * 2')).toMatchObject({ kind: 'error' })
  })

  it('stops a formula that reads itself', () => {
    const loop = type('loop', 'Loop', [formula('a', 'A', '{b} + 1'), formula('b', 'B', '{a} + 1')])
    const result = evaluateFormula(obj('x', 'loop'), loop.properties[0] as FormulaPropertyDef, ctx({ types: new Map([['loop', loop]]) }))
    expect(result).toMatchObject({ kind: 'error' })
  })
})

describe('formula fields', () => {
  it('turns names into ids and back', () => {
    const stored = formulaFromNames('{Price} * {quantity} + sum({Tasks.Estimate}) + count({Tags}) + "{Price}"', order, types.values())
    expect(stored).toBe('{price} * {qty} + sum({tasks.estimate}) + count({tags}) + "{Price}"')
    expect(formulaToNames(stored, order, types.values())).toBe('{Price} * {Quantity} + sum({Tasks.Estimate}) + count({Tags}) + "{Price}"')
  })

  it('keeps names it does not know and reports them', () => {
    expect(formulaFromNames('{Nope} + 1', order, types.values())).toBe('{Nope} + 1')
    expect(checkFormula('{Nope} + 1', order, types.values())).toBe('There is no field “Nope”')
    expect(checkFormula('{body}', order, types.values())).toMatch(/Text blocks/)
    expect(checkFormula('{price} *', order, types.values())).toMatch(/ends too soon/)
    expect(checkFormula('{price} * 2', order, types.values())).toBeUndefined()
  })

  it('knows the kind of value before running', () => {
    const kind = (expression: string) => formulaKind({ ...formula('total', 'Total', expression) }, [task, { ...order, properties: [...order.properties.filter((p) => p.id !== 'total'), formula('total', 'Total', expression)] }])
    expect(kind('{price} * {qty}')).toBe('number')
    expect(kind('{title} + 1')).toBe('text')
    expect(kind('{due} - today()')).toBe('number')
    expect(kind('{due} + 1')).toBe('date')
    expect(kind('{paid} or {price} > 2')).toBe('checkbox')
    expect(kind('if({paid}, "yes", "no")')).toBe('text')
    expect(kind('{tasks.estimate}')).toBe('list')
    expect(kind('max({tasks.due})')).toBe('date')
    expect(fieldKind('total', order.properties.find((p) => p.id === 'total'), types.values())).toBe('number')
  })

  it('lists the relations and tags a formula reads, through other formulas', () => {
    const withRollup = type('order', 'Order', [...order.properties, formula('work', 'Work', 'sum({tasks.estimate}) + count({tags})'), formula('outer', 'Outer', '{work} * 2')])
    expect([...formulaReferences(withRollup.properties.at(-1) as FormulaPropertyDef, [task, withRollup])].sort()).toEqual(['tags', 'tasks'])
    expect([...queryRelations({ sort: [{ field: 'outer', direction: 'asc' }] }, [task, withRollup])].sort()).toEqual(['tags', 'tasks'])
    expect(formulaUses('{tasks.estimate} + {price}', 'tasks')).toBe(true)
    expect(formulaUses('{price}', 'tasks')).toBe(false)
  })
})

describe('formulas in queries', () => {
  const orders = [
    anOrder,
    obj('Tea', 'order', { props: { price: { kind: 'number', value: 3 }, qty: { kind: 'number', value: 1 } } }),
    obj('Nothing', 'order'),
  ]

  it('filters and sorts by a formula', () => {
    const filter = { kind: 'group' as const, operator: 'and' as const, items: [{ kind: 'filter' as const, field: 'total', operator: 'gt' as const, value: { kind: 'literal' as const, value: 5 } }] }
    expect(runQuery(orders, { filter }, ctx()).map((o) => o.title)).toEqual(['Coffee'])
    expect(runQuery(orders, { sort: [{ field: 'total', direction: 'asc' }] }, ctx()).map((o) => o.title)).toEqual(['Tea', 'Coffee', 'Nothing'])
    const empty = { kind: 'group' as const, operator: 'and' as const, items: [{ kind: 'filter' as const, field: 'total', operator: 'is-empty' as const }] }
    expect(runQuery(orders, { filter: empty }, ctx()).map((o) => o.title)).toEqual(['Nothing'])
  })
})
