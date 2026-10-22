<script setup lang="ts">
// Rich-text editor for one document field. Emits the document after edits (debounced by the parent).
// A new `doc` from outside (e.g. an item captured from Telegram) replaces the content in place.
// With `text` it edits a field of the object's Y.Doc instead (the local replica keeps it in step,
// merging other devices' edits as they arrive); the emitted document is then only a copy to show.
// `reveal` scrolls to a block (a link to it, #b-<id>) once the text has it.
import { EditorContent, useEditor, type Editor } from '@tiptap/vue-3'
import { BubbleMenu } from '@tiptap/vue-3/menus'
import type { Doc } from '@vasta/core'
import { compactDoc } from '@vasta/editor-schema'
import { onBeforeUnmount, watch } from 'vue'
import { useRouter } from 'vue-router'
import type * as Y from 'yjs'
import AppIcon from '../components/AppIcon.vue'
import { api } from '../lib/api.ts'
import { promptDialog } from '../lib/overlays.ts'
import { lastError, notice, primeFromObject, refreshCounts } from '../lib/state.ts'
import { flashBlock } from './block-attributes.ts'
import { createExtensions } from './extensions.ts'

const props = defineProps<{ doc: Doc | undefined; text?: { doc: Y.Doc; field: string }; objectId?: string; reveal?: string; placeholder?: string; autofocus?: boolean }>()
const emit = defineEmits<{ change: [doc: Doc] }>()
const router = useRouter()

/** The app's own page a link points to (vasta://o/<id>, or this server's /o/<id>…), if it is one. */
function appPath(href: string): string | undefined {
  if (href.startsWith('vasta://')) return `/${href.slice('vasta://'.length)}`
  const url = new URL(href, location.href)
  if (url.origin !== location.origin || /^\/(api|media|desktop)\//.test(url.pathname)) return undefined
  return url.pathname + url.search + url.hash
}

const editor = useEditor({
  ...(props.text ? {} : { content: props.doc ?? { type: 'doc', content: [{ type: 'paragraph' }] } }),
  extensions: createExtensions(props.placeholder ?? 'Type / for blocks, @ to link an object…', props.text, props.objectId),
  autofocus: props.autofocus ? 'end' : false,
  editorProps: {
    attributes: { class: 'vasta-doc' },
    // Links to the app's own pages open here, not in a new tab or window (⌘/Ctrl-click still does).
    // A quote's highlight opens the quote.
    handleClick: (view, _pos, event) => {
      const quote = (event.target as HTMLElement | null)?.closest?.('mark[data-quote-id]')
      if (quote && view.state.selection.empty && event.button === 0 && !event.shiftKey) {
        void router.push(`/o/${quote.getAttribute('data-quote-id')}`)
        return true
      }
      const link = (event.target as HTMLElement | null)?.closest?.('a[href]')
      if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return false
      const path = appPath(link.getAttribute('href')!)
      if (!path) return false
      event.preventDefault()
      void router.push(path)
      return true
    },
  },
  onUpdate: ({ editor }) => {
    lastEmitted = compactDoc(editor.getJSON()) as Doc
    emit('change', lastEmitted)
  },
})

let lastEmitted: Doc | undefined

watch(
  () => props.doc,
  (doc) => {
    const current = editor.value
    if (props.text || !current || !doc || doc === lastEmitted) return
    if (JSON.stringify(doc) === JSON.stringify(compactDoc(current.getJSON()))) return
    // Captures are appended at the end, so the cursor position before them is still valid.
    const { from, to } = current.state.selection
    current.commands.setContent(doc, { emitUpdate: false })
    const max = current.state.doc.content.size
    if (current.isFocused) current.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) })
  }
)

let stopRevealing = () => {}

/** Scroll to the block with this id and flash it; the text may still be loading (or syncing), so keep looking for a while. */
function revealBlock(current: Editor, id: string) {
  stopRevealing()
  let tries = 0
  const timer = setInterval(() => {
    let found = -1
    current.state.doc.descendants((node, pos) => {
      if (found >= 0) return false
      if (node.attrs.id === id) found = pos
    })
    const dom = found >= 0 ? current.view.nodeDOM(found) : null
    if (dom instanceof HTMLElement && dom.isConnected) {
      stopRevealing()
      dom.scrollIntoView({ block: 'center', behavior: 'smooth' })
      flashBlock(current.view, id)
    } else if (++tries > 50) stopRevealing()
  }, 100)
  stopRevealing = () => clearInterval(timer)
}

watch(
  () => [props.reveal, editor.value] as const,
  ([id, current]) => {
    if (id && current) revealBlock(current, id)
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  stopRevealing()
  editor.value?.destroy()
})

async function setLink() {
  if (!editor.value) return
  const previous = editor.value.getAttributes('link').href as string | undefined
  const { from, to } = editor.value.state.selection
  const href = await promptDialog({ title: previous ? 'Edit link' : 'Add link', value: previous ?? 'https://', placeholder: 'https://', confirmLabel: 'Save' })
  if (!editor.value || href === null) return
  // The dialog took focus; restore the selection before applying the mark.
  editor.value.chain().focus().setTextSelection({ from, to }).extendMarkRange('link').setLink({ href }).run()
}

/** Save the selected passage as a quote of this object (with an optional note) and highlight it. */
async function quote() {
  const current = editor.value
  if (!current || !props.objectId) return
  const { from, to, empty } = current.state.selection
  if (empty) return
  const passage = current.state.doc.textBetween(from, to, ' ', ' ').trim()
  const note = await promptDialog({
    title: 'Save as quote',
    message: passage.length > 240 ? `${passage.slice(0, 240)}…` : passage,
    placeholder: 'A note (optional)',
    confirmLabel: 'Save quote',
    optional: true,
  })
  if (note === null) return
  try {
    const created = await api.createQuote(props.objectId, { text: passage, ...(note ? { note } : {}) })
    primeFromObject(created)
    void refreshCounts()
    editor.value?.chain().focus().setTextSelection({ from, to }).setMark('highlight', { color: 'yellow', quoteId: created.id }).run()
    notice.value = { message: 'Quote saved', action: { label: 'Open', run: () => router.push(`/o/${created.id}`) } }
  } catch (error) {
    lastError.value = (error as Error).message
  }
}

function removeLink() {
  editor.value?.chain().focus().extendMarkRange('link').unsetLink().run()
}

const marks: { name: string; title: string; icon: string; run: () => unknown }[] = [
  { name: 'bold', title: 'Bold', icon: 'ph:text-b-bold', run: () => editor.value?.chain().focus().toggleBold().run() },
  { name: 'italic', title: 'Italic', icon: 'ph:text-italic', run: () => editor.value?.chain().focus().toggleItalic().run() },
  { name: 'strike', title: 'Strikethrough', icon: 'ph:text-strikethrough', run: () => editor.value?.chain().focus().toggleStrike().run() },
  { name: 'code', title: 'Code', icon: 'ph:code', run: () => editor.value?.chain().focus().toggleCode().run() },
  { name: 'highlight', title: 'Highlight', icon: 'ph:highlighter', run: () => editor.value?.chain().focus().toggleHighlight({ color: 'yellow' }).run() },
  { name: 'link', title: 'Link', icon: 'ph:link', run: setLink },
  ...(props.objectId ? [{ name: 'quote', title: 'Save as quote', icon: 'ph:quotes', run: quote }] : []),
]
</script>

<template>
  <!-- The block handle (editor/blocks.ts) sits in a 2.5rem gutter left of the text (1.5rem on phones). The gutter is
       part of this box so the pointer can travel from a block to its handle without leaving it;
       it borrows the page's own padding, so the text does not move. -->
  <div class="relative -ml-6 pl-6 md:-ml-10 md:pl-10" data-block-gutter>
    <BubbleMenu v-if="editor" :editor="editor" class="flex gap-0.5 rounded-lg border border-line bg-surface p-0.5 shadow-lg">
      <button
        v-for="mark in marks"
        :key="mark.name"
        class="grid h-7 w-7 place-items-center rounded-md hover:bg-hover"
        :class="editor.isActive(mark.name) ? 'bg-hover text-accent' : 'text-ink-soft'"
        :title="mark.title"
        @click="mark.run"
      >
        <AppIcon :fallback="mark.icon" />
      </button>
      <button v-if="editor.isActive('link')" class="grid h-7 w-7 place-items-center rounded-md text-ink-soft hover:bg-hover" title="Remove link" @click="removeLink">
        <AppIcon fallback="ph:link-break" />
      </button>
    </BubbleMenu>
    <EditorContent :editor="editor" />
  </div>
</template>
