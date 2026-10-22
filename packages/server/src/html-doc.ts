// Turns an HTML fragment (a Readability article) into Vasta rich-text blocks. Only structure the
// editor schema knows survives: paragraphs, headings, lists, quotes, code, rules, tables, and
// bold/italic/strike/code/link marks. Images, media and scripts are dropped.
import type { DocMark, DocNode } from '@vasta/core'

/** Stop converting past this many top-level blocks; the rest of a huge page is not worth keeping. */
const MAX_BLOCKS = 3000

const SKIP = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'canvas', 'video', 'audio', 'img', 'picture', 'source', 'form', 'input', 'button', 'select', 'textarea', 'head', 'title', 'meta', 'link'])
/** Containers whose children join the surrounding flow of blocks. */
const CONTAINERS = new Set(['div', 'section', 'article', 'main', 'header', 'footer', 'aside', 'nav', 'figure', 'figcaption', 'center', 'details', 'summary', 'body', 'html', 'dl', 'dd', 'dt', 'address', 'hgroup', 'thead', 'tbody', 'tfoot'])
const HEADINGS: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 4, h6: 4 }
const MARKS: Record<string, DocMark> = {
  strong: { type: 'bold' }, b: { type: 'bold' },
  em: { type: 'italic' }, i: { type: 'italic' }, cite: { type: 'italic' },
  s: { type: 'strike' }, del: { type: 'strike' }, strike: { type: 'strike' },
  code: { type: 'code' }, kbd: { type: 'code' }, samp: { type: 'code' },
  mark: { type: 'highlight', attrs: { color: 'yellow' } },
}

const TEXT_NODE = 3
const ELEMENT_NODE = 1

const tagOf = (node: Node) => (node.nodeType === ELEMENT_NODE ? (node as Element).tagName.toLowerCase() : '')
const BLOCKS = ['p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr', 'table', 'tr']
const isBlock = (tag: string) => tag in HEADINGS || CONTAINERS.has(tag) || BLOCKS.includes(tag)
const BLOCK_SELECTOR = [...BLOCKS, ...Object.keys(HEADINGS), 'div', 'section', 'article'].join(',')
/** An inline element wrapping blocks (Readability turns <br><br> inside <font> into <p>s). */
const wrapsBlocks = (element: Element) => !!element.querySelector(BLOCK_SELECTOR)

function href(element: Element, baseUrl: string): string | undefined {
  const raw = element.getAttribute('href')?.trim()
  if (!raw || raw.startsWith('#')) return undefined
  try {
    const url = new URL(raw, baseUrl)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.toString() : undefined
  } catch {
    return undefined
  }
}

const sameMarks = (a: DocMark[] = [], b: DocMark[] = []) => JSON.stringify(a) === JSON.stringify(b)

/** Trim the edges of a run of inline nodes, merge neighbours with equal marks, drop empties. */
function tidyInline(nodes: DocNode[]): DocNode[] {
  const merged: DocNode[] = []
  for (const node of nodes) {
    const last = merged.at(-1)
    if (node.type !== 'text') {
      merged.push({ ...node })
      continue
    }
    // Collapse the space between neighbours, and after a line break.
    const text = !last || last.type === 'hardBreak' || /\s$/.test(last.text ?? '') ? node.text!.replace(/^\s+/, '') : node.text!
    if (!text) continue
    if (last?.type === 'text' && sameMarks(last.marks, node.marks)) last.text = `${last.text}${text}`
    else merged.push({ ...node, text })
  }
  while (merged[0]?.type === 'hardBreak') merged.shift()
  while (merged.at(-1)?.type === 'hardBreak') merged.pop()
  const last = merged.at(-1)
  if (last?.type === 'text') last.text = last.text!.replace(/\s+$/, '')
  return merged.filter((node) => node.type !== 'text' || node.text)
}

class Converter {
  private readonly baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  /** Inline content of a node with the marks of its ancestors. */
  inline(node: Node, marks: DocMark[] = []): DocNode[] {
    if (node.nodeType === TEXT_NODE) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ')
      if (!text) return []
      return [marks.length ? { type: 'text', text, marks } : { type: 'text', text }]
    }
    if (node.nodeType !== ELEMENT_NODE) return []
    const tag = tagOf(node)
    if (SKIP.has(tag)) return []
    if (tag === 'br') return [{ type: 'hardBreak' }]
    // A block inside inline content (invalid HTML) at least starts on its own line.
    if (isBlock(tag)) return [{ type: 'hardBreak' }, ...Array.from(node.childNodes).flatMap((child) => this.inline(child, marks)), { type: 'hardBreak' }]
    let next = marks
    const mark = MARKS[tag]
    const link = tag === 'a' ? href(node as Element, this.baseUrl) : undefined
    // The code mark excludes every other mark in the editor schema.
    if (mark?.type === 'code') next = [mark]
    else if (!marks.some((m) => m.type === 'code')) {
      if (mark && !marks.some((m) => m.type === mark.type)) next = [...marks, mark]
      if (link) next = [...next.filter((m) => m.type !== 'link'), { type: 'link', attrs: { href: link } }]
    }
    return Array.from(node.childNodes).flatMap((child) => this.inline(child, next))
  }

  paragraph(nodes: DocNode[]): DocNode[] {
    const content = tidyInline(nodes)
    return content.length ? [{ type: 'paragraph', content }] : []
  }

  /** Block content of a node: inline runs become paragraphs, block elements their own nodes. */
  blocks(parent: Node): DocNode[] {
    const out: DocNode[] = []
    let run: DocNode[] = []
    const flush = () => {
      out.push(...this.paragraph(run))
      run = []
    }
    for (const child of Array.from(parent.childNodes)) {
      if (out.length >= MAX_BLOCKS) break
      const tag = tagOf(child)
      if (child.nodeType === ELEMENT_NODE && SKIP.has(tag)) continue
      if (child.nodeType !== ELEMENT_NODE || (!isBlock(tag) && !wrapsBlocks(child as Element))) {
        run.push(...this.inline(child))
        continue
      }
      flush()
      out.push(...this.block(child as Element, tag))
    }
    flush()
    return out
  }

  block(element: Element, tag: string): DocNode[] {
    if (tag === 'p') return this.paragraph(this.inline(element))
    if (tag in HEADINGS) {
      const content = tidyInline(this.inline(element))
      return content.length ? [{ type: 'heading', attrs: { level: HEADINGS[tag] }, content }] : []
    }
    if (tag === 'ul' || tag === 'ol') return this.list(element, tag)
    if (tag === 'li') return this.list(element, 'ul', [element])
    if (tag === 'blockquote') {
      const content = this.blocks(element)
      return content.length ? [{ type: 'blockquote', content }] : []
    }
    if (tag === 'pre') {
      const text = (element.textContent ?? '').replace(/\n$/, '')
      if (!text.trim()) return []
      const language = /(?:^|\s)(?:language|lang)-([\w+-]+)/.exec(element.querySelector('code')?.getAttribute('class') ?? element.getAttribute('class') ?? '')?.[1]
      return [{ type: 'codeBlock', attrs: { language: language ?? null }, content: [{ type: 'text', text }] }]
    }
    if (tag === 'hr') return [{ type: 'horizontalRule' }]
    if (tag === 'table') return this.table(element)
    if (tag === 'tr') return this.blocks(element)
    return this.blocks(element)
  }

  list(element: Element, tag: 'ul' | 'ol', items = Array.from(element.children).filter((c) => tagOf(c) === 'li')): DocNode[] {
    const content = items.flatMap((item) => {
      const blocks = this.blocks(item)
      if (!blocks.length) return []
      // A list item must start with a paragraph.
      if (blocks[0]!.type !== 'paragraph') blocks.unshift({ type: 'paragraph' })
      return [{ type: 'listItem', content: blocks } as DocNode]
    })
    if (!content.length) return []
    const start = Number(element.getAttribute('start'))
    return [tag === 'ol' ? { type: 'orderedList', attrs: { start: Number.isInteger(start) && start > 0 ? start : 1 }, content } : { type: 'bulletList', content }]
  }

  table(element: Element): DocNode[] {
    const rows = Array.from(element.querySelectorAll('tr')).filter((row) => row.closest('table') === element)
    const content = rows.flatMap((row) => {
      const cells = Array.from(row.children).filter((c) => ['td', 'th'].includes(tagOf(c)))
      if (!cells.length) return []
      return [{ type: 'tableRow', content: cells.map((cell) => ({ type: 'tableCell', content: this.cellBlocks(cell) }) as DocNode) } as DocNode]
    })
    return content.length ? [{ type: 'table', content }] : []
  }

  private cellBlocks(cell: Element): DocNode[] {
    const blocks = this.blocks(cell)
    return blocks.length ? blocks : [{ type: 'paragraph' }]
  }
}

/** Blocks for the children of `root`. Relative links resolve against `baseUrl`. */
export function htmlToBlocks(root: Node, baseUrl: string): DocNode[] {
  return new Converter(baseUrl).blocks(root)
}
