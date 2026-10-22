<script setup lang="ts">
// Details of one occurrence of an object's repeating date: when it is, how it repeats, and ways
// to retime or delete it. Both ask whether the change is for this occurrence, this and the
// following, or all of them (lib/calendar.ts, changeEntryTimes).
import { computed, ref } from 'vue'
import type { CalendarEntry, DateValue } from '@vasta/core'
import { dayKey } from '../../lib/actions.ts'
import { changeEntryTimes, describeRepeat, entryTime, formatDayShort } from '../../lib/calendar.ts'
import { displayTitle } from '../../lib/format.ts'
import { lastError, summaryOf, typesById } from '../../lib/state.ts'
import AppIcon from '../AppIcon.vue'

const props = defineProps<{ entry: CalendarEntry }>()
const emit = defineEmits<{ done: [] }>()

const summary = computed(() => summaryOf(props.entry.objectId ?? ''))
const type = computed(() => typesById.value.get(summary.value?.typeId ?? ''))
const title = computed(() => displayTitle(summary.value, type.value))
const value = computed<DateValue | undefined>(() => {
  const object = summary.value
  if (!object) return undefined
  if (props.entry.field === 'date') return object.date
  const prop = object.props[props.entry.field ?? '']
  return prop?.kind === 'date' ? prop.value : undefined
})
const fieldName = computed(() => (props.entry.field && props.entry.field !== 'date' ? type.value?.properties.find((p) => p.id === props.entry.field)?.name : undefined))
const when = computed(() => {
  const days = props.entry.endDay !== props.entry.startDay ? `${formatDayShort(props.entry.startDay)} – ${formatDayShort(props.entry.endDay)}` : formatDayShort(props.entry.startDay)
  const time = entryTime(props.entry)
  return time ? `${days}, ${time}` : days
})

// Retiming ---------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, '0')
const clock = (iso: string) => {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const editing = ref(false)
const day = ref(props.entry.allDay ? props.entry.start.slice(0, 10) : dayKey(new Date(props.entry.start)))
const startTime = ref(props.entry.allDay ? '' : clock(props.entry.start))
const endTime = ref(!props.entry.allDay && props.entry.end ? clock(props.entry.end) : '')
const busy = ref(false)

function newTimes(): { start: string; end?: string } | undefined {
  if (!day.value) return undefined
  if (props.entry.allDay) {
    const length = props.entry.end ? Date.parse(props.entry.end) - Date.parse(props.entry.start) : 0
    const start = `${day.value}T00:00:00.000Z`
    return { start, ...(length ? { end: new Date(Date.parse(start) + length).toISOString() } : {}) }
  }
  const start = new Date(`${day.value}T${startTime.value || '00:00'}`).toISOString()
  if (!endTime.value) return { start }
  let end = new Date(`${day.value}T${endTime.value}`).getTime()
  // An end before the start is on the next day (22:00 – 01:00).
  if (end <= Date.parse(start)) end += 86_400_000
  return { start, end: new Date(end).toISOString() }
}

async function run(change: Parameters<typeof changeEntryTimes>[1]) {
  if (busy.value) return
  busy.value = true
  try {
    if (await changeEntryTimes(props.entry, change)) emit('done')
  } catch (error) {
    lastError.value = (error as Error).message
  } finally {
    busy.value = false
  }
}

function save() {
  const times = newTimes()
  if (times) void run(times)
}
</script>

<template>
  <div class="space-y-2 p-2 text-sm">
    <div class="flex items-start gap-2">
      <AppIcon :icon="summary?.icon ?? type?.icon" fallback="ph:cube" class="mt-0.5 shrink-0 text-ink-soft" />
      <div class="min-w-0">
        <RouterLink :to="`/o/${entry.objectId}`" class="font-semibold leading-snug hover:underline" @click="emit('done')">{{ title }}</RouterLink>
        <div class="text-xs text-ink-soft">{{ when }}</div>
      </div>
    </div>
    <div class="flex items-center gap-1.5 text-xs text-ink-soft"><AppIcon fallback="ph:repeat" :size="13" /> {{ describeRepeat(value?.rrule) || 'Repeats' }}</div>
    <div v-if="type" class="text-xs text-ink-faint">{{ [type.name, fieldName].filter(Boolean).join(' · ') }}</div>

    <form v-if="editing" class="space-y-2 border-t border-line pt-2" @submit.prevent="save">
      <input v-model="day" type="date" aria-label="Day" class="w-full rounded-lg bg-hover px-2 py-1 outline-none" />
      <div v-if="!entry.allDay" class="flex items-center gap-1.5">
        <input v-model="startTime" type="time" aria-label="Start time" class="min-w-0 flex-1 rounded-lg bg-hover px-2 py-1 outline-none" />
        <span class="text-ink-faint">–</span>
        <input v-model="endTime" type="time" aria-label="End time" class="min-w-0 flex-1 rounded-lg bg-hover px-2 py-1 outline-none" />
      </div>
      <div class="flex justify-end gap-1.5">
        <button type="button" class="rounded-md px-2 py-1 text-xs hover:bg-hover" @click="editing = false">Cancel</button>
        <button type="submit" class="rounded-md bg-ink px-2 py-1 text-xs font-medium text-surface hover:opacity-90 disabled:opacity-40" :disabled="busy">Save</button>
      </div>
    </form>

    <div v-else class="flex items-center gap-1.5 border-t border-line pt-2 text-xs">
      <RouterLink :to="`/o/${entry.objectId}`" class="flex items-center gap-1 rounded-md bg-hover px-2 py-1 text-ink-soft hover:text-ink" @click="emit('done')">
        <AppIcon fallback="ph:arrow-square-out" :size="13" /> Open
      </RouterLink>
      <button class="flex items-center gap-1 rounded-md bg-hover px-2 py-1 text-ink-soft hover:text-ink" @click="editing = true">
        <AppIcon fallback="ph:clock" :size="13" /> Change time
      </button>
      <button class="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-red-600 hover:bg-hover disabled:opacity-40" :disabled="busy" @click="run({ cancelled: true })">
        <AppIcon fallback="ph:trash" :size="13" /> Delete
      </button>
    </div>
  </div>
</template>
