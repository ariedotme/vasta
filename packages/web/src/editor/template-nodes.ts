// Templates in the editor (core's templates.ts): placeholder chips, conditional blocks, and in a
// template or snippet the "{{" menu of placeholders. The nodes are in every editor (the schema is
// shared), the menu only where a template is being edited.
import { Extension, type Editor, type Range } from '@tiptap/core'
import Suggestion from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import { PLACEHOLDERS } from '@vasta/core'
import { TemplateBranch, TemplateIf, TemplatePlaceholder } from '@vasta/editor-schema'
import { promptDialog } from '../lib/overlays.ts'
import type { SlashCommand } from './commands.ts'
import PlaceholderView from './PlaceholderView.vue'
import SlashList from './SlashList.vue'
import { suggestionPopup } from './suggestion-popup.ts'
import TemplateBranchView from './TemplateBranchView.vue'

export const PlaceholderWithView = TemplatePlaceholder.extend({
  addNodeView: () => VueNodeViewRenderer(PlaceholderView),
})

export const TemplateBranchWithView = TemplateBranch.extend({
  addNodeView: () => VueNodeViewRenderer(TemplateBranchView),
})

export { TemplateIf }

const ICONS: Record<string, string> = {
  date: 'ph:calendar-blank',
  time: 'ph:clock',
  title: 'ph:text-aa',
  me: 'ph:user',
  yesterday: 'ph:arrow-left',
  tomorrow: 'ph:arrow-right',
  ask: 'ph:question',
  choose: 'ph:list-checks',
  selection: 'ph:selection',
  cursor: 'ph:cursor-text',
  formula: 'ph:function',
}

/** What to ask before inserting a placeholder that needs more than its name. */
const ARGUMENTS: Record<string, { title: string; message: string; placeholder: string; optional?: boolean }> = {
  date: { title: 'Date', message: 'Optional: a shift (+7d, -1w, next monday) and a format after | (D MMM YYYY).', placeholder: '+7d|D MMM', optional: true },
  ask: { title: 'Ask', message: 'The question asked when an object is made from the template.', placeholder: 'With whom?' },
  choose: { title: 'Choose', message: 'The question, then the answers, all separated by |.', placeholder: 'Kind|Bug|Feature' },
  formula: { title: 'Formula', message: 'Its value goes here: if(weekday(date) = 1, "Monday", "").', placeholder: 'if(ask("Kind") = "Bug", "🐞", "✨")' },
}

export function insertPlaceholder(editor: Editor, range: Range, value: string) {
  editor.chain().focus().deleteRange(range).insertContent([{ type: 'templatePlaceholder', attrs: { value } }, { type: 'text', text: ' ' }]).run()
}

/** A conditional block with one branch around the current block's place. */
export function insertCondition(editor: Editor, range: Range, condition = '') {
  editor
    .chain()
    .focus()
    .deleteRange(range)
    .insertContent({ type: 'templateIf', content: [{ type: 'templateBranch', attrs: { condition }, content: [{ type: 'paragraph' }] }] })
    .run()
}

function placeholderCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase()
  const items: SlashCommand[] = PLACEHOLDERS.filter((p) => !q || p.name.startsWith(q) || p.description.toLowerCase().includes(q)).map((p) => ({
    id: p.name,
    label: p.name,
    detail: p.description,
    icon: ICONS[p.name] ?? 'ph:brackets-curly',
    run: async (editor, range) => {
      const argument = ARGUMENTS[p.name]
      if (!argument) return insertPlaceholder(editor, range, p.name)
      const value = await promptDialog({ ...argument, confirmLabel: 'Insert', ...(argument.optional ? { optional: true } : {}) })
      if (value === null) return
      const sep = p.name === 'date' && value.startsWith('|') ? '' : ':'
      insertPlaceholder(editor, range, value ? `${p.name}${sep}${value}` : p.name)
    },
  }))
  if (!q || 'if'.startsWith(q)) {
    items.push({
      id: 'if-inline',
      label: 'If…',
      detail: 'One text or another, by a condition',
      icon: 'ph:git-branch',
      run: async (editor, range) => {
        const condition = await promptDialog({ title: 'If…', message: 'The condition, a formula: weekday(date) = 1, ask("Body", "Yes", "No") = "Yes" (asked with buttons).', placeholder: 'weekday(date) = 1', confirmLabel: 'Next' })
        if (!condition) return
        const then = await promptDialog({ title: 'Then', message: 'The text when it holds.', confirmLabel: 'Next', optional: true })
        if (then === null) return
        const otherwise = await promptDialog({ title: 'Otherwise', message: 'The text when it does not (may be empty).', confirmLabel: 'Insert', optional: true })
        if (otherwise === null) return
        const quote = (text: string) => `"${text.replace(/["\\]/g, '\\$&')}"`
        insertPlaceholder(editor, range, `formula:if(${condition}, ${quote(then)}, ${quote(otherwise)})`)
      },
    })
  }
  return items
}

/** The "{{" menu, for editors of templates and snippets. */
export const PlaceholderMenu = Extension.create({
  name: 'placeholderMenu',
  addProseMirrorPlugins() {
    return [
      Suggestion<SlashCommand>({
        editor: this.editor,
        pluginKey: new PluginKey('placeholder-suggestion'),
        char: '{{',
        startOfLine: false,
        allowedPrefixes: null,
        items: ({ query }) => placeholderCommands(query.replace(/\}+$/, '')),
        command: ({ editor, range, props }) => props.run(editor, range),
        render: suggestionPopup<SlashCommand>(SlashList),
      }),
    ]
  },
})
