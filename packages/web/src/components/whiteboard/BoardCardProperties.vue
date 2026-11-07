<script setup lang="ts">
// A card on a whiteboard showing its object's title and the properties chosen for it (in the
// selection bar); with none chosen, the first few that have a value.
import { computed } from 'vue'
import type { ObjectSummary, ObjectType } from '@vasta/core'
import { displayTitle } from '../../lib/format.ts'
import { iconTextClasses } from '../../lib/colors.ts'
import { kindIcon } from '../../lib/properties.ts'
import AppIcon from '../AppIcon.vue'
import PropertyDisplay from '../PropertyDisplay.vue'

const props = defineProps<{ object: ObjectSummary; type?: ObjectType; fields?: string[] }>()

const rows = computed(() => {
  const defs = props.type?.properties ?? []
  if (props.fields?.length) return props.fields.flatMap((id) => defs.filter((d) => d.id === id))
  return defs.filter((d) => d.kind === 'formula' || props.object.props[d.id] !== undefined).slice(0, 4)
})
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
    <div class="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-2 text-sm font-semibold">
      <AppIcon :icon="object.icon ?? type?.icon" fallback="ph:file-text" :size="15" :class="type?.color ? iconTextClasses[type.color] : 'text-ink-soft'" />
      <span class="truncate">{{ displayTitle(object, type) }}</span>
    </div>
    <dl class="min-h-0 flex-1 space-y-1 overflow-hidden px-3 py-2 text-sm">
      <div v-for="def in rows" :key="def.id" class="flex min-w-0 items-center gap-2">
        <dt class="flex w-[42%] shrink-0 items-center gap-1 truncate text-xs text-ink-soft">
          <AppIcon :icon="def.icon" :fallback="kindIcon(def.kind)" :size="12" class="shrink-0 text-ink-faint" /><span class="truncate">{{ def.name }}</span>
        </dt>
        <dd class="flex min-w-0 flex-1 items-center overflow-hidden">
          <PropertyDisplay :def="def" :value="object.props[def.id]" :object="object" />
        </dd>
      </div>
      <p v-if="!rows.length" class="text-xs text-ink-faint">No properties to show. Pick them in the card's view menu.</p>
    </dl>
  </div>
</template>
