<script setup lang="ts">
// A titled card of the settings page.
import AppIcon from '../AppIcon.vue'
import { sectionIcon } from './sections.ts'

defineProps<{ id: string; title: string; description?: string }>()
</script>

<template>
  <section :id="id" class="scroll-mt-6 rounded-xl border border-line p-5 max-md:rounded-none max-md:border-x-0 max-md:border-b-0 max-md:px-0 md:p-6">
    <div class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
      <h2 class="flex items-center gap-2 text-base font-semibold">
        <AppIcon :fallback="sectionIcon(id)" :size="18" class="text-ink-faint" />
        {{ title }}
      </h2>
      <slot name="actions" />
    </div>
    <p v-if="description" class="-mt-2 mb-4 text-sm text-ink-soft">{{ description }}</p>
    <slot />
  </section>
</template>
