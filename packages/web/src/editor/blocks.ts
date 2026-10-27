// Block selection and the block handle.
//   Esc            selects the block around the cursor; again, the block around that one
//   ⋮⋮ handle      shown in the gutter next to the hovered line: click selects that line's block and opens the block menu
//                  (⇧-click extends the selection), dragging moves it. On touch screens (no hover) it stays next to the
//                  line with the cursor instead: a tap opens the menu, dragging it with the finger moves the block
// With blocks selected:
//   ↑ ↓            select the previous / next block         ⇧↑ ⇧↓  extend the selection
//   ⌘⇧↑ ⌘⇧↓        move the blocks (also works while typing)  ⌘D     duplicate
//   ⌫              delete                                    ⌘C ⌘X  copy, cut
//   Enter          back to typing at the end of the selection  right-click  block menu
// A "block" is a child of the document or of a container (callout, group, column, toggle content,
// quote, list), so a list item or a paragraph inside a callout can be selected on its own.
import { Extension, type Editor } from '@tiptap/core'
import { Fragment, Slice, type Node as PMNode, type ResolvedPos } from '@tiptap/pm/model'
import { NodeSelection, Plugin, PluginKey, Selection, SelectionRange, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import type { Mappable } from '@tiptap/pm/transform'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { embedFor } from '../lib/embeds.ts'
import { imageOf } from '../lib/media.ts'
import type { ColorName } from '@vasta/core'
import { openMenuAt, type MenuItem } from '../lib/overlays.ts'
import { cachedSummary, lastError, notice, typesById } from '../lib/state.ts'
import { saveAsSnippet } from '../lib/templates.ts'
import type { DocNode } from '@vasta/core'
import { fixBlockIds } from './block-attributes.ts'
import { slashCommands } from './commands.ts'

/** Nodes whose children are blocks that can be selected and moved one by one. */
const CONTAINERS = new Set(['doc', 'callout', 'group', 'column', 'detailsContent', 'blockquote', 'bulletList', 'orderedList', 'taskList'])
/** The handle picks their items, never the whole list (Esc still reaches the list). */
const LISTS = new Set(['bulletList', 'orderedList', 'taskList'])

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = isMac ? '⌘' : 'Ctrl+'

/**
 * One or more sibling blocks, selected as a whole. `anchor` and `head` sit between blocks of the
 * same container: the anchor block stays selected while ⇧↑/⇧↓ move the head.
 */
export class BlockSelection extends Selection {
  constructor($anchor: ResolvedPos, $head: ResolvedPos) {
    const [$from, $to] = $anchor.pos <= $head.pos ? [$anchor, $head] : [$head, $anchor]
    super($anchor, $head, [new SelectionRange($from, $to)])
  }

  /** The selected blocks, closed, so they can be pasted or dropped anywhere. */
  override content(): Slice {
    return new Slice(this.$from.parent.content.cut(this.$from.parentOffset, this.$to.parentOffset), 0, 0)
  }

  override map(doc: PMNode, mapping: Mappable): Selection {
    const $anchor = doc.resolve(mapping.map(this.anchor))
    const $head = doc.resolve(mapping.map(this.head))
    if ($anchor.pos !== $head.pos && $anchor.sameParent($head) && CONTAINERS.has($anchor.parent.type.name)) return new BlockSelection($anchor, $head)
    return Selection.near($anchor)
  }

  override eq(other: Selection): boolean {
    return other instanceof BlockSelection && other.anchor === this.anchor && other.head === this.head
  }

  override toJSON() {
    return { type: 'vastaBlocks', anchor: this.anchor, head: this.head }
  }

  static override fromJSON(doc: PMNode, json: { anchor: number; head: number }) {
    return new BlockSelection(doc.resolve(json.anchor), doc.resolve(json.head))
  }

  get blocks(): PMNode[] {
    const nodes: PMNode[] = []
    this.$from.parent.forEach((node, offset) => {
      if (offset >= this.$from.parentOffset && offset < this.$to.parentOffset) nodes.push(node)
    })
    return nodes
  }
}
BlockSelection.prototype.visible = false
Selection.jsonID('vastaBlocks', BlockSelection)

interface Block {
  pos: number
  node: PMNode
}

const blockSelection = (doc: PMNode, block: Block) => new BlockSelection(doc.resolve(block.pos), doc.resolve(block.pos + block.node.nodeSize))

/** The innermost block containing `$pos`, looking no deeper than `maxDepth`. */
function blockAround($pos: ResolvedPos, maxDepth = $pos.depth): Block | undefined {
  for (let depth = maxDepth; depth >= 1; depth--) {
    if (CONTAINERS.has($pos.node(depth - 1).type.name)) return { pos: $pos.before(depth), node: $pos.node(depth) }
  }
  return undefined
}

/** The block the current (text or node) selection is in. */
function currentBlock(state: EditorState): Block | undefined {
  const { selection } = state
  if (selection instanceof NodeSelection && CONTAINERS.has(selection.$from.parent.type.name)) return { pos: selection.from, node: selection.node }
  return blockAround(selection.$from)
}

/** Select the block around the cursor, or the block around the selected blocks. */
function selectOutward(view: EditorView): boolean {
  const { state } = view
  const { selection } = state
  let block: Block | undefined
  if (selection instanceof BlockSelection) {
    // The container is itself a block when its own parent is a container (a callout, a list…).
    const $from = selection.$from
    block = $from.depth > 0 ? blockAround($from, $from.depth) : undefined
    if (!block) {
      view.dispatch(state.tr.setSelection(Selection.near($from)))
      ;(view.dom as HTMLElement).blur()
      return true
    }
  } else {
    block = currentBlock(state)
  }
  if (!block) return false
  view.dispatch(state.tr.setSelection(blockSelection(state.doc, block)).scrollIntoView())
  return true
}

/** Select the sibling before (-1) or after (1) the selection. */
function selectSibling(view: EditorView, selection: BlockSelection, direction: -1 | 1) {
  const sibling = direction < 0 ? selection.$from.nodeBefore : selection.$to.nodeAfter
  if (!sibling) return
  const pos = direction < 0 ? selection.from - sibling.nodeSize : selection.to
  view.dispatch(view.state.tr.setSelection(blockSelection(view.state.doc, { pos, node: sibling })).scrollIntoView())
}

/** ⇧↑/⇧↓: grow or shrink the selection at its head. */
function extend(view: EditorView, selection: BlockSelection, direction: -1 | 1) {
  const { doc } = view.state
  const forward = selection.head > selection.anchor
  let anchor = selection.anchor
  let head = selection.head
  if (forward === direction > 0) {
    // Growing away from the anchor.
    const next = direction > 0 ? selection.$head.nodeAfter : selection.$head.nodeBefore
    if (!next) return
    head += direction * next.nodeSize
  } else if (selection.blocks.length > 1) {
    // Shrinking back towards the anchor.
    const last = direction > 0 ? selection.$head.nodeAfter : selection.$head.nodeBefore
    head += direction * last!.nodeSize
  } else {
    // A single block: keep it and grow on the other side.
    const next = direction > 0 ? selection.$to.nodeAfter : selection.$from.nodeBefore
    if (!next) return
    anchor = direction > 0 ? selection.from : selection.to
    head = direction > 0 ? selection.to + next.nodeSize : selection.from - next.nodeSize
  }
  view.dispatch(view.state.tr.setSelection(new BlockSelection(doc.resolve(anchor), doc.resolve(head))).scrollIntoView())
}

/** Swap the range [from, to) with its neighbour; returns the transaction and the range's new start. */
function moveRange(state: EditorState, from: number, to: number, direction: -1 | 1): { tr: Transaction; start: number } | undefined {
  const $from = state.doc.resolve(from)
  const $to = state.doc.resolve(to)
  const neighbour = direction < 0 ? $from.nodeBefore : $to.nodeAfter
  if (!neighbour) return undefined
  const moved = $from.parent.content.cut($from.parentOffset, $to.parentOffset)
  const tr = state.tr
  if (direction < 0) {
    tr.replaceWith(from - neighbour.nodeSize, to, moved.append(Fragment.from(neighbour)))
    return { tr, start: from - neighbour.nodeSize }
  }
  tr.replaceWith(from, to + neighbour.nodeSize, Fragment.from(neighbour).append(moved))
  return { tr, start: from + neighbour.nodeSize }
}

/** ⌘⇧↑/⌘⇧↓: move the selected blocks, or the block being typed in (keeping the cursor). */
function move(view: EditorView, direction: -1 | 1): boolean {
  const { state } = view
  const { selection } = state
  if (selection instanceof BlockSelection) {
    const result = moveRange(state, selection.from, selection.to, direction)
    if (!result) return true
    const { tr, start } = result
    const end = start + (selection.to - selection.from)
    const forward = selection.head > selection.anchor
    tr.setSelection(new BlockSelection(tr.doc.resolve(forward ? start : end), tr.doc.resolve(forward ? end : start)))
    view.dispatch(tr.scrollIntoView())
    return true
  }
  const block = currentBlock(state)
  if (!block) return false
  const result = moveRange(state, block.pos, block.pos + block.node.nodeSize, direction)
  if (!result) return true
  const { tr, start } = result
  const shift = start - block.pos
  tr.setSelection(selection instanceof NodeSelection ? NodeSelection.create(tr.doc, selection.from + shift) : TextSelection.create(tr.doc, selection.anchor + shift, selection.head + shift))
  view.dispatch(tr.scrollIntoView())
  return true
}

function duplicate(view: EditorView, selection: BlockSelection) {
  const copy = selection.content().content
  const tr = view.state.tr.insert(selection.to, copy)
  tr.setSelection(new BlockSelection(tr.doc.resolve(selection.to), tr.doc.resolve(selection.to + copy.size)))
  view.dispatch(tr.scrollIntoView())
}

function remove(view: EditorView, selection: BlockSelection) {
  const tr = view.state.tr.deleteRange(selection.from, selection.to)
  tr.setSelection(Selection.near(tr.doc.resolve(Math.min(selection.from, tr.doc.content.size))))
  view.dispatch(tr.scrollIntoView())
}

/** Back to typing, at the end of the last selected block. */
function edit(view: EditorView, selection: BlockSelection) {
  view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(selection.to), -1)).scrollIntoView())
}

async function copy(view: EditorView, selection: BlockSelection) {
  const { dom, text } = view.serializeForClipboard(selection.content())
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ 'text/html': new Blob([dom.innerHTML], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) }),
    ])
  } catch {
    await navigator.clipboard.writeText(text)
  }
}

/** The selected blocks with their positions. */
function selectedBlocks(selection: BlockSelection): Block[] {
  let pos = selection.from
  return selection.blocks.map((node) => {
    const block = { pos, node }
    pos += node.nodeSize
    return block
  })
}

/** "Color…": a text color and a background for the selected blocks (a group's background is its color). */
function colorMenu(view: EditorView, x: number, y: number) {
  const selection = view.state.selection
  if (!(selection instanceof BlockSelection)) return
  const blocks = selectedBlocks(selection).filter(({ node }) => 'textColor' in node.attrs)
  const attrOf = (node: PMNode, sample: 'text' | 'background') => (sample === 'text' ? 'textColor' : node.type.name === 'group' ? 'color' : 'background')
  const shared = (sample: 'text' | 'background') => {
    const values = new Set(blocks.map(({ node }) => (node.attrs[attrOf(node, sample)] ?? null) as ColorName | null))
    return values.size === 1 ? [...values][0] : undefined
  }
  const pick = (sample: 'text' | 'background') => (color: ColorName | null) => {
    const tr = view.state.tr
    for (const { pos, node } of blocks) tr.setNodeAttribute(pos, attrOf(node, sample), color)
    view.dispatch(tr)
    view.focus()
  }
  openMenuAt(x, y, [
    { kind: 'colors', label: 'Text', sample: 'text', current: shared('text'), pick: pick('text') },
    { kind: 'colors', label: 'Background', sample: 'background', current: shared('background'), pick: pick('background') },
  ])
}

/** "Copy link to block": <server>/o/<object>#b-<block> (vasta://… in the desktop app). Gives the block an id first if it has none. */
async function copyBlockLink(view: EditorView, objectId: string, pos: number) {
  const tr = fixBlockIds(view.state.tr)
  if (tr.docChanged) view.dispatch(tr)
  const id = view.state.doc.nodeAt(pos)?.attrs.id as string | undefined
  if (!id) return
  const path = `o/${objectId}#b-${id}`
  const desktop = '__TAURI_INTERNALS__' in window
  try {
    await navigator.clipboard.writeText(desktop ? `vasta://${path}` : `${location.origin}/${path}`)
    notice.value = { message: 'Link to the block copied' }
  } catch {
    lastError.value = 'Could not copy the link'
  }
}

const TURN_INTO = ['text', 'h1', 'h2', 'h3', 'bullet', 'numbered', 'todo', 'quote', 'callout', 'toggle', 'code']

/** The menu of the ⋮⋮ handle and of a right-click on selected blocks. */
function openBlockMenu(editor: Editor, x: number, y: number, objectId: string | undefined) {
  const view = editor.view
  const selection = view.state.selection
  if (!(selection instanceof BlockSelection)) return
  const textOnly = selection.blocks.every((node) => node.isTextblock)
  const count = selection.blocks.length
  const turnInto: MenuItem[] = [
    { kind: 'heading', label: 'Turn into' },
    ...slashCommands
      .filter((c) => TURN_INTO.includes(c.id))
      .map(
        (command): MenuItem => ({
          label: command.label,
          icon: command.icon,
          run: () => {
            const { from, to } = view.state.selection
            const text = TextSelection.between(view.state.doc.resolve(from), view.state.doc.resolve(to))
            view.dispatch(view.state.tr.setSelection(text))
            command.run(editor, { from: text.from, to: text.from })
          },
        })
      ),
  ]
  const items: MenuItem[] = []
  // A second menu in place of a submenu; it opens once this one has closed.
  if (textOnly) items.push({ label: 'Turn into…', icon: 'ph:arrows-clockwise', run: () => setTimeout(() => openMenuAt(x, y, turnInto)) }, { kind: 'separator' })
  const embed = count === 1 && selection.blocks[0]?.type.name === 'objectEmbed' ? selection.blocks[0] : undefined
  if (embed) items.push(...embedDisplays(view, selection.from, embed))
  const current = () => view.state.selection as BlockSelection
  const colorable = selection.blocks.some((node) => 'textColor' in node.attrs)
  const linkable = count === 1 && objectId && 'id' in selection.blocks[0]!.attrs
  if (colorable || linkable) {
    if (colorable) items.push({ label: 'Color…', icon: 'ph:palette', run: () => setTimeout(() => colorMenu(view, x, y)) })
    if (linkable) items.push({ label: 'Copy link to block', icon: 'ph:link', run: () => copyBlockLink(view, objectId, selection.from) })
    items.push({ kind: 'separator' })
  }
  items.push(
    { label: count > 1 ? `Duplicate ${count} blocks` : 'Duplicate', icon: 'ph:copy-simple', hint: `${MOD}D`, run: () => duplicate(view, current()) },
    { label: 'Move up', icon: 'ph:arrow-up', hint: `${MOD}⇧↑`, disabled: !selection.$from.nodeBefore, run: () => move(view, -1) },
    { label: 'Move down', icon: 'ph:arrow-down', hint: `${MOD}⇧↓`, disabled: !selection.$to.nodeAfter, run: () => move(view, 1) },
    { label: 'Copy', icon: 'ph:clipboard-text', hint: `${MOD}C`, run: () => copy(view, current()) },
    { label: 'Save as snippet…', icon: 'ph:brackets-curly', run: () => saveAsSnippet(current().blocks.map((node) => node.toJSON() as DocNode)) },
    { kind: 'separator' },
    { label: count > 1 ? `Delete ${count} blocks` : 'Delete', icon: 'ph:trash', danger: true, hint: '⌫', run: () => remove(view, current()) }
  )
  openMenuAt(x, y, items)
}

/** "Show as" entries for one embedded object: the displays that fit it, the current one checked. */
function embedDisplays(view: EditorView, pos: number, node: PMNode): MenuItem[] {
  const summary = cachedSummary(node.attrs.objectId as string)
  const type = typesById.value.get(summary?.typeId ?? '')
  // Queries always show their results.
  if (!summary || type?.system === 'query') return []
  const current = node.attrs.display as string
  const mimeType = summary.media?.mimeType ?? summary.media?.file?.mimeType ?? ''
  const isImage = (type?.system === 'image' || mimeType.startsWith('image/')) && !!imageOf(summary)
  const displays: { value: string; label: string; icon: string }[] = [
    { value: 'inline', label: 'Inline', icon: 'ph:text-align-left' },
    { value: 'card', label: 'Card', icon: 'ph:cards' },
    { value: 'wide-card', label: 'Wide card', icon: 'ph:rows' },
    ...(type?.system === 'weblink' && embedFor(summary.media?.url) ? [{ value: 'embed', label: 'Embed', icon: 'ph:play-circle' }] : []),
    ...(isImage ? [{ value: 'image', label: 'Image', icon: 'ph:image' }] : []),
  ]
  return [
    { kind: 'heading', label: 'Show as' },
    ...displays.map(
      (d): MenuItem => ({
        label: d.label,
        icon: d.value === current ? 'ph:check' : d.icon,
        run: () => {
          if (d.value !== current) view.dispatch(view.state.tr.setNodeAttribute(pos, 'display', d.value))
        },
      })
    ),
    { kind: 'separator' },
  ]
}

// ---------------------------------------------------------------------------
// The ⋮⋮ handle

/** Position of the first textblock or atom inside a node at `pos` (the node's first line). */
function firstLeaf(node: PMNode, pos: number): number {
  while (!node.isTextblock && !node.isAtom && node.firstChild) {
    node = node.firstChild
    pos += 1
  }
  return pos
}

/**
 * The block a line belongs to: the outermost block that starts on that line, so the first line of
 * a callout moves the callout and its later lines move what is inside. Lists are skipped in favour
 * of their items.
 */
function blockOnLine(doc: PMNode, leafPos: number): Block | undefined {
  const $leaf = doc.resolve(leafPos)
  for (let depth = 1; depth <= $leaf.depth; depth++) {
    const node = $leaf.node(depth)
    const pos = $leaf.before(depth)
    if (CONTAINERS.has($leaf.node(depth - 1).type.name) && !LISTS.has(node.type.name) && firstLeaf(node, pos) === leafPos) return { pos, node }
  }
  const leaf = doc.nodeAt(leafPos)
  return leaf && CONTAINERS.has($leaf.parent.type.name) ? { pos: leafPos, node: leaf } : undefined
}

const HANDLE_ICON =
  '<svg viewBox="0 0 10 16" width="10" height="16" fill="currentColor" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>'

class BlockHandle {
  private readonly handle: HTMLElement
  private readonly dropLine: HTMLElement
  private readonly wrapper: HTMLElement
  private block: Block | undefined
  /** A drag started from the handle is in progress. */
  private dragging = false
  /** No hover (a phone): the handle follows the cursor instead of the pointer. */
  private readonly touch = typeof matchMedia !== 'undefined' && matchMedia('(hover: none)').matches
  /** The handle is being tapped; the editor losing focus meanwhile must not hide it. */
  private pressing = false

  constructor(
    private readonly view: EditorView,
    private readonly editor: Editor,
    private readonly objectId: string | undefined
  ) {
    // The box marked data-block-gutter (DocEditor) includes the gutter the handle sits in, so the
    // pointer can go from a block to its handle without leaving it.
    this.wrapper = (view.dom.closest('[data-block-gutter]') ?? view.dom.parentElement) as HTMLElement
    // A div, not a button: buttons cannot be dragged in every browser.
    this.handle = document.createElement('div')
    this.handle.setAttribute('role', 'button')
    this.handle.className = 'vasta-block-handle'
    this.handle.title = 'Click to select, drag to move'
    this.handle.draggable = !this.touch
    this.handle.innerHTML = HANDLE_ICON
    this.handle.hidden = true
    this.wrapper.appendChild(this.handle)
    this.dropLine = document.createElement('div')
    this.dropLine.className = 'vasta-drop-line'
    this.dropLine.hidden = true
    this.wrapper.appendChild(this.dropLine)
    if (this.touch) {
      this.handle.title = 'Tap for the block menu, drag to move'
      this.handle.classList.add('vasta-block-handle-touch')
      this.handle.addEventListener('pointerdown', this.onPress)
      this.handle.addEventListener('pointermove', this.onTouchMove)
      this.handle.addEventListener('pointerup', this.onTouchEnd)
      this.handle.addEventListener('pointercancel', this.onTouchEnd)
      view.dom.addEventListener('blur', this.onBlur)
      view.dom.addEventListener('focus', this.onFocus)
    } else {
      this.wrapper.addEventListener('mousemove', this.onMouseMove)
      this.wrapper.addEventListener('mouseleave', this.hide)
      view.dom.addEventListener('keydown', this.hide)
    }
    // Capture phase: drops of dragged blocks are handled here, before ProseMirror sees them.
    this.wrapper.addEventListener('dragover', this.onDragOver, true)
    this.wrapper.addEventListener('drop', this.onDrop, true)
    this.handle.addEventListener('dragend', this.endDrag)
    this.handle.addEventListener('click', this.onClick)
    this.handle.addEventListener('dragstart', this.onDragStart)
  }

  update() {
    if (this.touch) return this.followCursor()
    // The hovered block may have moved or disappeared.
    if (this.block && this.block.pos + this.block.node.nodeSize > this.view.state.doc.content.size) this.hide()
  }

  destroy() {
    cancelAnimationFrame(this.scrollFrame)
    this.wrapper.removeEventListener('mousemove', this.onMouseMove)
    this.wrapper.removeEventListener('mouseleave', this.hide)
    this.view.dom.removeEventListener('keydown', this.hide)
    this.view.dom.removeEventListener('blur', this.onBlur)
    this.view.dom.removeEventListener('focus', this.onFocus)
    this.wrapper.removeEventListener('dragover', this.onDragOver, true)
    this.wrapper.removeEventListener('drop', this.onDrop, true)
    this.handle.remove()
    this.dropLine.remove()
  }

  private hide = () => {
    this.handle.hidden = true
    this.block = undefined
  }

  /** The block on the line at a point (see blockOnLine); in the gutter, the line the pointer is on. */
  private blockAtPoint(x: number, y: number): Block | undefined {
    const editorRect = this.view.dom.getBoundingClientRect()
    const found = this.view.posAtCoords({ left: Math.max(x, editorRect.left + 4), top: y })
    if (!found) return undefined
    const { doc } = this.view.state
    const inside = found.inside >= 0 ? doc.nodeAt(found.inside) : null
    if (inside?.isAtom && inside.isBlock) return blockOnLine(doc, found.inside)
    const $pos = doc.resolve(found.pos)
    if ($pos.parent.isTextblock) return blockOnLine(doc, $pos.before())
    return blockAround($pos)
  }

  /** Touch screens: the handle sits next to the line with the cursor, or the first selected block. */
  private followCursor() {
    if (this.touchDrag?.active) return
    const { state } = this.view
    const { selection } = state
    if (!this.editor.isEditable || (!this.view.hasFocus() && !this.pressing)) return this.hide()
    let block: Block | undefined
    if (selection instanceof BlockSelection) block = { pos: selection.from, node: selection.blocks[0]! }
    else if (selection.$from.parent.isTextblock) block = blockOnLine(state.doc, selection.$from.before())
    else block = currentBlock(state)
    if (block) this.show(block)
    else this.hide()
  }

  private onFocus = () => setTimeout(() => this.followCursor())

  private onBlur = () => {
    // Tapping the handle may blur the editor first; give the tap time to land.
    setTimeout(() => {
      if (!this.pressing && !this.touchDrag?.active && !this.view.hasFocus()) this.hide()
    }, 300)
  }

  private onMouseMove = (event: MouseEvent) => {
    // Stay put over the handle itself and while a button is down (about to drag, or selecting text).
    if (event.target === this.handle || this.handle.contains(event.target as Node) || event.buttons || this.dragging || !this.editor.isEditable) return
    const block = this.blockAtPoint(event.clientX, event.clientY)
    if (block) this.show(block)
    else this.hide()
  }

  private show(block: Block) {
    const dom = this.view.nodeDOM(block.pos)
    if (!(dom instanceof HTMLElement)) return this.hide()
    this.block = block
    const wrapperRect = this.wrapper.getBoundingClientRect()
    const rect = dom.getBoundingClientRect()
    // Line up with the first line of text, or the top of an embed.
    let top = rect.top + 2
    if (block.node.isTextblock || block.node.firstChild?.isTextblock) {
      const line = this.view.coordsAtPos(block.pos + (block.node.isTextblock ? 1 : 2))
      top = (line.top + line.bottom) / 2 - 11
    }
    // Always in the gutter, whatever the nesting, so it never covers content (a callout's icon…).
    this.handle.style.top = `${top - wrapperRect.top}px`
    // A narrow gutter (phones) keeps the handle on screen, against the edge.
    this.handle.style.left = `${Math.max(0, this.view.dom.getBoundingClientRect().left - wrapperRect.left - 26)}px`
    this.handle.hidden = false
  }

  private selectBlock(extend: boolean) {
    const block = this.block
    if (!block) return
    const { state } = this.view
    const { selection } = state
    let next: Selection = blockSelection(state.doc, block)
    const $block = state.doc.resolve(block.pos)
    if (extend && selection instanceof BlockSelection && $block.sameParent(selection.$from)) {
      // ⇧-click: from the anchor block to this one.
      const anchorFirst = block.pos >= selection.from
      const anchor = anchorFirst ? Math.min(selection.anchor, selection.head) : Math.max(selection.anchor, selection.head)
      next = new BlockSelection(state.doc.resolve(anchor), state.doc.resolve(anchorFirst ? block.pos + block.node.nodeSize : block.pos))
    } else if (selection instanceof BlockSelection && block.pos >= selection.from && block.pos < selection.to) {
      // Part of the selection already: keep the whole selection (to drag or open the menu for all).
      next = selection
    }
    this.view.focus()
    this.view.dispatch(state.tr.setSelection(next))
  }

  private onClick = (event: MouseEvent) => {
    if (this.swallowClick) return
    this.selectBlock(event.shiftKey)
    if (event.shiftKey) return
    const rect = this.handle.getBoundingClientRect()
    openBlockMenu(this.editor, rect.left, rect.bottom + 4, this.objectId)
  }

  private onDragStart = (event: DragEvent) => {
    if (!this.block || !event.dataTransfer) return
    this.selectBlock(false)
    const selection = this.view.state.selection
    if (!(selection instanceof BlockSelection)) return
    const slice = selection.content()
    const { dom, text } = this.view.serializeForClipboard(slice)
    event.dataTransfer.clearData()
    event.dataTransfer.setData('text/html', dom.innerHTML)
    event.dataTransfer.setData('text/plain', text)
    event.dataTransfer.effectAllowed = 'copyMove'
    const image = this.view.nodeDOM(selection.from)
    if (image instanceof HTMLElement) event.dataTransfer.setDragImage(image, 0, 0)
    this.dragging = true
    this.view.dragging = { slice, move: true }
  }

  /** Where a drop at this point goes: before the block under the pointer (top half) or after it. */
  /** Where a drop at this point goes: before the block under it (top half) or after it. */
  private dropPoint(point: { clientX: number; clientY: number }): { pos: number; rect: DOMRect; before: boolean } | undefined {
    // Above or below the text (the title, the backlinks): the first or last block.
    const editorRect = this.view.dom.getBoundingClientRect()
    const y = Math.min(Math.max(point.clientY, editorRect.top + 2), editorRect.bottom - 2)
    const block = this.blockAtPoint(point.clientX, y)
    const dom = block && this.view.nodeDOM(block.pos)
    if (!block || !(dom instanceof HTMLElement)) return undefined
    const rect = dom.getBoundingClientRect()
    const before = point.clientY < rect.top + rect.height / 2
    return { pos: before ? block.pos : block.pos + block.node.nodeSize, rect, before }
  }

  private showDropLine(point: { clientX: number; clientY: number }) {
    const target = this.dropPoint(point)
    if (!target) {
      this.dropLine.hidden = true
      return
    }
    const wrapperRect = this.wrapper.getBoundingClientRect()
    this.dropLine.style.top = `${(target.before ? target.rect.top : target.rect.bottom) - wrapperRect.top - 2}px`
    this.dropLine.style.left = `${target.rect.left - wrapperRect.left}px`
    this.dropLine.style.width = `${target.rect.width}px`
    this.dropLine.hidden = false
  }

  private onDragOver = (event: DragEvent) => {
    if (!this.dragging) return
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    this.showDropLine(event)
  }

  private onDrop = (event: DragEvent) => {
    if (!this.dragging) return
    event.preventDefault()
    event.stopPropagation()
    const target = this.dropPoint(event)
    this.endDrag()
    this.moveSelectionTo(target?.pos)
  }

  /** Move the selected blocks to `pos` (between blocks). */
  private moveSelectionTo(pos: number | undefined) {
    const { state } = this.view
    const selection = state.selection
    // Dropped next to or inside itself: nothing moves.
    if (pos === undefined || !(selection instanceof BlockSelection) || (pos >= selection.from && pos <= selection.to)) return
    try {
      const content = selection.content().content
      const tr = state.tr.delete(selection.from, selection.to)
      const at = tr.mapping.map(pos)
      tr.insert(at, content)
      // The content may have been wrapped to fit (a paragraph dropped into a list becomes an item).
      const end = tr.mapping.slice(tr.mapping.maps.length - 1).map(at, 1)
      const $at = tr.doc.resolve(at)
      const $end = tr.doc.resolve(end)
      tr.setSelection($at.sameParent($end) && CONTAINERS.has($at.parent.type.name) ? new BlockSelection($at, $end) : Selection.near($at))
      this.view.dispatch(tr.scrollIntoView())
      this.view.focus()
    } catch {
      // The blocks do not fit there; leave them where they were.
    }
  }

  // Touch dragging. HTML drag and drop does not start from a finger on iOS, so the handle follows
  // pointer events: a press that moves more than a few pixels drags the block (the handle and a
  // drop line follow the finger, the page scrolls near its edges); a press that stays put is a tap.

  private touchDrag: { id: number; startX: number; startY: number; x: number; y: number; active: boolean } | undefined
  private scrollFrame = 0
  /** A drag just ended: a click that may follow it (before the next press) must not open the menu. */
  private swallowClick = false

  private onPress = (event: PointerEvent) => {
    this.swallowClick = false
    this.pressing = true
    setTimeout(() => (this.pressing = false), 600)
    if (event.pointerType === 'mouse' || !this.block) return
    this.touchDrag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, active: false }
    // Keep getting the finger's moves when it leaves the handle.
    try {
      this.handle.setPointerCapture(event.pointerId)
    } catch {}
  }

  private onTouchMove = (event: PointerEvent) => {
    const drag = this.touchDrag
    if (!drag || event.pointerId !== drag.id) return
    drag.x = event.clientX
    drag.y = event.clientY
    if (!drag.active) {
      if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 8) return
      drag.active = true
      this.pressing = true
      this.selectBlock(false)
      this.handle.classList.add('vasta-block-handle-dragging')
      this.scrollFrame = requestAnimationFrame(this.autoScroll)
    }
    event.preventDefault()
    this.followFinger()
  }

  private followFinger() {
    const drag = this.touchDrag
    if (!drag) return
    const wrapperRect = this.wrapper.getBoundingClientRect()
    this.handle.style.top = `${drag.y - wrapperRect.top - 14}px`
    this.showDropLine({ clientX: drag.x, clientY: drag.y })
  }

  /** Near the top or bottom of the scrolling page, scroll it so the block can go further. */
  private autoScroll = () => {
    const drag = this.touchDrag
    if (!drag?.active) return
    const scroller = this.view.dom.closest('main') ?? document.scrollingElement
    if (scroller) {
      const rect = scroller.getBoundingClientRect()
      const edge = 64
      const speed = drag.y < rect.top + edge ? -(rect.top + edge - drag.y) / 4 : drag.y > rect.bottom - edge ? (drag.y - (rect.bottom - edge)) / 4 : 0
      if (speed) {
        scroller.scrollBy(0, speed)
        this.followFinger()
      }
    }
    this.scrollFrame = requestAnimationFrame(this.autoScroll)
  }

  private onTouchEnd = (event: PointerEvent) => {
    const drag = this.touchDrag
    if (!drag || event.pointerId !== drag.id) return
    this.touchDrag = undefined
    cancelAnimationFrame(this.scrollFrame)
    if (!drag.active) return
    this.handle.classList.remove('vasta-block-handle-dragging')
    this.dropLine.hidden = true
    this.swallowClick = true
    if (event.type === 'pointerup') this.moveSelectionTo(this.dropPoint({ clientX: drag.x, clientY: drag.y })?.pos)
    this.followCursor()
  }

  private endDrag = () => {
    this.dragging = false
    this.view.dragging = null
    this.dropLine.hidden = true
  }
}

// ---------------------------------------------------------------------------
// Extension

const key = new PluginKey('vastaBlocks')

/** Keys while blocks are selected. First in line, so list, table and toggle keys do not get them. */
export const Blocks = Extension.create<{ objectId: string | undefined }>({
  name: 'vastaBlocks',
  priority: 1000,
  addOptions: () => ({ objectId: undefined }),

  addKeyboardShortcuts() {
    const editor = this.editor
    const when = (run: (selection: BlockSelection) => unknown) => () => {
      const { selection } = editor.state
      if (!(selection instanceof BlockSelection)) return false
      run(selection)
      return true
    }
    return {
      Escape: when(() => selectOutward(editor.view)),
      'Mod-Shift-ArrowUp': when(() => move(editor.view, -1)),
      'Mod-Shift-ArrowDown': when(() => move(editor.view, 1)),
      ArrowUp: when((selection) => selectSibling(editor.view, selection, -1)),
      ArrowDown: when((selection) => selectSibling(editor.view, selection, 1)),
      'Shift-ArrowUp': when((selection) => extend(editor.view, selection, -1)),
      'Shift-ArrowDown': when((selection) => extend(editor.view, selection, 1)),
      Enter: when((selection) => edit(editor.view, selection)),
      Backspace: when((selection) => remove(editor.view, selection)),
      Delete: when((selection) => remove(editor.view, selection)),
      'Mod-d': when((selection) => duplicate(editor.view, selection)),
    }
  },

  addProseMirrorPlugins() {
    const editor = this.editor
    const objectId = this.options.objectId
    return [
      new Plugin({
        key,
        view: (view) => new BlockHandle(view, editor, objectId),
        props: {
          decorations: (state) => {
            const { selection } = state
            if (!(selection instanceof BlockSelection)) return null
            const decorations: Decoration[] = []
            let pos = selection.from
            for (const node of selection.blocks) {
              decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'vasta-block-selected' }))
              pos += node.nodeSize
            }
            return DecorationSet.create(state.doc, decorations)
          },
          attributes: (state): Record<string, string> => (state.selection instanceof BlockSelection ? { class: 'vasta-blocks-mode' } : {}),
          // Typing does not replace selected blocks; Enter goes back to typing first.
          handleKeyDown: (view, event) => view.state.selection instanceof BlockSelection && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey,
          handleTextInput: (view) => view.state.selection instanceof BlockSelection,
          handleDOMEvents: {
            contextmenu: (view, event) => {
              const { selection } = view.state
              if (!(selection instanceof BlockSelection)) return false
              const found = view.posAtCoords({ left: event.clientX, top: event.clientY })
              if (!found || found.pos < selection.from || found.pos > selection.to) return false
              event.preventDefault()
              openBlockMenu(editor, event.clientX, event.clientY, objectId)
              return true
            },
          },
        },
      }),
    ]
  },
})

/** Keys while typing. Last in line, so an open "/" or "@" menu handles Escape itself. */
export const BlockKeysWhileTyping = Extension.create({
  name: 'vastaBlockKeysWhileTyping',
  priority: 50,

  addKeyboardShortcuts() {
    const view = () => this.editor.view
    return {
      Escape: () => selectOutward(view()),
      'Mod-Shift-ArrowUp': () => move(view(), -1),
      'Mod-Shift-ArrowDown': () => move(view(), 1),
    }
  },
})
