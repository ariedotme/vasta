// The shared block attributes (@vasta/editor-schema's BlockAttributes) in the editor:
// - ids: every block gets one, so it can be linked to (`/o/<object>#b-<id>`). Old documents get
//   theirs on their first edit here, or when a link is copied. Local edits only: a change that came
//   from another device (or Yjs undo) is left alone, that device gave its blocks ids already.
//   A duplicated block gets a new id; pasted blocks keep theirs unless the document has them already
//   (copy and paste makes new blocks, cut and paste moves them).
// - colors: the palette's classes on blocks with a text color or background. Callouts paint their
//   own (CalloutView), since Vue re-renders their element's classes.
import { Extension } from '@tiptap/core'
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import { blockIdFixes } from '@vasta/editor-schema'
import type { ColorName } from '@vasta/core'
import { blockBackgroundClasses, blockTextClasses } from '../lib/colors.ts'

const OWN_COLORS = new Set(['callout'])

/** Classes for a block's text color and background. */
export function blockColorClasses(attrs: Record<string, unknown>): string {
  const text = attrs.textColor as ColorName | null
  const background = attrs.background as ColorName | null
  return [text && blockTextClasses[text], background && `vasta-bg ${blockBackgroundClasses[background]}`].filter(Boolean).join(' ')
}

function colorDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.attrs.textColor && !node.attrs.background) return
    if (OWN_COLORS.has(node.type.name)) return
    const classes = blockColorClasses(node.attrs)
    if (classes) decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: classes }))
  })
  return DecorationSet.create(doc, decorations)
}

const fromElsewhere = (tr: Transaction) => !!tr.getMeta(ySyncPluginKey)?.isChangeOrigin

/**
 * The details extension's toggle sets `open` with setNodeMarkup, which drops every other attribute
 * (id, colors, icon). Put them back.
 */
function keepDetailsAttrs(transactions: readonly Transaction[], before: EditorState, tr: Transaction) {
  const details = before.schema.nodes.details
  if (!details) return
  const defaults = details.create().attrs
  before.doc.descendants((old, pos) => {
    if (old.type !== details) return
    let mapped = pos
    for (const t of transactions) mapped = t.mapping.map(mapped)
    const now = tr.doc.nodeAt(mapped)
    if (now?.type !== details || now.attrs.open === old.attrs.open) return
    const lost = Object.entries(defaults).every(([name, value]) => name === 'open' || now.attrs[name] === value)
    if (lost) tr.setNodeMarkup(mapped, undefined, { ...old.attrs, open: now.attrs.open })
  })
}

/** Give every block of the document an id (see blockIdFixes). */
export function fixBlockIds(tr: Transaction): Transaction {
  for (const { pos, id } of blockIdFixes(tr.doc)) tr.setNodeAttribute(pos, 'id', id)
  return tr
}

/** Pasted blocks whose ids the document has already are copies: they get new ones. */
function withoutTakenIds(slice: Slice, doc: PMNode): Slice {
  const taken = new Set<string>()
  doc.descendants((node) => {
    if (node.attrs.id) taken.add(node.attrs.id as string)
  })
  const strip = (fragment: Fragment): Fragment => {
    const nodes: PMNode[] = []
    fragment.forEach((node) => {
      const id = node.attrs.id as string | null | undefined
      const attrs = id && taken.has(id) ? { ...node.attrs, id: null } : node.attrs
      nodes.push(node.isText ? node : node.type.create(attrs, strip(node.content), node.marks))
    })
    return Fragment.from(nodes)
  }
  return new Slice(strip(slice.content), slice.openStart, slice.openEnd)
}

const key = new PluginKey<DecorationSet>('vastaBlockAttributes')
const flashKey = new PluginKey<string | null>('vastaBlockFlash')

/**
 * Flash a block (a link to it was opened). A decoration found by the block's id, so it survives the
 * block being redrawn and y-sync replacing the document.
 */
export function flashBlock(view: EditorView, id: string) {
  view.dispatch(view.state.tr.setMeta(flashKey, id))
  setTimeout(() => {
    if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(flashKey, null))
  }, 1600)
}

function flashDecoration(state: EditorState): DecorationSet | null {
  const id = flashKey.getState(state)
  if (!id) return null
  let found: Decoration | undefined
  state.doc.descendants((node, pos) => {
    if (found) return false
    if (node.attrs.id === id) found = Decoration.node(pos, pos + node.nodeSize, { class: 'vasta-flash' })
  })
  return found ? DecorationSet.create(state.doc, [found]) : null
}

export const BlockAttributesView = Extension.create({
  name: 'vastaBlockAttributesView',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => colorDecorations(state.doc),
          apply: (tr, set) => (tr.docChanged ? colorDecorations(tr.doc) : set),
        },
        appendTransaction: (transactions, before, state) => {
          if (!transactions.some((tr) => tr.docChanged) || transactions.some(fromElsewhere)) return null
          const tr = state.tr
          keepDetailsAttrs(transactions, before, tr)
          fixBlockIds(tr)
          return tr.docChanged ? tr.setMeta('addToHistory', false) : null
        },
        props: {
          decorations: (state) => key.getState(state),
          // A block dragged within the document (view.dragging.move) moves, so it keeps its id.
          transformPasted: (slice, view) => (view.dragging?.move ? slice : withoutTakenIds(slice, view.state.doc)),
        },
      }),
      new Plugin<string | null>({
        key: flashKey,
        state: {
          init: () => null,
          apply: (tr, id) => {
            const meta = tr.getMeta(flashKey) as string | null | undefined
            return meta === undefined ? id : meta
          },
        },
        props: { decorations: flashDecoration },
      }),
    ]
  },
})
