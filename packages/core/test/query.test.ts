import { describe, expect, it } from 'vitest'
import { createBuiltinTypes, type Filter, type FilterGroup, type ObjectSummary, type ObjectType } from '../src/index.ts'
import { filterRelations, relatedIds, runQuery, type QueryContext } from '../src/query.ts'
import { addDays } from '../src/time.ts'

const at = '2026-10-01T12:00:00.000Z'
const book: ObjectType = {
  id: 'book',
  spaceId: 's',
  name: 'Book',
  pluralName: 'Books',
  properties: [
    { id: 'author', kind: 'relation', name: 'Author', targetTypeIds: [], multiple: true },
    { id: 'read', kind: 'checkbox', name: 'Read' },
    { id: 'pages', kind: 'number', name: 'Pages' },
    { id: 'shelf', kind: 'select', name: 'Shelf', multiple: false, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  ],
  views: [],
  createdAt: at,
  updatedAt: at,
}
const types = new Map([...createBuiltinTypes('s', at), book].map((t) => [t.id, t]))

function obj(id: string, data: Partial<ObjectSummary> = {}): ObjectSummary {
  return { id, spaceId: 's', typeId: 'book', title: id, aliases: [], tagIds: [], collectionIds: [], props: {}, createdAt: at, updatedAt: at, preview: '', ...data }
}

const books = [
  obj('Dune', { props: { author: { kind: 'relation', value: ['herbert'] }, read: { kind: 'checkbox', value: true }, pages: { kind: 'number', value: 600 }, shelf: { kind: 'select', value: ['b'] } }, createdAt: '2026-10-01T02:00:00.000Z' }),
  obj('Ação', { props: { author: { kind: 'relation', value: ['other'] }, pages: { kind: 'number', value: 120 }, shelf: { kind: 'select', value: ['a'] } }, tagIds: ['t1'], createdAt: '2026-10-03T12:00:00.000Z' }),
  obj('Empty', { createdAt: '2026-10-02T12:00:00.000Z' }),
]
const ctx = (extra: Partial<QueryContext> = {}): QueryContext => ({ types, today: '2026-10-03', timeZone: 'America/Sao_Paulo', ...extra })
const titles = (filter: FilterGroup, extra?: Partial<QueryContext>) => runQuery(books, { filter }, ctx(extra)).map((o) => o.title)
const and = (...items: FilterGroup['items']): FilterGroup => ({ kind: 'group', operator: 'and', items })
const or = (...items: FilterGroup['items']): FilterGroup => ({ kind: 'group', operator: 'or', items })

describe('query engine', () => {
  it('sorts newest first by default and by any field', () => {
    expect(runQuery(books, {}, ctx()).map((o) => o.title)).toEqual(['Ação', 'Empty', 'Dune'])
    expect(runQuery(books, { sort: [{ field: 'pages', direction: 'asc' }] }, ctx()).map((o) => o.title)).toEqual(['Ação', 'Dune', 'Empty'])
    expect(runQuery(books, { sort: [{ field: 'shelf', direction: 'asc' }] }, ctx()).map((o) => o.title)).toEqual(['Ação', 'Dune', 'Empty'])
  })

  it('filters text ignoring case and accents, numbers and checkboxes', () => {
    expect(titles(and({ kind: 'filter', field: 'title', operator: 'contains', value: { kind: 'literal', value: 'aca' } }))).toEqual(['Ação'])
    expect(titles(and({ kind: 'filter', field: 'pages', operator: 'gt', value: { kind: 'literal', value: 200 } }))).toEqual(['Dune'])
    expect(titles(and({ kind: 'filter', field: 'read', operator: 'is-not-checked' }))).toEqual(['Ação', 'Empty'])
    expect(titles(and({ kind: 'filter', field: 'pages', operator: 'is-empty' }))).toEqual(['Empty'])
  })

  it('filters weblinks by website', () => {
    const links = [obj('a', { media: { url: 'https://www.youtube.com/watch?v=x', host: 'www.youtube.com' } }), obj('b', { media: { url: 'https://example.com/', host: 'example.com' } }), obj('c')]
    const matching = (operator: 'is' | 'is-empty', value?: string) =>
      runQuery(links, { filter: and({ kind: 'filter', field: 'host', operator, ...(value ? { value: { kind: 'literal', value } } : {}) }) }, ctx()).map((o) => o.title)
    expect(matching('is', 'youtube.com')).toEqual(['a'])
    expect(matching('is-empty')).toEqual(['c'])
  })

  it('matches lists of ids and nests and/or groups', () => {
    const shelfA = { kind: 'filter' as const, field: 'shelf', operator: 'contains' as const, value: { kind: 'literal' as const, value: ['a'] } }
    const tagged = { kind: 'filter' as const, field: 'tags', operator: 'is-not-empty' as const }
    const read = { kind: 'filter' as const, field: 'read', operator: 'is-checked' as const }
    expect(titles(and(shelfA, tagged))).toEqual(['Ação'])
    expect(titles(or(read, and(shelfA, tagged)))).toEqual(['Ação', 'Dune'])
    expect(titles(and({ kind: 'filter', field: 'shelf', operator: 'not-contains', value: { kind: 'literal', value: ['a'] } }))).toEqual(['Empty', 'Dune'])
  })

  it('resolves the parent variable, also against one of its fields', () => {
    const herbert = obj('herbert', { typeId: 'page:s' })
    const byParent = and({ kind: 'filter', field: 'author', operator: 'contains', value: { kind: 'variable', name: 'parent' } })
    expect(titles(byParent, { parent: herbert })).toEqual(['Dune'])
    expect(titles(byParent)).toEqual([]) // no parent: nothing, not everything

    // A daily note stands for its date even if it was created on another day.
    const daily = obj('daily', { typeId: 'daily-note:s', date: { start: '2026-10-03T00:00:00.000Z', resolution: 'day' }, createdAt: '2026-10-05T10:00:00.000Z' })
    const sameDay = and({ kind: 'filter', field: 'createdAt', operator: 'is', value: { kind: 'variable', name: 'parent', field: 'createdAt' } })
    expect(titles(sameDay, { parent: daily })).toEqual(['Ação'])
  })

  it('compares days in the time zone, with today and offsets', () => {
    // Dune was created 2026-10-01 02:00 UTC, which is still Sep 30 in São Paulo.
    const createdOn = (day: string) => and({ kind: 'filter', field: 'createdAt', operator: 'is', value: { kind: 'literal', value: day } })
    expect(titles(createdOn('2026-09-30'))).toEqual(['Dune'])
    expect(titles(and({ kind: 'filter', field: 'createdAt', operator: 'after', value: { kind: 'variable', name: 'today', offsetDays: -2 } }))).toEqual(['Ação', 'Empty'])
    expect(titles(and({ kind: 'filter', field: 'createdAt', operator: 'is', value: { kind: 'variable', name: 'today' } }))).toEqual(['Ação'])
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('ignores filters that have no value yet', () => {
    expect(titles(and({ kind: 'filter', field: 'shelf', operator: 'contains' }))).toHaveLength(3)
  })

  it('filters on a related object\'s field: any related object matches, negatives when none does', () => {
    const person = { ...book, id: 'person', name: 'Person', pluralName: 'People', properties: [
      { id: 'country', kind: 'text' as const, name: 'Country' },
      { id: 'living', kind: 'checkbox' as const, name: 'Living' },
    ] }
    const people = new Map([
      ['br', obj('br', { typeId: 'person', props: { country: { kind: 'text', value: 'Brazil' }, living: { kind: 'checkbox', value: true } } })],
      ['us', obj('us', { typeId: 'person', props: { country: { kind: 'text', value: 'USA' } } })],
      ['gone', obj('gone', { typeId: 'person', props: { country: { kind: 'text', value: 'Brazil' } }, deletedAt: at })],
    ])
    const list = [
      obj('Both', { props: { author: { kind: 'relation', value: ['br', 'us'] } } }),
      obj('American', { props: { author: { kind: 'relation', value: ['us'] } } }),
      obj('Trashed author', { props: { author: { kind: 'relation', value: ['gone'] } } }),
      obj('No author'),
    ]
    const context = ctx({ types: new Map([...types, ['person', person]]), related: (id) => people.get(id) })
    const run = (operator: Filter['operator'], field = 'author.country', value?: string) =>
      runQuery(list, { filter: and({ kind: 'filter', field, operator, ...(value ? { value: { kind: 'literal', value } } : {}) }), sort: [{ field: 'title', direction: 'asc' }] }, context).map((o) => o.title)

    expect(run('is', 'author.country', 'brazil')).toEqual(['Both'])
    expect(run('is-not', 'author.country', 'Brazil')).toEqual(['American', 'No author', 'Trashed author'])
    expect(run('contains', 'author.country', 'us')).toEqual(['American', 'Both'])
    expect(run('is-empty')).toEqual(['No author', 'Trashed author'])
    expect(run('is-not-empty')).toEqual(['American', 'Both'])
    expect(run('is-checked', 'author.living')).toEqual(['Both'])
    expect(run('is-not-checked', 'author.living')).toEqual(['American', 'No author', 'Trashed author'])
    // Not set up yet: no narrowing, as for other filters.
    expect(run('is-not')).toHaveLength(4)
    expect([...filterRelations(and({ kind: 'filter', field: 'author.country', operator: 'is-empty' }, or({ kind: 'filter', field: 'read', operator: 'is-checked' })))]).toEqual(['author'])
    expect(relatedIds(list, new Set(['author']))).toEqual(['br', 'us', 'gone'])
  })
})
