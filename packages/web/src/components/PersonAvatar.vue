<script setup lang="ts">
// A person's initials in a circle of their color; `name` when it is known better than the open space's members.
import { computed } from 'vue'
import type { Id } from '@vasta/core'
import { chip } from '../lib/colors.ts'
import { initials, personColor, personName } from '../lib/people.ts'

const props = withDefaults(defineProps<{ id: Id; size?: number; name?: string }>(), { size: 20, name: undefined })
const name = computed(() => props.name ?? personName(props.id))
</script>

<template>
  <span
    class="inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium leading-none"
    :class="chip(personColor(id))"
    :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px` }"
    :title="name"
    >{{ initials(name) }}</span
  >
</template>
