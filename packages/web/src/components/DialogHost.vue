<script setup lang="ts">
// Renders the active prompt/confirm dialog from lib/overlays.ts.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { activeDialog } from '../lib/overlays.ts'

const text = ref('')
const input = ref<HTMLInputElement | null>(null)
const confirmButton = ref<HTMLButtonElement | null>(null)
const firstChoice = ref<HTMLButtonElement[] | null>(null)
const blocked = computed(() => {
  const dialog = activeDialog.value
  if (dialog?.kind === 'prompt') return !dialog.optional && !text.value.trim()
  if (dialog?.kind === 'choice') return false
  return !!dialog?.requireText && text.value.trim() !== dialog.requireText.trim()
})

watch(activeDialog, async (dialog) => {
  if (!dialog) return
  text.value = dialog.kind === 'prompt' ? dialog.value : ''
  await nextTick()
  if (dialog.kind === 'choice') firstChoice.value?.[0]?.focus()
  else if (dialog.kind === 'prompt' || dialog.requireText) {
    input.value?.focus()
    input.value?.select()
  } else confirmButton.value?.focus()
})

function cancel() {
  const dialog = activeDialog.value
  if (dialog?.kind === 'prompt' || dialog?.kind === 'choice') dialog.resolve(null)
  else dialog?.resolve(false)
}

function accept() {
  const dialog = activeDialog.value
  if (dialog?.kind === 'choice') return
  if (dialog?.kind === 'prompt') {
    if (text.value.trim() || dialog.optional) dialog.resolve(text.value)
  } else if (dialog && !blocked.value) dialog.resolve(true)
}

function onKey(event: KeyboardEvent) {
  if (!activeDialog.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopImmediatePropagation()
    cancel()
  }
}
// Capture phase so Escape closes this dialog before anything underneath reacts.
onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <Teleport to="body">
    <div v-if="activeDialog" class="fixed inset-0 z-[60] flex items-start justify-center bg-black/25 px-4 pt-[18vh]" @mousedown.self="cancel">
      <form class="w-full max-w-md rounded-2xl border border-line bg-surface p-5 shadow-2xl" @submit.prevent="accept">
        <h2 class="font-semibold">{{ activeDialog.title }}</h2>
        <p v-if="activeDialog.message" class="mt-1.5 text-sm text-ink-soft">{{ activeDialog.message }}</p>
        <div v-if="activeDialog.kind === 'choice'" class="mt-4 flex flex-col gap-1.5">
          <button
            v-for="choice in activeDialog.choices"
            :key="choice.value"
            ref="firstChoice"
            type="button"
            class="rounded-lg border border-line px-3 py-2 text-left text-sm hover:bg-hover focus:border-line-strong focus:outline-none"
            :class="choice.danger ? 'text-red-600' : ''"
            @click="activeDialog.resolve(choice.value)"
          >
            {{ choice.label }}
          </button>
        </div>
        <input
          v-else-if="activeDialog.kind === 'prompt' || activeDialog.requireText"
          ref="input"
          v-model="text"
          class="mt-4 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-line-strong"
          :placeholder="activeDialog.kind === 'prompt' ? activeDialog.placeholder : activeDialog.requireText"
          :aria-label="activeDialog.kind === 'confirm' ? `Type ${activeDialog.requireText} to confirm` : undefined"
          autocapitalize="off"
          autocomplete="off"
        />
        <div class="mt-5 flex justify-end gap-2">
          <button type="button" class="rounded-lg px-3 py-1.5 text-sm hover:bg-hover" @click="cancel">Cancel</button>
          <button
            v-if="activeDialog.kind !== 'choice'"
            ref="confirmButton"
            type="submit"
            class="rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-40"
            :class="activeDialog.kind === 'confirm' && activeDialog.danger ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-ink text-surface hover:opacity-90'"
            :disabled="blocked"
          >
            {{ activeDialog.confirmLabel }}
          </button>
        </div>
      </form>
    </div>
  </Teleport>
</template>
