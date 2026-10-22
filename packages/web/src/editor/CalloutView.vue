<script setup lang="ts">
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import type { CaptureInfo, ColorName, Icon } from '@vasta/core'
import { computed } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import { formatCaptureTime, formatChannel } from '../lib/format.ts'
import { reviewed } from '../lib/inbox.ts'
import { blockBackgroundClasses, blockTextClasses } from '../lib/colors.ts'

const props = defineProps(nodeViewProps)
const icon = computed(() => props.node.attrs.icon as Icon | null)
/** Items that came through a capture channel show the channel icon and the time they arrived. */
const capture = computed(() => props.node.attrs.capture as CaptureInfo | null)
/** The block menu's colors; a background replaces the callout's own. */
const colors = computed(() => {
  const { textColor, background } = props.node.attrs as { textColor: ColorName | null; background: ColorName | null }
  return [background ? blockBackgroundClasses[background] : 'bg-raised', textColor ? blockTextClasses[textColor] : '']
})

/** Reviewed items (also set from the inbox) keep the check, and fade if the user chose so; the check toggles it. */
function toggleDone() {
  if (!capture.value) return
  const { done, ...rest } = capture.value
  props.updateAttributes({ capture: done ? rest : { ...rest, done: true } })
}
</script>

<template>
  <NodeViewWrapper
    v-if="capture"
    class="group/capture my-1.5 rounded-xl px-3 py-2 ring-1 ring-line transition-opacity"
    :class="[colors, capture.done && reviewed.fade ? 'opacity-55' : '']"
    :data-capture-id="capture.id"
  >
    <div contenteditable="false" class="flex select-none items-center gap-1.5 text-xs text-ink-faint">
      <AppIcon :icon="icon ?? undefined" fallback="ph:tray-arrow-down" :size="15" class="text-ink-soft" />
      <span class="tabular-nums" :title="`${formatChannel(capture.channel)} · ${new Date(capture.at).toLocaleString()}`">{{ formatCaptureTime(capture.at) }}</span>
      <button
        v-if="editor.isEditable"
        class="-my-1 ml-auto flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-hover hover:text-ink"
        :class="capture.done ? 'text-green-600' : 'opacity-0 focus-visible:opacity-100 group-hover/capture:opacity-100 [@media(hover:none)]:opacity-100'"
        :title="capture.done ? `Mark not ${reviewed.lower}` : `Mark ${reviewed.lower}`"
        @click="toggleDone"
      >
        <AppIcon :fallback="capture.done ? 'ph:check-circle-fill' : 'ph:check-circle'" :size="15" />
        <span v-if="capture.done">{{ reviewed.word }}</span>
      </button>
    </div>
    <NodeViewContent class="mt-0.5 min-w-0" />
  </NodeViewWrapper>
  <NodeViewWrapper v-else class="my-1 flex gap-2.5 rounded-xl px-3 py-2 ring-1 ring-line" :class="colors">
    <span contenteditable="false" class="mt-[3px] select-none text-ink-soft">
      <AppIcon :icon="icon ?? undefined" fallback="ph:info" :size="18" />
    </span>
    <NodeViewContent class="min-w-0 flex-1" />
  </NodeViewWrapper>
</template>
