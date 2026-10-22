import { describe, expect, it } from 'vitest'
import { mapCapacities } from '../src/map.ts'
import type { CapComponent, ComponentRow } from '../src/source.ts'

const SPACE = 'space-1'
const at = '2026-05-08T00:00:00.000Z'
const policies = [{ name: 'write' }]

function row(component: Partial<CapComponent> & { id: string; type: string; structureId: string }, extra: Partial<ComponentRow> = {}): ComponentRow {
  return {
    id: component.id,
    spaceId: SPACE,
    structureId: component.structureId,
    title: null,
    createdAt: at,
    lastUpdated: at,
    deleteRequested: 0,
    dateResolution: null,
    startTime: null,
    endTime: null,
    component: { properties: {}, data: { blocks: {} }, databases: [], ...component, ...({ policies } as object) } as CapComponent,
    ...extra,
  }
}

const paragraph = (value: string) => [{ id: value, type: 'TextBlock', hierarchy: { key: 'Base', val: 0 }, tokens: [{ type: 'TextToken', text: value, style: {} }], blocks: [] }]

const fixture: ComponentRow[] = [
  row({
    id: SPACE,
    type: 'RootSpace',
    structureId: 'RootSpace',
    properties: { title: { val: 'My space' } },
    data: {
      workspace: { pinned: { ids: ['RootDailyNote', 'type-book'] }, g1: { ids: ['book-1'], name: 'Reading', icon: { type: 'iconify', val: 'ph-books' } } },
      workspaceOrder: ['pinned', 'g1', 'objects'],
    },
  }),
  row({
    id: 'type-book',
    type: 'RootStructure',
    structureId: 'RootStructure',
    properties: { title: { val: 'Book' }, pluralName: { val: 'Books' }, icon: { val: { type: 'iconify', val: 'ph-book' } } },
    data: {
      labelColor: 'violet',
      propertyDefinitions: [
        { id: 'title', type: 'entity_title', dataType: 'string' },
        { id: 'tags', type: 'entity_tags', dataType: 'entity' },
        { id: 'p-author', type: 'entity', dataType: 'entity', name: { val: 'Author' }, allowedStructures: ['RootPage'], isArray: true },
        { id: 'p-status', type: 'label', dataType: 'label', name: { val: 'Status' }, isArray: false, set: [{ id: 'reading', text: 'Reading', color: 'rose' }] },
        { id: 'p-read', type: 'datetime', dataType: 'datetime', name: { val: 'Read on' } },
        { id: 'p-pages', type: 'number', dataType: 'number', name: { val: 'Pages' } },
        { id: 'p-notes', type: 'blocks', dataType: 'blocks', name: { val: 'Notes' } },
      ],
    },
  }),
  row({ id: 'default-db', type: 'RootDatabase', structureId: 'RootDatabase', properties: { isDefaultDatabase: { val: true } } }),
  row({ id: 'tag-1', type: 'RootTag', structureId: 'RootTag', properties: { title: { val: 'fiction' } } }),
  row({ id: 'author-1', type: 'RootPage', structureId: 'RootPage', properties: { title: { val: 'Author Name' } } }),
  row({ id: 'date-1', type: 'UtilDate', structureId: 'UtilDate', properties: { date: { val: { dateResolution: 'day', startTime: at } } } }),
  row({
    id: 'book-1',
    type: 'RootEntity',
    structureId: 'type-book',
    databases: [{ id: 'default-db' }],
    properties: {
      title: { val: 'Dune' },
      tags: { val: [{ id: 'tag-1', link: {} }] },
      'p-author': { val: [{ id: 'author-1', link: {} }] },
      'p-status': { val: ['reading'] },
      'p-read': { val: [{ id: 'date-1', link: {} }] },
      'p-pages': { val: 412 },
      'p-notes': { val: 'p-notes' },
    },
    data: { blocks: { 'p-notes': paragraph('Great book') } },
  }),
  row(
    {
      id: 'daily-1',
      type: 'RootDailyNote',
      structureId: 'RootDailyNote',
      createdAt: at,
      properties: { title: { val: '' }, RootDailyNote_notes: { val: 'RootDailyNote_notes' } },
      data: { blocks: { RootDailyNote_notes: paragraph('captured from chat') } },
    },
    { title: '8 May 2026' }
  ),
  row({
    id: 'query-1',
    type: 'RootQuery',
    structureId: 'RootQuery',
    properties: { title: { val: 'Reading now' } },
    data: {
      viewDefinition: { dataViewLayout: 'kanban' },
      definition: {
        scope: 'structures',
        structures: [{ id: 'type-book' }],
        filterGroup: {
          type: 'filterGroup',
          operator: 'and',
          elements: [
            { type: 'filter', propertyId: 'p-status', option: 'contains', referenceValue: { type: 'label', val: [{ id: 'reading' }] } },
            { type: 'filter', propertyId: 'p-author', option: 'contains', referenceValue: { type: 'queryVariable', val: { type: 'parent' } } },
          ],
        },
      },
    },
  }),
  row({ id: 'gone', type: 'RootPage', structureId: 'RootPage', deleteRequested: true }),
  row({ id: 'user', type: 'User', structureId: 'User' }, { spaceId: 'personal' }),
]

describe('mapCapacities', () => {
  const result = mapCapacities(fixture, at)
  const object = (id: string) => result.objects.find((o) => o.id === id)!

  it('creates the space with its sidebar sections', () => {
    expect(result.spaces).toEqual([
      expect.objectContaining({
        id: SPACE,
        name: 'My space',
        sidebar: [
          { id: 'pinned', name: 'Pinned', items: [`daily-note:${SPACE}`, 'type-book'] },
          { id: 'g1', name: 'Reading', icon: { kind: 'icon', value: 'ph:books' }, items: ['book-1'] },
        ],
      }),
    ])
  })

  it('maps custom types and their property definitions', () => {
    const book = result.types.find((t) => t.id === 'type-book')!
    expect(book).toMatchObject({ name: 'Book', pluralName: 'Books', color: 'violet', icon: { kind: 'icon', value: 'ph:book' } })
    expect(book.properties.map((p) => [p.id, p.kind])).toEqual([
      ['p-author', 'relation'],
      ['p-status', 'select'],
      ['p-read', 'date'],
      ['p-pages', 'number'],
      ['p-notes', 'rich-text'],
    ])
    expect(book.properties[0]).toMatchObject({ targetTypeIds: [`page:${SPACE}`], multiple: true })
  })

  it('maps property values, tags and rich text, and skips internal collections', () => {
    expect(object('book-1')).toMatchObject({
      typeId: 'type-book',
      title: 'Dune',
      tagIds: ['tag-1'],
      collectionIds: [],
      props: {
        'p-author': { kind: 'relation', value: ['author-1'] },
        'p-status': { kind: 'select', value: ['reading'] },
        'p-read': { kind: 'date', value: { start: at, resolution: 'day' } },
        'p-pages': { kind: 'number', value: 412 },
      },
    })
    expect(object('book-1').content['p-notes']!.content[0]).toMatchObject({ type: 'paragraph' })
  })

  it('dates daily notes and merges built-in note fields into the body', () => {
    const daily = object('daily-1')
    expect(daily).toMatchObject({ typeId: `daily-note:${SPACE}`, title: '8 May 2026', date: { start: at, resolution: 'day' } })
    expect(Object.keys(daily.content)).toEqual(['body'])
  })

  it('converts query definitions', () => {
    expect(object('query-1').query).toEqual({
      typeIds: ['type-book'],
      layout: 'kanban',
      filter: {
        kind: 'group',
        operator: 'and',
        items: [
          { kind: 'filter', field: 'p-status', operator: 'contains', value: { kind: 'literal', value: ['reading'] } },
          { kind: 'filter', field: 'p-author', operator: 'contains', value: { kind: 'variable', name: 'parent' } },
        ],
      },
    })
  })

  it('reports what was skipped', () => {
    expect(result.objects.map((o) => o.id)).not.toContain('gone')
    expect(result.report.skipped).toMatchObject({ deleted: 1, 'internal default collection': 1, RootSpace: 1, RootStructure: 1 })
  })
})
