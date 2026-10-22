// Blocks of an object's text that can be mentioned or embedded elsewhere (`@Dune#…`, an embed of
// one block): the list to choose from, with a line of each one's text; finding one by its id; and
// giving one an id when it has none yet (the editor gives ids to blocks as they are edited).
import { nodeText } from './doc.ts'
import type { Doc, DocNode, Id, ObjectRecord } from './model.ts'

export interface BlockInfo {
  /** The rich-text field it is in ("body"…). */
  field: Id
  /** Child indexes from the field's document down to the block. */
  path: number[]
  /** Absent until the block is edited (or picked: see setBlockId). */
  id?: string
  type: string
  /** A heading's level. */
  level?: number
  /** The block's text on one line, shortened. */
  text: string
}

const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'codeBlock'])
const ITEMS = new Set(['listItem', 'taskItem'])
const EXCERPT = 120

const excerpt = (text: string) => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > EXCERPT ? `${line.slice(0, EXCERPT - 1)}…` : line
}

/**
 * The blocks one can point to, in reading order: paragraphs, headings and code with text, and list
 * items (named by their first line, so their first paragraph is not listed again). Containers
 * (quotes, callouts, toggles, columns, tables) are not listed; their blocks are.
 */
export function listBlocks(object: Pick<ObjectRecord, 'content'>): BlockInfo[] {
  const blocks: BlockInfo[] = []
  for (const [field, doc] of Object.entries(object.content)) {
    const walk = (nodes: DocNode[] | undefined, path: number[], skipFirst: boolean) => {
      ;(nodes ?? []).forEach((node, index) => {
        if (skipFirst && index === 0) return
        const at = [...path, index]
        const add = (text: string) => {
          if (!text.trim()) return
          const id = typeof node.attrs?.id === 'string' ? node.attrs.id : undefined
          const level = node.type === 'heading' && typeof node.attrs?.level === 'number' ? node.attrs.level : undefined
          blocks.push({ field, path: at, ...(id ? { id } : {}), type: node.type, ...(level ? { level } : {}), text: excerpt(text) })
        }
        if (TEXT_BLOCKS.has(node.type)) add(nodeText(node))
        else if (ITEMS.has(node.type)) {
          add(node.content?.[0] ? nodeText(node.content[0]) : '')
          walk(node.content, at, true)
        } else if (node.type !== 'objectEmbed') walk(node.content, at, false)
      })
    }
    walk(doc.content, [], false)
  }
  return blocks
}

/** The block with this id, and the field it is in. */
export function findBlock(object: Pick<ObjectRecord, 'content'>, blockId: string): { field: Id; node: DocNode } | undefined {
  for (const [field, doc] of Object.entries(object.content)) {
    const found = findIn(doc.content, blockId)
    if (found) return { field, node: found }
  }
  return undefined
}

function findIn(nodes: DocNode[] | undefined, blockId: string): DocNode | undefined {
  for (const node of nodes ?? []) {
    if (node.attrs?.id === blockId) return node
    const inner = findIn(node.content, blockId)
    if (inner) return inner
  }
  return undefined
}

/** Every block id an object's text uses. */
export function blockIds(object: Pick<ObjectRecord, 'content'>): Set<string> {
  const ids = new Set<string>()
  const walk = (nodes: DocNode[] | undefined) => {
    for (const node of nodes ?? []) {
      if (typeof node.attrs?.id === 'string') ids.add(node.attrs.id)
      walk(node.content)
    }
  }
  for (const doc of Object.values(object.content)) walk(doc.content)
  return ids
}

/** The node at a path, if there is one. */
export function nodeAt(doc: Doc, path: number[]): DocNode | undefined {
  let nodes: DocNode[] | undefined = doc.content
  let node: DocNode | undefined
  for (const index of path) {
    node = nodes?.[index]
    if (!node) return undefined
    nodes = node.content
  }
  return node
}

/** A copy of the document with `id` on the block at `path`. */
export function setBlockId(doc: Doc, path: number[], id: string): Doc {
  const set = (nodes: DocNode[], [index, ...rest]: number[]): DocNode[] =>
    nodes.map((node, i) => {
      if (i !== index) return node
      if (!rest.length) return { ...node, attrs: { ...node.attrs, id } }
      return { ...node, content: set(node.content ?? [], rest) }
    })
  return { ...doc, content: set(doc.content, path) }
}

/** What an embed of one block shows: the block as a document (a list item inside its list). */
export function blockAsDoc(node: DocNode): Doc {
  if (node.type === 'listItem') return { type: 'doc', content: [{ type: 'bulletList', content: [node] }] }
  if (node.type === 'taskItem') return { type: 'doc', content: [{ type: 'taskList', content: [node] }] }
  return { type: 'doc', content: [node] }
}
