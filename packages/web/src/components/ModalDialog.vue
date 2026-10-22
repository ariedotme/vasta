<script setup lang="ts">
// Centered dialog with a header and scrollable body. Closes on Escape or backdrop click.
import { onBeforeUnmount, onMounted } from 'vue'
import { isPhone } from '../lib/viewport.ts'
import AppIcon from './AppIcon.vue'

defineProps<{ title: string; width?: string }>()
const emit = defineEmits<{ close: [] }>()

function onKey(event: KeyboardEvent) {
  // Popovers inside the dialog handle their own Escape first.
  if (event.key === 'Escape' && !event.defaultPrevented) emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <!-- Full screen on phones. -->
    <div class="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/25 md:px-4 md:py-[8vh]" @mousedown.self="emit('close')">
      <div
        role="dialog"
        aria-modal="true"
        :aria-label="title"
        class="flex h-full w-full flex-col overflow-hidden bg-surface pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] md:h-auto md:max-h-[84vh] md:rounded-2xl md:border md:border-line md:pb-0 md:pt-0 md:shadow-2xl"
        :style="{ maxWidth: isPhone ? undefined : width ?? '40rem' }"
      >
        <header class="flex items-center gap-2 border-b border-line px-4 py-3.5 md:px-5">
          <slot name="icon" />
          <h2 class="font-semibold">{{ title }}</h2>
          <button class="ml-auto rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink" title="Close" @click="emit('close')">
            <AppIcon fallback="ph:x" />
          </button>
        </header>
        <div class="flex-1 overflow-y-auto px-4 py-4 md:px-5">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="flex items-center gap-2 border-t border-line px-5 py-3">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>
