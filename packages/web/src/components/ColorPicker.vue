<script setup lang="ts">
import type { ColorName } from '@vasta/core'
import { colorNames, swatchClasses } from '../lib/colors.ts'

defineProps<{ color?: ColorName | undefined }>()
const emit = defineEmits<{ pick: [color: ColorName] }>()
</script>

<template>
  <div class="grid grid-cols-9 gap-1">
    <button
      v-for="name in colorNames"
      :key="name"
      class="h-6 w-6 rounded-full ring-offset-2 ring-offset-surface"
      :class="[swatchClasses[name], color === name ? 'ring-2 ring-ink-soft' : 'hover:ring-2 hover:ring-line-strong']"
      :title="name"
      @click="emit('pick', name)"
    />
  </div>
</template>
