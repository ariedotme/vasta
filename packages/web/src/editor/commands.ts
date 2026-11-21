// Blocks offered by the "/" menu, and the snippets that apply in the text being edited.
import type { Editor, Range } from '@tiptap/core'
import type { Id } from '@vasta/core'
import { createObject } from '../lib/actions.ts'
import { t, typeName } from '../lib/i18n.ts'
import { MERMAID } from '../lib/mermaid.ts'
import { openMenuAt, type MenuItem } from '../lib/overlays.ts'
import { systemType, typesById } from '../lib/state.ts'
import { insertSnippet, insertTemplate, loadTemplates, snippetsFor, templates } from '../lib/templates.ts'
import { insertCondition } from './template-nodes.ts'
import { toggleFromLine } from './toggles.ts'
import { pickImages } from './uploads.ts'

export interface SlashCommand {
  id: string
  label: string
  icon: string
  keywords?: string
  /** Shown faded beside the label. */
  detail?: string
  /** A heading the item is listed under ("Snippets"). */
  group?: string
  run: (editor: Editor, range: Range) => void
}

/** Where the "/" menu is: the object whose text it is, and whether it is a template's or snippet's. */
export interface SlashContext {
  objectId?: Id
  template?: boolean
}

/** A menu below the cursor. */
function menuAtCursor(editor: Editor, items: MenuItem[]) {
  const coords = editor.view.coordsAtPos(editor.state.selection.from)
  openMenuAt(coords.left, coords.bottom + 4, items.length ? items : [{ kind: 'heading', label: t('editor.slash.noneYet') }])
}

const chain = (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range)

export const slashCommands: SlashCommand[] = [
  { id: 'text', get label() { return t('editor.slash.text') }, icon: 'ph:text-t', keywords: 'text paragraph', run: (e, r) => chain(e, r).setParagraph().run() },
  { id: 'h1', get label() { return t('editor.slash.h1') }, icon: 'ph:text-h-one', keywords: 'heading title', run: (e, r) => chain(e, r).setHeading({ level: 1 }).run() },
  { id: 'h2', get label() { return t('editor.slash.h2') }, icon: 'ph:text-h-two', keywords: 'heading subtitle', run: (e, r) => chain(e, r).setHeading({ level: 2 }).run() },
  { id: 'h3', get label() { return t('editor.slash.h3') }, icon: 'ph:text-h-three', keywords: 'heading', run: (e, r) => chain(e, r).setHeading({ level: 3 }).run() },
  { id: 'bullet', get label() { return t('editor.slash.bullet') }, icon: 'ph:list-bullets', keywords: 'bulleted list ul', run: (e, r) => chain(e, r).toggleBulletList().run() },
  { id: 'numbered', get label() { return t('editor.slash.numbered') }, icon: 'ph:list-numbers', keywords: 'numbered list ol', run: (e, r) => chain(e, r).toggleOrderedList().run() },
  { id: 'todo', get label() { return t('editor.slash.todo') }, icon: 'ph:check-square', keywords: 'to-do task checkbox', run: (e, r) => chain(e, r).toggleTaskList().run() },
  { id: 'quote', get label() { return t('editor.slash.quote') }, icon: 'ph:quotes', keywords: 'quote', run: (e, r) => chain(e, r).toggleBlockquote().run() },
  {
    id: 'callout',
    get label() { return t('editor.slash.callout') },
    icon: 'ph:lightbulb',
    keywords: 'callout note info',
    run: (e, r) => chain(e, r).wrapIn('callout', { icon: { kind: 'emoji', value: '💡' } }).run(),
  },
  { id: 'toggle', get label() { return t('editor.slash.toggle') }, icon: 'ph:caret-circle-right', keywords: 'toggle details collapse', run: (e, r) => chain(e, r).run() && toggleFromLine(e) },
  { id: 'group', get label() { return t('editor.slash.group') }, icon: 'ph:selection-background', keywords: 'colored group box container', run: (e, r) => chain(e, r).wrapIn('group', { color: 'sky' }).run() },
  {
    id: 'columns',
    get label() { return t('editor.slash.columns') },
    icon: 'ph:columns',
    keywords: 'two columns grid layout',
    run: (e, r) =>
      chain(e, r)
        .insertContent({
          type: 'columns',
          content: [
            { type: 'column', content: [{ type: 'paragraph' }] },
            { type: 'column', content: [{ type: 'paragraph' }] },
          ],
        })
        .run(),
  },
  {
    id: 'image',
    get label() { return t('editor.slash.image') },
    icon: 'ph:image',
    keywords: 'image picture photo upload camera',
    // Synchronous, so the file picker opens within the tap or key press (iOS requires it).
    run: (e, r) => {
      chain(e, r).run()
      pickImages(e)
    },
  },
  { id: 'table', get label() { return t('editor.slash.table') }, icon: 'ph:table', keywords: 'table', run: (e, r) => chain(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: false }).run() },
  { id: 'code', get label() { return t('editor.slash.code') }, icon: 'ph:code', keywords: 'code', run: (e, r) => chain(e, r).toggleCodeBlock().run() },
  {
    id: 'diagram',
    get label() { return t('editor.slash.diagram') },
    icon: 'ph:flow-arrow',
    keywords: 'diagram mermaid flowchart chart graph sequence mindmap',
    // A Mermaid code block (CodeBlockView.vue draws it), started with a small flowchart.
    run: (e, r) =>
      chain(e, r)
        .insertContent({ type: 'codeBlock', attrs: { language: MERMAID }, content: [{ type: 'text', text: 'flowchart LR\n  A[Idea] --> B[Note]' }] })
        .run(),
  },
  { id: 'divider', get label() { return t('editor.slash.divider') }, icon: 'ph:minus', keywords: 'divider hr line', run: (e, r) => chain(e, r).setHorizontalRule().run() },
  {
    id: 'query',
    get label() { return t('editor.slash.query') },
    icon: 'ph:funnel',
    keywords: 'query filter list database view',
    // Creates a query object and embeds it; its settings open right away.
    run: async (e, r) => {
      const type = systemType('query')
      if (!type) return
      chain(e, r).run()
      const query = await createObject(type.id, { title: t('editor.slash.query'), query: { typeIds: [], layout: 'list' } }, false)
      e.chain().focus().insertContent({ type: 'objectEmbed', attrs: { objectId: query.id, display: 'embed' } }).run()
    },
  },
  {
    id: 'embed',
    get label() { return t('editor.slash.embed') },
    icon: 'ph:cards',
    keywords: 'embed object card link',
    // Inserts "@@" so the mention suggestion opens in embed mode.
    run: (e, r) => chain(e, r).insertContent('@@').run(),
  },
]

/** Picking a snippet or a template in a menu, after "/snippet" or "/template". */
const pickers = (context: SlashContext): SlashCommand[] => [
  {
    id: 'snippet',
    label: t('editor.slash.snippet'),
    icon: 'ph:brackets-curly',
    keywords: 'snippet insert reuse',
    run: async (e, r) => {
      await loadTemplates()
      menuAtCursor(e, [{ kind: 'heading', label: t('editor.slash.snippets') }, ...snippetsFor(context.objectId).map((s) => ({ label: s.template!.name, icon: 'ph:brackets-curly', run: () => insertSnippet(e, r, s, context.objectId) }))])
    },
  },
  {
    id: 'template',
    label: t('editor.slash.template'),
    icon: 'ph:copy-simple',
    keywords: 'template insert',
    run: async (e, r) => {
      await loadTemplates()
      const list = templates.list.filter((tpl) => tpl.template?.kind === 'template' && tpl.id !== context.objectId)
      menuAtCursor(e, [
        { kind: 'heading', label: t('editor.slash.insertTemplate') },
        ...list.map((tpl) => {
          const type = typesById.value.get(tpl.typeId)
          return { label: tpl.template!.name, hint: type ? typeName(type) : undefined, icon: 'ph:copy-simple', run: () => insertTemplate(e, r, tpl, context.objectId) }
        }),
      ])
    },
  },
]

/** Blocks only templates and snippets have. */
const templateCommands: SlashCommand[] = [
  { id: 'condition', get label() { return t('editor.slash.condition') }, icon: 'ph:git-branch', keywords: 'condition if else template', run: (e, r) => insertCondition(e, r) },
  { id: 'placeholder', get label() { return t('editor.slash.placeholder') }, icon: 'ph:brackets-curly', keywords: 'placeholder variable date ask template', run: (e, r) => e.chain().focus().deleteRange(r).insertContent('{{').run() },
]

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

export function filterCommands(query: string, context: SlashContext = {}): SlashCommand[] {
  const q = fold(query)
  const commands = [...slashCommands, ...pickers(context), ...(context.template ? templateCommands : [])]
  const blocks = commands.filter((c) => !q || fold(c.label).includes(q) || c.id.includes(q) || c.keywords?.includes(q))
  // Snippets that apply here, by trigger then name; one whose trigger is typed whole comes first.
  const wanted = fold(query)
  const found = snippetsFor(context.objectId).flatMap((snippet) => {
    const info = snippet.template?.kind === 'snippet' ? snippet.template : undefined
    if (!info) return []
    const trigger = fold(info.trigger ?? '')
    const rank = !wanted ? 3 : trigger === wanted ? 0 : trigger.startsWith(wanted) ? 1 : fold(info.name).includes(wanted) ? 2 : -1
    return rank < 0 ? [] : [{ rank, snippet, info }]
  })
  found.sort((a, b) => a.rank - b.rank || a.info.name.localeCompare(b.info.name))
  const items: SlashCommand[] = found.slice(0, 8).map(({ snippet, info }) => ({
    id: `snippet:${snippet.id}`,
    label: info.name,
    icon: 'ph:brackets-curly',
    group: t('editor.slash.snippets'),
    ...(info.trigger ? { detail: `/${info.trigger}` } : {}),
    run: (e, r) => void insertSnippet(e, r, snippet, context.objectId),
  }))
  return found[0]?.rank === 0 ? [...items, ...blocks] : [...blocks, ...items]
}
