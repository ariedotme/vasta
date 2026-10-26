<script setup lang="ts">
// A Mermaid diagram outside the editor (DocPreview): drawn by lib/mermaid.ts, or its code when it
// cannot be drawn.
import type { Mounted } from 'pele/lazy'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { mountDiagram } from '../lib/mermaid.ts'

const props = defineProps<{ text: string }>()
const canvas = ref<HTMLElement | null>(null)
const failed = ref(false)
let mounted: Mounted | undefined
let gone = false

onMounted(async () => {
  if (!canvas.value) return
  const result = await mountDiagram(canvas.value, props.text, (message) => (failed.value = !!message))
  if (gone) result.destroy()
  else mounted = result
})
onBeforeUnmount(() => {
  gone = true
  mounted?.destroy()
})
</script>

<template>
  <div v-show="!failed" ref="canvas" class="my-1 overflow-x-auto" />
  <pre v-if="failed" class="my-1 overflow-x-auto rounded-lg bg-hover p-2 text-xs">{{ text }}</pre>
</template>
