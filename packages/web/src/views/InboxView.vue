<script setup lang="ts">
// Inbox: everything captured into the daily notes of the last days (Telegram, Shortcuts, the
// browser extension…), newest first and grouped by day. Marking an item reviewed (or the user's word
// for it, lib/inbox.ts) hides it here and checks it in its daily note; "Show reviewed" brings it back.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { addDays } from '@vasta/core'
import AppIcon from '../components/AppIcon.vue'
import DocPreview from '../components/DocPreview.ts'
import { dayKey } from '../lib/actions.ts'
import { api, type InboxItem } from '../lib/api.ts'
import { onChange } from '../lib/events.ts'
import { channelIconName, formatCaptureTime, formatChannel, formatLongDay } from '../lib/format.ts'
import { reviewed } from '../lib/inbox.ts'
import { openContextMenu } from '../lib/overlays.ts'
import { lastError, notice, primeSummaries, systemType, workspace } from '../lib/state.ts'

const STEP = 14
const MAX_DAYS = 365
const SHOW_DONE_KEY = 'vasta.inbox.showDone'

const router = useRouter()
const items = ref<InboxItem[]>([])
const days = ref(STEP)
const loading = ref(true)
const showDone = ref(false)
try {
  showDone.value = localStorage.getItem(SHOW_DONE_KEY) === '1'
} catch {}

function toggleShowDone() {
  showDone.value = !showDone.value
  try {
    localStorage.setItem(SHOW_DONE_KEY, showDone.value ? '1' : '0')
  } catch {}
}

async function load() {
  if (!workspace.space) return
  try {
    const result = await api.inbox(workspace.space.id, dayKey(), days.value)
    primeSummaries(result.objects)
    items.value = result.items
  } catch (error) {
    lastError.value = (error as Error).message
  } finally {
    loading.value = false
  }
}
onMounted(load)

// New captures (and items marked done in a daily note) show up while the page is open.
let reloadTimer: ReturnType<typeof setTimeout> | undefined
const stop = onChange((event) => {
  if (event.kind !== 'object' || event.typeId !== systemType('daily-note')?.id) return
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(load, 300)
})
onBeforeUnmount(() => {
  stop()
  clearTimeout(reloadTimer)
})

const doneCount = computed(() => items.value.filter((i) => i.done).length)
const shown = computed(() => items.value.filter((i) => showDone.value || !i.done))

const groups = computed(() => {
  const today = dayKey()
  const byDay = new Map<string, InboxItem[]>()
  for (const item of shown.value) byDay.set(item.day, [...(byDay.get(item.day) ?? []), item])
  return [...byDay].map(([day, list]) => ({
    day,
    label: day === today ? 'Today' : day === addDays(today, -1) ? 'Yesterday' : formatLongDay(`${day}T00:00:00.000Z`),
    items: list,
  }))
})

async function setDone(item: InboxItem, done: boolean, undoable = true) {
  item.done = done
  try {
    await api.setCaptureDone(item.noteId, item.id, done)
    if (done && undoable) notice.value = { message: `Marked ${reviewed.value.lower}`, action: { label: 'Undo', run: () => setDone(item, false, false) } }
  } catch (error) {
    item.done = !done
    lastError.value = (error as Error).message
  }
}

const openInNote = (item: InboxItem) => router.push({ path: `/o/${item.noteId}`, query: { capture: item.id } })

function itemMenu(event: MouseEvent, item: InboxItem) {
  openContextMenu(event, [
    { label: 'Open in the daily note', icon: 'ph:arrow-square-out', run: () => openInNote(item) },
    item.done
      ? { label: `Mark not ${reviewed.value.lower}`, icon: 'ph:circle', run: () => setDone(item, false) }
      : { label: `Mark ${reviewed.value.lower}`, icon: 'ph:check-circle', run: () => setDone(item, true) },
  ])
}

async function showOlder() {
  days.value = Math.min(days.value + STEP, MAX_DAYS)
  await load()
}
</script>

<template>
  <div class="mx-auto max-w-3xl px-4 py-8 sm:px-8 md:py-12">
    <div class="flex flex-wrap items-center gap-3">
      <AppIcon fallback="ph:tray" :size="26" class="text-ink-soft" />
      <h1 class="text-2xl font-semibold">Inbox</h1>
      <button
        v-if="doneCount"
        class="ml-auto flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-ink-soft hover:bg-hover max-md:py-2"
        :aria-pressed="showDone"
        @click="toggleShowDone"
      >
        <AppIcon :fallback="showDone ? 'ph:eye-slash' : 'ph:eye'" />
        {{ showDone ? `Hide ${reviewed.lower}` : `Show ${reviewed.lower} (${doneCount})` }}
      </button>
    </div>
    <p class="mt-2 text-sm text-ink-soft">What came in through Telegram, Shortcuts and the other channels in the last {{ days }} days.</p>

    <p v-if="loading" class="mt-10 text-sm text-ink-faint">Loading…</p>
    <div v-else-if="!shown.length" class="mt-16 flex flex-col items-center gap-2 text-center text-sm text-ink-faint">
      <AppIcon :fallback="items.length ? 'ph:check-circle' : 'ph:tray'" :size="36" class="opacity-50" />
      {{ items.length ? `All ${reviewed.lower}.` : `Nothing captured in the last ${days} days.` }}
    </div>

    <section v-for="group in groups" :key="group.day" class="mt-8">
      <h2 class="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">{{ group.label }}</h2>
      <ul class="space-y-2">
        <li
          v-for="item in group.items"
          :key="item.id"
          class="flex gap-3 rounded-xl bg-raised px-3 py-2.5 ring-1 ring-line transition-opacity"
          :class="item.done && reviewed.fade ? 'opacity-55' : ''"
          @contextmenu="itemMenu($event, item)"
        >
          <button
            class="-ml-1 grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-faint hover:bg-hover hover:text-ink max-md:h-10 max-md:w-10"
            :title="item.done ? `Mark not ${reviewed.lower}` : `Mark ${reviewed.lower}`"
            @click="setDone(item, !item.done)"
          >
            <AppIcon :fallback="item.done ? 'ph:check-circle-fill' : 'ph:circle'" :size="20" :class="item.done ? 'text-green-600' : ''" />
          </button>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5 text-xs text-ink-faint">
              <AppIcon :fallback="channelIconName(item.channel)" :size="14" class="text-ink-soft" />
              <span class="tabular-nums">{{ formatCaptureTime(item.at) }}</span>
              <span>· {{ formatChannel(item.channel) }}</span>
              <button class="ml-auto flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-hover hover:text-ink max-md:py-1.5" title="Open in the daily note" @click="openInNote(item)">
                <span class="max-sm:hidden">Open in note</span>
                <AppIcon fallback="ph:arrow-up-right" :size="13" />
              </button>
            </div>
            <DocPreview class="mt-0.5" :content="item.content" />
          </div>
        </li>
      </ul>
    </section>

    <div v-if="!loading && days < MAX_DAYS" class="mt-8 flex justify-center">
      <button class="rounded-lg border border-line px-3 py-1.5 text-sm text-ink-soft hover:bg-hover max-md:py-2" @click="showOlder">Show older</button>
    </div>
  </div>
</template>
