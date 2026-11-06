<script setup lang="ts">
// On a tag's page: its sub-tags, and everything tagged with it or with any of them (#recipe takes
// #recipe/breakfast too), each with the tags that brought it here.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Id, ObjectSummary } from '@vasta/core'
import { createObject, dayKey } from '../lib/actions.ts'
import { api } from '../lib/api.ts'
import { viewerTimeZone } from '../lib/calendar.ts'
import { onChange } from '../lib/events.ts'
import { displayTitle, formatRelative } from '../lib/format.ts'
import { promptDialog } from '../lib/overlays.ts'
import { lastError, primeSummaries, systemType, typesById, workspace } from '../lib/state.ts'
import { descendantsOf, objectColor } from '../lib/tags.ts'
import AppIcon from './AppIcon.vue'
import TypeIcon from './TypeIcon.vue'
import ObjectChip from './ObjectChip.vue'
import ObjectLink from './ObjectLink.vue'

const props = defineProps<{ tagId: Id }>()

const tags = ref<ObjectSummary[]>([])
const tagged = ref<ObjectSummary[]>([])

const children = computed(() => tags.value.filter((t) => t.parentId === props.tagId).sort((a, b) => a.title.localeCompare(b.title)))
/** This tag and every tag under it: what puts an object in the list. */
const family = computed(() => new Set([props.tagId, ...descendantsOf(props.tagId, tags.value).map((t) => t.id)]))

async function load() {
  const tagType = systemType('tag')
  if (!workspace.space || !tagType) return
  const [allTags, list] = await Promise.all([
    api.objectsOfType(tagType.id),
    api.query(workspace.space.id, {
      query: { typeIds: [], filter: { kind: 'group', operator: 'and', items: [{ kind: 'filter', field: 'tags', operator: 'contains', value: { kind: 'literal', value: [props.tagId] } }] }, sort: [{ field: 'updatedAt', direction: 'desc' }] },
      today: dayKey(),
      timeZone: viewerTimeZone(),
    }),
  ])
  primeSummaries([...allTags, ...list])
  tags.value = allTags
  tagged.value = list
}
watch(() => props.tagId, load, { immediate: true })

let timer: ReturnType<typeof setTimeout> | undefined
const stop = onChange(() => {
  clearTimeout(timer)
  timer = setTimeout(load, 400)
})
onBeforeUnmount(() => {
  stop()
  clearTimeout(timer)
})

async function newSubTag() {
  const tagType = systemType('tag')
  const title = await promptDialog({ title: 'New sub-tag', placeholder: 'breakfast', confirmLabel: 'Create' })
  if (!title?.trim() || !tagType) return
  try {
    await createObject(tagType.id, { title: title.trim(), parentId: props.tagId }, false)
    await load()
  } catch (error) {
    lastError.value = (error as Error).message
  }
}

const typeOf = (object: ObjectSummary) => typesById.value.get(object.typeId)
const heading = 'mb-2 flex items-center gap-2 text-sm font-semibold text-ink-soft'
</script>

<template>
  <section class="mt-10">
    <h2 :class="heading">
      <AppIcon fallback="ph:tree-structure" /> Sub-tags <span v-if="children.length" class="font-normal text-ink-faint">{{ children.length }}</span>
    </h2>
    <div class="flex flex-wrap items-center gap-1.5">
      <ObjectChip v-for="child in children" :key="child.id" :id="child.id" tag />
      <button class="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-sm text-ink-faint hover:bg-hover hover:text-ink" @click="newSubTag">
        <AppIcon fallback="ph:plus" :size="13" /> New sub-tag
      </button>
    </div>
  </section>

  <section class="mt-10">
    <h2 :class="heading">
      <AppIcon fallback="ph:tag" /> Tagged <span class="font-normal text-ink-faint">{{ tagged.length }}</span>
    </h2>
    <p v-if="!tagged.length" class="text-sm text-ink-faint">Nothing has this tag{{ children.length ? ' or its sub-tags' : '' }} yet.</p>
    <ObjectLink v-for="object in tagged" :key="object.id" :id="object.id" class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-hover">
      <TypeIcon :icon="object.icon ?? typeOf(object)?.icon" fallback="ph:file-text" :color="objectColor(object, typeOf(object))" />
      <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ displayTitle(object, typeOf(object)) }}</span>
      <span class="hidden shrink-0 items-center gap-1 sm:flex" @click.prevent>
        <ObjectChip v-for="id in object.tagIds.filter((t) => family.has(t) && t !== tagId)" :key="id" :id="id" tag />
      </span>
      <span class="shrink-0 text-xs text-ink-faint">{{ formatRelative(object.updatedAt) }}</span>
    </ObjectLink>
  </section>
</template>
