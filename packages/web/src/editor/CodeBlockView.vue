<script setup lang="ts">
// A code block. In "mermaid" it shows the diagram (lib/mermaid.ts), and its code while the cursor is
// in it (clicking the diagram puts it there), or while it is empty or cannot be drawn. The code stays
// in the page, hidden, so the editor and other devices keep editing the same text.
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import type { Mounted } from 'pele/lazy'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { MERMAID, mountDiagram } from '../lib/mermaid.ts'

const props = defineProps(nodeViewProps)
const isDiagram = computed(() => props.node.attrs.language === MERMAID)
const text = computed(() => props.node.textContent)

const canvas = ref<HTMLElement | null>(null)
const error = ref<string | null>(null)
let mounted: Mounted | undefined
let timer: ReturnType<typeof setTimeout> | undefined
/** Counts draws, so one that finishes after a later one (Pele loading) is dropped. */
let drawing = 0

async function draw() {
  const turn = ++drawing
  mounted?.destroy()
  mounted = undefined
  if (!canvas.value || !isDiagram.value || !text.value.trim()) {
    error.value = null
    return
  }
  const result = await mountDiagram(canvas.value, text.value, (message) => {
    if (turn === drawing) error.value = message
  })
  if (turn === drawing) mounted = result
  else result.destroy()
}

// Redrawn a moment after typing stops.
watch([text, isDiagram], () => {
  clearTimeout(timer)
  timer = setTimeout(draw, 250)
})
onMounted(draw)
onBeforeUnmount(() => {
  clearTimeout(timer)
  mounted?.destroy()
})

/** Whether the selection is inside this block. */
const inside = ref(false)
function track() {
  const pos = props.getPos()
  if (typeof pos !== 'number') return
  const { from, to } = props.editor.state.selection
  inside.value = from > pos && to < pos + props.node.nodeSize
}
onMounted(() => {
  track()
  props.editor.on('selectionUpdate', track)
  props.editor.on('update', track)
})
onBeforeUnmount(() => {
  props.editor.off('selectionUpdate', track)
  props.editor.off('update', track)
})

const showCode = computed(() => !isDiagram.value || inside.value || !text.value.trim() || !!error.value)

function editCode() {
  const pos = props.getPos()
  if (!props.editor.isEditable || typeof pos !== 'number') return
  props.editor.chain().focus().setTextSelection(pos + 1 + props.node.content.size).run()
}
</script>

<template>
  <NodeViewWrapper v-if="isDiagram" class="my-2" data-diagram>
    <div
      v-show="text.trim() && !error"
      ref="canvas"
      contenteditable="false"
      class="overflow-x-auto rounded-lg py-2"
      :class="editor.isEditable ? 'cursor-text hover:bg-hover/60' : ''"
      :title="editor.isEditable && !inside ? 'Edit the diagram' : undefined"
      @click="editCode"
    />
    <pre v-show="showCode" :class="error ? 'border-red-300 dark:border-red-900' : ''"><NodeViewContent as="code" /></pre>
    <div v-if="error && text.trim()" contenteditable="false" class="mt-1 select-none whitespace-pre-wrap font-mono text-xs text-red-600 dark:text-red-400" data-diagram-error>{{ error }}</div>
    <p v-else-if="!text.trim() && editor.isEditable" contenteditable="false" class="mt-1 select-none text-xs text-ink-faint">
      A Mermaid diagram: try <code>flowchart LR</code> and <code>A --> B</code> on the next line.
    </p>
  </NodeViewWrapper>
  <NodeViewWrapper v-else as="pre"><NodeViewContent as="code" /></NodeViewWrapper>
</template>
