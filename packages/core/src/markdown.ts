// Markdown to and from Vasta rich text, for agents (the MCP endpoint and the CLI). Markdown holds
// less than a document, so the conversion keeps what an agent reads and writes:
//   paragraphs, headings, lists, to-dos (- [ ] / - [x]), quotes, code, rules, tables, line breaks;
//   **bold**, _italic_, ~~strike~~, `code`, ==highlight==, [links](https://…);
//   a mention is [@Title](vasta://o/<id>), an embedded object ![Title](vasta://o/<id>); with
//   #b-<block> after the id they point to one block ([@Title › its text](…), an embedded block);
//   a callout is a quote starting with [!NOTE] (or TIP, IMPORTANT, WARNING, CAUTION).
// Toggles, groups and columns become their content; block colors and ids are not kept.
import { Marked, type Token, type Tokens } from 'marked'
import type { Doc, DocMark, DocNode, Id } from './model.ts'

const OBJECT_LINK = /^vasta:\/\/o\/([^/?#\s]+)(?:#b-([A-Za-z0-9]+))?$/

/** The object a vasta://o/<id> link points to. */
export function objectIdOfLink(href: string): Id | undefined {
  return OBJECT_LINK.exec(href)?.[1]
}

/** The block a vasta://o/<id>#b-<block> link points to. */
export function blockIdOfLink(href: string): string | undefined {
  return OBJECT_LINK.exec(href)?.[2]
}

export const objectLink = (id: Id, blockId?: string | null) => `vasta://o/${id}${blockId ? `#b-${blockId}` : ''}`

/** A block mention's link text: the object's title, then the block's. */
const BLOCK_SEPARATOR = ' › '

// ---------------------------------------------------------------------------
// Document → Markdown

export interface ToMarkdownOptions {
  /** Titles of embedded objects (mentions carry their own label). */
  titleOf?: (id: Id) => string | undefined
}

const escapeText = (text: string) => text.replace(/([\\`*_[\]<>~=|])/g, '\\$1')
/** Characters that would start a block at the beginning of a line. */
const escapeLineStart = (line: string) => line.replace(/^(\s*)([#>+-])(?=\s|$)/, '$1\\$2').replace(/^(\s*\d+)([.)])(?=\s|$)/, '$1\\$2')

function inline(nodes: DocNode[] | undefined): string {
  let out = ''
  for (const node of nodes ?? []) {
    if (node.type === 'hardBreak') out += '\\\n'
    else if (node.type === 'mention') {
      const blockId = node.attrs?.blockId as string | null | undefined
      const label = blockId && node.attrs?.blockLabel ? `${node.attrs?.label ?? ''}${BLOCK_SEPARATOR}${node.attrs.blockLabel}` : String(node.attrs?.label ?? '')
      out += `[@${escapeText(label)}](${objectLink(String(node.attrs?.objectId), blockId)})`
    }
    else if (node.type === 'text') out += markText(node.text ?? '', node.marks ?? [])
  }
  return out
}

function markText(text: string, marks: DocMark[]): string {
  const code = marks.some((m) => m.type === 'code')
  let body = code ? (text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``) : escapeText(text)
  // Whitespace stays outside the markers, or Markdown would not see them.
  const [, lead = '', core = body, trail = ''] = code ? ['', '', body, ''] : (/^(\s*)([\s\S]*?)(\s*)$/.exec(body) ?? [])
  if (!core) return body
  body = core
  for (const mark of marks) {
    if (mark.type === 'bold') body = `**${body}**`
    else if (mark.type === 'italic') body = `_${body}_`
    else if (mark.type === 'strike') body = `~~${body}~~`
    else if (mark.type === 'highlight') body = `==${body}==`
  }
  const link = marks.find((m) => m.type === 'link')
  if (link) body = `[${body}](${link.attrs.href.replace(/[()\s]/g, encodeURIComponent)})`
  return lead + body + trail
}

const indent = (text: string, prefix: string, first = prefix) =>
  text
    .split('\n')
    .map((line, i) => (line ? (i ? prefix : first) + line : line.trimEnd()))
    .join('\n')

function blocks(nodes: DocNode[] | undefined, options: ToMarkdownOptions): string {
  return (nodes ?? [])
    .map((node) => block(node, options))
    .filter((text) => text !== '')
    .join('\n\n')
}

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList'])

function listItems(node: DocNode, options: ToMarkdownOptions): string {
  let number = Number(node.attrs?.start ?? 1) || 1
  return (node.content ?? [])
    .map((item) => {
      const marker = node.type === 'orderedList' ? `${number++}.` : node.type === 'taskList' ? (item.attrs?.checked ? '- [x]' : '- [ ]') : '-'
      const pad = ' '.repeat(node.type === 'taskList' ? 2 : marker.length + 1)
      // A nested list follows its line directly, or the list would turn loose.
      const body = (item.content ?? [])
        .map((child) => ({ child, text: block(child, options) }))
        .filter(({ text }) => text !== '')
        .map(({ child, text }, i) => (i === 0 ? '' : LIST_TYPES.has(child.type) ? '\n' : '\n\n') + text)
        .join('')
      return indent(body, pad, `${marker} `)
    })
    .join('\n')
}

function cellText(cell: DocNode): string {
  return (cell.content ?? []).map((p) => inline(p.content)).join(' ').replace(/\n/g, ' ')
}

function block(node: DocNode, options: ToMarkdownOptions): string {
  switch (node.type) {
    case 'paragraph':
      return escapeLineStart(inline(node.content))
    case 'heading':
      return `${'#'.repeat(Number(node.attrs?.level ?? 1))} ${inline(node.content)}`
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return listItems(node, options)
    case 'blockquote':
      return indent(blocks(node.content, options), '> ').replace(/^$/gm, '>')
    case 'callout':
      return indent(`[!NOTE]\n${blocks(node.content, options)}`, '> ').replace(/^$/gm, '>')
    case 'codeBlock': {
      const text = (node.content ?? []).map((t) => t.text ?? '').join('')
      const fence = text.includes('```') ? '~~~~' : '```'
      return `${fence}${node.attrs?.language ?? ''}\n${text}\n${fence}`
    }
    case 'horizontalRule':
      return '---'
    case 'details': {
      const [summary, content] = node.content ?? []
      return blocks([{ type: 'paragraph', content: [{ type: 'text', text: '▸ ' }, ...(summary?.content ?? [])] }, ...(content?.content ?? [])], options)
    }
    case 'group':
    case 'columns':
    case 'column':
      return blocks(node.content, options)
    case 'objectEmbed': {
      const id = String(node.attrs?.objectId)
      return `![${escapeText(options.titleOf?.(id) ?? '')}](${objectLink(id, node.attrs?.blockId as string | null | undefined)})`
    }
    case 'table': {
      const rows = (node.content ?? []).map((row) => (row.content ?? []).map((cell) => cellText(cell).replace(/\|/g, '\\|')))
      if (!rows.length) return ''
      const width = Math.max(...rows.map((r) => r.length))
      const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`
      return [line(rows[0]!), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n')
    }
    default:
      return ''
  }
}

/** A document as Markdown. */
export function docToMarkdown(doc: Doc | undefined, options: ToMarkdownOptions = {}): string {
  return blocks(doc?.content, options)
}

// ---------------------------------------------------------------------------
// Markdown → document

const marked = new Marked({
  gfm: true,
  extensions: [
    {
      name: 'highlight',
      level: 'inline',
      start: (src) => src.indexOf('=='),
      tokenizer(src) {
        const match = /^==(?=\S)([\s\S]*?\S)==/.exec(src)
        if (match) return { type: 'highlight', raw: match[0], text: match[1]!, tokens: this.lexer.inlineTokens(match[1]!) }
        return undefined
      },
    },
  ],
})

const CALLOUT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|INFO)\][ \t]*\n?/i

function inlineNodes(tokens: Token[] | undefined, marks: DocMark[] = []): DocNode[] {
  const out: DocNode[] = []
  const text = (value: string) => {
    if (!value) return
    out.push({ type: 'text', text: value, ...(marks.length ? { marks } : {}) })
  }
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'text':
        if (token.tokens?.length) out.push(...inlineNodes(token.tokens, marks))
        else text(decodeEntities(token.text))
        break
      case 'escape':
        text(token.text)
        break
      case 'codespan':
        text(decodeEntities(token.text))
        out.at(-1)!.marks = [...marks, { type: 'code' }]
        break
      case 'strong':
        out.push(...inlineNodes(token.tokens, [...marks, { type: 'bold' }]))
        break
      case 'em':
        out.push(...inlineNodes(token.tokens, [...marks, { type: 'italic' }]))
        break
      case 'del':
        out.push(...inlineNodes(token.tokens, [...marks, { type: 'strike' }]))
        break
      case 'highlight':
        out.push(...inlineNodes(token.tokens, [...marks, { type: 'highlight', attrs: { color: 'yellow' } }]))
        break
      case 'br':
        out.push({ type: 'hardBreak' })
        break
      case 'link': {
        const link = token as Tokens.Link
        const id = objectIdOfLink(link.href)
        const blockId = blockIdOfLink(link.href)
        if (id && link.text.startsWith('@') && blockId) {
          const [label = '', ...rest] = link.text.slice(1).split(BLOCK_SEPARATOR)
          out.push({ type: 'mention', attrs: { objectId: id, label, blockId, ...(rest.length ? { blockLabel: rest.join(BLOCK_SEPARATOR) } : {}) } })
        } else if (id && link.text.startsWith('@')) out.push({ type: 'mention', attrs: { objectId: id, label: link.text.slice(1) } })
        else if (link.href) out.push(...inlineNodes(link.tokens, [...marks, { type: 'link', attrs: { href: link.href } }]))
        else out.push(...inlineNodes(link.tokens, marks))
        break
      }
      case 'image': {
        // Embeds are blocks (paragraphBlocks takes them out); other images stay as links.
        const image = token as Tokens.Image
        const id = objectIdOfLink(image.href)
        const blockId = blockIdOfLink(image.href)
        if (id && blockId) out.push({ type: 'objectEmbed', attrs: { objectId: id, display: 'block', blockId } })
        else if (id) out.push({ type: 'objectEmbed', attrs: { objectId: id, display: 'card' } })
        else out.push({ type: 'text', text: image.text || image.href, marks: [...marks, { type: 'link', attrs: { href: image.href } }] })
        break
      }
      case 'html':
        text(token.raw)
        break
      default:
        if ('text' in token && typeof token.text === 'string') text(token.text)
    }
  }
  return out
}

/** Adjacent text with the same marks as one node (escapes and entities come as pieces of their own). */
function inlineContent(tokens: Token[] | undefined): DocNode[] {
  const out: DocNode[] = []
  for (const node of inlineNodes(tokens)) {
    const last = out.at(-1)
    if (node.type === 'text' && last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(node.marks ?? [])) last.text += node.text ?? ''
    else out.push(node.type === 'text' ? { ...node } : node)
  }
  return out
}

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name]!)
}

/** A paragraph's inline content; embedded objects split it into blocks of their own. */
function paragraphBlocks(tokens: Token[] | undefined): DocNode[] {
  const out: DocNode[] = []
  let run: DocNode[] = []
  const flush = () => {
    // Line breaks around an embed are only layout.
    while (run[0]?.type === 'hardBreak') run.shift()
    while (run.at(-1)?.type === 'hardBreak') run.pop()
    if (run.some((n) => n.type !== 'text' || n.text?.trim())) out.push({ type: 'paragraph', content: run })
    run = []
  }
  for (const node of inlineContent(tokens)) {
    if (node.type === 'objectEmbed') {
      flush()
      out.push(node)
    } else run.push(node)
  }
  flush()
  return out
}

function listNodes(list: Tokens.List): DocNode {
  const task = list.items.some((item) => item.task)
  const items = list.items.map((item): DocNode => {
    const content = blockNodes(item.tokens.filter((t) => t.type !== 'checkbox'))
    // A list item starts with a paragraph ("- # Heading" keeps the heading below an empty line).
    const body: DocNode[] = content[0]?.type === 'paragraph' ? content : [{ type: 'paragraph' }, ...content]
    return task ? { type: 'taskItem', attrs: { checked: !!item.checked }, content: body } : { type: 'listItem', content: body }
  })
  if (task) return { type: 'taskList', content: items }
  if (list.ordered) return { type: 'orderedList', attrs: { start: Number(list.start) || 1 }, content: items }
  return { type: 'bulletList', content: items }
}

const cellNode = (cell: Tokens.TableCell, header: boolean): DocNode => ({
  type: header ? 'tableHeader' : 'tableCell',
  content: [{ type: 'paragraph', ...(cell.tokens.length ? { content: inlineContent(cell.tokens) } : {}) }],
})

function blockNodes(tokens: Token[]): DocNode[] {
  const out: DocNode[] = []
  for (const token of tokens) {
    switch (token.type) {
      case 'paragraph':
        out.push(...paragraphBlocks(token.tokens))
        break
      case 'text':
        // Tight list items hold text tokens instead of paragraphs.
        out.push(...paragraphBlocks(token.tokens ?? [{ type: 'text', raw: token.raw, text: token.text }]))
        break
      case 'heading':
        out.push({ type: 'heading', attrs: { level: Math.min(Math.max(token.depth, 1), 4) }, content: inlineContent(token.tokens) })
        break
      case 'list':
        out.push(listNodes(token as Tokens.List))
        break
      case 'blockquote': {
        const quote = token as Tokens.Blockquote
        const callout = CALLOUT.exec(quote.text)
        if (callout) {
          const inner = blockNodes(marked.lexer(quote.text.slice(callout[0].length)))
          out.push({ type: 'callout', content: inner.length ? inner : [{ type: 'paragraph' }] })
        } else {
          const inner = blockNodes(quote.tokens)
          out.push({ type: 'blockquote', content: inner.length ? inner : [{ type: 'paragraph' }] })
        }
        break
      }
      case 'code': {
        const code = token as Tokens.Code
        out.push({ type: 'codeBlock', attrs: { language: code.lang || null }, ...(code.text ? { content: [{ type: 'text', text: code.text }] } : {}) })
        break
      }
      case 'hr':
        out.push({ type: 'horizontalRule' })
        break
      case 'table': {
        const table = token as Tokens.Table
        out.push({
          type: 'table',
          content: [
            { type: 'tableRow', content: table.header.map((cell) => cellNode(cell, true)) },
            ...table.rows.map((row): DocNode => ({ type: 'tableRow', content: row.map((cell) => cellNode(cell, false)) })),
          ],
        })
        break
      }
      case 'html':
        if (token.text.trim()) out.push({ type: 'paragraph', content: [{ type: 'text', text: token.text.trim() }] })
        break
      default:
        break
    }
  }
  return out
}

/** Blocks of a document written in Markdown. */
export function markdownToBlocks(markdown: string): DocNode[] {
  return blockNodes(marked.lexer(markdown))
}

export function markdownToDoc(markdown: string): Doc {
  const content = markdownToBlocks(markdown)
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }
}
