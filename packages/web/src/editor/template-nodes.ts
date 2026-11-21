// Templates in the editor (core's templates.ts): placeholder chips, conditional blocks, and in a
// template or snippet the "{{" menu of placeholders. The nodes are in every editor (the schema is
// shared), the menu only where a template is being edited.
import { Extension, type Editor, type Range } from '@tiptap/core'
import Suggestion from '@tiptap/suggestion'
import { PluginKey } from '@tiptap/pm/state'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import { PLACEHOLDERS } from '@vasta/core'
import { TemplateBranch, TemplateIf, TemplatePlaceholder } from '@vasta/editor-schema'
import { t } from '../lib/i18n.ts'
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
function argumentFor(name: string): { title: string; message: string; placeholder: string; optional?: boolean } | undefined {
  switch (name) {
    case 'date':
      return { title: t('dateEditor.date'), message: t('editor.template.arg.date.message'), placeholder: '+7d|D MMM', optional: true }
    case 'ask':
      return { title: t('editor.template.arg.ask.title'), message: t('editor.template.arg.ask.message'), placeholder: t('editor.template.arg.ask.placeholder') }
    case 'choose':
      return { title: t('editor.template.arg.choose.title'), message: t('editor.template.arg.choose.message'), placeholder: t('editor.template.arg.choose.placeholder') }
    case 'formula':
      return { title: t('propKind.formula'), message: t('editor.template.arg.formula.message'), placeholder: 'if(ask("Kind") = "Bug", "🐞", "✨")' }
    default:
      return undefined
  }
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
      const argument = argumentFor(p.name)
      if (!argument) return insertPlaceholder(editor, range, p.name)
      const value = await promptDialog({ ...argument, confirmLabel: t('editor.template.insert'), ...(argument.optional ? { optional: true } : {}) })
      if (value === null) return
      const sep = p.name === 'date' && value.startsWith('|') ? '' : ':'
      insertPlaceholder(editor, range, value ? `${p.name}${sep}${value}` : p.name)
    },
  }))
  if (!q || 'if'.startsWith(q)) {
    items.push({
      id: 'if-inline',
      label: t('editor.template.ifInline'),
      detail: t('editor.template.ifInlineDetail'),
      icon: 'ph:git-branch',
      run: async (editor, range) => {
        const condition = await promptDialog({
          title: t('editor.template.ifInline'),
          message: t('editor.template.ifConditionMessage'),
          placeholder: 'weekday(date) = 1',
          confirmLabel: t('editor.template.next'),
        })
        if (!condition) return
        const then = await promptDialog({ title: t('editor.template.thenTitle'), message: t('editor.template.thenMessage'), confirmLabel: t('editor.template.next'), optional: true })
        if (then === null) return
        const otherwise = await promptDialog({ title: t('editor.template.otherwiseTitle'), message: t('editor.template.otherwiseMessage'), confirmLabel: t('editor.template.insert'), optional: true })
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
