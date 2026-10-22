// Converts Capacities block trees into Vasta rich-text documents (ProseMirror JSON).
//
// Capacities stores a document as a list of blocks. A TextBlock carries inline tokens plus
// flags that change its meaning (heading level, list, todo, quote, toggle, icon) and may own
// child blocks. ProseMirror instead wraps list items in list nodes, so consecutive list
// blocks of the same kind are grouped here.
import type { Doc, DocMark, DocNode } from '@vasta/core'
import type { CapBlock } from './source.ts'
import { toColor, toIcon, type Warnings } from './common.ts'

interface TextToken {
  type: 'TextToken'
  text?: string
  style?: Record<string, unknown>
  color?: string
}

interface LinkToken {
  type: 'LinkToken'
  text?: string
  url?: string
  entity?: { id?: string }
}

type Token = TextToken | LinkToken | { type: string; text?: string }

interface TextBlock extends CapBlock {
  type: 'TextBlock'
  tokens?: Token[]
  blocks?: CapBlock[]
  hierarchy?: { key?: string }
  list?: { type?: 'bullet' | 'numerical' }
  todo?: { isDone?: boolean }
  quote?: unknown
  toggle?: { isOpen?: boolean }
  icon?: unknown
}

export interface BlockContext {
  warnings: Warnings
  /** Title of a referenced object, used when a mention has no text of its own. */
  titleOf(objectId: string): string | undefined
}

const ENTITY_VIEW_TO_DISPLAY: Record<string, string> = {
  inline: 'inline',
  smallCard: 'card',
  wideCard: 'wide-card',
  embed: 'embed',
}

const STYLE_TO_MARK: Record<string, DocMark['type']> = {
  bold: 'bold',
  italic: 'italic',
  strikethrough: 'strike',
  strike: 'strike',
  code: 'code',
}

function convertTokens(tokens: Token[] | undefined, ctx: BlockContext): DocNode[] {
  const nodes: DocNode[] = []
  for (const token of tokens ?? []) {
    if (token.type === 'TextToken') {
      const { text, style, color } = token as TextToken
      if (!text) continue
      const marks: DocMark[] = []
      for (const [key, on] of Object.entries(style ?? {})) {
        if (!on) continue
        const mark = STYLE_TO_MARK[key]
        if (mark) marks.push({ type: mark } as DocMark)
        else ctx.warnings.add(`text style "${key}" dropped`)
      }
      const highlight = toColor(color)
      if (highlight) marks.push({ type: 'highlight', attrs: { color: highlight } })
      nodes.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text })
    } else if (token.type === 'LinkToken') {
      const { text, url, entity } = token as LinkToken
      if (entity?.id) {
        const label = text?.trim() || ctx.titleOf(entity.id) || 'Untitled'
        nodes.push({ type: 'mention', attrs: { objectId: entity.id, label } })
      } else if (url) {
        nodes.push({ type: 'text', text: text || url, marks: [{ type: 'link', attrs: { href: url } }] })
      } else if (text) {
        nodes.push({ type: 'text', text })
      }
    } else {
      ctx.warnings.add(`inline token "${token.type}" converted to plain text`)
      if (token.text) nodes.push({ type: 'text', text: token.text })
    }
  }
  return nodes
}

function paragraph(inline: DocNode[]): DocNode {
  return inline.length ? { type: 'paragraph', content: inline } : { type: 'paragraph' }
}

/** ProseMirror container nodes need at least one block child. */
function nonEmpty(nodes: DocNode[]): DocNode[] {
  return nodes.length ? nodes : [{ type: 'paragraph' }]
}

type ListKind = 'bulletList' | 'orderedList' | 'taskList'

function listKindOf(block: CapBlock): ListKind | undefined {
  if (block.type !== 'TextBlock') return undefined
  const text = block as TextBlock
  if (text.todo) return 'taskList'
  if (text.list?.type === 'bullet') return 'bulletList'
  if (text.list?.type === 'numerical') return 'orderedList'
  return undefined
}

function convertListItem(block: TextBlock, kind: ListKind, ctx: BlockContext): DocNode {
  const content = [paragraph(convertTokens(block.tokens, ctx)), ...convertBlocks(block.blocks ?? [], ctx)]
  if (kind === 'taskList') return { type: 'taskItem', attrs: { checked: !!block.todo?.isDone }, content }
  return { type: 'listItem', content }
}

function convertTextBlock(block: TextBlock, ctx: BlockContext): DocNode[] {
  const inline = convertTokens(block.tokens, ctx)
  const children = convertBlocks(block.blocks ?? [], ctx)
  const icon = toIcon(block.icon)

  if (block.toggle) {
    return [
      {
        type: 'details',
        attrs: { open: !!block.toggle.isOpen, ...(icon ? { icon } : {}) },
        content: [
          { type: 'detailsSummary', ...(inline.length ? { content: inline } : {}) },
          { type: 'detailsContent', content: nonEmpty(children) },
        ],
      },
    ]
  }
  if (block.quote) return [{ type: 'blockquote', content: [paragraph(inline), ...children] }]
  if (icon) return [{ type: 'callout', attrs: { icon }, content: [paragraph(inline), ...children] }]

  const level = /^H([1-6])$/.exec(block.hierarchy?.key ?? '')?.[1]
  const head: DocNode = level
    ? { type: 'heading', attrs: { level: Math.min(Number(level), 4) }, ...(inline.length ? { content: inline } : {}) }
    : paragraph(inline)
  if (children.length) ctx.warnings.add('indented blocks flattened to the parent level')
  return [head, ...children]
}

function convertTable(block: CapBlock, ctx: BlockContext): DocNode {
  const columns = (block.blocks as (CapBlock & { blocks?: CapBlock[]; width?: number })[] | undefined) ?? []
  const rowCount = Math.max(0, ...columns.map((c) => c.blocks?.length ?? 0))
  const rows: DocNode[] = []
  for (let r = 0; r < rowCount; r++) {
    rows.push({
      type: 'tableRow',
      content: columns.map((column) => {
        const cell = column.blocks?.[r]
        return {
          type: 'tableCell',
          attrs: column.width ? { colwidth: [column.width] } : {},
          content: nonEmpty(cell ? convertBlocks([cell], ctx) : []),
        }
      }),
    })
  }
  return rows.length ? { type: 'table', content: rows } : { type: 'paragraph' }
}

function convertGrid(block: CapBlock, ctx: BlockContext): DocNode {
  const columns = (block.columns as CapBlock[][] | undefined) ?? []
  // Dividers are the column boundaries, in percent of the total width.
  const dividers = ((block.dividers as number[] | undefined) ?? []).filter((d) => typeof d === 'number')
  const bounds = [0, ...dividers, 100]
  return {
    type: 'columns',
    content: columns.map((blocks, i) => {
      const width = bounds.length === columns.length + 1 ? bounds[i + 1]! - bounds[i]! : undefined
      return { type: 'column', attrs: width ? { width } : {}, content: nonEmpty(convertBlocks(blocks, ctx)) }
    }),
  }
}

function convertBlock(block: CapBlock, ctx: BlockContext): DocNode[] {
  switch (block.type) {
    case 'TextBlock':
      return convertTextBlock(block as TextBlock, ctx)
    case 'EntityBlock': {
      const entity = block.entity as { id?: string; link?: { data?: { activeView?: { type?: string } } } } | undefined
      if (!entity?.id) break
      const view = entity.link?.data?.activeView?.type ?? 'inline'
      return [{ type: 'objectEmbed', attrs: { objectId: entity.id, display: ENTITY_VIEW_TO_DISPLAY[view] ?? 'inline' } }]
    }
    case 'HorizontalLineBlock':
      return [{ type: 'horizontalRule' }]
    case 'GroupBlock': {
      const color = toColor(block.colorTheme)
      return [{ type: 'group', attrs: color ? { color } : {}, content: nonEmpty(convertBlocks((block.blocks as CapBlock[]) ?? [], ctx)) }]
    }
    case 'GridBlock':
      return [convertGrid(block, ctx)]
    case 'SimpleTableBlock':
      return [convertTable(block, ctx)]
    case 'CodeBlock': {
      const text = typeof block.code === 'string' ? block.code : convertTokens(block.tokens as Token[], ctx).map((n) => n.text ?? '').join('')
      const language = typeof block.language === 'string' ? block.language : null
      return [{ type: 'codeBlock', attrs: { language }, ...(text ? { content: [{ type: 'text', text }] } : {}) }]
    }
  }
  ctx.warnings.add(`block "${block.type}" kept as unsupported`)
  return [{ type: 'unsupported', attrs: { source: block.type, raw: block } }]
}

export function convertBlocks(blocks: CapBlock[], ctx: BlockContext): DocNode[] {
  const out: DocNode[] = []
  let list: DocNode | undefined
  for (const block of blocks) {
    const kind = listKindOf(block)
    if (kind) {
      if (!list || list.type !== kind) {
        list = { type: kind, content: [] }
        out.push(list)
      }
      list.content!.push(convertListItem(block as TextBlock, kind, ctx))
      continue
    }
    list = undefined
    out.push(...convertBlock(block, ctx))
  }
  return out
}

export function blocksToDoc(blocks: CapBlock[], ctx: BlockContext): Doc {
  return { type: 'doc', content: nonEmpty(convertBlocks(blocks, ctx)) }
}
