<script setup lang="ts">
// Shows the media file an object stands for (image, PDF, audio, video). Weblinks use WeblinkPanel.
import { computed } from 'vue'
import type { MediaInfo, ObjectType } from '@vasta/core'
import { mediaUrl } from '../lib/api.ts'

const props = defineProps<{ media: MediaInfo; type: ObjectType | undefined }>()

const src = computed(() => (props.media.file ? mediaUrl(props.media.file.key) : props.type?.system === 'image' ? props.media.url : undefined))
const mime = computed(() => props.media.file?.mimeType ?? (props.type?.system === 'image' ? 'image/' : props.media.mimeType ?? ''))
</script>

<template>
  <section class="mb-6">
    <template v-if="src && mime.startsWith('image/')">
      <a :href="src" target="_blank"><img :src="src" alt="" class="max-h-[70vh] w-auto max-w-full rounded-xl border border-line" /></a>
    </template>
    <iframe v-else-if="src && mime === 'application/pdf'" :src="src" class="h-[75vh] w-full rounded-xl border border-line" />
    <audio v-else-if="src && mime.startsWith('audio/')" :src="src" controls class="w-full" />
    <video v-else-if="src && mime.startsWith('video/')" :src="src" controls class="w-full rounded-xl" />

    <p v-else-if="!src && type?.system && type.system !== 'weblink'" class="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-ink-faint">
      File not available{{ media.url ? '' : ' in this space' }}.
    </p>
  </section>
</template>
