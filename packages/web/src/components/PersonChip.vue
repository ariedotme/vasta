<script setup lang="ts">
// A person (a space member) by avatar and name, for person properties. Optional remove button.
import type { Id } from '@vasta/core'
import { personName } from '../lib/people.ts'
import AppIcon from './AppIcon.vue'
import PersonAvatar from './PersonAvatar.vue'

defineProps<{ id: Id; removable?: boolean }>()
defineEmits<{ remove: [] }>()
</script>

<template>
  <span class="group inline-flex max-w-full items-center gap-1.5 rounded-full bg-hover py-0.5 pl-0.5 pr-2 text-sm">
    <PersonAvatar :id="id" :size="18" />
    <span class="truncate">{{ personName(id) }}</span>
    <button v-if="removable" class="hidden opacity-60 hover:opacity-100 group-hover:inline" title="Remove" @click.stop="$emit('remove')">
      <AppIcon fallback="ph:x" :size="12" />
    </button>
  </span>
</template>
