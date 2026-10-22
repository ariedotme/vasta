import { describe, expect, it } from 'vitest'
import { docToMarkdown, markdownToDoc } from '../src/markdown.ts'
import type { Doc, DocNode } from '../src/model.ts'

const text = (value: string, marks?: DocNode['marks']): DocNode => ({ type: 'text', text: value, ...(marks ? { marks } : {}) })
const paragraph = (...content: DocNode[]): DocNode => ({ type: 'paragraph', content })

const sample = `# Title

Some **bold**, _italic_, ~~gone~~, \`code\`, ==marked== and a [link](https://example.com/a_b).\\
Second line with [@Coffee](vasta://o/o1).

- one
- two
  1. nested

3. three
4. four

- [ ] open task
- [x] done task

> quoted

> [!NOTE]
> a callout

\`\`\`ts
let x = 1
\`\`\`

---

![Photo](vasta://o/img1)

| A | B |
| --- | --- |
| 1 | 2 |`

describe('markdown', () => {
  it('reads Markdown into blocks', () => {
    const doc = markdownToDoc(sample)
    expect(doc.content.map((n) => n.type)).toEqual([
      'heading', 'paragraph', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'callout', 'codeBlock', 'horizontalRule', 'objectEmbed', 'table',
    ])
    expect(doc.content[1]!.content).toEqual([
      text('Some '),
      text('bold', [{ type: 'bold' }]),
      text(', '),
      text('italic', [{ type: 'italic' }]),
      text(', '),
      text('gone', [{ type: 'strike' }]),
      text(', '),
      text('code', [{ type: 'code' }]),
      text(', '),
      text('marked', [{ type: 'highlight', attrs: { color: 'yellow' } }]),
      text(' and a '),
      text('link', [{ type: 'link', attrs: { href: 'https://example.com/a_b' } }]),
      text('.'),
      { type: 'hardBreak' },
      text('Second line with '),
      { type: 'mention', attrs: { objectId: 'o1', label: 'Coffee' } },
      text('.'),
    ])
    expect(doc.content[3]).toMatchObject({ type: 'orderedList', attrs: { start: 3 } })
    expect(doc.content[4]!.content!.map((item) => item.attrs!.checked)).toEqual([false, true])
    expect(doc.content[6]).toEqual({ type: 'callout', content: [paragraph(text('a callout'))] })
    expect(doc.content[9]).toEqual({ type: 'objectEmbed', attrs: { objectId: 'img1', display: 'card' } })
    expect(doc.content[10]!.content![0]!.content![0]!.type).toBe('tableHeader')
  })

  it('writes documents as Markdown that reads back the same', () => {
    const doc = markdownToDoc(sample)
    const markdown = docToMarkdown(doc, { titleOf: (id) => (id === 'img1' ? 'Photo' : undefined) })
    expect(markdown).toBe(sample)
    expect(markdownToDoc(markdown)).toEqual(doc)
  })

  it('escapes what Markdown would read as formatting', () => {
    const doc: Doc = { type: 'doc', content: [paragraph(text('1. not a list *nor* [a link]')), paragraph(text('# not a heading')), paragraph(text(' spaced ', [{ type: 'bold' }]), text('x'))] }
    const markdown = docToMarkdown(doc)
    expect(markdown).toBe('1\\. not a list \\*nor\\* \\[a link\\]\n\n\\# not a heading\n\n **spaced** x')
    expect(markdownToDoc(markdown).content.slice(0, 2)).toEqual(doc.content.slice(0, 2))
  })

  it('splits paragraphs around embedded objects and keeps other images as links', () => {
    expect(markdownToDoc('before ![X](vasta://o/a) after ![pic](https://example.com/p.png)').content).toEqual([
      paragraph(text('before ')),
      { type: 'objectEmbed', attrs: { objectId: 'a', display: 'card' } },
      paragraph(text(' after '), text('pic', [{ type: 'link', attrs: { href: 'https://example.com/p.png' } }])),
    ])
    expect(markdownToDoc('')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
  })

  it('keeps mentions and embeds of one block as #b- links', () => {
    const doc: Doc = {
      type: 'doc',
      content: [
        paragraph(text('See '), { type: 'mention', attrs: { objectId: 'o1', label: 'Dune', blockId: 'abc123', blockLabel: 'Chapter 1' } }),
        { type: 'objectEmbed', attrs: { objectId: 'o1', display: 'block', blockId: 'abc123' } },
      ],
    }
    const markdown = docToMarkdown(doc, { titleOf: () => 'Dune' })
    expect(markdown).toBe('See [@Dune › Chapter 1](vasta://o/o1#b-abc123)\n\n![Dune](vasta://o/o1#b-abc123)')
    expect(markdownToDoc(markdown).content).toEqual(doc.content)
  })

  it('flattens toggles, groups and columns', () => {
    const doc: Doc = {
      type: 'doc',
      content: [
        { type: 'details', content: [{ type: 'detailsSummary', content: [text('More')] }, { type: 'detailsContent', content: [paragraph(text('hidden'))] }] },
        { type: 'columns', content: [{ type: 'column', content: [paragraph(text('left'))] }, { type: 'column', content: [{ type: 'group', content: [paragraph(text('right'))] }] }] },
      ],
    }
    expect(docToMarkdown(doc)).toBe('▸ More\n\nhidden\n\nleft\n\nright')
  })
})
