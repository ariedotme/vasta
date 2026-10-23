// Blocks offered by the "/" menu, and the snippets that apply in the text being edited.
import type { Editor, Range } from '@tiptap/core'
import type { Id } from '@vasta/core'
import { createObject } from '../lib/actions.ts'
import { openMenuAt, type MenuItem } from '../lib/overlays.ts'
import { systemType, typesById } from '../lib/state.ts'
import { insertSnippet, insertTemplate, loadTemplates, snippetsFor, templates } from '../lib/templates.ts'
import { insertCondition } from './template-nodes.ts'
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
  openMenuAt(coords.left, coords.bottom + 4, items.length ? items : [{ kind: 'heading', label: 'None yet' }])
}

const chain = (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range)

export const slashCommands: SlashCommand[] = [
  { id: 'text', label: 'Text', icon: 'ph:text-t', keywords: 'paragraph', run: (e, r) => chain(e, r).setParagraph().run() },
  { id: 'h1', label: 'Heading 1', icon: 'ph:text-h-one', keywords: 'title', run: (e, r) => chain(e, r).setHeading({ level: 1 }).run() },
  { id: 'h2', label: 'Heading 2', icon: 'ph:text-h-two', keywords: 'subtitle', run: (e, r) => chain(e, r).setHeading({ level: 2 }).run() },
  { id: 'h3', label: 'Heading 3', icon: 'ph:text-h-three', run: (e, r) => chain(e, r).setHeading({ level: 3 }).run() },
  { id: 'bullet', label: 'Bulleted list', icon: 'ph:list-bullets', keywords: 'ul', run: (e, r) => chain(e, r).toggleBulletList().run() },
  { id: 'numbered', label: 'Numbered list', icon: 'ph:list-numbers', keywords: 'ol', run: (e, r) => chain(e, r).toggleOrderedList().run() },
  { id: 'todo', label: 'To-do', icon: 'ph:check-square', keywords: 'task checkbox', run: (e, r) => chain(e, r).toggleTaskList().run() },
  { id: 'quote', label: 'Quote', icon: 'ph:quotes', run: (e, r) => chain(e, r).toggleBlockquote().run() },
  {
    id: 'callout',
    label: 'Callout',
    icon: 'ph:lightbulb',
    keywords: 'note info',
    run: (e, r) => chain(e, r).wrapIn('callout', { icon: { kind: 'emoji', value: '💡' } }).run(),
  },
  { id: 'toggle', label: 'Toggle', icon: 'ph:caret-circle-right', keywords: 'details collapse', run: (e, r) => chain(e, r).setDetails().run() },
  { id: 'group', label: 'Colored group', icon: 'ph:selection-background', keywords: 'box container', run: (e, r) => chain(e, r).wrapIn('group', { color: 'sky' }).run() },
  {
    id: 'columns',
    label: 'Two columns',
    icon: 'ph:columns',
    keywords: 'grid layout',
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
    label: 'Image',
    icon: 'ph:image',
    keywords: 'picture photo upload camera',
    // Synchronous, so the file picker opens within the tap or key press (iOS requires it).
    run: (e, r) => {
      chain(e, r).run()
      pickImages(e)
    },
  },
  { id: 'table', label: 'Table', icon: 'ph:table', run: (e, r) => chain(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: false }).run() },
  { id: 'code', label: 'Code', icon: 'ph:code', run: (e, r) => chain(e, r).toggleCodeBlock().run() },
  { id: 'divider', label: 'Divider', icon: 'ph:minus', keywords: 'hr line', run: (e, r) => chain(e, r).setHorizontalRule().run() },
  {
    id: 'query',
    label: 'Query',
    icon: 'ph:funnel',
    keywords: 'filter list database view',
    // Creates a query object and embeds it; its settings open right away.
    run: async (e, r) => {
      const type = systemType('query')
      if (!type) return
      chain(e, r).run()
      const query = await createObject(type.id, { title: 'Query', query: { typeIds: [], layout: 'list' } }, false)
      e.chain().focus().insertContent({ type: 'objectEmbed', attrs: { objectId: query.id, display: 'embed' } }).run()
    },
  },
  {
    id: 'embed',
    label: 'Embed object',
    icon: 'ph:cards',
    keywords: 'card link',
    // Inserts "@@" so the mention suggestion opens in embed mode.
    run: (e, r) => chain(e, r).insertContent('@@').run(),
  },
]

/** Picking a snippet or a template in a menu, after "/snippet" or "/template". */
const pickers = (context: SlashContext): SlashCommand[] => [
  {
    id: 'snippet',
    label: 'Snippet…',
    icon: 'ph:brackets-curly',
    keywords: 'insert reuse',
    run: async (e, r) => {
      await loadTemplates()
      menuAtCursor(e, [{ kind: 'heading', label: 'Snippets' }, ...snippetsFor(context.objectId).map((s) => ({ label: s.template!.name, icon: 'ph:brackets-curly', run: () => insertSnippet(e, r, s, context.objectId) }))])
    },
  },
  {
    id: 'template',
    label: 'Template…',
    icon: 'ph:copy-simple',
    keywords: 'insert',
    run: async (e, r) => {
      await loadTemplates()
      const list = templates.list.filter((t) => t.template?.kind === 'template' && t.id !== context.objectId)
      menuAtCursor(e, [
        { kind: 'heading', label: 'Insert a template’s text' },
        ...list.map((t) => ({ label: t.template!.name, hint: typesById.value.get(t.typeId)?.name, icon: 'ph:copy-simple', run: () => insertTemplate(e, r, t, context.objectId) })),
      ])
    },
  },
]

/** Blocks only templates and snippets have. */
const templateCommands: SlashCommand[] = [
  { id: 'condition', label: 'Condition', icon: 'ph:git-branch', keywords: 'if else template', run: (e, r) => insertCondition(e, r) },
  { id: 'placeholder', label: 'Placeholder', icon: 'ph:brackets-curly', keywords: 'variable date ask template', run: (e, r) => e.chain().focus().deleteRange(r).insertContent('{{').run() },
]

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

export function filterCommands(query: string, context: SlashContext = {}): SlashCommand[] {
  const q = query.toLowerCase()
  const commands = [...slashCommands, ...pickers(context), ...(context.template ? templateCommands : [])]
  const blocks = commands.filter((c) => !q || c.label.toLowerCase().includes(q) || c.id.includes(q) || c.keywords?.includes(q))
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
    group: 'Snippets',
    ...(info.trigger ? { detail: `/${info.trigger}` } : {}),
    run: (e, r) => void insertSnippet(e, r, snippet, context.objectId),
  }))
  return found[0]?.rank === 0 ? [...items, ...blocks] : [...blocks, ...items]
}
