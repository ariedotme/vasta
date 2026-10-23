<script setup lang="ts">
// Quick capture (the desktop app's global shortcut): a text goes into today's note of the user's
// capture space (Settings › Account), or the open space when none is set, as a captured item, like
// a Telegram message. Online the server takes it (links become
// weblinks); offline the local replica does, and it syncs later. "/" and a type's name make an
// object of that type instead ("/Book Dune author:x"), embedded in the note; "/" lists the types,
// and a relation's or a select's `name:` lists its objects or options. "/food …" logs what was
// eaten on today's note instead, offering the foods at the cursor.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { foodCommand, type ObjectSummary, type ObjectType } from '@vasta/core'
import { captureSpace, captureText, completionSource, dayKey, typesOf } from '../lib/actions.ts'
import { foodSourcesOf, previewFoodLine } from '../lib/nutrition.ts'
import { isDesktop } from '../lib/platform.ts'
import { meId, people } from '../lib/people.ts'
import { notice, ui } from '../lib/state.ts'
import { previewLine, typedLine, type Completion } from '../lib/typed-line.ts'
import { templates } from '../lib/templates.ts'
import { useCompletions } from '../lib/use-completions.ts'
import AppIcon from './AppIcon.vue'
import ModalDialog from './ModalDialog.vue'

const text = ref('')
const error = ref('')
const saving = ref(false)
const field = ref<HTMLTextAreaElement>()
const types = ref<ObjectType[]>([])
const cursor = ref(0)

const close = () => (ui.captureOpen = false)

const space = computed(captureSpace)

onMounted(async () => {
  await nextTick()
  field.value?.focus()
  if (space.value) types.value = await typesOf(space.value).catch(() => [])
})

const source = computed(() => (space.value ? completionSource(space.value.id, types.value) : undefined))
const { shown, active, dismiss, move, current } = useCompletions(text, cursor, () => source.value)
const readCursor = () => (cursor.value = field.value?.selectionStart ?? text.value.length)
watch(text, () => nextTick(readCursor))

const typed = computed(() => typedLine(types.value, text.value))
const preview = computed(() => (typed.value ? previewLine(typed.value.type, typed.value.rest, dayKey(), people.list, meId(), space.value?.id === templates.spaceId ? templates.list : []) : undefined))

// A line of food: what it will log, against the space's foods (loaded once one is typed).
const eaten = computed(() => foodCommand(text.value))
const foods = ref<ObjectSummary[] | null>(null)
watch(eaten, async (value) => {
  if (value === undefined || foods.value) return
  foods.value = []
  foods.value = await foodSourcesOf(types.value).catch(() => [])
})
const foodPreview = computed(() => (eaten.value !== undefined && space.value ? previewFoodLine(eaten.value, space.value, foods.value ?? [], dayKey()) : undefined))

async function pick(item: Completion) {
  text.value = item.text
  await nextTick()
  field.value?.focus()
  field.value?.setSelectionRange(item.cursor, item.cursor)
  cursor.value = item.cursor
}

async function save() {
  if (!text.value.trim() || !space.value || saving.value) return
  saving.value = true
  error.value = ''
  try {
    const { space: saved, answer, food } = await captureText(text.value, isDesktop ? 'desktop' : 'app')
    if (food) {
      notice.value = { message: food.summary.replace(/\n/g, ' ') }
      close()
      return
    }
    const unread = answer.unreadable?.length ? ` Could not read ${answer.unreadable.join('; ')}.` : ''
    notice.value = { message: answer.summary ? `${answer.summary}, in today’s note in ${saved.name}.${unread}` : `Captured to today’s note in ${saved.name}` }
    close()
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : String(failure)
  } finally {
    saving.value = false
  }
}

function onKey(event: KeyboardEvent) {
  if (shown.value.length) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      move(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void pick(current()!)
      return
    }
    if (event.key === 'Escape') {
      // Puts the list away; the next Esc closes the dialog.
      event.preventDefault()
      dismiss()
      return
    }
  }
  // Enter saves; Shift+Enter starts a new line.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void save()
  }
}
</script>

<template>
  <ModalDialog title="Quick capture" width="34rem" @close="close">
    <template #icon><AppIcon fallback="ph:lightning" class="text-ink-soft" /></template>
    <textarea
      ref="field"
      v-model="text"
      rows="4"
      class="w-full resize-none rounded-xl border border-line bg-raised px-3 py-2.5 outline-none focus:border-line-strong"
      placeholder="A thought, a link, a task… or / for an object of a type"
      @keydown="onKey"
      @keyup="readCursor"
      @click="readCursor"
    />
    <div v-if="shown.length" class="mt-1 max-h-64 overflow-y-auto rounded-xl border border-line bg-surface p-1" role="listbox" aria-label="Suggestions">
      <button
        v-for="(item, i) in shown"
        :key="`${i}-${item.label}`"
        role="option"
        :aria-selected="i === active"
        class="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm"
        :class="i === active ? 'bg-hover' : ''"
        @mouseenter="active = i"
        @mousedown.prevent="pick(item)"
      >
        <AppIcon :icon="item.icon" fallback="ph:cube" :size="16" class="text-ink-soft" />
        <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
        <span v-if="item.detail" class="shrink-0 text-xs text-ink-faint">{{ item.detail }}</span>
      </button>
    </div>
    <p v-if="error" class="mt-2 text-sm text-red-600 dark:text-red-400">{{ error }}</p>
    <div v-if="foodPreview" class="mt-2 space-y-0.5 text-xs text-ink-faint" data-testid="capture-preview">
      <p class="text-ink-soft">{{ foodPreview.text }}</p>
      <p v-if="foodPreview.problem" class="text-amber-700 dark:text-amber-400">{{ foodPreview.problem }}</p>
    </div>
    <div v-else-if="typed && preview" class="mt-2 space-y-0.5 text-xs text-ink-faint" data-testid="capture-preview">
      <p>
        <span class="text-ink-soft">New {{ typed.type.name }}</span>
        <template v-if="preview.title"> “{{ preview.title }}”</template>
        <template v-if="preview.template"> · from {{ preview.template }}</template>
        <template v-if="preview.parts.length"> · {{ preview.parts.join(', ') }}</template>
        <span>, in today’s note in {{ space?.name }}.</span>
      </p>
      <p v-if="preview.errors.length" class="text-amber-700 dark:text-amber-400">Cannot read {{ preview.errors.join('; ') }}; it stays in the title.</p>
      <p v-else-if="!preview.parts.length && preview.properties.length">name:value sets {{ preview.properties.join(', ') }}.</p>
    </div>
    <p v-else class="mt-2 text-xs text-ink-faint">Goes to today’s note in {{ space?.name }}. Enter saves, Shift+Enter adds a line.</p>
    <template #footer>
      <button class="ml-auto rounded-lg px-3 py-1.5 text-sm hover:bg-hover" @click="close">Cancel</button>
      <button class="rounded-lg bg-ink px-3 py-1.5 text-sm text-surface disabled:opacity-50" :disabled="!text.trim() || saving" @click="save">Capture</button>
    </template>
  </ModalDialog>
</template>
