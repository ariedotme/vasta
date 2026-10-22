<script setup lang="ts">
// A provider's embed page (player, post, map) in a sandboxed iframe.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { Embed } from '../lib/embeds.ts'

const props = defineProps<{ embed: Embed }>()
const frame = ref<HTMLIFrameElement | null>(null)
const height = ref(props.embed.height)

/** Posts on X report their rendered height; follow it instead of a fixed guess. */
function onMessage(event: MessageEvent) {
  if (event.source !== frame.value?.contentWindow || event.origin !== 'https://platform.twitter.com') return
  try {
    const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
    const params = data?.['twttr.embed']?.method === 'twttr.private.resize' ? data['twttr.embed'].params?.[0] : undefined
    if (params?.height) height.value = Math.ceil(params.height)
  } catch {}
}

onMounted(() => window.addEventListener('message', onMessage))
onBeforeUnmount(() => window.removeEventListener('message', onMessage))
</script>

<template>
  <iframe
    ref="frame"
    :src="embed.src"
    :title="embed.provider"
    class="w-full rounded-xl"
    :class="height ? '' : 'border border-line bg-hover'"
    :style="height ? { height: `${height}px` } : { aspectRatio: embed.aspect ?? '16 / 9' }"
    sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"
    allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
    referrerpolicy="strict-origin-when-cross-origin"
    allowfullscreen
    loading="lazy"
  />
</template>
