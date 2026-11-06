<script setup lang="ts">
// The side pane: an object open next to the page that is showing (lib/open.ts keeps which one in
// the address). It is dragged wider or narrower by its left edge, and keeps its width on this
// device. Phones have no room for it, and the page of the same object needs no pane: an address
// with one opens the page instead.
import { defineAsyncComponent, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { closePane, expandPane, pageObjectId, paneBlockId, paneObjectId } from '../lib/open.ts'
import { isPhone } from '../lib/viewport.ts'
import AppIcon from './AppIcon.vue'

// The object page is its own chunk (router.ts); the pane waits for it the same way.
const ObjectPage = defineAsyncComponent(() => import('../views/ObjectPage.vue'))

const WIDTH_KEY = 'vasta.pane-width'
const MIN_WIDTH = 360
const DEFAULT_WIDTH = 520
/** The page behind keeps at least this much room. */
const PAGE_ROOM = 420

function readWidth() {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY))
    return value >= MIN_WIDTH ? value : DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

const width = ref(readWidth())
const clamp = (value: number) => Math.round(Math.max(MIN_WIDTH, Math.min(value, window.innerWidth - PAGE_ROOM)))

watch(
  [paneObjectId, pageObjectId, isPhone],
  ([pane, page, phone]) => {
    if (!pane) return
    if (phone) void expandPane(true)
    else if (pane === page) void closePane(true)
  },
  { immediate: true }
)

// Focus goes into the pane when it opens, and back to what opened it when it closes.
const pane = ref<HTMLElement | null>(null)
let opener: HTMLElement | null = null
watch(paneObjectId, async (id, before) => {
  if (id && !before) {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    await nextTick()
    pane.value?.focus({ preventScroll: true })
  } else if (!id && before) {
    if (opener?.isConnected) opener.focus({ preventScroll: true })
    opener = null
  }
})

let drag: { x: number; width: number } | undefined
function startResize(event: PointerEvent) {
  if (event.button !== 0) return
  event.preventDefault()
  drag = { x: event.clientX, width: width.value }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function resize(event: PointerEvent) {
  if (drag) width.value = clamp(drag.width + drag.x - event.clientX)
}
function endResize() {
  if (!drag) return
  drag = undefined
  try {
    localStorage.setItem(WIDTH_KEY, String(width.value))
  } catch {}
}
function resizeByKey(event: KeyboardEvent) {
  const step = event.key === 'ArrowLeft' ? 32 : event.key === 'ArrowRight' ? -32 : 0
  if (!step) return
  event.preventDefault()
  width.value = clamp(width.value + step)
  endResize()
}

// A smaller window can leave the stored width too wide for it.
const fit = () => (width.value = clamp(width.value))
window.addEventListener('resize', fit)
onBeforeUnmount(() => window.removeEventListener('resize', fit))
</script>

<template>
  <section
    v-if="paneObjectId && !isPhone"
    ref="pane"
    tabindex="-1"
    aria-label="Side pane"
    data-side-pane
    class="relative mb-2 mr-2 flex shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-[0_1px_3px_rgb(0_0_0/0.04)] outline-none"
    :style="{ width: `${width}px` }"
  >
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side pane"
      :aria-valuenow="width"
      tabindex="0"
      class="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/30 focus-visible:bg-accent/40 focus-visible:outline-none"
      @pointerdown="startResize"
      @pointermove="resize"
      @pointerup="endResize"
      @pointercancel="endResize"
      @keydown="resizeByKey"
    />
    <div class="flex shrink-0 items-center justify-end gap-0.5 border-b border-line px-2 py-1 text-ink-soft">
      <button class="grid h-7 w-7 place-items-center rounded-md hover:bg-hover hover:text-ink" title="Open full page" @click="expandPane()">
        <AppIcon fallback="ph:arrows-out-simple" :size="15" />
      </button>
      <button class="grid h-7 w-7 place-items-center rounded-md hover:bg-hover hover:text-ink" title="Close (Esc)" @click="closePane()">
        <AppIcon fallback="ph:x" :size="15" />
      </button>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <ObjectPage :id="paneObjectId" :key="paneObjectId" variant="pane" :block="paneBlockId" />
    </div>
  </section>
</template>
