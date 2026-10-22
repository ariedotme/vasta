import { describe, expect, it } from 'vitest'
import { blockAsDoc, findBlock, listBlocks, setBlockId } from '../src/blocks.ts'
import type { Doc, DocNode } from '../src/model.ts'

const text = (value: string): DocNode => ({ type: 'text', text: value })
const paragraph = (value: string, id?: string): DocNode => ({ type: 'paragraph', ...(id ? { attrs: { id } } : {}), content: value ? [text(value)] : [] })
const body: Doc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2, id: 'h1' }, content: [text('Chapter 1')] },
    paragraph('The spice must flow.'),
    paragraph(''),
    { type: 'bulletList', content: [{ type: 'listItem', attrs: { id: 'li1' }, content: [paragraph('Arrakis'), paragraph('a desert planet')] }] },
    { type: 'callout', content: [paragraph('Fear is the mind-killer.', 'p9')] },
    { type: 'objectEmbed', attrs: { objectId: 'x' } },
  ],
}

describe('blocks of an object', () => {
  it('lists the blocks with text in reading order, list items by their first line', () => {
    expect(listBlocks({ content: { body } })).toEqual([
      { field: 'body', path: [0], id: 'h1', type: 'heading', level: 2, text: 'Chapter 1' },
      { field: 'body', path: [1], type: 'paragraph', text: 'The spice must flow.' },
      { field: 'body', path: [3, 0], id: 'li1', type: 'listItem', text: 'Arrakis' },
      { field: 'body', path: [3, 0, 1], type: 'paragraph', text: 'a desert planet' },
      { field: 'body', path: [4, 0], id: 'p9', type: 'paragraph', text: 'Fear is the mind-killer.' },
    ])
  })

  it('finds a block by id, gives one an id, and shows a list item inside its list', () => {
    expect(findBlock({ content: { body } }, 'p9')).toEqual({ field: 'body', node: body.content[4]!.content![0] })
    const withId = setBlockId(body, [1], 'new1')
    expect(findBlock({ content: { body: withId } }, 'new1')?.node.content).toEqual([text('The spice must flow.')])
    expect(body.content[1]!.attrs).toBeUndefined()
    expect(blockAsDoc(body.content[3]!.content![0]!).content[0]!.type).toBe('bulletList')
  })
})
