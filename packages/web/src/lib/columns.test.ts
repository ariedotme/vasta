import { describe, expect, it, vi } from 'vitest'
import { builtinTypeId, createBuiltinTypes, type ObjectSummary, type ObjectType } from '@vasta/core'
import { listFields, listSettings, rowFields } from './columns.ts'
import { formulaValue } from './properties.ts'

// The field menus read the workspace's types, which need the app's state: stand in for them.
const types: ObjectType[] = []
vi.mock('./query.ts', () => ({
  fieldOptions: (typeIds: string[]) => [
    ...['title', 'tags', 'type', 'collections', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'createdVia', 'updatedVia', 'date', 'host'].map((field) => ({ field, label: field, kind: 'text', icon: '' })),
    ...types.filter((t) => !typeIds.length || typeIds.includes(t.id)).flatMap((t) => t.properties.map((def) => ({ field: def.id, label: def.name, kind: 'text', icon: '', def }))),
  ],
}))
vi.mock('./properties.ts', () => ({ formulaValue: vi.fn(() => ({ kind: 'empty' })) }))

const at = '2026-10-19T12:00:00.000Z'
const task = createBuiltinTypes('s', at).find((t) => t.id === builtinTypeId('s', 'task')) as ObjectType
const book: ObjectType = {
  id: 'book', spaceId: 's', name: 'Book', pluralName: 'Books', createdAt: at, updatedAt: at, views: [],
  properties: [
    { id: 'pages', kind: 'number', name: 'Pages' },
    { id: 'read', kind: 'checkbox', name: 'Read' },
    { id: 'notes', kind: 'text', name: 'Notes' },
    { id: 'genres', kind: 'select', name: 'Genres', options: [], multiple: true },
    { id: 'author', kind: 'relation', name: 'Author', targetTypeIds: [], multiple: true },
    { id: 'owner', kind: 'person', name: 'Owner', multiple: false },
    { id: 'website', kind: 'url', name: 'Website' },
    { id: 'result', kind: 'formula', name: 'Result', expression: '0' },
  ],
}
const summary = (patch: Partial<ObjectSummary>): ObjectSummary =>
  ({ id: 'o', typeId: 'book', spaceId: 's', title: 'A', tagIds: [], collectionIds: [], props: {}, aliases: [], createdAt: at, updatedAt: at, ...patch }) as ObjectSummary

types.push(task, book)

describe('fields on list rows', () => {
  it('ticks what the default row shows while nothing is chosen, never the title', () => {
    const fields = listFields(undefined, ['book'])
    expect(fields.filter((f) => f.on).map((f) => f.field)).toEqual(['tags', 'updatedAt'])
    expect(fields.some((f) => f.field === 'title')).toBe(false)
    expect(fields.some((f) => f.field === 'createdBy' || f.field === 'updatedBy')).toBe(false)
    expect(fields.some((f) => f.field === 'pages' && !f.on)).toBe(true)
  })

  it('keeps the default ticks when only title wrapping is saved', () => {
    expect(listFields({ wrap: true }, ['book']).filter((f) => f.on).map((f) => f.field)).toEqual(['tags', 'updatedAt'])
  })

  it('offers every type’s properties for an all-types query', () => {
    const fields = listFields({ fields: ['due', 'pages'] }, [])
    expect(fields.filter((f) => f.on).map((f) => f.field)).toEqual(['due', 'pages'])
  })

  it('keeps the chosen fields first, in their order, and drops ones the types do not have', () => {
    const fields = listFields({ fields: ['pages', 'gone', 'tags', 'pages', 'title', 'createdBy', 'updatedBy'] }, ['book'])
    expect(fields.filter((f) => f.on).map((f) => f.field)).toEqual(['pages', 'tags'])
    expect(listFields({ fields: [] }, ['book']).some((f) => f.on)).toBe(false)
  })

  it('saves no ticked fields as an explicit empty list', () => {
    expect(listSettings(listFields({ fields: [] }, ['book']), false)).toEqual({ fields: [] })
  })

  it('saves the ticked fields in order, and whether titles wrap', () => {
    const fields = listFields({ fields: ['pages'] }, ['book'])
    expect(listSettings(fields, undefined)).toEqual({ fields: ['pages'] })
    expect(listSettings(fields.map((f) => (f.field === 'tags' ? { ...f, on: true } : f)), true)).toEqual({ fields: ['pages', 'tags'], wrap: true })
  })

  it('shows only the fields an object has a value for', () => {
    const fields = listFields({ fields: ['pages', 'read', 'notes', 'tags', 'date'] }, ['book'])
    const names = (o: ObjectSummary) => rowFields(o, book, fields).map((f) => f.field)
    expect(names(summary({}))).toEqual([])
    expect(names(summary({ props: { pages: { kind: 'number', value: 0 }, read: { kind: 'checkbox', value: true }, notes: { kind: 'text', value: '' } }, tagIds: ['t'] }))).toEqual(['pages', 'read', 'tags'])
    expect(names(summary({ props: { read: { kind: 'checkbox', value: false } }, date: { start: at, resolution: 'day' } }))).toEqual(['date'])
  })

  it('skips properties the object’s own type does not have', () => {
    const fields = listFields({ fields: ['pages'] }, ['book', task.id])
    expect(rowFields(summary({ typeId: task.id, props: { pages: { kind: 'number', value: 3 } } }), task, fields)).toEqual([])
  })

  it('omits empty strings and arrays, but keeps filled relations, people and selections', () => {
    const fields = listFields({ fields: ['notes', 'genres', 'author', 'owner', 'website'] }, ['book'])
    const object = summary({ props: { notes: { kind: 'text', value: '' }, genres: { kind: 'select', value: [] }, author: { kind: 'relation', value: [] }, owner: { kind: 'person', value: [] }, website: { kind: 'url', value: '' } } })
    expect(rowFields(object, book, fields)).toEqual([])
    object.props.genres = { kind: 'select', value: ['fiction'] }
    object.props.author = { kind: 'relation', value: ['writer'] }
    object.props.owner = { kind: 'person', value: ['person'] }
    object.props.website = { kind: 'url', value: 'mailto:reader@example.com' }
    expect(rowFields(object, book, fields).map((f) => f.field)).toEqual(['genres', 'author', 'owner', 'website'])
  })

  it('uses the property definition of the object’s own type', () => {
    const fields = listFields({ fields: ['pages'] }, ['book'])
    const own: ObjectType = { ...book, properties: [{ id: 'pages', kind: 'text', name: 'Pages' }] }
    expect(rowFields(summary({ props: { pages: { kind: 'text', value: 'Several' } } }), own, fields)[0]?.def).toEqual(own.properties[0])
  })

  it('shows computed formulas without a stored property value, unless the result is empty', () => {
    const fields = listFields({ fields: ['result'] }, ['book'])
    expect(rowFields(summary({}), book, fields)).toEqual([])
    for (const value of [{ kind: 'number', value: 0 }, { kind: 'checkbox', value: false }, { kind: 'text', value: 'Ready' }] as const) {
      vi.mocked(formulaValue).mockReturnValueOnce(value)
      expect(rowFields(summary({}), book, fields).map((f) => f.field)).toEqual(['result'])
    }
  })

  it('omits built-in fields without a value', () => {
    const fields = listFields({ fields: ['tags', 'collections', 'date', 'host', 'createdVia', 'updatedVia'] }, ['book'])
    expect(rowFields(summary({}), book, fields)).toEqual([])
    const object = summary({ tagIds: ['tag'], collectionIds: ['collection'], date: { start: at, resolution: 'day' }, media: { host: 'example.com' }, createdVia: 'codex', updatedVia: 'claude' })
    expect(rowFields(object, book, fields).map((f) => f.field)).toEqual(fields.filter((f) => f.on).map((f) => f.field))
  })
})
