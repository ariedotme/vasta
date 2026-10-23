// TipTap extensions of the editor: the shared schema (@vasta/editor-schema) with the app's node
// views, palette classes and plugins on top. Extending must not change the schema; a test checks.
import { Extension, mergeAttributes, type Editor, type Range } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import { DetailsContent, DetailsSummary } from '@tiptap/extension-details'
import { TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import Suggestion from '@tiptap/suggestion'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import {
  BlockAttributes,
  Callout,
  ColorHighlight,
  Column,
  Columns,
  Group,
  Mention,
  ObjectEmbed,
  TaskItemNested,
  Unsupported,
  VastaDetails,
  VastaStarterKit,
  VastaTableKit,
} from '@vasta/editor-schema'
import { listBlocks, type ColorName, type Id, type ObjectRecord, type ObjectSummary } from '@vasta/core'
import type * as Y from 'yjs'
import { groupClasses, highlightClasses } from '../lib/colors.ts'
import { api } from '../lib/api.ts'
import { bareUrl, embedFor } from '../lib/embeds.ts'
import { openMenuAt } from '../lib/overlays.ts'
import { lastError, primeFromObject, primeSummaries, refreshCounts, systemType, workspace } from '../lib/state.ts'
import { createObject } from '../lib/actions.ts'
import { BlockAttributesView } from './block-attributes.ts'
import { BlockKeysWhileTyping, Blocks } from './blocks.ts'
import CalloutView from './CalloutView.vue'
import { filterCommands, type SlashCommand, type SlashContext } from './commands.ts'
import MentionList, { type MentionItem } from './MentionList.vue'
import MentionView from './MentionView.vue'
import ObjectEmbedView from './ObjectEmbedView.vue'
import { Uploads } from './uploads.ts'
import SlashList from './SlashList.vue'
import { suggestionPopup } from './suggestion-popup.ts'
import { PlaceholderMenu, PlaceholderWithView, TemplateBranchWithView, TemplateIf } from './template-nodes.ts'

const CalloutWithView = Callout.extend({
  addNodeView: () => VueNodeViewRenderer(CalloutView),
})

const PaletteGroup = Group.extend({
  renderHTML: ({ node, HTMLAttributes }) => {
    const color = node.attrs.color as ColorName | null
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'group', 'data-color': color, class: `vasta-group ${groupClasses[color ?? 'gray']}` }), 0]
  },
})

const ObjectEmbedWithView = ObjectEmbed.extend({
  addNodeView: () => VueNodeViewRenderer(ObjectEmbedView),
})

const PaletteHighlight = ColorHighlight.extend({
  renderHTML({ mark, HTMLAttributes }) {
    const color = (mark.attrs.color ?? 'yellow') as ColorName
    const quote = mark.attrs.quoteId ? ' vasta-quote' : ''
    return ['mark', mergeAttributes(HTMLAttributes, { 'data-color': color, class: (highlightClasses[color] ?? highlightClasses.yellow) + quote }), 0]
  },
})

const MentionWithSuggestion = Mention.extend({
  addNodeView: () => VueNodeViewRenderer(MentionView),
  addProseMirrorPlugins() {
    return [
      Suggestion<MentionItem>({
        editor: this.editor,
        pluginKey: new PluginKey('mention-suggestion'),
        char: '@',
        allowSpaces: true,
        items: async ({ query }) => {
          if (!workspace.space) return []
          const text = query.replace(/^@/, '')
          // "Dune#chap": the blocks of Dune whose text has "chap".
          const hash = text.lastIndexOf('#')
          if (hash > 0) {
            const blocks = await blockItems(workspace.space.id, text.slice(0, hash).trim(), text.slice(hash + 1))
            if (blocks) return blocks
          }
          const found = await api.search(workspace.space.id, text, 8)
          primeSummaries(found)
          const items: MentionItem[] = found.map((object) => ({ kind: 'object', object }))
          if (text.trim()) items.push({ kind: 'create', title: text.trim() })
          return items
        },
        command: ({ editor, range, props }) => {
          const typed = editor.state.doc.textBetween(range.from, range.to)
          // Tab on an object (or choosing one of several with the same title): "@Title#", to choose
          // one of its blocks. That object, not another one with the same title.
          if (props.kind === 'drill') {
            chosen = props.object
            // In two steps, so the list asks again even when "@Title#" was typed already.
            editor.chain().focus().insertContentAt(range, `${typed.startsWith('@@') ? '@@' : '@'}${props.object.title}`).run()
            editor.chain().insertContent('#').run()
          } else void insertReference(editor, range, props, typed.startsWith('@@'))
        },
        render: () => {
          const popup = suggestionPopup<MentionItem>(MentionList)()
          // The choice holds for this "@…" only: the next one asks again.
          return { ...popup, onExit: () => ((chosen = undefined), popup.onExit()) }
        },
      }),
    ]
  },
})

/** The object chosen in the list for this "@Title#" (titles are not unique). */
let chosen: ObjectSummary | undefined
/** The latest object fetched for "@Title#…", so each keystroke after the # does not fetch it again. */
let blockSource: { at: number; object: ObjectRecord; summary: ObjectSummary } | undefined

/**
 * The blocks of the object "Title" names whose text has `text`: the one chosen in the list, else
 * the one with that title, else the first found. When several objects have that title (of other
 * types, say), they are offered first to choose from. Undefined when no object matches, so the
 * whole query is searched as a title instead ("C#").
 */
async function blockItems(spaceId: Id, query: string, text: string): Promise<MentionItem[] | undefined> {
  let target = chosen && fold(chosen.title) === fold(query) ? chosen : undefined
  if (!target) {
    const found = await api.search(spaceId, query, 30)
    const same = found.filter((o) => fold(o.title) === fold(query))
    if (same.length > 1) return same.map((object) => ({ kind: 'drill', object }))
    target = same[0] ?? found[0]
    if (!target) return undefined
  }
  if (!blockSource || blockSource.summary.id !== target.id || Date.now() - blockSource.at > 10_000) {
    blockSource = { at: Date.now(), object: await api.object(target.id), summary: target }
  }
  const { object, summary } = blockSource
  const wanted = fold(text)
  return listBlocks(object)
    .filter((block) => fold(block.text).includes(wanted))
    .slice(0, 30)
    .map((block) => ({ kind: 'block', object: summary, block }))
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()

/** A block's text for a mention's label: its first words. */
const blockLabel = (text: string) => (text.length > 60 ? `${text.slice(0, 59)}…` : text)

async function insertReference(editor: Editor, range: Range, item: MentionItem, asEmbed: boolean) {
  if (item.kind === 'drill') return
  if (item.kind === 'block') {
    let blockId = item.block.id
    try {
      blockId ??= await api.blockId(item.object.id, item.block.field, item.block.path)
    } catch (error) {
      lastError.value = (error as Error).message
      return
    }
    const node = asEmbed
      ? { type: 'objectEmbed', attrs: { objectId: item.object.id, display: 'block', blockId } }
      : { type: 'mention', attrs: { objectId: item.object.id, label: item.object.title, blockId, blockLabel: blockLabel(item.block.text) } }
    editor.chain().focus().deleteRange(range).insertContent(asEmbed ? [node] : [node, { type: 'text', text: ' ' }]).run()
    return
  }
  let id: Id
  let label: string
  if (item.kind === 'object') {
    id = item.object.id
    label = item.object.title
  } else {
    const page = systemType('page')
    if (!page) return
    const created = await createObject(page.id, { title: item.title }, false)
    id = created.id
    label = created.title
  }
  const node = asEmbed ? { type: 'objectEmbed', attrs: { objectId: id, display: 'card' } } : { type: 'mention', attrs: { objectId: id, label } }
  editor.chain().focus().deleteRange(range).insertContent(asEmbed ? [node] : [node, { type: 'text', text: ' ' }]).run()
}

const SlashMenu = Extension.create<SlashContext>({
  name: 'slashMenu',
  addOptions: () => ({}),
  addProseMirrorPlugins() {
    const context = this.options
    return [
      Suggestion<SlashCommand>({
        editor: this.editor,
        pluginKey: new PluginKey('slash-suggestion'),
        char: '/',
        startOfLine: false,
        items: ({ query }) => filterCommands(query, context),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: suggestionPopup<SlashCommand>(SlashList),
      }),
    ]
  },
})

/**
 * Pasting a bare URL inserts it as a link, then offers to turn it into a mention of a weblink
 * object or an embed of one (saved with its page's metadata, or the one saved before). Links to
 * the app itself are only links.
 */
const UrlPaste = Extension.create({
  name: 'urlPaste',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        key: new PluginKey('url-paste'),
        props: {
          handlePaste: (view, event) => {
            const url = bareUrl(event.clipboardData?.getData('text/plain') ?? '')
            const { selection, schema } = view.state
            // With text selected, the link extension turns the selection into a link.
            if (!url || !selection.empty || selection.$from.parent.type.spec.code || !schema.marks.link) return false
            const from = selection.from
            view.dispatch(view.state.tr.insert(from, schema.text(url, [schema.marks.link.create({ href: url })])))
            // A link to this app's own pages (a block, an object) stays a link.
            if (new URL(url).origin !== location.origin) offerWeblink(editor, url, from, from + url.length)
            return true
          },
        },
      }),
    ]
  },
})

function offerWeblink(editor: Editor, url: string, from: number, to: number) {
  const coords = editor.view.coordsAtPos(to)
  const embeddable = !!embedFor(url)
  const stillThere = () => to <= editor.state.doc.content.size && editor.state.doc.textBetween(from, to) === url
  const save = async () => {
    if (!workspace.space) return undefined
    try {
      const object = await api.saveWeblink(workspace.space.id, url)
      primeFromObject(object)
      void refreshCounts()
      return stillThere() ? object : undefined
    } catch (error) {
      lastError.value = (error as Error).message
      return undefined
    }
  }
  openMenuAt(coords.left, coords.bottom + 4, [
    { kind: 'heading', label: 'Paste as' },
    { label: 'Link', icon: 'ph:link', run: () => editor.commands.focus(to) },
    {
      label: 'Mention a weblink',
      icon: 'ph:at',
      run: async () => {
        const object = await save()
        if (!object) return
        editor.chain().focus().insertContentAt({ from, to }, [{ type: 'mention', attrs: { objectId: object.id, label: object.title } }, { type: 'text', text: ' ' }]).run()
      },
    },
    {
      label: embeddable ? 'Embed' : 'Weblink card',
      icon: embeddable ? 'ph:play-circle' : 'ph:cards',
      run: async () => {
        const object = await save()
        if (!object) return
        const embed = { type: 'objectEmbed', attrs: { objectId: object.id, display: embeddable ? 'embed' : 'wide-card' } }
        const $from = editor.state.doc.resolve(from)
        const block = { from: $from.before(), to: $from.after() }
        // A paragraph holding only the link becomes the embed; otherwise the embed goes below it.
        if ($from.parent.textContent.trim() === url) editor.chain().focus().insertContentAt(block, [embed, { type: 'paragraph' }]).run()
        else editor.chain().focus().insertContentAt(block.to, embed).deleteRange({ from, to }).run()
      },
    },
  ])
}

/**
 * The editor's extensions. With `text`, the editor edits that field of a Y.Doc (the object's text
 * in the local replica) instead of a JSON document, and undo follows Yjs (only this device's edits).
 * `objectId` (the object the text belongs to) makes links to its blocks. `template`: the text of a
 * template or snippet, where "{{" opens the menu of placeholders.
 */
export function createExtensions(placeholder: string, text?: { doc: Y.Doc; field: string }, objectId?: string, template = false) {
  return [
    text ? VastaStarterKit.configure({ undoRedo: false }) : VastaStarterKit,
    TaskList,
    TaskItemNested,
    VastaTableKit,
    VastaDetails,
    DetailsSummary,
    DetailsContent,
    PaletteHighlight,
    CalloutWithView,
    PaletteGroup,
    Columns,
    Column,
    ObjectEmbedWithView,
    Unsupported,
    MentionWithSuggestion,
    PlaceholderWithView,
    TemplateIf,
    TemplateBranchWithView,
    BlockAttributes,
    BlockAttributesView,
    SlashMenu.configure({ ...(objectId ? { objectId } : {}), template }),
    ...(template ? [PlaceholderMenu] : []),
    Uploads,
    UrlPaste,
    Blocks.configure({ objectId }),
    BlockKeysWhileTyping,
    Placeholder.configure({ placeholder, includeChildren: false }),
    ...(text ? [Collaboration.configure({ document: text.doc, field: text.field })] : []),
  ]
}
