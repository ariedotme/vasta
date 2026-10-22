<script setup lang="ts">
// Shows the last error an action reported (lastError) and the last notice (e.g. "Moved to the
// trash · Undo") for a few seconds each.
import { ref, watch } from 'vue'
import { lastError, notice } from '../lib/state.ts'
import AppIcon from './AppIcon.vue'

let errorTimer: ReturnType<typeof setTimeout> | undefined
watch(lastError, (message) => {
  clearTimeout(errorTimer)
  if (message) errorTimer = setTimeout(() => (lastError.value = ''), 6000)
})

let noticeTimer: ReturnType<typeof setTimeout> | undefined
watch(notice, (value) => {
  clearTimeout(noticeTimer)
  if (value) noticeTimer = setTimeout(() => (notice.value = null), value.action ? 8000 : 4000)
})

const running = ref(false)
async function runAction() {
  const action = notice.value?.action
  if (!action || running.value) return
  running.value = true
  try {
    await action.run()
    notice.value = null
  } catch (error) {
    lastError.value = (error as Error).message
  } finally {
    running.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="pointer-events-none fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-50 flex w-max max-w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 flex-col items-center gap-2">
      <div v-if="notice" class="pointer-events-auto flex max-w-full items-center gap-2 rounded-xl border border-line bg-surface py-1.5 pl-3 pr-1.5 text-sm shadow-lg" role="status">
        <span class="min-w-0 flex-1">{{ notice.message }}</span>
        <button
          v-if="notice.action"
          class="shrink-0 rounded-lg px-2.5 py-1 font-medium text-accent hover:bg-hover disabled:opacity-50 max-md:py-2"
          :disabled="running"
          @click="runAction"
        >
          {{ notice.action.label }}
        </button>
        <button class="shrink-0 rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink" title="Dismiss" @click="notice = null"><AppIcon fallback="ph:x" :size="14" /></button>
      </div>
      <div v-if="lastError" class="pointer-events-auto flex max-w-full items-center gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-sm shadow-lg" role="alert">
        <AppIcon fallback="ph:warning-circle" class="shrink-0 text-red-600" />
        <span class="min-w-0 flex-1">{{ lastError }}</span>
        <button class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink" title="Dismiss" @click="lastError = ''"><AppIcon fallback="ph:x" :size="14" /></button>
      </div>
    </div>
  </Teleport>
</template>
