<script setup lang="ts">
// A whiteboard embedded in a note: a still view of the whole board or of one frame (a scene),
// kept live with the board's document. The frame is the embed's `blockId`, so the scene survives
// Markdown as vasta://o/<board>#b-<frame>.
import { computed, onBeforeUnmount, onMounted, shallowRef, ref } from 'vue'
import { readBoard, type FrameElement, type Id } from '@vasta/core'
import type * as Yjs from 'yjs'
import { openText, useReplica, type TextSession } from '../../lib/replica.ts'
import { openRemoteText } from '../../lib/remote-text.ts'
import { displayTitle } from '../../lib/format.ts'
import { summaryOf, typesById } from '../../lib/state.ts'
import { openObject } from '../../lib/open.ts'
import AppIcon from '../AppIcon.vue'
import WhiteboardCanvas from './WhiteboardCanvas.vue'

const props = defineProps<{ boardId: Id; frameId: Id | null; editable: boolean }>()
const emit = defineEmits<{ scene: [frameId: Id | null] }>()

const summary = computed(() => summaryOf(props.boardId))
const title = computed(() => displayTitle(summary.value, typesById.value.get(summary.value?.typeId ?? '')))
const session = shallowRef<TextSession | null>(null)
const failed = ref(false)
const frames = shallowRef<FrameElement[]>([])
const readFrames = (doc: Yjs.Doc) => (frames.value = readBoard(doc).filter((e): e is FrameElement => e.kind === 'frame'))
const onUpdate = () => session.value && readFrames(session.value.doc)
/** The board's default scene, which an embed without a scene of its own shows. */
const cover = computed(() => frames.value.find((f) => f.cover))
const sceneName = computed(() => {
  const frame = props.frameId ? frames.value.find((f) => f.id === props.frameId) : cover.value
  return frame ? frame.title?.trim() || 'Frame' : null
})

onMounted(async () => {
  try {
    session.value = useReplica() ? await openText(props.boardId) : await openRemoteText(props.boardId)
    readFrames(session.value.doc)
    session.value.doc.on('update', onUpdate)
  } catch {
    failed.value = true
  }
})
onBeforeUnmount(() => {
  session.value?.doc.off('update', onUpdate)
  session.value?.release()
})

const open = () => openObject(props.boardId)
</script>

<template>
  <div class="vasta-ui overflow-hidden rounded-xl border border-line bg-surface">
    <div class="flex items-center gap-2 border-b border-line px-3 py-1.5 text-sm">
      <AppIcon fallback="ph:chalkboard-simple" :size="15" class="text-ink-soft" />
      <button class="min-w-0 truncate font-medium hover:underline" @click="open">{{ title }}</button>
      <span v-if="sceneName" class="truncate text-ink-faint">› {{ sceneName }}</span>
      <select
        v-if="editable && frames.length"
        class="ml-auto max-w-[45%] rounded-md bg-hover px-1.5 py-0.5 text-xs text-ink-soft outline-none"
        :value="frameId ?? ''"
        title="Which part of the board this shows"
        @change="emit('scene', ($event.target as HTMLSelectElement).value || null)"
      >
        <option value="">{{ cover ? `Default scene (${cover.title?.trim() || 'Frame'})` : 'Whole board' }}</option>
        <option v-for="f in frames" :key="f.id" :value="f.id">{{ f.title?.trim() || 'Frame' }}</option>
      </select>
      <button class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-soft hover:bg-hover hover:text-ink" :class="editable && frames.length ? '' : 'ml-auto'" title="Open the board" @click="open">
        <AppIcon fallback="ph:arrow-square-out" :size="14" />
      </button>
    </div>
    <!-- A still picture of the board: a double click opens it. -->
    <div class="relative h-80 max-md:h-60" @dblclick="open">
      <div v-if="session" class="pointer-events-none absolute inset-0">
        <WhiteboardCanvas :doc="session.doc" :board-id="boardId" readonly embedded :focus="frameId" />
      </div>
      <div v-else class="grid h-full place-items-center text-sm text-ink-faint">{{ failed ? 'This board needs a connection to the server.' : 'Opening the board…' }}</div>
    </div>
  </div>
</template>
