<script setup lang="ts">
// Subscribed calendars: add an iCalendar link, rename, recolor, pause, sync now or remove.
import { onMounted, ref } from 'vue'
import type { CalendarSource, ColorName } from '@vasta/core'
import { api } from '../../lib/api.ts'
import { colorNames, swatchClasses } from '../../lib/colors.ts'
import { formatRelative } from '../../lib/format.ts'
import { confirmDialog } from '../../lib/overlays.ts'
import { workspace } from '../../lib/state.ts'
import AppIcon from '../AppIcon.vue'
import ModalDialog from '../ModalDialog.vue'

const emit = defineEmits<{ close: []; changed: [] }>()

const sources = ref<CalendarSource[]>([])
const busy = ref(new Set<string>())
const error = ref('')

async function load() {
  if (workspace.space) sources.value = await api.calendarSources(workspace.space.id)
}
onMounted(load)

function replace(source: CalendarSource | undefined) {
  if (!source) return
  const index = sources.value.findIndex((s) => s.id === source.id)
  if (index >= 0) sources.value[index] = source
  else sources.value.push(source)
  emit('changed')
}

async function run(id: string, task: () => Promise<CalendarSource | void>) {
  busy.value = new Set(busy.value).add(id)
  error.value = ''
  try {
    const result = await task()
    if (result) replace(result)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    const next = new Set(busy.value)
    next.delete(id)
    busy.value = next
  }
}

const update = (source: CalendarSource, data: Parameters<typeof api.updateCalendarSource>[1]) => run(source.id, () => api.updateCalendarSource(source.id, data))
const sync = (source: CalendarSource) => run(source.id, () => api.syncCalendarSource(source.id))

async function remove(source: CalendarSource) {
  const ok = await confirmDialog({ title: `Remove “${source.name}”?`, message: 'Its events disappear from the calendar. Nothing changes in the original calendar.', confirmLabel: 'Remove', danger: true })
  if (!ok) return
  await run(source.id, () => api.deleteCalendarSource(source.id))
  sources.value = sources.value.filter((s) => s.id !== source.id)
  emit('changed')
}

// Adding ---------------------------------------------------------------------
const form = ref({ url: '', name: '', color: 'sky' as ColorName, username: '', password: '' })
const showAuth = ref(false)

async function add() {
  if (!workspace.space || !form.value.url.trim()) return
  const { url, name, color, username, password } = form.value
  await run('new', async () => {
    const source = await api.addCalendarSource(workspace.space!.id, { url, name, color, ...(username ? { username } : {}), ...(password ? { password } : {}) })
    form.value = { url: '', name: '', color: colorNames[(sources.value.length * 5 + 3) % colorNames.length]!, username: '', password: '' }
    showAuth.value = false
    return source
  })
}

function cycleColor(source: CalendarSource) {
  const index = colorNames.indexOf(source.color ?? 'sky')
  void update(source, { color: colorNames[(index + 1) % colorNames.length]! })
}
</script>

<template>
  <ModalDialog title="Subscribed calendars" width="38rem" @close="emit('close')">
    <template #icon><AppIcon fallback="ph:calendar-dots" class="text-ink-soft" /></template>

    <p class="text-sm text-ink-soft">
      Events from these calendars show next to your notes. They are read-only and refresh every 15 minutes.
    </p>

    <ul v-if="sources.length" class="mt-4 divide-y divide-line rounded-xl border border-line">
      <li v-for="source in sources" :key="source.id" class="flex items-start gap-3 px-3 py-2.5">
        <button class="mt-1 h-3.5 w-3.5 shrink-0 rounded-full" :class="swatchClasses[source.color ?? 'sky']" title="Change color" @click="cycleColor(source)" />
        <div class="min-w-0 flex-1">
          <input
            :value="source.name"
            class="w-full rounded bg-transparent text-sm font-medium outline-none hover:bg-hover focus:bg-hover"
            @change="update(source, { name: ($event.target as HTMLInputElement).value })"
          />
          <div class="truncate text-xs text-ink-faint" :title="source.url">{{ source.url }}</div>
          <div class="mt-0.5 text-xs" :class="source.error ? 'text-red-600' : 'text-ink-faint'">
            <template v-if="busy.has(source.id)">Syncing…</template>
            <template v-else-if="source.error">{{ source.error }}</template>
            <template v-else-if="source.syncedAt">{{ source.eventCount ?? 0 }} events · synced {{ formatRelative(source.syncedAt) }}</template>
            <template v-else>Not synced yet</template>
          </div>
        </div>
        <label class="flex items-center gap-1.5 pt-0.5 text-xs text-ink-soft" title="Show on the calendar">
          <input type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" :checked="source.enabled" @change="update(source, { enabled: ($event.target as HTMLInputElement).checked })" />
        </label>
        <button class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink disabled:opacity-40" title="Sync now" :disabled="busy.has(source.id)" @click="sync(source)">
          <AppIcon fallback="ph:arrows-clockwise" :class="busy.has(source.id) ? 'animate-spin' : ''" />
        </button>
        <button class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-red-600" title="Remove" @click="remove(source)">
          <AppIcon fallback="ph:trash" />
        </button>
      </li>
    </ul>

    <form class="mt-5 space-y-2" @submit.prevent="add">
      <h3 class="text-sm font-semibold">Add a calendar</h3>
      <div class="flex gap-2">
        <input v-model="form.url" class="min-w-0 flex-1 rounded-lg bg-hover px-2.5 py-1.5 text-sm outline-none placeholder:text-ink-faint" placeholder="https:// or webcal:// link to an .ics feed" />
        <input v-model="form.name" class="w-36 rounded-lg bg-hover px-2.5 py-1.5 text-sm outline-none placeholder:text-ink-faint" placeholder="Name (optional)" />
      </div>
      <div v-if="showAuth" class="flex gap-2">
        <input v-model="form.username" autocomplete="off" class="min-w-0 flex-1 rounded-lg bg-hover px-2.5 py-1.5 text-sm outline-none placeholder:text-ink-faint" placeholder="Username" />
        <input v-model="form.password" type="password" autocomplete="new-password" class="min-w-0 flex-1 rounded-lg bg-hover px-2.5 py-1.5 text-sm outline-none placeholder:text-ink-faint" placeholder="Password or app password" />
      </div>
      <div class="flex items-center gap-2">
        <div class="flex gap-1">
          <button
            v-for="color in colorNames.slice(0, 12)"
            :key="color"
            type="button"
            class="h-4 w-4 rounded-full"
            :class="[swatchClasses[color], form.color === color ? 'ring-2 ring-ink ring-offset-1 ring-offset-surface' : '']"
            @click="form.color = color"
          />
        </div>
        <button v-if="!showAuth" type="button" class="text-xs text-ink-faint hover:text-ink" @click="showAuth = true">Needs a password?</button>
        <button type="submit" class="ml-auto rounded-lg bg-ink px-3 py-1.5 text-sm text-surface disabled:opacity-40" :disabled="!form.url.trim() || busy.has('new')">
          {{ busy.has('new') ? 'Adding…' : 'Add' }}
        </button>
      </div>
      <p v-if="error" class="text-sm text-red-600">{{ error }}</p>
    </form>

    <details class="mt-5 text-xs text-ink-soft">
      <summary class="cursor-pointer text-ink-faint hover:text-ink">Where to find the link</summary>
      <ul class="mt-2 list-disc space-y-1 pl-5">
        <li><b>Google Calendar:</b> Settings → your calendar → Integrate calendar → “Secret address in iCal format”.</li>
        <li><b>iCloud:</b> Calendar app → share the calendar → Public Calendar → copy the webcal:// link.</li>
        <li><b>Nextcloud / CalDAV:</b> the calendar's “Copy subscription link”, or its export URL (…?export) with your username and an app password.</li>
        <li><b>Outlook.com:</b> Settings → Shared calendars → Publish a calendar → ICS link.</li>
      </ul>
      <p class="mt-2">Passwords are stored in Vasta's database on your server, in plain text; prefer app passwords.</p>
    </details>
  </ModalDialog>
</template>
