<script setup lang="ts">
// A type's icon (or an object's, in its type's color): in a rounded square tinted with the color,
// or bare, as Settings › Appearance says. Emoji stay as they are.
import { computed } from 'vue'
import type { ColorName, Icon } from '@vasta/core'
import { iconBoxClasses, iconTextClasses } from '../lib/colors.ts'
import { iconStyle } from '../lib/theme.ts'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ icon?: Icon | undefined; fallback?: string; color?: ColorName | undefined; size?: number }>()

const size = computed(() => props.size ?? 16)
const boxed = computed(() => iconStyle.value === 'boxed' && props.icon?.kind !== 'emoji')
</script>

<template>
  <span
    v-if="boxed"
    class="inline-grid shrink-0 place-items-center"
    :class="[iconBoxClasses[color ?? 'gray'], size >= 22 ? 'rounded-lg' : 'rounded-[5px]']"
    :style="{ width: `${size + 2}px`, height: `${size + 2}px` }"
  >
    <AppIcon :icon="icon" :fallback="fallback" :size="Math.round(size * 0.72)" />
  </span>
  <AppIcon v-else :icon="icon" :fallback="fallback" :size="size" :class="color ? iconTextClasses[color] : 'text-ink-soft'" />
</template>
