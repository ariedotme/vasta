import { getSchema, type AnyExtension } from '@tiptap/core'
import { Node as PmNode } from '@tiptap/pm/model'
import { describe, expect, it, vi } from 'vitest'
import { blockIdFixes, describeSchema, vastaSchema } from '../src/index.ts'
import { Y, contentToYDoc, loadYDoc, markDeletions, normalizeDoc, readContent, textFields, writeContent, type JsonDoc, type JsonNode } from '../src/yjs.ts'

// The web editor's extensions without the browser: views and app state are stubbed, they do not
// shape the schema.
vi.mock('../../web/src/editor/CalloutView.vue', () => ({ default: {} }))
vi.mock('../../web/src/editor/MentionList.vue', () => ({ default: {} }))
vi.mock('../../web/src/editor/MentionView.vue', () => ({ default: {} }))
vi.mock('../../web/src/editor/ObjectEmbedView.vue', () => ({ default: {} }))
vi.mock('../../web/src/editor/SlashList.vue', () => ({ default: {} }))
vi.mock('../../web/src/lib/api.ts', () => ({ api: {}, MAX_UPLOAD_BYTES: 0 }))
vi.mock('../../web/src/lib/state.ts', () => ({ workspace: {}, typesById: { value: new Map() } }))
vi.mock('../../web/src/lib/actions.ts', () => ({}))
vi.mock('../../web/src/lib/overlays.ts', () => ({}))
vi.mock('../../web/src/lib/media.ts', () => ({}))
vi.mock('../../web/src/lib/templates.ts', () => ({}))
vi.mock('../../web/src/editor/PlaceholderView.vue', () => ({ default: {} }))
vi.mock('../../web/src/editor/TemplateBranchView.vue', () => ({ default: {} }))

const text = (value: string, marks?: JsonNode['marks']): JsonNode => ({ type: 'text', text: value, ...(marks ? { marks } : {}) })
const paragraph = (...content: JsonNode[]): JsonNode => ({ type: 'paragraph', ...(content.length ? { content } : {}) })

/** A document using every node and mark, as the editor saves it. */
const everything = normalizeDoc({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2, id: 'h1a2b3c4', textColor: 'red', background: 'yellow' }, content: [text('Title')] },
    paragraph(
      text('bold', [{ type: 'bold' }]),
      text(' link', [{ type: 'link', attrs: { href: 'https://example.com' } }, { type: 'italic' }]),
      text(' marked', [{ type: 'highlight', attrs: { color: 'green' } }]),
      { type: 'mention', attrs: { objectId: 'o1', label: 'Coffee' } },
      { type: 'hardBreak' },
      text('code', [{ type: 'code' }])
    ),
    { type: 'callout', attrs: { icon: { kind: 'emoji', value: '💡' }, capture: { id: 'c1', channel: 'telegram', at: '2026-10-19T10:00:00.000Z' } }, content: [paragraph(text('captured'))] },
    { type: 'group', attrs: { color: 'blue', textColor: 'gray' }, content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text('item'))] }] }] },
    { type: 'columns', content: [{ type: 'column', attrs: { width: 2 }, content: [paragraph(text('left'))] }, { type: 'column', content: [{ type: 'objectEmbed', attrs: { objectId: 'o2', display: 'wide-card' } }] }] },
    { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [paragraph(text('done'))] }] },
    { type: 'details', attrs: { open: true, icon: { kind: 'icon', value: 'ph:star' } }, content: [{ type: 'detailsSummary', content: [text('More')] }, { type: 'detailsContent', content: [paragraph(text('hidden'))] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [paragraph(text('h'))] }, { type: 'tableCell', attrs: { colwidth: [80] }, content: [paragraph(text('c'))] }] }] },
    { type: 'orderedList', attrs: { start: 3 }, content: [{ type: 'listItem', content: [paragraph(text('three'))] }] },
    { type: 'blockquote', attrs: { id: 'q1', background: 'green' }, content: [paragraph(text('quote'))] },
    { type: 'codeBlock', attrs: { language: 'ts' }, content: [text('let x = 1')] },
    { type: 'horizontalRule' },
    { type: 'unsupported', attrs: { source: 'capacities:chart', raw: { kind: 'chart', data: [1, 2] } } },
    { type: 'templateIf', content: [{ type: 'templateBranch', attrs: { condition: 'weekday(date) = 1' }, content: [paragraph(text('Monday: '), { type: 'placeholder', attrs: { value: 'date:+7d' } })] }, { type: 'templateBranch', content: [paragraph()] }] },
    paragraph(),
  ],
})

describe('editor schema', () => {
  it('is the schema of the web editor', async () => {
    // A path TypeScript does not follow: the web app is type-checked with its own settings (vue-tsc).
    const web = '../../web/src/editor/extensions.ts'
    const { createExtensions } = (await import(/* @vite-ignore */ web)) as { createExtensions: (placeholder: string) => AnyExtension[] }
    expect(describeSchema(getSchema(createExtensions('placeholder')))).toEqual(describeSchema(vastaSchema()))
  })

  it('round-trips every node and mark through Yjs unchanged', () => {
    expect(everything.content).toHaveLength(15)
    expect(normalizeDoc(everything)).toEqual(everything)
    const ydoc = contentToYDoc({ body: everything, notes: normalizeDoc({ type: 'doc', content: [paragraph(text('second field'))] as never }) })
    const back = readContent(loadYDoc(Y.encodeStateAsUpdate(ydoc)))
    expect(back.body).toEqual(everything)
    expect(Object.keys(back)).toEqual(['body', 'notes'])
  })

  it('merges concurrent edits of the same paragraph and of attributes', () => {
    const start = contentToYDoc({ body: normalizeDoc({ type: 'doc', content: [paragraph(text('Hello world')), { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [paragraph(text('task'))] }] }] as never }) })
    const a = loadYDoc(Y.encodeStateAsUpdate(start))
    const b = loadYDoc(Y.encodeStateAsUpdate(start))
    const edit = (ydoc: Y.Doc, change: (doc: JsonDoc) => JsonDoc) => writeContent(ydoc, { body: change(readContent(ydoc).body!) })
    edit(a, (doc) => ({ ...doc, content: [paragraph(text('Hello brave world')), doc.content[1]!] }))
    edit(b, (doc) => {
      const list = structuredClone(doc.content[1]!)
      list.content![0]!.attrs!.checked = true
      return { ...doc, content: [paragraph(text('Hello world!')), list] }
    })
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    for (const ydoc of [a, b]) {
      const body = readContent(ydoc).body!
      expect(body.content[0]).toEqual(paragraph(text('Hello brave world!')))
      expect(body.content[1]!.content![0]!.attrs!.checked).toBe(true)
    }
  })

  it('gives blocks without an id, and later blocks with a taken id, new ids', () => {
    const doc = PmNode.fromJSON(vastaSchema(), {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'a' }, content: [text('first')] },
        { type: 'paragraph', attrs: { id: 'a' }, content: [text('duplicate')] },
        { type: 'bulletList', content: [{ type: 'listItem', attrs: { id: 'b' }, content: [paragraph(text('item'))] }] },
      ],
    })
    let n = 0
    const fixes = blockIdFixes(doc, () => (n++ === 0 ? 'b' : `new${n}`))
    // The duplicate, the list and the item's paragraph; 'b' is taken by the item, so the first try is drawn again.
    expect(fixes.map((fix) => [doc.nodeAt(fix.pos)!.type.name, doc.nodeAt(fix.pos)!.textContent, fix.id])).toEqual([
      ['paragraph', 'duplicate', 'new2'],
      ['bulletList', 'item', 'new3'],
      ['paragraph', 'item', 'new4'],
    ])
    expect(blockIdFixes(doc).every((fix) => /^[a-z0-9]{8}$/.test(fix.id))).toBe(true)
    // Unset shared attributes stay out of the JSON.
    expect(normalizeDoc({ type: 'doc', content: [paragraph(text('x'))] }).content[0]).toEqual(paragraph(text('x')))
  })

  it('merges ids given on one device with text typed on another', () => {
    const start = contentToYDoc({ body: normalizeDoc({ type: 'doc', content: [paragraph(text('Hello')), paragraph(text('World'))] as never }) })
    const a = loadYDoc(Y.encodeStateAsUpdate(start))
    const b = loadYDoc(Y.encodeStateAsUpdate(start))
    const doc = readContent(a).body!
    writeContent(a, { body: { ...doc, content: doc.content.map((node, i) => ({ ...node, attrs: { ...node.attrs, id: `id${i}`, textColor: i ? 'blue' : null } })) } })
    writeContent(b, { body: normalizeDoc({ type: 'doc', content: [paragraph(text('Hello there')), paragraph(text('World'))] as never }) })
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    for (const ydoc of [a, b]) {
      const body = readContent(ydoc).body!
      expect(body.content.map((node) => [node.attrs!.id, node.attrs!.textColor ?? null, node.content![0]!.text])).toEqual([
        ['id0', null, 'Hello there'],
        ['id1', 'blue', 'World'],
      ])
    }
  })

  it('advances the state vector for a change that only deletes, without a text field for it', () => {
    const ydoc = contentToYDoc({ body: normalizeDoc({ type: 'doc', content: [paragraph(text('Hello brave world'))] as never }) })
    const before = Y.encodeStateVector(ydoc)
    writeContent(ydoc, { body: normalizeDoc({ type: 'doc', content: [paragraph(text('Hello world'))] as never }) })
    expect(Y.encodeStateVector(ydoc)).toEqual(before)
    markDeletions(ydoc)
    expect(Y.encodeStateVector(ydoc)).not.toEqual(before)
    const copy = loadYDoc(Y.encodeStateAsUpdate(ydoc))
    expect(textFields(copy)).toEqual(['body'])
    expect(readContent(copy).body!.content[0]).toEqual(paragraph(text('Hello world')))
  })

  it('empties a field that is gone and drops nodes the schema lacks', () => {
    const ydoc = contentToYDoc({ body: normalizeDoc({ type: 'doc', content: [paragraph(text('x'))] as never }) })
    writeContent(ydoc, {})
    expect(readContent(ydoc)).toEqual({})
    expect(() => normalizeDoc({ type: 'doc', content: [{ type: 'mystery' }] })).toThrow('Unknown node type: mystery')
    // A Yjs element the schema cannot hold (e.g. from a newer client) is left out of the JSON.
    const fragment = ydoc.getXmlFragment('body')
    fragment.insert(0, [new Y.XmlElement('mystery'), new Y.XmlElement('paragraph')])
    expect(readContent(ydoc)).toEqual({ body: { type: 'doc', content: [paragraph()] } })
  })
})
