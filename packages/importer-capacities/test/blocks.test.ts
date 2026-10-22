import { describe, expect, it } from 'vitest'
import { blocksToDoc, type BlockContext } from '../src/blocks.ts'
import { Warnings } from '../src/common.ts'
import type { CapBlock } from '../src/source.ts'

const ctx = (): BlockContext => ({ warnings: new Warnings(), titleOf: (id) => (id === 'obj-1' ? 'Linked object' : undefined) })

const text = (value: string, style: Record<string, boolean> = {}) => ({ type: 'TextToken', id: value, text: value, style })
const block = (extra: Record<string, unknown>, tokens = [text('hello')], blocks: CapBlock[] = []): CapBlock => ({
  id: Math.random().toString(36),
  type: 'TextBlock',
  hierarchy: { key: 'Base', val: 0 },
  tokens,
  blocks,
  ...extra,
})

describe('blocksToDoc', () => {
  it('converts text styles, highlights, web links and object mentions', () => {
    const doc = blocksToDoc(
      [
        block({}, [
          text('bold', { bold: true, italic: false }),
          { type: 'TextToken', id: 'h', text: 'marked', style: {}, color: 'bg-red' },
          { type: 'LinkToken', id: 'l', text: 'site', url: 'https://example.com' },
          { type: 'LinkToken', id: 'm', text: ' ', entity: { id: 'obj-1' } },
        ] as never),
      ],
      ctx()
    )
    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'marked', marks: [{ type: 'highlight', attrs: { color: 'red' } }] },
        { type: 'text', text: 'site', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
        { type: 'mention', attrs: { objectId: 'obj-1', label: 'Linked object' } },
      ],
    })
  })

  it('groups consecutive list blocks and nests children inside list items', () => {
    const doc = blocksToDoc(
      [
        block({ list: { type: 'bullet' } }, [text('a')], [block({ list: { type: 'bullet' } }, [text('a.1')])]),
        block({ list: { type: 'bullet' } }, [text('b')]),
        block({ list: { type: 'numerical' } }, [text('one')]),
        block({ todo: { isDone: true } }, [text('done')]),
      ],
      ctx()
    )
    expect(doc.content.map((n) => n.type)).toEqual(['bulletList', 'orderedList', 'taskList'])
    const bullets = doc.content[0]!
    expect(bullets.content).toHaveLength(2)
    expect(bullets.content![0]!.content![1]!.type).toBe('bulletList')
    expect(doc.content[2]!.content![0]).toMatchObject({ type: 'taskItem', attrs: { checked: true } })
  })

  it('turns toggles into details, icon blocks into callouts and H-levels into headings', () => {
    const doc = blocksToDoc(
      [
        block({ toggle: { isOpen: true }, icon: { type: 'iconify', val: 'ph-star' } }, [text('summary')], [block({}, [text('inside')])]),
        block({ icon: { type: 'emoji', val: '💡' } }, [text('tip')]),
        block({ hierarchy: { key: 'H2', val: 0 } }, [text('Title')]),
        block({ quote: { layout: 'normal' } }, [text('quoted')]),
      ],
      ctx()
    )
    expect(doc.content[0]).toMatchObject({
      type: 'details',
      attrs: { open: true, icon: { kind: 'icon', value: 'ph:star' } },
      content: [{ type: 'detailsSummary' }, { type: 'detailsContent', content: [{ type: 'paragraph' }] }],
    })
    expect(doc.content[1]).toMatchObject({ type: 'callout', attrs: { icon: { kind: 'emoji', value: '💡' } } })
    expect(doc.content[2]).toMatchObject({ type: 'heading', attrs: { level: 2 } })
    expect(doc.content[3]).toMatchObject({ type: 'blockquote' })
  })

  it('converts embeds, groups, grids and column-major tables', () => {
    const doc = blocksToDoc(
      [
        { id: 'e', type: 'EntityBlock', entity: { id: 'obj-1', link: { data: { activeView: { type: 'smallCard' } } } } },
        { id: 'g', type: 'GroupBlock', colorTheme: 'bg-sky', blocks: [block({})] },
        { id: 'grid', type: 'GridBlock', dividers: [30], columns: [[block({})], [block({})]] },
        {
          id: 't',
          type: 'SimpleTableBlock',
          blocks: [
            { id: 'c1', type: 'SimpleTableColumn', width: 90, blocks: [block({}, [text('r1c1')]), block({}, [text('r2c1')])] },
            { id: 'c2', type: 'SimpleTableColumn', blocks: [block({}, [text('r1c2')])] },
          ],
        },
        { id: 'x', type: 'MysteryBlock' },
      ],
      ctx()
    )
    expect(doc.content[0]).toEqual({ type: 'objectEmbed', attrs: { objectId: 'obj-1', display: 'card' } })
    expect(doc.content[1]).toMatchObject({ type: 'group', attrs: { color: 'sky' } })
    expect(doc.content[2]!.content!.map((c) => c.attrs)).toEqual([{ width: 30 }, { width: 70 }])
    const table = doc.content[3]!
    expect(table.content).toHaveLength(2)
    expect(table.content![1]!.content![1]).toMatchObject({ type: 'tableCell', content: [{ type: 'paragraph' }] })
    expect(doc.content[4]).toMatchObject({ type: 'unsupported', attrs: { source: 'MysteryBlock' } })
  })
})
