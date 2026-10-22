<script setup lang="ts">
// The Tags page's Tree view: tags nested under their parents, a tag with sub-tags folding like a
// folder (remembered on this device). A filter shows the matching tags with the tags above them.
import { computed, ref, watch } from 'vue'
import type { Id, ObjectSummary } from '@vasta/core'
import { createObject } from '../lib/actions.ts'
import { chip } from '../lib/colors.ts'
import { promptDialog } from '../lib/overlays.ts'
import { lastError, systemType } from '../lib/state.ts'
import { tagColor } from '../lib/tags.ts'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ tags: ObjectSummary[]; filter?: string }>()
const emit = defineEmits<{ menu: [event: MouseEvent, object: ObjectSummary] }>()

const FOLDED_KEY = 'vasta.tags.folded'
function readFolded(): Set<Id> {
  try {
    return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]') as Id[])
  } catch {
    return new Set()
  }
}
const folded = ref(readFolded())
watch(folded, (set) => {
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...set]))
  } catch {}
})
function toggle(id: Id) {
  const next = new Set(folded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  folded.value = next
}

const byId = computed(() => new Map(props.tags.map((t) => [t.id, t])))
/** Children by parent id; a tag whose parent is gone (or makes a cycle) is a root. */
const children = computed(() => {
  const map = new Map<Id | undefined, ObjectSummary[]>()
  for (const tag of props.tags) {
    let parent = tag.parentId && byId.value.has(tag.parentId) ? tag.parentId : undefined
    // A cycle (made on two devices at once): put the tag at the root rather than lose it.
    for (let id = parent, steps = 0; id && steps < 64; id = byId.value.get(id)?.parentId, steps++) if (id === tag.id) parent = undefined
    const list = map.get(parent) ?? []
    list.push(tag)
    map.set(parent, list)
  }
  for (const list of map.values()) list.sort((a, b) => a.title.localeCompare(b.title))
  return map
})

/** With a filter: the tags that match, and every tag above one (shown unfolded). */
const shownIds = computed(() => {
  const q = props.filter?.trim().toLowerCase()
  if (!q) return undefined
  const ids = new Set<Id>()
  for (const tag of props.tags) {
    if (!tag.title.toLowerCase().includes(q)) continue
    for (let id: Id | undefined = tag.id; id && !ids.has(id); id = byId.value.get(id)?.parentId) ids.add(id)
  }
  return ids
})

interface Row {
  tag: ObjectSummary
  depth: number
  hasChildren: boolean
  count: number
}
const rows = computed(() => {
  const out: Row[] = []
  const walk = (parent: Id | undefined, depth: number) => {
    for (const tag of children.value.get(parent) ?? []) {
      if (shownIds.value && !shownIds.value.has(tag.id)) continue
      const kids = children.value.get(tag.id) ?? []
      out.push({ tag, depth, hasChildren: kids.length > 0, count: kids.length })
      if (kids.length && (shownIds.value || !folded.value.has(tag.id))) walk(tag.id, depth + 1)
    }
  }
  walk(undefined, 0)
  return out
})

async function newSubTag(parent: ObjectSummary) {
  const tagType = systemType('tag')
  const title = await promptDialog({ title: `New tag under ${parent.title}`, placeholder: 'breakfast', confirmLabel: 'Create' })
  if (!title?.trim() || !tagType) return
  try {
    await createObject(tagType.id, { title: title.trim(), parentId: parent.id }, false)
    if (folded.value.has(parent.id)) toggle(parent.id)
  } catch (error) {
    lastError.value = (error as Error).message
  }
}
</script>

<template>
  <div class="mt-4 max-w-3xl">
    <div
      v-for="row in rows"
      :key="row.tag.id"
      class="group flex items-center gap-1 rounded-lg py-0.5 pr-2 hover:bg-hover"
      :style="{ paddingLeft: `${row.depth * 1.5 + 0.25}rem` }"
      @contextmenu.prevent="emit('menu', $event, row.tag)"
    >
      <button
        class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-faint hover:bg-surface hover:text-ink"
        :class="row.hasChildren ? '' : 'invisible'"
        :title="folded.has(row.tag.id) ? 'Unfold' : 'Fold'"
        :aria-expanded="!folded.has(row.tag.id)"
        @click="toggle(row.tag.id)"
      >
        <AppIcon :fallback="folded.has(row.tag.id) && !shownIds ? 'ph:caret-right' : 'ph:caret-down'" :size="13" />
      </button>
      <AppIcon :fallback="row.hasChildren ? (folded.has(row.tag.id) && !shownIds ? 'ph:folder-simple' : 'ph:folder-open') : 'ph:hash'" :size="15" class="shrink-0 text-ink-faint" />
      <RouterLink :to="`/o/${row.tag.id}`" class="min-w-0 truncate rounded-md px-2 py-0.5 text-sm font-medium hover:brightness-95" :class="chip(tagColor(row.tag))">
        {{ row.tag.title || 'Untitled' }}
      </RouterLink>
      <span v-if="row.hasChildren" class="text-xs text-ink-faint">{{ row.count }}</span>
      <button
        class="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-ink-faint opacity-0 hover:bg-surface hover:text-ink group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        @click="newSubTag(row.tag)"
      >
        <AppIcon fallback="ph:plus" :size="12" /> Sub-tag
      </button>
    </div>
    <p v-if="!rows.length" class="py-10 text-center text-sm text-ink-faint">No tags match the filter.</p>
  </div>
</template>
