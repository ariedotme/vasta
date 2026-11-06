<script setup lang="ts">
// One block of another object (an embed with `blockId`): a read-only copy that follows the
// original, shown by an editor that cannot be edited so it looks as it does there. "Open" goes to
// the block. Inside an embedded block another one is only a link, so a block cannot embed itself
// endlessly.
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { blockAsDoc, findBlock, type ObjectRecord } from '@vasta/core'
import { computed, inject, onBeforeUnmount, provide, ref, watch } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import { api } from '../lib/api.ts'
import { iconTextClasses } from '../lib/colors.ts'
import { onChange } from '../lib/events.ts'
import { displayTitle } from '../lib/format.ts'
import { BLOCK_EMBED_DEPTH } from '../lib/page.ts'
import { summaryOf, typesById } from '../lib/state.ts'
import { createExtensions } from './extensions.ts'
import { openObject } from '../lib/open.ts'

const props = defineProps<{ objectId: string; blockId: string }>()
const depth = inject(BLOCK_EMBED_DEPTH, 0)
provide(BLOCK_EMBED_DEPTH, depth + 1)

const object = ref<ObjectRecord>()
const failed = ref(false)
const summary = computed(() => summaryOf(props.objectId) ?? object.value)
const type = computed(() => typesById.value.get(summary.value?.typeId ?? ''))
const found = computed(() => (object.value ? findBlock(object.value, props.blockId) : undefined))
const open = () => openObject(props.objectId, { block: props.blockId })

async function load() {
  if (depth > 0) return
  try {
    object.value = await api.object(props.objectId)
    failed.value = false
  } catch {
    failed.value = true
  }
}
void load()
// The original changed (here, on another device, or by a capture): show it as it is now.
const stop = onChange((event) => {
  if (event.kind === 'object' && event.id === props.objectId) void load()
})

const editor = useEditor({
  editable: false,
  content: { type: 'doc', content: [{ type: 'paragraph' }] },
  extensions: createExtensions(''),
  editorProps: { attributes: { class: 'vasta-doc' } },
})
watch(
  [found, editor],
  ([block, current]) => {
    if (block && current) current.commands.setContent(blockAsDoc(block.node), { emitUpdate: false })
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  stop()
  editor.value?.destroy()
})
</script>

<template>
  <div class="rounded-lg border border-line bg-surface" data-testid="block-embed">
    <div class="flex items-center gap-1.5 border-b border-line px-2.5 py-1 text-xs text-ink-faint">
      <AppIcon :icon="summary?.icon ?? type?.icon" fallback="ph:file-text" :size="13" :class="type?.color ? iconTextClasses[type.color] : ''" />
      <span class="min-w-0 truncate">{{ displayTitle(summary, type) }}</span>
      <button class="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover hover:text-ink" title="Open the block where it is" @click="open">
        Open <AppIcon fallback="ph:arrow-up-right" :size="12" />
      </button>
    </div>
    <div class="px-3 py-1.5">
      <EditorContent v-if="depth === 0 && found" :editor="editor" class="vasta-block-embed" />
      <button v-else-if="depth > 0" class="text-sm text-accent hover:underline" @click="open">A block of {{ displayTitle(summary, type) }}</button>
      <p v-else-if="failed || object" class="text-sm text-ink-faint">{{ failed ? 'This object cannot be opened.' : 'The block is not there any more.' }}</p>
      <p v-else class="text-sm text-ink-faint">Loading…</p>
    </div>
  </div>
</template>
