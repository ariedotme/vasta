<script setup lang="ts">
// A template's placeholder ({{date}}, {{ask:With whom?}}) as a chip; a click edits what is in it.
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { parsePlaceholder } from '@vasta/core'
import { computed } from 'vue'
import { promptDialog } from '../lib/overlays.ts'

const props = defineProps(nodeViewProps)
const value = computed(() => String(props.node.attrs.value ?? ''))
const known = computed(() => !!parsePlaceholder(value.value))

async function edit() {
  if (!props.editor.isEditable) return
  const next = await promptDialog({
    title: 'Placeholder',
    message: 'What goes between the braces: date:+7d, ask:With whom?, formula:…',
    value: value.value,
    confirmLabel: 'Save',
  })
  if (next !== null) props.updateAttributes({ value: next })
}
</script>

<template>
  <NodeViewWrapper
    as="span"
    class="mx-px inline-flex cursor-pointer items-baseline rounded-md px-1 font-mono text-[0.85em] ring-1"
    :class="known ? 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950/40 dark:text-violet-300 dark:ring-violet-900' : 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900'"
    contenteditable="false"
    :title="known ? 'Replaced when an object is made from this template' : 'Not a placeholder Vasta knows'"
    data-placeholder-chip
    @click="edit"
  >{{ `{{${value}}}` }}</NodeViewWrapper>
</template>
