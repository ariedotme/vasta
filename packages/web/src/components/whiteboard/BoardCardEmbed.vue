<script setup lang="ts">
// A card on a whiteboard showing what its object holds: a query's live results, a picture, or the
// text of anything else (loaded once, again when the object changes elsewhere).
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Doc, ObjectSummary, ObjectType } from '@vasta/core'
import { api } from '../../lib/api.ts'
import { onChange } from '../../lib/events.ts'
import { displayTitle } from '../../lib/format.ts'
import { imageOf } from '../../lib/media.ts'
import { iconTextClasses } from '../../lib/colors.ts'
import AppIcon from '../AppIcon.vue'
import DocPreview from '../DocPreview.ts'
import QueryResults from '../QueryResults.vue'

const props = defineProps<{ object: ObjectSummary; type?: ObjectType; boardId: string }>()

const isQuery = computed(() => props.type?.system === 'query')
const image = computed(() => imageOf(props.object))
const content = ref<Doc[]>([])

async function load() {
  if (isQuery.value || image.value) return
  const full = await api.object(props.object.id).catch(() => undefined)
  content.value = full ? Object.entries(full.content).filter(([field]) => field !== 'whiteboard').map(([, doc]) => doc) : []
}
watch(() => props.object.id, load, { immediate: true })
const stop = onChange((event) => {
  if (event.kind === 'object' && event.id === props.object.id) void load()
})
onBeforeUnmount(stop)
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
    <div class="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-2 text-sm font-semibold">
      <AppIcon :icon="object.icon ?? type?.icon" fallback="ph:file-text" :size="15" :class="type?.color ? iconTextClasses[type.color] : 'text-ink-soft'" />
      <span class="truncate">{{ displayTitle(object, type) }}</span>
    </div>
    <!-- The contents scroll with the wheel (the board pans once they reach an end). -->
    <div data-scroll class="pointer-events-auto min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <QueryResults v-if="isQuery && object.query" :query="object.query" :parent-id="boardId" :limit="30" class="p-2 text-sm" />
      <img v-else-if="image" :src="image" alt="" class="pointer-events-none h-full w-full object-cover" />
      <div v-else-if="content.length" class="prose-sm space-y-1 px-3 py-2 text-sm text-ink">
        <DocPreview v-for="(doc, i) in content" :key="i" :content="doc.content" />
      </div>
      <p v-else class="px-3 py-2 text-sm text-ink-faint">{{ object.preview || 'Nothing written yet.' }}</p>
    </div>
  </div>
</template>
