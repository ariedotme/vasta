<script setup lang="ts">
// Create an object on a day (or at a time) from the calendar: a title and a type with a date
// property; the date goes into that property. Tasks use their due date.
import { computed, onMounted, ref } from 'vue'
import type { DateValue, ObjectType } from '@vasta/core'
import { createObject } from '../../lib/actions.ts'
import { dateProperties, formatClock, formatDayShort, instantAt } from '../../lib/calendar.ts'
import { iconTextClasses } from '../../lib/colors.ts'
import { workspace } from '../../lib/state.ts'
import AppIcon from '../AppIcon.vue'

const props = defineProps<{ day: string; minutes?: number | undefined; title?: string; end?: string }>()
const emit = defineEmits<{ done: [] }>()

const TYPE_KEY = 'vasta.calendar.createType'
const types = computed(() =>
  workspace.types
    .filter((t) => !t.deletedAt && dateProperties(t).length)
    .sort((a, b) => (a.system === 'task' ? -1 : b.system === 'task' ? 1 : a.name.localeCompare(b.name)))
)
let remembered = ''
try {
  remembered = localStorage.getItem(TYPE_KEY) ?? ''
} catch {}
const typeId = ref(types.value.find((t) => t.id === remembered)?.id ?? types.value[0]?.id ?? '')
const type = computed(() => types.value.find((t) => t.id === typeId.value))
const title = ref(props.title ?? '')
const input = ref<HTMLInputElement | null>(null)
const busy = ref(false)
const error = ref('')

const when = computed(() => (props.minutes === undefined ? formatDayShort(props.day) : `${formatDayShort(props.day)}, ${formatClock(instantAt(props.day, props.minutes))}`))

function dateFor(target: ObjectType): DateValue {
  if (props.minutes === undefined) return { start: `${props.day}T00:00:00.000Z`, resolution: 'day' }
  const start = instantAt(props.day, props.minutes)
  // Tasks are due at a moment; other things (meetings, events) get an hour unless told otherwise.
  if (target.system === 'task') return { start, resolution: 'time' }
  const end = props.end ?? new Date(Date.parse(start) + 3_600_000).toISOString()
  return { start, end, resolution: 'time' }
}

async function create(open: boolean) {
  const target = type.value
  const def = dateProperties(target)[0]
  if (!target || !def || busy.value) return
  busy.value = true
  try {
    localStorage.setItem(TYPE_KEY, target.id)
  } catch {}
  try {
    await createObject(target.id, { title: title.value.trim(), props: { [def.id]: { kind: 'date', value: dateFor(target) } } }, open)
    emit('done')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

onMounted(() => input.value?.focus())
</script>

<template>
  <div class="space-y-2 p-2 text-sm">
    <div class="flex items-center gap-1.5 text-xs text-ink-faint"><AppIcon fallback="ph:calendar-plus" :size="13" />{{ when }}</div>
    <input
      ref="input"
      v-model="title"
      class="w-full rounded-lg bg-hover px-2.5 py-1.5 outline-none placeholder:text-ink-faint"
      placeholder="Title"
      @keydown.enter.prevent="create($event.metaKey || $event.ctrlKey)"
    />
    <div v-if="types.length" class="flex flex-wrap gap-1">
      <button
        v-for="t in types"
        :key="t.id"
        class="flex items-center gap-1 rounded-md px-2 py-1 text-xs"
        :class="t.id === typeId ? 'bg-ink text-surface' : 'bg-hover text-ink-soft hover:text-ink'"
        @click="typeId = t.id"
      >
        <AppIcon :icon="t.icon" fallback="ph:cube" :size="12" :class="t.id !== typeId && t.color ? iconTextClasses[t.color] : ''" />{{ t.name }}
      </button>
    </div>
    <p v-else class="text-xs text-ink-faint">Add a date property to a type to create it from the calendar.</p>
    <p v-if="type && dateProperties(type).length > 1" class="text-xs text-ink-faint">Goes into “{{ dateProperties(type)[0]!.name }}”.</p>
    <p v-if="error" class="text-xs text-red-600">{{ error }}</p>
    <div class="flex gap-1.5">
      <button class="flex-1 rounded-lg bg-ink px-2.5 py-1.5 text-surface disabled:opacity-40" :disabled="!type || busy" @click="create(false)">Create</button>
      <button class="rounded-lg bg-hover px-2.5 py-1.5 text-ink-soft hover:text-ink disabled:opacity-40" :disabled="!type || busy" title="Create and open (⌘↩)" @click="create(true)">
        Open
      </button>
    </div>
  </div>
</template>
