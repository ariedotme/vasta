// Toggles made the way Capacities makes them, after the line is written:
//   /Toggle, Turn into › Toggle   the line (or the first selected line) becomes the toggle's title,
//                                 the other selected lines its content
//   Tab                           nests the block (or the selected blocks) under the one above: into
//                                 it when it is a toggle, else that line becomes a toggle holding them
//   ⇧Tab                          takes a toggle's block (and the ones after it) back out, below the
//                                 toggle; a toggle left empty is a plain line again
//   Enter at the end of an open toggle's title   goes to its first line when that one is empty
// Lists and tables keep their own Tab; code blocks too. Elsewhere Tab stays in the editor.
import { Extension, type Editor } from '@tiptap/core'
import { Fragment, type Node as PMNode, type ResolvedPos } from '@tiptap/pm/model'
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'

/** Nodes whose children are blocks Tab can move. */
const CONTAINERS = new Set(['doc', 'callout', 'group', 'column', 'detailsContent', 'blockquote', 'templateBranch'])
/** Inside these, Tab is theirs. */
const OWN_TAB = new Set(['listItem', 'taskItem', 'tableCell', 'tableHeader', 'codeBlock'])
/** Lines that can become a toggle's title. */
const LINES = new Set(['paragraph', 'heading'])
/** What a line keeps when it becomes a toggle (the toggle has the same block attributes). */
const KEPT = ['id', 'textColor', 'background']

interface Blocks {
  /** The container's depth in the resolved position, its start, and the block indexes taken. */
  depth: number
  container: PMNode
  from: number
  to: number
  /** Where the first block starts and the last one ends. */
  start: number
  end: number
}

/** The depth of the block around `$pos` that sits right in a container, or -1 where Tab is not ours. */
function blockDepth($pos: ResolvedPos): number {
  for (let d = $pos.depth; d > 0; d--) {
    if (OWN_TAB.has($pos.node(d).type.name)) return -1
    if (CONTAINERS.has($pos.node(d - 1).type.name)) return d
  }
  return -1
}

/** The sibling blocks the selection covers, in one container. */
function selectedBlocks(state: EditorState): Blocks | undefined {
  const { $from, $to } = state.selection
  const d = blockDepth($from)
  if (d < 0) return undefined
  const container = $from.node(d - 1)
  const from = $from.index(d - 1)
  // The selection's end counts when it is in a later block of the same container.
  let to = from
  const e = blockDepth($to)
  if (e === d && $to.node(d - 1) === container && $to.before(d) >= $from.before(d)) to = $to.index(d - 1)
  const start = $from.before(d)
  let end = start
  for (let i = from; i <= to; i++) end += container.child(i).nodeSize
  return { depth: d - 1, container, from, to, start, end }
}

const kept = (node: PMNode) => Object.fromEntries(KEPT.filter((k) => k in node.attrs && node.attrs[k] != null).map((k) => [k, node.attrs[k]]))

/** A toggle titled with a line's text, holding `content`; closed until openToggle opens it. */
function toggleOf(state: EditorState, line: PMNode, content: Fragment): PMNode {
  const { details, detailsSummary, detailsContent, paragraph } = state.schema.nodes
  const body = content.childCount ? content : Fragment.from(paragraph!.create())
  return details!.create({ ...kept(line), open: false }, [detailsSummary!.create(null, line.content), detailsContent!.create(null, body)])
}

/**
 * Open the toggle at `pos` in a transaction of its own. A toggle made open runs a timer that flips
 * its content's visibility, and an update in between (its block id) flips it first, so the content
 * ends up hidden while the toggle says open; opening it afterwards sets the visibility outright.
 */
function openToggle(editor: Editor, pos: number) {
  const node = editor.state.doc.nodeAt(pos)
  if (node?.type.name === 'details' && !node.attrs.open) editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, open: true }))
}

/** Keep the selection on the same text after the blocks moved from `oldStart` to `newStart`. */
function follow(tr: Transaction, state: EditorState, oldStart: number, newStart: number) {
  const { from, to } = state.selection
  const map = (pos: number) => Math.min(tr.doc.content.size, Math.max(0, newStart + (pos - oldStart)))
  tr.setSelection(TextSelection.between(tr.doc.resolve(map(from)), tr.doc.resolve(map(to))))
}

/** Turn the line at the cursor into a toggle titled with it; more selected blocks go inside. */
export function toggleFromLine(editor: Editor): boolean {
  const state = editor.state
  const blocks = selectedBlocks(state)
  const first = blocks?.container.child(blocks.from)
  if (!blocks || !first || !LINES.has(first.type.name)) return editor.chain().setDetails().run()
  const rest: PMNode[] = []
  for (let i = blocks.from + 1; i <= blocks.to; i++) rest.push(blocks.container.child(i))
  const toggle = toggleOf(state, first, Fragment.from(rest))
  const tr = state.tr.replaceWith(blocks.start, blocks.end, toggle)
  // The cursor stays where it was in the title (details › summary: two steps in).
  const offset = Math.min(state.selection.$from.parentOffset, first.content.size)
  tr.setSelection(TextSelection.create(tr.doc, blocks.start + 2 + offset))
  editor.view.dispatch(tr.scrollIntoView())
  openToggle(editor, blocks.start)
  return true
}

/** Tab: nest the blocks under the one above them. */
function indent(editor: Editor): boolean {
  const state = editor.state
  const blocks = selectedBlocks(state)
  if (!blocks) return false
  // Nothing above to go under: Tab still stays in the editor.
  if (blocks.from === 0) return true
  const above = blocks.container.child(blocks.from - 1)
  const slice = state.doc.slice(blocks.start, blocks.end).content
  const aboveStart = blocks.start - above.nodeSize
  const tr = state.tr
  if (above.type.name === 'details') {
    // At the end of its content, opened so the blocks stay in sight.
    const at = aboveStart + above.nodeSize - 2
    tr.delete(blocks.start, blocks.end)
    tr.insert(at, slice)
    follow(tr, state, blocks.start, at)
  } else if (LINES.has(above.type.name)) {
    const toggle = toggleOf(state, above, slice)
    tr.replaceWith(aboveStart, blocks.end, toggle)
    // details › summary › text, then the summary's end and the content's start.
    follow(tr, state, blocks.start, aboveStart + 1 + toggle.child(0).nodeSize + 1)
  } else return true
  editor.view.dispatch(tr.scrollIntoView())
  openToggle(editor, aboveStart)
  return true
}

/** ⇧Tab: take the blocks (and the ones after them) out of the toggle they are in. */
function outdent(editor: Editor): boolean {
  const state = editor.state
  const blocks = selectedBlocks(state)
  if (!blocks || blocks.container.type.name !== 'detailsContent') return false
  const $from = state.selection.$from
  const contentDepth = blocks.depth
  const toggle = $from.node(contentDepth - 1)
  const toggleStart = $from.before(contentDepth - 1)
  const toggleEnd = toggleStart + toggle.nodeSize
  const contentEnd = $from.end(contentDepth)
  const leaving = state.doc.slice(blocks.start, contentEnd).content
  const staying = blocks.container.content.cut(0, blocks.start - $from.start(contentDepth))
  const tr = state.tr
  if (staying.childCount) {
    // The toggle keeps the blocks before them; these go right below it.
    tr.insert(toggleEnd, leaving)
    tr.delete(blocks.start, contentEnd)
    follow(tr, state, blocks.start, toggleEnd - leaving.size)
  } else {
    // Nothing left inside: the toggle is its title again, a plain line, with them below.
    const line = state.schema.nodes.paragraph!.create(kept(toggle), toggle.child(0).content)
    tr.replaceWith(toggleStart, toggleEnd, Fragment.from(line).append(leaving))
    follow(tr, state, blocks.start, toggleStart + line.nodeSize)
  }
  editor.view.dispatch(tr.scrollIntoView())
  return true
}

/** Enter at the end of an open toggle's title: into its first line when it is empty (a new toggle's). */
function enterContent(editor: Editor): boolean {
  const { selection, doc } = editor.state
  const { $head } = selection
  if (!selection.empty || $head.parent.type.name !== 'detailsSummary' || $head.parentOffset !== $head.parent.content.size) return false
  const toggle = $head.node(-1)
  const first = toggle.childCount > 1 ? toggle.child(1).firstChild : null
  if (!toggle.attrs.open || !first || first.type.name !== 'paragraph' || first.content.size) return false
  // The summary's end, the content's start, then the paragraph's.
  const inside = $head.after() + 2
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(doc, inside)).scrollIntoView())
  return true
}

export const Toggles = Extension.create({
  name: 'vastaToggles',
  // Ahead of the toggle's own Enter; lists and tables are left their Tab (see blockDepth).
  priority: 110,

  addKeyboardShortcuts() {
    return {
      Enter: () => enterContent(this.editor),
      Tab: () => indent(this.editor),
      'Shift-Tab': () => outdent(this.editor) || blockDepth(this.editor.state.selection.$from) >= 0,
    }
  },
})
