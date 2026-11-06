<script setup lang="ts">
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { computed } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import { iconTextClasses } from '../lib/colors.ts'
import { displayTitle } from '../lib/format.ts'
import { summaryOf, typesById } from '../lib/state.ts'
import { openDay } from '../lib/actions.ts'
import { openObject } from '../lib/open.ts'

const props = defineProps(nodeViewProps)
const objectId = computed(() => props.node.attrs.objectId as string)
const summary = computed(() => summaryOf(objectId.value))
const type = computed(() => typesById.value.get(summary.value?.typeId ?? ''))
const label = computed(() => (summary.value ? displayTitle(summary.value, type.value) : (props.node.attrs.label as string)))
/** A mention of one block opens the object at that block. */
const blockId = computed(() => props.node.attrs.blockId as string | null)
const blockLabel = computed(() => props.node.attrs.blockLabel as string | null)
/** A day's note that may not exist yet (a template's {{yesterday}}): its id ends with the day. */
const day = computed(() => (/^daily-.+-(\d{4}-\d{2}-\d{2})$/.exec(objectId.value) ?? [])[1])
function open() {
  if (!summary.value && day.value) return void openDay(day.value)
  void openObject(objectId.value, { block: blockId.value ?? undefined })
}
</script>

<template>
  <NodeViewWrapper
    as="span"
    class="mx-px inline-flex cursor-pointer items-baseline gap-1 rounded-md px-1 align-baseline font-medium underline decoration-line-strong decoration-1 underline-offset-[3px] hover:bg-hover"
    :class="!summary && !day ? 'text-ink-faint' : ''"
    contenteditable="false"
    @click="open"
  >
    <AppIcon
      :icon="summary?.icon ?? type?.icon"
      fallback="ph:file-text"
      :size="14"
      class="relative top-[2px]"
      :class="type?.color ? iconTextClasses[type.color] : 'text-ink-soft'"
    />{{ label }}<template v-if="blockId"><span class="text-ink-faint">›</span><span class="font-normal">{{ blockLabel || 'a block' }}</span></template>
  </NodeViewWrapper>
</template>
