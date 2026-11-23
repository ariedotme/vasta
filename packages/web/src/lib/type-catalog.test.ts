import { describe, expect, it } from 'vitest'
import type { ObjectType, PropertyDef } from '@vasta/core'
import {
  TYPE_CATALOG,
  buildTemplateProperties,
  findMatchingExistingType,
  listedCatalogTemplates,
  relationDecisionKey,
  resolveImportChain,
  templateByKey,
  type RelationDecision,
  type TypeTemplate,
} from './type-catalog.ts'

const ts = '2026-01-01T00:00:00.000Z'

function makeType(id: string, name: string, pluralName = `${name}s`): ObjectType {
  return {
    id,
    spaceId: 'space-1',
    name,
    pluralName,
    properties: [{ id: 'body', kind: 'rich-text', name: 'Notes' }],
    views: [],
    createdAt: ts,
    updatedAt: ts,
  }
}

describe('type-catalog', () => {
  it('lists only the featured example template(s) while keeping chained dependency templates available', () => {
    expect(listedCatalogTemplates().map((tpl) => tpl.key)).toEqual(['book'])
    expect(templateByKey('person')).toBeDefined()
    expect(templateByKey('organization')).toBeDefined()
  })

  it('chains template dependencies recursively when importing, and stops when ignored or linked to an existing type', () => {
    // Empty space: Book -> Person -> Organization all chain by default.
    const fullChain = resolveImportChain('book', {}, [])
    expect(fullChain.map((n) => [n.template.key, n.depth])).toEqual([
      ['book', 0],
      ['person', 1],
      ['organization', 2],
    ])

    // Ignore Organization on Person -> imports Book and Person only.
    const twoSteps = resolveImportChain(
      'book',
      { [relationDecisionKey('person', 'organization')]: { mode: 'ignore' } },
      []
    )
    expect(twoSteps.map((n) => n.template.key)).toEqual(['book', 'person'])

    // Ignore Author on Book -> imports Book only.
    const rootOnly = resolveImportChain(
      'book',
      { [relationDecisionKey('book', 'author')]: { mode: 'ignore' } },
      []
    )
    expect(rootOnly.map((n) => n.template.key)).toEqual(['book'])

    // Space already has a "Person" type -> defaults to linking existing Person instead of chaining.
    const existingPerson = makeType('t-person', 'Person', 'People')
    expect(findMatchingExistingType(templateByKey('person')!, [existingPerson])?.id).toBe('t-person')
    const linkedExisting = resolveImportChain('book', {}, [existingPerson])
    expect(linkedExisting.map((n) => n.template.key)).toEqual(['book'])
  })

  it('deduplicates cyclic and diamond template dependency graphs safely', () => {
    const base = templateByKey('book')!
    const cyclicCatalog: TypeTemplate[] = [
      {
        ...base,
        key: 'a',
        listed: true,
        properties: [
          { id: 'to-b', kind: 'relation', nameKey: 'typeCatalog.prop.author', multiple: true, targetTemplateKey: 'b' },
          { id: 'to-c', kind: 'relation', nameKey: 'typeCatalog.prop.organization', multiple: false, targetTemplateKey: 'c' },
        ],
      },
      {
        ...base,
        key: 'b',
        listed: false,
        properties: [
          { id: 'back-a', kind: 'relation', nameKey: 'typeCatalog.prop.author', multiple: false, targetTemplateKey: 'a' },
          { id: 'to-c', kind: 'relation', nameKey: 'typeCatalog.prop.organization', multiple: false, targetTemplateKey: 'c' },
        ],
      },
      {
        ...base,
        key: 'c',
        listed: false,
        properties: [{ id: 'back-b', kind: 'relation', nameKey: 'typeCatalog.prop.author', multiple: false, targetTemplateKey: 'b' }],
      },
    ]

    const chain = resolveImportChain('a', {}, [], cyclicCatalog)
    expect(chain.map((n) => n.template.key)).toEqual(['a', 'b', 'c'])
  })

  it('builds concrete properties respecting import, existing, and ignore relation decisions', () => {
    const book = templateByKey('book')!
    const baseBody: PropertyDef[] = [{ id: 'body', kind: 'rich-text', name: 'Notes' }]
    const createdIds = new Map([['book', 'id-book'], ['person', 'id-person']])

    // 1. Imported relation points to the newly created Person id
    const withImport = buildTemplateProperties(book, baseBody, {}, createdIds, [])
    const authorImport = withImport.find((p) => p.kind === 'relation')
    expect(authorImport?.kind === 'relation' && authorImport.targetTypeIds).toEqual(['id-person'])
    expect(withImport[0]?.id).toBe('body')
    expect(withImport.length).toBe(1 + TYPE_CATALOG[0]!.properties.length)

    // 2. Ignored relation is omitted from the created type's properties
    const ignoreDecision: Record<string, RelationDecision> = {
      [relationDecisionKey('book', 'author')]: { mode: 'ignore' },
    }
    const withIgnore = buildTemplateProperties(book, baseBody, ignoreDecision, createdIds, [])
    expect(withIgnore.some((p) => p.kind === 'relation')).toBe(false)
    expect(withIgnore.length).toBe(TYPE_CATALOG[0]!.properties.length)

    // 3. Linked existing type uses that existing type's id
    const existing = makeType('t-custom-author', 'Author')
    const existingDecision: Record<string, RelationDecision> = {
      [relationDecisionKey('book', 'author')]: { mode: 'existing', typeId: existing.id },
    }
    const withExisting = buildTemplateProperties(book, baseBody, existingDecision, createdIds, [existing])
    const authorExisting = withExisting.find((p) => p.kind === 'relation')
    expect(authorExisting?.kind === 'relation' && authorExisting.targetTypeIds).toEqual(['t-custom-author'])
  })
})
