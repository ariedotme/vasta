// The TipTap schema of Vasta documents, without Vue node views or app state, so the server (and
// later the clients' local stores) can read and write rich text as Yjs. Node and mark names match
// DocNodeType in @vasta/core. The web app extends these nodes with its views and plugins; a test
// checks that both give the same schema, or a client would drop content the other one wrote.
import { Extension, Node, getSchema, mergeAttributes, type AnyExtension } from '@tiptap/core'
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details'
import Highlight from '@tiptap/extension-highlight'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import StarterKit from '@tiptap/starter-kit'
import type { Node as PmNode, Schema } from '@tiptap/pm/model'

const jsonAttr = (name: string) => ({
  default: null,
  parseHTML: (el: HTMLElement) => {
    const raw = el.getAttribute(`data-${name}`)
    return raw ? JSON.parse(raw) : null
  },
  renderHTML: (attrs: Record<string, unknown>) => (attrs[name] ? { [`data-${name}`]: JSON.stringify(attrs[name]) } : {}),
})

export const VastaStarterKit = StarterKit.configure({
  heading: { levels: [1, 2, 3, 4] },
  underline: false,
  link: { openOnClick: true, autolink: true, HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' } },
})

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  // `capture` marks an item that arrived through a capture channel (see CaptureInfo).
  addAttributes: () => ({ icon: jsonAttr('icon'), capture: jsonAttr('capture') }),
  parseHTML: () => [{ tag: 'div[data-type="callout"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'callout' }), 0],
})

/** Colored container; the web app adds the palette's classes when rendering it. */
export const Group = Node.create({
  name: 'group',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes: () => ({ color: { default: null, parseHTML: (el) => el.getAttribute('data-color'), renderHTML: () => ({}) } }),
  parseHTML: () => [{ tag: 'div[data-type="group"]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'group', 'data-color': node.attrs.color }), 0],
})

export const Columns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column+',
  isolating: true,
  parseHTML: () => [{ tag: 'div[data-type="columns"]' }],
  renderHTML: ({ node, HTMLAttributes }) => {
    const widths: string[] = []
    node.content.forEach((child) => widths.push(child.attrs.width ? `${child.attrs.width}fr` : '1fr'))
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'columns', class: 'vasta-columns', style: `grid-template-columns: ${widths.join(' ')}` }), 0]
  },
})

export const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,
  addAttributes: () => ({ width: { default: null, parseHTML: (el) => Number(el.getAttribute('data-width')) || null, renderHTML: (a) => (a.width ? { 'data-width': a.width } : {}) } }),
  parseHTML: () => [{ tag: 'div[data-type="column"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'column', class: 'vasta-column' }), 0],
})

export const ObjectEmbed = Node.create({
  name: 'objectEmbed',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes: () => ({
    objectId: { default: null, parseHTML: (el) => el.getAttribute('data-object-id'), renderHTML: (a) => ({ 'data-object-id': a.objectId }) },
    display: { default: 'card', parseHTML: (el) => el.getAttribute('data-display'), renderHTML: (a) => ({ 'data-display': a.display }) },
    // One block of the object instead of the whole (display "block"): a read-only copy kept current.
    blockId: { default: null, parseHTML: (el) => el.getAttribute('data-target-block'), renderHTML: (a) => (a.blockId ? { 'data-target-block': a.blockId } : {}) },
  }),
  parseHTML: () => [{ tag: 'div[data-type="object-embed"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'object-embed' })],
})

export const Unsupported = Node.create({
  name: 'unsupported',
  group: 'block',
  atom: true,
  addAttributes: () => ({ source: { default: '' }, raw: { default: null, rendered: false } }),
  parseHTML: () => [{ tag: 'div[data-type="unsupported"]' }],
  renderHTML: ({ node }) => ['div', { 'data-type': 'unsupported', class: 'vasta-unsupported' }, `Unsupported block: ${node.attrs.source}`],
})

/**
 * Highlights use the app palette instead of raw CSS colors; the web app adds the palette's classes.
 * `quoteId` marks the passage a quote object was made from.
 */
export const ColorHighlight = Highlight.extend({
  addAttributes: () => ({
    color: { default: 'yellow', parseHTML: (el) => el.getAttribute('data-color'), renderHTML: () => ({}) },
    quoteId: { default: null, parseHTML: (el) => el.getAttribute('data-quote-id'), renderHTML: (a) => (a.quoteId ? { 'data-quote-id': a.quoteId } : {}) },
  }),
  renderHTML({ mark, HTMLAttributes }) {
    return ['mark', mergeAttributes(HTMLAttributes, { 'data-color': mark.attrs.color ?? 'yellow' }), 0]
  },
}).configure({ multicolor: true })

/** Keeps the toggle's icon from imported documents. */
export const VastaDetails = Details.extend({
  addAttributes() {
    return { ...this.parent?.(), icon: { default: null, rendered: false } }
  },
}).configure({ persist: true })

/** Inline link to an object, or to one of its blocks (`blockId`, its text then in `blockLabel`); the web app adds its view and the `@` suggestion. */
export const Mention = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({
    objectId: { default: null, parseHTML: (el) => el.getAttribute('data-object-id'), renderHTML: (a) => ({ 'data-object-id': a.objectId }) },
    label: { default: '', parseHTML: (el) => el.textContent ?? '', renderHTML: () => ({}) },
    blockId: { default: null, parseHTML: (el) => el.getAttribute('data-target-block'), renderHTML: (a) => (a.blockId ? { 'data-target-block': a.blockId } : {}) },
    blockLabel: { default: null, parseHTML: (el) => el.getAttribute('data-block-label'), renderHTML: (a) => (a.blockLabel ? { 'data-block-label': a.blockLabel } : {}) },
  }),
  parseHTML: () => [{ tag: 'span[data-type="mention"]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'mention' }), node.attrs.label],
  renderText: ({ node }) => node.attrs.label,
})

/**
 * A template's placeholder (`{{date}}`, `{{ask:With whom?}}`; core's templates.ts), drawn as a
 * chip. `value` is what goes between the braces. Only templates and snippets hold them: applying
 * one replaces them.
 */
export const TemplatePlaceholder = Node.create({
  name: 'placeholder',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: () => ({ value: { default: '', parseHTML: (el) => el.getAttribute('data-value') ?? '', renderHTML: (a) => ({ 'data-value': a.value }) } }),
  parseHTML: () => [{ tag: 'span[data-type="placeholder"]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'placeholder' }), `{{${node.attrs.value}}}`],
  renderText: ({ node }) => `{{${node.attrs.value}}}`,
})

/**
 * Blocks of a template that are kept only when a condition holds: branches (If, Else if, Else),
 * the first that holds is kept and the container goes. Only templates and snippets hold them.
 */
export const TemplateIf = Node.create({
  name: 'templateIf',
  group: 'block',
  content: 'templateBranch+',
  defining: true,
  isolating: true,
  parseHTML: () => [{ tag: 'div[data-type="template-if"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'template-if' }), 0],
})

/** A branch of a TemplateIf: `condition` is a formula; none is the Else. */
export const TemplateBranch = Node.create({
  name: 'templateBranch',
  content: 'block+',
  defining: true,
  isolating: true,
  addAttributes: () => ({
    condition: { default: null, parseHTML: (el) => el.getAttribute('data-condition'), renderHTML: (a) => (a.condition === null ? {} : { 'data-condition': a.condition }) },
  }),
  parseHTML: () => [{ tag: 'div[data-type="template-branch"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'template-branch' }), 0],
})

/** Blocks that can be linked to: each gets a stable `id` (see blockIdFixes). */
export const BLOCK_TYPES = [
  'paragraph', 'heading', 'blockquote', 'codeBlock', 'horizontalRule', 'bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem',
  'callout', 'details', 'group', 'columns', 'table', 'objectEmbed', 'unsupported',
]
/** Blocks with a text color and a background (a group's background is its own `color`). */
export const COLOR_TYPES = ['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem', 'callout', 'details', 'group']

const dataAttr = (name: string, data: string, keepOnSplit = true) => ({
  [name]: {
    default: null,
    keepOnSplit,
    parseHTML: (el: HTMLElement) => el.getAttribute(data),
    renderHTML: (attrs: Record<string, unknown>) => (attrs[name] ? { [data]: attrs[name] } : {}),
  },
})

/**
 * Attributes every block shares: `id` (a split leaves it on the first half), and the palette's
 * `textColor` and `background` (ColorName). The web app adds the palette's classes.
 */
export const BlockAttributes = Extension.create({
  name: 'blockAttributes',
  addGlobalAttributes: () => [
    { types: BLOCK_TYPES, attributes: dataAttr('id', 'data-block-id', false) },
    { types: COLOR_TYPES, attributes: dataAttr('textColor', 'data-text-color') },
    { types: COLOR_TYPES.filter((type) => type !== 'group'), attributes: dataAttr('background', 'data-background') },
  ],
})

/** Attributes left out of the JSON while unset: the shared block ones, and a mention's or embed's block. */
const SHARED_ATTRS = ['id', 'textColor', 'background', 'blockId', 'blockLabel']

/**
 * A document's JSON without the shared block attributes that are unset (ProseMirror writes every
 * attribute, so each paragraph would carry three nulls), nor a highlight's unset quoteId. Reading
 * it back fills them in again.
 */
export function compactDoc<T extends object>(doc: T): T {
  const node = doc as { attrs?: Record<string, unknown>; content?: object[]; marks?: { attrs?: Record<string, unknown> }[] }
  // Likewise a highlight's quoteId.
  for (const mark of node.marks ?? []) if (mark.attrs && mark.attrs.quoteId === null) delete mark.attrs.quoteId
  if (node.attrs) {
    const attrs = Object.fromEntries(Object.entries(node.attrs).filter(([name, value]) => value !== null || !SHARED_ATTRS.includes(name)))
    if (Object.keys(attrs).length) node.attrs = attrs
    else delete node.attrs
  }
  node.content?.forEach(compactDoc)
  return doc
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

/** A new block id: 8 random letters and digits (unique within a document is enough). */
export function newBlockId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (b) => ID_CHARS[b % ID_CHARS.length]).join('')
}

/**
 * The blocks of a document that need a new id: those without one, and every block after the first
 * that has the same id as another (a duplicated block, or two devices' blocks merged).
 */
export function blockIdFixes(doc: PmNode, makeId: () => string = newBlockId): { pos: number; id: string }[] {
  const blocks: { pos: number; id: string | null }[] = []
  doc.descendants((node, pos) => {
    if (BLOCK_TYPES.includes(node.type.name) && 'id' in node.attrs) blocks.push({ pos, id: node.attrs.id as string | null })
  })
  const taken = new Set(blocks.flatMap((block) => (block.id ? [block.id] : [])))
  const kept = new Set<string>()
  const fixes: { pos: number; id: string }[] = []
  for (const { pos, id } of blocks) {
    if (id && !kept.has(id)) {
      kept.add(id)
      continue
    }
    let fresh = makeId()
    while (taken.has(fresh)) fresh = makeId()
    taken.add(fresh)
    fixes.push({ pos, id: fresh })
  }
  return fixes
}

export const TaskItemNested = TaskItem.configure({ nested: true })
export const VastaTableKit = TableKit.configure({ table: { resizable: false } })

/** Every extension that shapes the schema, in the order the editor lists them. */
export function schemaExtensions(): AnyExtension[] {
  return [
    VastaStarterKit,
    TaskList,
    TaskItemNested,
    VastaTableKit,
    VastaDetails,
    DetailsSummary,
    DetailsContent,
    ColorHighlight,
    Callout,
    Group,
    Columns,
    Column,
    ObjectEmbed,
    Unsupported,
    Mention,
    TemplatePlaceholder,
    TemplateIf,
    TemplateBranch,
    BlockAttributes,
  ]
}

let schema: Schema | undefined

/** The ProseMirror schema of Vasta documents (built once). */
export function vastaSchema(): Schema {
  return (schema ??= getSchema(schemaExtensions()))
}

/** A comparable description of a schema: node and mark names, attributes and content expressions. */
export function describeSchema(schema: Schema) {
  const attrs = (spec: Record<string, { default?: unknown }> | undefined) =>
    Object.fromEntries(Object.entries(spec ?? {}).map(([name, attr]) => [name, 'default' in attr ? attr.default : '(required)']))
  return {
    nodes: Object.values(schema.nodes).map((type) => ({
      name: type.name,
      content: type.spec.content ?? '',
      marks: type.spec.marks ?? null,
      group: type.spec.group ?? '',
      inline: !!type.spec.inline,
      atom: !!type.spec.atom,
      attrs: attrs(type.spec.attrs as never),
    })),
    marks: Object.values(schema.marks).map((type) => ({ name: type.name, excludes: type.spec.excludes ?? null, attrs: attrs(type.spec.attrs as never) })),
  }
}
