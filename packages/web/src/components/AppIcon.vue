<script setup lang="ts">
import { computed, watchEffect } from 'vue'
import { Icon as Iconify, iconLoaded } from '@iconify/vue'
import type { Icon } from '@vasta/core'
import { phosphorReady, requestPhosphor } from '../lib/icons.ts'

const props = defineProps<{
  icon?: Icon | undefined
  /** Iconify name used when `icon` is empty. */
  fallback?: string
  size?: number
}>()

const name = computed(() => (props.icon?.kind === 'emoji' ? undefined : props.icon?.value || props.fallback))

/**
 * A Phosphor icon outside the bundled subset waits for the full set (lib/icons.ts) instead of
 * letting Iconify fetch it from its public API; until then an empty box keeps the layout.
 */
const waiting = computed(() => !!name.value?.startsWith('ph:') && !phosphorReady.value && !iconLoaded(name.value))
watchEffect(() => {
  if (waiting.value) requestPhosphor(name.value!)
})
</script>

<template>
  <span
    v-if="icon?.kind === 'emoji'"
    class="inline-flex shrink-0 items-center justify-center leading-none"
    :style="{ fontSize: `${(size ?? 16) * 0.95}px`, width: `${size ?? 16}px`, height: `${size ?? 16}px` }"
    >{{ icon.value }}</span
  >
  <span v-else-if="waiting" class="inline-block shrink-0" :style="{ width: `${size ?? 16}px`, height: `${size ?? 16}px` }" />
  <Iconify v-else-if="name" :icon="name" class="shrink-0" :width="size ?? 16" :height="size ?? 16" />
</template>
