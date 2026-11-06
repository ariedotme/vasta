<script setup lang="ts">
// Small link to an object (relations, tags). Optional remove button. A tag (or a relation to one)
// takes the tag's color and shows its path, the parents faded: recipe/breakfast.
import { computed } from 'vue'
import type { Id } from '@vasta/core'
import { chip, iconTextClasses } from '../lib/colors.ts'
import { displayTitle } from '../lib/format.ts'
import { summaryOf, typesById } from '../lib/state.ts'
import { tagAncestors, tagColor } from '../lib/tags.ts'
import AppIcon from './AppIcon.vue'
import ObjectLink from './ObjectLink.vue'

const props = defineProps<{ id: Id; removable?: boolean; tag?: boolean }>()
defineEmits<{ remove: [] }>()

const summary = computed(() => summaryOf(props.id))
const type = computed(() => typesById.value.get(summary.value?.typeId ?? ''))
const isTag = computed(() => props.tag || type.value?.system === 'tag')
const parents = computed(() => (isTag.value ? tagAncestors(summary.value) : []))
const title = computed(() => (summary.value?.title.trim() && isTag.value ? summary.value.title : displayTitle(summary.value, type.value)))
</script>

<template>
  <span
    class="group inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-sm"
    :class="isTag ? chip(tagColor(summary)) : 'bg-hover'"
    :title="isTag ? displayTitle(summary, type) : undefined"
  >
    <ObjectLink :id="id" class="inline-flex min-w-0 items-center gap-1 hover:underline">
      <AppIcon
        :icon="summary?.icon ?? (isTag ? undefined : type?.icon)"
        :fallback="isTag ? undefined : 'ph:file-text'"
        :size="14"
        :class="!isTag && type?.color ? iconTextClasses[type.color] : ''"
      />
      <span class="truncate"><span v-if="parents.length" class="opacity-60">{{ parents.map((p) => p.title).join('/') }}/</span>{{ title }}</span>
    </ObjectLink>
    <button v-if="removable" class="hidden opacity-60 hover:opacity-100 group-hover:inline" title="Remove" @click="$emit('remove')">
      <AppIcon fallback="ph:x" :size="12" />
    </button>
  </span>
</template>
