<script setup lang="ts">
// Comments on an object (core comments.ts): the thread, oldest first, and a box to write one;
// @ offers the space's members. Authors edit and delete their own. Each comment is a prop of the
// object, written on its own, so it works offline and merges with what others write meanwhile.
import { computed, nextTick, ref, watch } from 'vue'
import type { Id, ObjectRecord } from '@vasta/core'
import { addComment, commentsOf, deleteComment, editComment } from '@vasta/core'
import { api } from '../lib/api.ts'
import { formatRelative } from '../lib/format.ts'
import { meId, people, personName, sharedSpace } from '../lib/people.ts'
import { lastError, primeFromObject } from '../lib/state.ts'
import AppIcon from './AppIcon.vue'
import PersonAvatar from './PersonAvatar.vue'

// The page's own saves leave the comments alone: they write only the fields they changed.
const props = defineProps<{ object: ObjectRecord }>()

// The newer of the page's copy and the last one saved here.
const latest = ref<ObjectRecord>(props.object)
watch(
  () => props.object,
  (object) => {
    if (object.id !== latest.value.id || object.updatedAt >= latest.value.updatedAt) latest.value = object
  }
)
const comments = computed(() => commentsOf(latest.value))
const now = () => new Date().toISOString()

async function change(apply: (object: ObjectRecord) => void) {
  const me = meId()
  if (!me) return
  try {
    const object = await api.object(props.object.id)
    apply(object)
    const saved = await api.saveObject(object)
    latest.value = saved
    primeFromObject(saved)
  } catch (error) {
    lastError.value = (error as Error).message
  }
}

// Writing ------------------------------------------------------------------------
const draft = ref('')
const box = ref<HTMLTextAreaElement | null>(null)
const sending = ref(false)
async function send() {
  const text = draft.value.trim()
  const me = meId()
  if (!text || !me || sending.value) return
  sending.value = true
  await change((object) => addComment(object, me, text, now()))
  draft.value = ''
  sending.value = false
  mention.value = null
}

// @ offers the members whose username or name starts with what follows it.
const mention = ref<{ start: number; query: string } | null>(null)
const choice = ref(0)
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
const offered = computed(() => {
  if (!mention.value) return []
  const wanted = fold(mention.value.query)
  return people.list.filter((p) => fold(p.username).startsWith(wanted) || fold(p.name).split(/\s+/).some((w) => w.startsWith(wanted))).slice(0, 6)
})
function typed(event: Event) {
  const area = event.target as HTMLTextAreaElement
  const before = area.value.slice(0, area.selectionStart)
  const match = /(?:^|\s)@([\w.-]*)$/.exec(before)
  mention.value = match ? { start: area.selectionStart - match[1]!.length - 1, query: match[1]! } : null
  choice.value = 0
  area.style.height = 'auto'
  area.style.height = `${Math.min(area.scrollHeight, 320)}px`
}
async function pick(username: string) {
  const area = box.value
  if (!area || !mention.value) return
  const end = area.selectionStart
  const written = `@${username} `
  draft.value = draft.value.slice(0, mention.value.start) + written + draft.value.slice(end)
  const cursor = mention.value.start + written.length
  mention.value = null
  await nextTick()
  area.focus()
  area.setSelectionRange(cursor, cursor)
}
function keydown(event: KeyboardEvent) {
  if (mention.value && offered.value.length) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      choice.value = (choice.value + (event.key === 'ArrowDown' ? 1 : offered.value.length - 1)) % offered.value.length
      return
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      void pick(offered.value[choice.value]!.username)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      mention.value = null
      return
    }
  }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault()
    void send()
  }
}

// Editing one's own ---------------------------------------------------------------
const editing = ref<Id | null>(null)
const editText = ref('')
function startEdit(id: Id, text: string) {
  editing.value = id
  editText.value = text
}
async function saveEdit(id: Id) {
  const me = meId()
  const text = editText.value.trim()
  editing.value = null
  if (!me || !text || text === comments.value.find((c) => c.id === id)?.text) return
  await change((object) => editComment(object, id, me, text, now()))
}
async function remove(id: Id) {
  const me = meId()
  if (me) await change((object) => deleteComment(object, id, me))
}

// A comment's text in pieces: plain text, @members and links.
type Piece = { kind: 'text' | 'mention' | 'link'; text: string }
function pieces(text: string): Piece[] {
  const out: Piece[] = []
  const pattern = /(@[\w.-]+)|(https?:\/\/[^\s<>]+[^\s<>.,;:!?)\]])/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index!
    if (index > last) out.push({ kind: 'text', text: text.slice(last, index) })
    const member = match[1] && people.list.find((p) => p.username.toLowerCase() === match[1]!.slice(1).toLowerCase().replace(/[.-]+$/, ''))
    out.push({ kind: match[2] ? 'link' : member ? 'mention' : 'text', text: match[0] })
    last = index + match[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}
</script>

<template>
  <!-- A space with nobody else: only once something was said (an agent's note, say). -->
  <section v-if="sharedSpace || comments.length" class="mt-10">
    <h2 class="mb-3 flex items-center gap-1.5 text-sm font-semibold text-ink-soft">
      Comments <span v-if="comments.length" class="font-normal text-ink-faint">{{ comments.length }}</span>
    </h2>
    <ol class="space-y-4">
      <li v-for="comment in comments" :key="comment.id" class="group/comment flex gap-2.5">
        <PersonAvatar :id="comment.author" :size="26" class="mt-0.5" />
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2 text-sm">
            <span class="font-medium">{{ personName(comment.author) }}</span>
            <span class="text-xs text-ink-faint" :title="new Date(comment.at).toLocaleString()">{{ formatRelative(comment.at) }}<template v-if="comment.editedAt"> · edited</template></span>
            <span v-if="comment.author === meId() && editing !== comment.id" class="ml-auto flex gap-0.5 opacity-0 group-hover/comment:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
              <button class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink" title="Edit" @click="startEdit(comment.id, comment.text)"><AppIcon fallback="ph:pencil-simple" :size="13" /></button>
              <button class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-red-600" title="Delete" @click="remove(comment.id)"><AppIcon fallback="ph:trash" :size="13" /></button>
            </span>
          </div>
          <form v-if="editing === comment.id" class="mt-1" @submit.prevent="saveEdit(comment.id)">
            <textarea
              v-model="editText"
              rows="3"
              class="w-full resize-y rounded-lg border border-line-strong bg-surface px-2.5 py-1.5 text-sm outline-none"
              aria-label="Edit comment"
              @keydown.enter.meta.prevent="saveEdit(comment.id)"
              @keydown.enter.ctrl.prevent="saveEdit(comment.id)"
              @keydown.esc="editing = null"
            />
            <div class="mt-1 flex gap-2 text-sm">
              <button type="submit" class="rounded-lg bg-ink px-2.5 py-1 font-medium text-surface">Save</button>
              <button type="button" class="rounded-lg px-2.5 py-1 text-ink-soft hover:bg-hover" @click="editing = null">Cancel</button>
            </div>
          </form>
          <p v-else class="mt-0.5 whitespace-pre-wrap break-words text-sm text-ink"><template v-for="(piece, i) in pieces(comment.text)" :key="i"><a v-if="piece.kind === 'link'" :href="piece.text" target="_blank" rel="noopener noreferrer" class="text-accent hover:underline">{{ piece.text }}</a><span v-else-if="piece.kind === 'mention'" class="rounded bg-accent/10 px-0.5 font-medium text-accent">{{ piece.text }}</span><template v-else>{{ piece.text }}</template></template></p>
        </div>
      </li>
    </ol>
    <form class="relative mt-4 flex gap-2.5" @submit.prevent="send">
      <PersonAvatar v-if="meId()" :id="meId()!" :size="26" class="mt-1" />
      <div class="min-w-0 flex-1">
        <textarea
          ref="box"
          v-model="draft"
          rows="1"
          class="block w-full resize-none rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-line-strong"
          :placeholder="sharedSpace ? 'Write a comment… @ mentions someone' : 'Write a comment…'"
          aria-label="Write a comment"
          @input="typed"
          @keydown="keydown"
        />
        <ul v-if="mention && offered.length" class="absolute z-20 mt-1 w-64 rounded-lg border border-line bg-surface p-1 shadow-lg" role="listbox" aria-label="People">
          <li v-for="(person, index) in offered" :key="person.id">
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm"
              :class="index === choice ? 'bg-hover' : ''"
              role="option"
              :aria-selected="index === choice"
              @mousedown.prevent="pick(person.username)"
            >
              <PersonAvatar :id="person.id" :size="18" />{{ person.name }}<span class="text-xs text-ink-faint">@{{ person.username }}</span>
            </button>
          </li>
        </ul>
        <div v-if="draft.trim()" class="mt-1.5 flex items-center gap-2">
          <button type="submit" class="rounded-lg bg-ink px-3 py-1 text-sm font-medium text-surface disabled:opacity-40" :disabled="sending">Comment</button>
          <span class="text-xs text-ink-faint">⌘ Enter</span>
        </div>
      </div>
    </form>
  </section>
</template>
