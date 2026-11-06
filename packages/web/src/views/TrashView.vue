<script setup lang="ts">
// The trash of the open space: deleted types (with the objects that went with them) and objects
// deleted on their own, newest first. Each can be restored or deleted for good; everything goes
// for good 30 days after it was deleted. Owners also find their deleted spaces here.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { Icon, Id, ObjectType, Space } from '@vasta/core'
import AppIcon from '../components/AppIcon.vue'
import { deleteForeverFlow, restoreObjectFlow, restoreTypeFlow } from '../lib/actions.ts'
import { api, type Trash } from '../lib/api.ts'
import { chip, iconTextClasses } from '../lib/colors.ts'
import { onChange } from '../lib/events.ts'
import { displayTitle, formatRelative } from '../lib/format.ts'
import { confirmDialog, openContextMenu } from '../lib/overlays.ts'
import { lastError, loadWorkspace, notice, refreshCounts, typesById, workspace } from '../lib/state.ts'
import { openObject } from '../lib/open.ts'

const router = useRouter()
const trash = ref<Trash>({ types: [], objects: [] })
const spaces = ref<(Space & { deletedAt: string })[]>([])
const loading = ref(true)

interface Entry {
  kind: 'type' | 'object'
  id: Id
  title: string
  icon?: Icon
  fallback: string
  type?: ObjectType
  detail: string
  deletedAt: string
}

/** Types of objects in the list: live ones and those in the trash. */
const types = computed(() => new Map<Id, ObjectType>([...typesById.value, ...trash.value.types.map((t) => [t.id, t] as const)]))

const entries = computed<Entry[]>(() =>
  [
    ...trash.value.types.map((t): Entry => ({
      kind: 'type',
      id: t.id,
      title: t.pluralName,
      ...(t.icon ? { icon: t.icon } : {}),
      fallback: 'ph:cube',
      type: t,
      detail: t.objectCount ? `Type, with ${t.objectCount} ${t.objectCount === 1 ? 'object' : 'objects'}` : 'Type',
      deletedAt: t.deletedAt,
    })),
    ...trash.value.objects.map((o): Entry => {
      const type = types.value.get(o.typeId)
      return {
        kind: 'object',
        id: o.id,
        title: displayTitle(o, type),
        ...(o.icon ?? type?.icon ? { icon: (o.icon ?? type?.icon)! } : {}),
        fallback: 'ph:file-text',
        ...(type ? { type } : {}),
        detail: type?.name ?? '',
        deletedAt: o.deletedAt!,
      }
    }),
  ].sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
)

async function load() {
  if (!workspace.space) return
  try {
    const [next, deletedSpaces] = await Promise.all([api.trash(workspace.space.id), api.deletedSpaces()])
    trash.value = next
    spaces.value = deletedSpaces
  } catch (error) {
    lastError.value = (error as Error).message
  } finally {
    loading.value = false
  }
}
onMounted(load)

// Deletes and restores from other pages or devices show up here.
let reloadTimer: ReturnType<typeof setTimeout> | undefined
const stop = onChange((event) => {
  if (event.spaceId !== workspace.space?.id || event.kind === 'calendar') return
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(load, 300)
})
onBeforeUnmount(() => {
  stop()
  clearTimeout(reloadTimer)
})

const busy = ref(new Set<Id>())

async function run(id: Id, task: () => Promise<unknown>) {
  if (busy.value.has(id)) return
  busy.value = new Set(busy.value).add(id)
  try {
    await task()
    await load()
  } catch (error) {
    lastError.value = (error as Error).message
  } finally {
    const next = new Set(busy.value)
    next.delete(id)
    busy.value = next
  }
}

function restore(entry: Entry) {
  return run(entry.id, async () => {
    if (entry.kind === 'type') {
      const type = await restoreTypeFlow(entry.id)
      notice.value = { message: `Restored “${type.pluralName}”`, action: { label: 'Open', run: () => router.push(`/t/${type.id}`) } }
    } else {
      const { object, type } = await restoreObjectFlow(entry.id)
      notice.value = {
        message: type ? `Restored “${entry.title}” and its type “${type.name}”` : `Restored “${entry.title}”`,
        action: { label: 'Open', run: () => openObject(object.id) },
      }
    }
  })
}

function deleteForever(entry: Entry) {
  return run(entry.id, async () => {
    if (entry.kind === 'object') return deleteForeverFlow(entry.id, entry.title)
    const count = trash.value.types.find((t) => t.id === entry.id)?.objectCount ?? 0
    const ok = await confirmDialog({
      title: `Delete “${entry.title}” forever?`,
      message: `The type${count ? ` and its ${count} ${count === 1 ? 'object' : 'objects'}` : ''} cannot be restored afterwards.`,
      confirmLabel: 'Delete forever',
      danger: true,
    })
    if (!ok) return
    await api.deleteTypeForever(entry.id)
    await refreshCounts()
  })
}

async function emptyTrash() {
  if (!workspace.space) return
  const ok = await confirmDialog({
    title: 'Empty the trash?',
    message: `${entries.value.length} ${entries.value.length === 1 ? 'item goes' : 'items go'} for good. This cannot be undone.`,
    confirmLabel: 'Empty trash',
    danger: true,
  })
  if (!ok) return
  await run('__all', async () => {
    await api.emptyTrash(workspace.space!.id)
    await refreshCounts()
  })
}

function open(entry: Entry) {
  if (entry.kind === 'object') void openObject(entry.id)
}

function entryMenu(event: MouseEvent, entry: Entry) {
  openContextMenu(event, [
    { kind: 'heading', label: entry.title },
    ...(entry.kind === 'object' ? [{ label: 'Open', icon: 'ph:arrow-square-out', run: () => open(entry) }] : []),
    { label: 'Restore', icon: 'ph:arrow-counter-clockwise', run: () => restore(entry) },
    { kind: 'separator' },
    { label: 'Delete forever…', icon: 'ph:trash', danger: true, run: () => deleteForever(entry) },
  ])
}

function restoreSpace(space: Space) {
  return run(space.id, async () => {
    await api.restoreSpace(space.id)
    await loadWorkspace(workspace.space?.id)
    notice.value = { message: `Restored the space “${space.name}”`, action: { label: 'Switch to it', run: async () => (await loadWorkspace(space.id), router.push('/')) } }
  })
}

/** "Goes for good in 12 days". */
function remaining(deletedAt: string) {
  const days = Math.max(0, Math.ceil((Date.parse(deletedAt) + 30 * 86_400_000 - Date.now()) / 86_400_000))
  return days <= 1 ? 'goes for good within a day' : `goes for good in ${days} days`
}
</script>

<template>
  <div class="mx-auto max-w-3xl px-4 py-8 sm:px-8 md:py-12">
    <div class="flex flex-wrap items-center gap-3">
      <AppIcon fallback="ph:trash" :size="26" class="text-ink-soft" />
      <h1 class="text-2xl font-semibold">Trash</h1>
      <button
        v-if="entries.length"
        class="ml-auto rounded-lg border border-line px-3 py-1.5 text-sm text-red-600 hover:bg-hover disabled:opacity-40 max-md:py-2"
        :disabled="busy.has('__all')"
        @click="emptyTrash"
      >
        Empty trash
      </button>
    </div>
    <p class="mt-2 text-sm text-ink-soft">Deleted types and objects of {{ workspace.space?.name }} stay here for 30 days, then go for good.</p>

    <p v-if="loading" class="mt-10 text-sm text-ink-faint">Loading…</p>
    <div v-else-if="!entries.length" class="mt-16 flex flex-col items-center gap-2 text-sm text-ink-faint">
      <AppIcon fallback="ph:trash" :size="36" class="opacity-50" />
      The trash is empty.
    </div>

    <ul v-else class="mt-6 divide-y divide-line rounded-xl border border-line">
      <li
        v-for="entry in entries"
        :key="entry.id"
        class="flex items-center gap-3 px-3 py-2.5"
        :class="busy.has(entry.id) ? 'opacity-50' : ''"
        @contextmenu="entryMenu($event, entry)"
      >
        <button
          class="flex min-w-0 flex-1 items-center gap-3 text-left"
          :class="entry.kind === 'object' ? 'hover:opacity-80' : 'cursor-default'"
          :title="entry.kind === 'object' ? 'Open' : undefined"
          @click="open(entry)"
        >
          <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-hover">
            <AppIcon :icon="entry.icon" :fallback="entry.fallback" :size="18" :class="entry.type?.color ? iconTextClasses[entry.type.color] : 'text-ink-soft'" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{{ entry.title }}</span>
            <span class="flex flex-wrap items-center gap-x-1.5 text-xs text-ink-faint">
              <span v-if="entry.detail" class="rounded px-1 py-px font-medium" :class="chip(entry.type?.color)">{{ entry.detail }}</span>
              <span>{{ formatRelative(entry.deletedAt) }}</span>
              <span class="max-sm:hidden">· {{ remaining(entry.deletedAt) }}</span>
            </span>
          </span>
        </button>
        <div class="flex shrink-0 items-center gap-1">
          <button class="rounded-lg border border-line px-2.5 py-1 text-sm hover:bg-hover max-md:py-1.5" :disabled="busy.has(entry.id)" @click="restore(entry)">
            Restore
          </button>
          <button
            class="rounded-lg px-2 py-1 text-sm text-ink-faint hover:bg-hover hover:text-red-600 max-md:py-1.5"
            title="Delete forever"
            :disabled="busy.has(entry.id)"
            @click="deleteForever(entry)"
          >
            <AppIcon fallback="ph:trash" />
            <span class="sr-only">Delete forever</span>
          </button>
        </div>
      </li>
    </ul>

    <template v-if="spaces.length">
      <h2 class="mt-12 text-sm font-semibold text-ink-soft">Deleted spaces</h2>
      <p class="mt-1 text-sm text-ink-faint">Spaces you owned, with everything in them.</p>
      <ul class="mt-3 divide-y divide-line rounded-xl border border-line">
        <li v-for="space in spaces" :key="space.id" class="flex items-center gap-3 px-3 py-2.5" :class="busy.has(space.id) ? 'opacity-50' : ''">
          <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-hover">
            <AppIcon :icon="space.icon" fallback="ph:planet" :size="18" class="text-ink-soft" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{{ space.name }}</span>
            <span class="text-xs text-ink-faint">{{ formatRelative(space.deletedAt) }} · {{ remaining(space.deletedAt) }}</span>
          </span>
          <button class="rounded-lg border border-line px-2.5 py-1 text-sm hover:bg-hover max-md:py-1.5" :disabled="busy.has(space.id)" @click="restoreSpace(space)">Restore</button>
        </li>
      </ul>
    </template>
  </div>
</template>
