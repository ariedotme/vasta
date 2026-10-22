import { describe, expect, it } from 'vitest'
import { applyQuoteHighlights, quoteHighlights, withoutQuoteHighlight } from '../src/doc.ts'
import { builtinTypeId, createBuiltinTypes, missingBuiltinTypes } from '../src/builtin-types.ts'
import { createQuote, ensureBuiltinTypes } from '../src/operations.ts'
import type { Doc, DocMark, DocNode } from '../src/model.ts'
import { NodeStore } from '../src/store-node.ts'

const AT = '2026-10-19T15:00:00.000Z'
const quoteMark = (quoteId: string): DocMark => ({ type: 'highlight', attrs: { color: 'yellow', quoteId } })
const text = (value: string, marks?: DocMark[]): DocNode => ({ type: 'text', text: value, ...(marks ? { marks } : {}) })
const doc = (...content: DocNode[]): Doc => ({ type: 'doc', content })
const paragraph = (...content: DocNode[]): DocNode => ({ type: 'paragraph', content })

describe('quote highlights', () => {
  const article = doc(
    paragraph(text('The spice '), text('must ', [quoteMark('q1')]), text('flow', [{ type: 'bold' }, quoteMark('q1')]), text('.')),
    { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text('Fear is the '), text('mind-killer', [quoteMark('q2')]))] }] }
  )

  it('finds the runs of each quote', () => {
    expect(quoteHighlights(article)).toEqual([
      { quoteId: 'q1', text: 'must flow', color: 'yellow' },
      { quoteId: 'q2', text: 'mind-killer', color: 'yellow' },
    ])
  })

  it('removes one quote’s highlight and keeps the text', () => {
    const without = withoutQuoteHighlight(article, 'q1')!
    expect(without.content[0]).toEqual(paragraph(text('The spice '), text('must '), text('flow', [{ type: 'bold' }]), text('.')))
    expect(quoteHighlights(without)).toEqual([{ quoteId: 'q2', text: 'mind-killer', color: 'yellow' }])
    expect(withoutQuoteHighlight(article, 'nope')).toBeUndefined()
  })

  it('puts highlights back into a new version of the text by their passage', () => {
    const fresh = doc(paragraph(text('Intro.')), paragraph(text('The spice must '), text('flow', [{ type: 'bold' }]), text(' forever.')), paragraph(text('No fear here.')))
    const { doc: result, missing } = applyQuoteHighlights(fresh, quoteHighlights(article))
    expect(result.content[1]).toEqual(paragraph(text('The spice '), text('must ', [quoteMark('q1')]), text('flow', [{ type: 'bold' }, quoteMark('q1')]), text(' forever.')))
    expect(missing.map((m) => m.text)).toEqual(['mind-killer'])
    expect(fresh.content[1]).toEqual(paragraph(text('The spice must '), text('flow', [{ type: 'bold' }]), text(' forever.')))
  })
})

describe('quotes', () => {
  function setup() {
    const store = new NodeStore(':memory:')
    store.putSpace({ id: 's', name: 'Space', sidebar: [], createdAt: AT })
    // A space from before quotes existed.
    for (const type of createBuiltinTypes('s', AT).filter((t) => t.system !== 'quote')) store.putType(type)
    return store
  }

  it('gives older spaces the Quote type', () => {
    const store = setup()
    expect(missingBuiltinTypes('s', store.listTypes('s'), AT).map((t) => t.id)).toEqual([builtinTypeId('s', 'quote')])
    expect(ensureBuiltinTypes(store, AT).map((t) => t.name)).toEqual(['Quote'])
    expect(ensureBuiltinTypes(store, AT)).toEqual([])
    expect(store.getType(builtinTypeId('s', 'quote'))?.properties.map((p) => p.name)).toEqual(['Source', 'Notes'])
  })

  it('makes a quote related to its source, and deleting it removes the highlight', () => {
    const store = setup()
    ensureBuiltinTypes(store, AT)
    const page = store.putObject({ id: 'p', spaceId: 's', typeId: builtinTypeId('s', 'page'), title: 'Dune', aliases: [], tagIds: [], collectionIds: [], props: {}, content: {}, createdAt: AT, updatedAt: AT })
    const quote = createQuote(store, page.id, { text: '  The spice\n must flow ', note: 'Good line' }, AT)
    expect(quote).toMatchObject({ title: 'The spice must flow', typeId: builtinTypeId('s', 'quote'), props: { source: { kind: 'relation', value: ['p'] } } })
    expect(quote.content.body!.content).toEqual([paragraph(text('Good line'))])
    expect(store.backlinks(page.id).map((b) => [b.object.id, b.kind])).toEqual([[quote.id, 'relation']])
    store.putObject({ ...page, content: { body: doc(paragraph(text('The spice must flow', [quoteMark(quote.id)]), text(' and more'))) }, updatedAt: AT })
    store.deleteObject(quote.id, '2026-10-19T16:00:00.000Z')
    expect(store.getObject(page.id)!.content.body!.content[0]).toEqual(paragraph(text('The spice must flow and more')))
    expect(() => createQuote(store, page.id, { text: '   ' }, AT)).toThrow('select the passage')
    expect(() => createQuote(store, 'missing', { text: 'x' }, AT)).toThrow('not found')
  })
})
