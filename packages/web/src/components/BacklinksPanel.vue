<script setup lang="ts">
// Objects that point to this one, grouped by how they reference it.
import { computed, ref, watch } from 'vue'
import type { Backlink, Id } from '@vasta/core'
import { api } from '../lib/api.ts'
import { displayTitle, formatRelative } from '../lib/format.ts'
import { primeSummaries, typesById } from '../lib/state.ts'
import { objectColor } from '../lib/tags.ts'
import AppIcon from './AppIcon.vue'
import TypeIcon from './TypeIcon.vue'
import ObjectLink from './ObjectLink.vue'

/** `hideTagged`: a tag's page lists what it tags itself (TagPanel). */
const props = defineProps<{ objectId: Id; title?: string; hideTagged?: boolean }>()
const links = ref<Backlink[]>([])

watch(
  () => props.objectId,
  async (id) => {
    // Relations are shown with the object's properties (ReverseRelations).
    links.value = (await api.backlinks(id)).filter((l) => l.kind !== 'relation' && !(props.hideTagged && l.kind === 'tag'))
    primeSummaries(links.value.map((l) => l.object))
  },
  { immediate: true }
)

const LABELS: Record<Backlink['kind'], string> = {
  mention: 'Mentioned in',
  embed: 'Embedded in',
  relation: 'Related',
  tag: 'Tagged',
  collection: 'In this collection',
}

const groups = computed(() => {
  const byKind = new Map<string, Backlink[]>()
  for (const link of links.value) {
    const list = byKind.get(link.kind) ?? []
    if (!list.some((l) => l.object.id === link.object.id)) list.push(link)
    byKind.set(link.kind, list)
  }
  return [...byKind].map(([kind, items]) => ({ label: LABELS[kind as Backlink['kind']] ?? kind, items }))
})
</script>

<template>
  <section v-if="links.length" class="mt-14 border-t border-line pt-6">
    <h2 class="mb-3 flex items-center gap-2 text-sm font-semibold text-ink-soft">
      <AppIcon fallback="ph:arrow-bend-down-left" /> {{ title ?? 'Backlinks' }}
      <span class="font-normal text-ink-faint">{{ links.length }}</span>
    </h2>
    <div v-for="group in groups" :key="group.label" class="mb-4">
      <h3 class="mb-1 text-xs font-medium text-ink-faint">{{ group.label }}</h3>
      <ObjectLink
        v-for="link in group.items"
        :key="link.object.id"
        :id="link.object.id"
        class="flex items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-hover"
      >
        <TypeIcon :icon="link.object.icon ?? typesById.get(link.object.typeId)?.icon" fallback="ph:file-text" class="mt-0.5" :color="objectColor(link.object, typesById.get(link.object.typeId))" />
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-medium">{{ displayTitle(link.object, typesById.get(link.object.typeId)) }}</div>
          <div v-if="link.object.preview" class="truncate text-xs text-ink-faint">{{ link.object.preview }}</div>
        </div>
        <span class="shrink-0 text-xs text-ink-faint">{{ formatRelative(link.object.updatedAt) }}</span>
      </ObjectLink>
    </div>
  </section>
</template>
