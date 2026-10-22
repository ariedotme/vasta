<script setup lang="ts">
// Floating panel anchored to an element. Closes on outside click or Escape.
import { autoUpdate, computePosition, flip, offset, shift, type Placement } from '@floating-ui/dom'
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{ anchor: HTMLElement | null | undefined; placement?: Placement; width?: string }>()
const open = defineModel<boolean>('open', { required: true })
const panel = ref<HTMLElement | null>(null)
let stop: (() => void) | undefined

async function position() {
  if (!props.anchor || !panel.value) return
  const { x, y } = await computePosition(props.anchor, panel.value, {
    placement: props.placement ?? 'bottom-start',
    middleware: [offset(6), flip(), shift({ padding: 8, crossAxis: true })],
  })
  Object.assign(panel.value.style, { left: `${x}px`, top: `${y}px` })
}

function onPointerDown(event: PointerEvent) {
  const target = event.target as Node
  if (panel.value?.contains(target) || props.anchor?.contains(target)) return
  open.value = false
}

function onKey(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  // Mark the event handled so an enclosing dialog stays open.
  event.preventDefault()
  open.value = false
}

watch(
  open,
  async (value) => {
    stop?.()
    stop = undefined
    if (!value) {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey)
      return
    }
    await nextTick()
    if (props.anchor && panel.value) stop = autoUpdate(props.anchor, panel.value, position)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey)
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  stop?.()
  document.removeEventListener('pointerdown', onPointerDown, true)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="panel"
      data-overlay
      class="fixed left-0 top-0 z-50 max-h-[70vh] overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-xl shadow-black/10"
      :style="{ width: width ?? '16rem', maxWidth: 'calc(100vw - 16px)' }"
    >
      <slot />
    </div>
  </Teleport>
</template>
