import type { ColorName, Doc, DocMark, DocNode, Id, ObjectRecord } from './model.ts'

export interface DocReference {
  objectId: Id
  kind: 'mention' | 'embed'
}

function visit(nodes: DocNode[] | undefined, fn: (node: DocNode) => void) {
  for (const node of nodes ?? []) {
    fn(node)
    visit(node.content, fn)
  }
}

/** The text of a node and what it holds (a mention as its label), without line breaks between blocks. */
export function nodeText(node: DocNode): string {
  if (node.type === 'text') return node.text ?? ''
  if (node.type === 'mention') return String(node.attrs?.label ?? '')
  if (node.type === 'hardBreak') return '\n'
  return (node.content ?? []).map(nodeText).join('')
}

/** Plain text of a document, one line per block, for search indexing and previews. */
export function docToPlainText(doc: Doc): string {
  const lines: string[] = []
  const walk = (node: DocNode): string => {
    if (node.type === 'text') return node.text ?? ''
    if (node.type === 'mention') return String(node.attrs?.label ?? '')
    if (node.type === 'hardBreak') return '\n'
    const inner = (node.content ?? []).map(walk).join('')
    return inner
  }
  visit(doc.content, (node) => {
    if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock' || node.type === 'detailsSummary') {
      const line = walk(node)
      if (line.trim()) lines.push(line)
    }
  })
  return lines.join('\n')
}

export function docReferences(doc: Doc): DocReference[] {
  const refs: DocReference[] = []
  visit(doc.content, (node) => {
    const objectId = node.attrs?.objectId
    if (typeof objectId !== 'string') return
    if (node.type === 'mention') refs.push({ objectId, kind: 'mention' })
    if (node.type === 'objectEmbed') refs.push({ objectId, kind: 'embed' })
  })
  return refs
}

export interface ObjectLink {
  fromId: Id
  toId: Id
  kind: 'mention' | 'embed' | 'relation' | 'tag' | 'collection'
  via: string | null
}

/** Every outgoing reference of an object; the source of the backlinks index. */
export function objectLinks(object: ObjectRecord): ObjectLink[] {
  const links: ObjectLink[] = []
  const add = (toId: Id, kind: ObjectLink['kind'], via: string | null) => {
    if (toId === object.id) return
    if (links.some((l) => l.toId === toId && l.kind === kind && l.via === via)) return
    links.push({ fromId: object.id, toId, kind, via })
  }
  for (const [field, doc] of Object.entries(object.content)) {
    for (const ref of docReferences(doc)) add(ref.objectId, ref.kind, field)
  }
  for (const [propertyId, value] of Object.entries(object.props)) {
    if (value.kind === 'relation') for (const id of value.value) add(id, 'relation', propertyId)
    // A recipe's foods, so a food's backlinks list the recipes it is in. What a daily note logs
    // (`food-entry`) is not a link: a food eaten daily would gather thousands.
    if (value.kind === 'ingredients') for (const { id } of value.value) add(id, 'relation', propertyId)
  }
  for (const id of object.tagIds) add(id, 'tag', null)
  for (const id of object.collectionIds) add(id, 'collection', null)
  return links
}

// ---------------------------------------------------------------------------
// Quote highlights: a highlight mark with a quoteId marks the passage a quote object was made
// from (createQuote in operations.ts).

/** A run of text highlighted for a quote, within one block. */
export interface QuoteHighlight {
  quoteId: Id
  text: string
  color: ColorName
}

const quoteOf = (mark: DocMark): Id | undefined => (mark.type === 'highlight' && mark.attrs.quoteId ? mark.attrs.quoteId : undefined)

/** The document without the highlight of a quote (the passage stays, unmarked); undefined when it had none. */
export function withoutQuoteHighlight(doc: Doc, quoteId: Id): Doc | undefined {
  let changed = false
  const strip = (nodes: DocNode[]): DocNode[] =>
    nodes.map((node) => {
      let next = node
      if (node.marks?.some((m) => quoteOf(m) === quoteId)) {
        changed = true
        const marks = node.marks.filter((m) => quoteOf(m) !== quoteId)
        const { marks: _marks, ...rest } = node
        next = marks.length ? { ...rest, marks } : rest
      }
      return next.content ? { ...next, content: strip(next.content) } : next
    })
  const content = strip(doc.content)
  return changed ? { ...doc, content } : undefined
}

/** Blocks holding inline content (paragraphs, headings…), in document order. */
function textBlocks(nodes: DocNode[] | undefined, out: DocNode[] = []): DocNode[] {
  for (const node of nodes ?? []) {
    if (node.content?.some((child) => child.type === 'text' || child.type === 'mention' || child.type === 'hardBreak')) out.push(node)
    else textBlocks(node.content, out)
  }
  return out
}

/** Text of an inline node as offsets count it: atoms take one character. */
const inlineText = (node: DocNode) => (node.type === 'text' ? (node.text ?? '') : '￼')

/** The quote highlights of a document, one run per block and quote, in order. */
export function quoteHighlights(doc: Doc): QuoteHighlight[] {
  const runs: QuoteHighlight[] = []
  for (const block of textBlocks(doc.content)) {
    let current: QuoteHighlight | undefined
    for (const node of block.content ?? []) {
      const mark = node.marks?.find((m) => quoteOf(m))
      const id = mark && quoteOf(mark)
      if (id && current?.quoteId === id) current.text += inlineText(node)
      else if (id && mark?.type === 'highlight') runs.push((current = { quoteId: id, text: inlineText(node), color: mark.attrs.color }))
      else current = undefined
    }
  }
  return runs
}

/**
 * Put quote highlights back into a new version of a text (a re-fetched page): each run is found
 * by its text, after the previous one when possible. Runs whose text is gone are returned in
 * `missing`.
 */
export function applyQuoteHighlights(doc: Doc, highlights: QuoteHighlight[]): { doc: Doc; missing: QuoteHighlight[] } {
  const copy = structuredClone(doc)
  const blocks = textBlocks(copy.content)
  const missing: QuoteHighlight[] = []
  let from = 0
  for (const highlight of highlights) {
    const find = (start: number) => {
      for (let i = start; i < blocks.length; i++) {
        const at = (blocks[i]!.content ?? []).map(inlineText).join('').indexOf(highlight.text)
        if (at >= 0) return { index: i, at }
      }
      return undefined
    }
    const found = highlight.text.trim() ? (find(from) ?? find(0)) : undefined
    if (!found) {
      missing.push(highlight)
      continue
    }
    from = found.index
    markRange(blocks[found.index]!, found.at, found.at + highlight.text.length, { type: 'highlight', attrs: { color: highlight.color, quoteId: highlight.quoteId } })
  }
  return { doc: copy, missing }
}

/** Add `mark` to the text between two offsets of a block, splitting text nodes at the edges. */
function markRange(block: DocNode, start: number, end: number, mark: DocMark) {
  const content: DocNode[] = []
  let offset = 0
  for (const node of block.content ?? []) {
    const length = inlineText(node).length
    const [a, b] = [Math.max(start - offset, 0), Math.min(end - offset, length)]
    offset += length
    if (node.type !== 'text' || a >= b) {
      content.push(node)
      continue
    }
    const text = node.text ?? ''
    const marks = (node.marks ?? []).filter((m) => m.type !== 'highlight')
    const piece = (slice: string, extra: DocMark[] = []): DocNode => ({ ...node, text: slice, ...(node.marks || extra.length ? { marks: extra.length ? [...marks, ...extra] : node.marks } : {}) })
    if (a > 0) content.push(piece(text.slice(0, a)))
    content.push(piece(text.slice(a, b), [mark]))
    if (b < length) content.push(piece(text.slice(b)))
  }
  block.content = content
}
