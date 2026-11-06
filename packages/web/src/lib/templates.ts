// Templates and snippets in the app (core's templates.ts): the open space's list, kept apart from
// every other list, making objects from a template (its questions asked first), saving an object
// or a selection as one, and inserting a template's or snippet's text into the editor.
import type { Editor, Range } from '@tiptap/core'
import {
  BODY_PROPERTY_ID, applySnippet, applyTemplate, scopeHolds, templateAsks, templateFromObject, typeTemplates,
  type AppliedTemplate, type DocNode, type Id, type ObjectRecord, type ObjectType, type SnippetScope, type TemplateContext,
} from '@vasta/core'
import { computed, reactive, watch } from 'vue'
import { api } from './api.ts'
import { dayKey } from './actions.ts'
import { onChange } from './events.ts'
import { asksDialog, confirmDialog, promptDialog } from './overlays.ts'
import { meId, people } from './people.ts'
import { lastError, notice, primeFromObject, summaryOf, systemType, typesById, workspace } from './state.ts'
import { openObject } from './open.ts'

export const templates = reactive({
  spaceId: '' as Id,
  list: [] as ObjectRecord[],
})

let loading: Promise<void> | undefined

/** Load the open space's templates (again); callers that show them call it when they open. */
export function loadTemplates(): Promise<void> {
  const spaceId = workspace.space?.id
  if (!spaceId) return Promise.resolve()
  loading ??= api
    .templates(spaceId)
    .then((list) => {
      if (workspace.space?.id !== spaceId) return
      templates.spaceId = spaceId
      templates.list = list
    })
    .catch(() => {})
    .finally(() => (loading = undefined))
  return loading
}

/** The list, loaded for the open space first when it is not yet. */
export async function currentTemplates(): Promise<ObjectRecord[]> {
  if (templates.spaceId !== workspace.space?.id) await loadTemplates()
  return current()
}

watch(
  () => workspace.space?.id,
  (id) => id && void loadTemplates(),
  { immediate: true }
)

// One of them changed elsewhere (another device, another tab).
onChange((event) => {
  if (event.kind === 'object' && event.spaceId === templates.spaceId && templates.list.some((t) => t.id === event.id)) void loadTemplates()
})

const current = () => (templates.spaceId === workspace.space?.id ? templates.list : [])

/** A type's templates, the default first. */
export const templatesOf = (typeId: Id) => typeTemplates(current(), typeId)
export const snippets = computed(() => current().filter((t) => t.template?.kind === 'snippet'))

/** Keep the list in step after a template is saved from its page. */
export const rememberTemplate = (template: ObjectRecord) => remember(template)

function remember(template: ObjectRecord) {
  const list = templates.list.filter((t) => t.id !== template.id)
  templates.list = template.deletedAt ? list : [...list, template]
}

/** What applying needs from the app: today, the user and the space's people and types. */
export function templateContext(extra: Partial<TemplateContext> = {}): TemplateContext {
  const me = meId()
  return {
    at: new Date().toISOString(),
    today: dayKey(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    types: typesById.value,
    people: people.list,
    ...(me ? { me } : {}),
    ...extra,
  }
}

/** The template's questions, asked; null when cancelled. Templates without any answer at once. */
async function askFor(template: ObjectRecord): Promise<Record<string, string> | null> {
  const asks = templateAsks(template)
  if (!asks.length) return {}
  return asksDialog({ title: template.template!.name, fields: asks })
}

/** The object page's "where the cursor goes" after a template, as a query value. */
const cursorQuery = (made: AppliedTemplate) => (made.cursor ? { cursor: `${made.cursor.blockId}:${made.cursor.offset}` } : {})

/**
 * Make an object of a type from a template (asking its questions), or blank without one, and open
 * it. `title`: what the user typed for it.
 */
export async function createFromTemplate(type: ObjectType, template: ObjectRecord | undefined, options: { title?: string; open?: boolean; data?: Partial<ObjectRecord> } = {}): Promise<ObjectRecord | undefined> {
  const open = options.open ?? true
  let data: Partial<ObjectRecord> = { ...options.data, ...(options.title ? { title: options.title } : {}) }
  let made: AppliedTemplate | undefined
  if (template) {
    const answers = await askFor(template)
    if (!answers) return undefined
    made = applyTemplate(template, type, templateContext({ answers, ...(options.title ? { title: options.title } : {}) }))
    data = { ...data, title: made.title, props: { ...made.props, ...data.props }, content: made.content, tagIds: [...template.tagIds], ...(template.icon ? { icon: template.icon } : {}) }
  }
  try {
    const object = await api.createObject({ ...data, typeId: type.id })
    primeFromObject(object)
    if (open) await openObject(object.id, { query: { new: '1', ...(made ? cursorQuery(made) : {}) } })
    return object
  } catch (error) {
    lastError.value = (error as Error).message
    return undefined
  }
}

/**
 * What an empty object gets from a template ("Start from a template" on a new object), its
 * questions asked; the page writes it (its text through the editor's document). What the user
 * typed in the title stays.
 */
export async function templateFill(object: ObjectRecord, type: ObjectType, template: ObjectRecord): Promise<AppliedTemplate | undefined> {
  const answers = await askFor(template)
  if (!answers) return undefined
  return applyTemplate(template, type, templateContext({ answers, ...(object.title ? { title: object.title } : {}) }))
}

/** A template resolved for now, with its questions answered by their own labels (Preview). */
export function previewTemplate(template: ObjectRecord, type: ObjectType): AppliedTemplate {
  const answers = Object.fromEntries(templateAsks(template).map((a) => [a.label, a.options?.[0] ?? `‹${a.label}›`]))
  return applyTemplate(template, type, templateContext({ answers }))
}

/** Unmark the type's other default templates (this one becomes it on its page). */
export async function clearOtherDefaults(template: ObjectRecord) {
  for (const other of templatesOf(template.typeId)) {
    if (other.id === template.id || other.template?.kind !== 'template' || !other.template.default) continue
    const { default: _default, ...info } = other.template
    remember(await api.saveObject({ ...other, template: info }, other))
  }
}

/** "Save as template": a copy of the object as a template of its type, opened to edit. */
export async function saveAsTemplate(object: ObjectRecord, type: ObjectType) {
  const name = await promptDialog({ title: 'Save as template', message: `A template of ${type.name}: new ${type.pluralName.toLowerCase()} can start from it.`, value: object.title, placeholder: 'Template name', confirmLabel: 'Save template' })
  if (!name) return
  const draft = templateFromObject(object, type, name, '', new Date().toISOString())
  const { id: _id, ...data } = draft
  const template = await api.createObject({ ...data, typeId: type.id })
  remember(template)
  notice.value = { message: `Saved as a template of ${type.name}`, action: { label: 'Open', run: () => openObject(template.id) } }
}

/** A new, empty template of a type, opened to edit. */
export async function newTemplate(type: ObjectType) {
  const name = await promptDialog({ title: `New template of ${type.name}`, placeholder: 'Template name, e.g. “Bug”', confirmLabel: 'Create' })
  if (!name) return
  const template = await api.createObject({ typeId: type.id, title: '', template: { kind: 'template', name, ...(templatesOf(type.id).length ? {} : { default: true }) } })
  remember(template)
  await openObject(template.id)
}

/** Make a template the type's default (the others stop being it), or stop it being the default. */
export async function setDefaultTemplate(template: ObjectRecord, on: boolean) {
  if (template.template?.kind !== 'template') return
  const others = on ? templatesOf(template.typeId).filter((t) => t.id !== template.id && t.template?.kind === 'template' && t.template.default) : []
  const saveInfo = async (t: ObjectRecord, isDefault: boolean) => {
    const { default: _default, ...info } = t.template as Extract<ObjectRecord['template'], { kind: 'template' }>
    const saved = await api.saveObject({ ...t, template: { ...info, ...(isDefault ? { default: true } : {}) } }, t)
    remember(saved)
    return saved
  }
  for (const other of others) await saveInfo(other, false)
  return saveInfo(template, on)
}

/** Rename a template or snippet. */
export async function renameTemplate(template: ObjectRecord) {
  if (!template.template) return
  const name = await promptDialog({ title: 'Rename', value: template.template.name, confirmLabel: 'Rename' })
  if (!name) return
  const saved = await api.saveObject({ ...template, template: { ...template.template, name } }, template)
  remember(saved)
  return saved
}

export async function deleteTemplate(template: ObjectRecord): Promise<boolean> {
  if (!template.template) return false
  const what = template.template.kind === 'snippet' ? 'snippet' : 'template'
  if (!(await confirmDialog({ title: `Delete the ${what} “${template.template.name}”?`, message: 'What was made from it stays as it is.', confirmLabel: 'Delete', danger: true }))) return false
  await api.deleteObject(template.id)
  templates.list = templates.list.filter((t) => t.id !== template.id)
  return true
}

/** Save blocks (a selection) as a snippet that applies everywhere, opened to edit when asked. */
export async function saveAsSnippet(content: DocNode[], open = false) {
  const page = systemType('page')
  if (!page) return
  const name = await promptDialog({ title: 'Save as snippet', message: 'Insert it anywhere with / and its name.', placeholder: 'Snippet name, e.g. “Signature”', confirmLabel: 'Save snippet' })
  if (!name) return
  const snippet = await api.createObject({ typeId: page.id, title: name, content: { [BODY_PROPERTY_ID]: { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] } }, template: { kind: 'snippet', name } })
  remember(snippet)
  if (open) await openObject(snippet.id)
  else notice.value = { message: `Snippet “${name}” saved`, action: { label: 'Open', run: () => openObject(snippet.id) } }
}

/** Change a snippet's trigger and scope (Settings › Snippets). */
export async function saveSnippetInfo(snippet: ObjectRecord, info: { trigger?: string; scope?: SnippetScope }) {
  if (snippet.template?.kind !== 'snippet') return
  const { trigger: _trigger, scope: _scope, ...rest } = snippet.template
  const trigger = info.trigger?.trim().replace(/^\//, '')
  const saved = await api.saveObject({ ...snippet, template: { ...rest, ...(trigger ? { trigger } : {}), ...(info.scope ? { scope: info.scope } : {}) } }, snippet)
  remember(saved)
  return saved
}

/** Snippets that apply in an object's text (by its type, properties and values). */
export function snippetsFor(objectId: Id | undefined): ObjectRecord[] {
  const object = objectId ? summaryOf(objectId) : undefined
  const type = object ? typesById.value.get(object.typeId) : undefined
  return snippets.value.filter((snippet) => {
    if (snippet.id === objectId || snippet.template?.kind !== 'snippet') return false
    if (!object || !type) return !snippet.template.scope
    return scopeHolds(snippet.template.scope, object, type, { today: dayKey(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, types: typesById.value })
  })
}

/** The selection's blocks (whole blocks when it spans several, its text in one otherwise). */
export function selectedBlocks(editor: Editor): DocNode[] | undefined {
  const { from, to, empty } = editor.state.selection
  if (empty) return undefined
  const slice = editor.state.doc.slice(from, to).content.toJSON() as DocNode[] | null
  if (!slice?.length) return undefined
  return slice.every((n) => n.type === 'text' || n.type === 'mention' || n.type === 'hardBreak') ? [{ type: 'paragraph', content: slice }] : slice
}

/**
 * Put a snippet's text at the cursor: inline into the paragraph when it is one paragraph, else as
 * blocks after the current one (in place of it when it is empty). `{{selection}}` takes what was selected.
 */
export async function insertSnippet(editor: Editor, range: Range, snippet: ObjectRecord, objectId: Id | undefined) {
  const answers = await askFor(snippet)
  if (!answers) return
  const target = objectId ? await api.object(objectId).catch(() => undefined) : undefined
  const type = target ? typesById.value.get(target.typeId) : systemType('page')
  if (!type) return
  const selection = selectedBlocks(editor)
  const blank: ObjectRecord = { id: '', spaceId: type.spaceId, typeId: type.id, title: '', aliases: [], tagIds: [], collectionIds: [], props: {}, content: {}, createdAt: '', updatedAt: '' }
  const made = applySnippet(snippet, target ?? blank, type, templateContext({ answers, ...(selection ? { selection } : {}) }))
  insertMade(editor, range, made.inline, made.blocks, made.cursor)
}

/** `/template`: a template's text (of any type) at the cursor, as a snippet would put it. */
export async function insertTemplate(editor: Editor, range: Range, template: ObjectRecord, objectId: Id | undefined) {
  const answers = await askFor(template)
  if (!answers) return
  const type = typesById.value.get(template.typeId)
  if (!type) return
  const target = objectId ? await api.object(objectId).catch(() => undefined) : undefined
  const made = applyTemplate(template, type, templateContext({ answers, ...(target?.title ? { title: target.title } : {}) }))
  const field = type.properties.find((p) => p.kind === 'rich-text' && made.content[p.id])
  const blocks = field ? made.content[field.id]!.content : []
  insertMade(editor, range, undefined, blocks, made.cursor ? { blockId: made.cursor.blockId, offset: made.cursor.offset } : undefined)
}

function insertMade(editor: Editor, range: Range, inline: DocNode[] | undefined, blocks: DocNode[] | undefined, cursor?: { blockId?: string; offset: number }) {
  const chain = editor.chain().focus().deleteRange(range)
  if (inline) {
    const start = range.from
    chain.insertContent(inline.length ? inline : '').run()
    if (cursor && cursor.blockId === undefined) editor.commands.setTextSelection(start + cursor.offset)
    return
  }
  if (!blocks?.length) return chain.run()
  const { $from } = editor.state.selection
  const empty = $from.parent.type.name === 'paragraph' && !$from.parent.textContent.trim() && $from.parent.childCount === 0
  chain.run()
  const at = editor.state.selection.$from
  const depth = at.depth
  if (empty && depth > 0) editor.chain().insertContentAt({ from: at.before(depth), to: at.after(depth) }, blocks).run()
  else editor.chain().insertContentAt(depth > 0 ? at.after(depth) : at.pos, blocks).run()
  if (cursor?.blockId) {
    editor.state.doc.descendants((node, pos) => {
      if (node.attrs.id !== cursor.blockId) return true
      editor.commands.setTextSelection(pos + 1 + cursor.offset)
      return false
    })
  }
}
