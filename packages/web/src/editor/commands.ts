// Blocks offered by the "/" menu.
import type { Editor, Range } from '@tiptap/core'
import { createObject } from '../lib/actions.ts'
import { systemType } from '../lib/state.ts'
import { pickImages } from './uploads.ts'

export interface SlashCommand {
  id: string
  label: string
  icon: string
  keywords?: string
  run: (editor: Editor, range: Range) => void
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

export function filterCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase()
  return slashCommands.filter((c) => !q || c.label.toLowerCase().includes(q) || c.id.includes(q) || c.keywords?.includes(q))
}
