<script setup lang="ts">
// Create an object on a day (or at a time) from the calendar: a title and a type with a date
// property; the date goes into that property. Tasks use their due date.
import { computed, onMounted, ref } from 'vue'
import type { DateValue, ObjectType } from '@vasta/core'
import { createObject } from '../../lib/actions.ts'
import { dateProperties, formatClock, formatDayShort, instantAt } from '../../lib/calendar.ts'
import { iconTextClasses } from '../../lib/colors.ts'
import { propName, t, typeName } from '../../lib/i18n.ts'
import { mod } from '../../lib/shortcuts.ts'
import { workspace } from '../../lib/state.ts'
import AppIcon from '../AppIcon.vue'

const props = defineProps<{ day: string; minutes?: number | undefined; title?: string; end?: string }>()
const emit = defineEmits<{ done: [] }>()

const TYPE_KEY = 'vasta.calendar.createType'
const types = computed(() =>
  workspace.types
    .filter((item) => !item.deletedAt && dateProperties(item).length)
    .sort((a, b) => (a.system === 'task' ? -1 : b.system === 'task' ? 1 : typeName(a).localeCompare(typeName(b))))
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
      :placeholder="t('object.titleLabel')"
      @keydown.enter.prevent="create($event.metaKey || $event.ctrlKey)"
    />
    <div v-if="types.length" class="flex flex-wrap gap-1">
      <button
        v-for="item in types"
        :key="item.id"
        class="flex items-center gap-1 rounded-md px-2 py-1 text-xs"
        :class="item.id === typeId ? 'bg-ink text-surface' : 'bg-hover text-ink-soft hover:text-ink'"
        @click="typeId = item.id"
      >
        <AppIcon :icon="item.icon" fallback="ph:cube" :size="12" :class="item.id !== typeId && item.color ? iconTextClasses[item.color] : ''" />{{ typeName(item) }}
      </button>
    </div>
    <p v-else class="text-xs text-ink-faint">{{ t('calendar.quick.noDateTypes') }}</p>
    <p v-if="type && dateProperties(type).length > 1" class="text-xs text-ink-faint">{{ t('calendar.quick.goesInto', { prop: propName(dateProperties(type)[0]!) }) }}</p>
    <p v-if="error" class="text-xs text-red-600">{{ error }}</p>
    <div class="flex gap-1.5">
      <button class="flex-1 rounded-lg bg-ink px-2.5 py-1.5 text-surface disabled:opacity-40" :disabled="!type || busy" @click="create(false)">{{ t('common.create') }}</button>
      <button class="rounded-lg bg-hover px-2.5 py-1.5 text-ink-soft hover:text-ink disabled:opacity-40" :disabled="!type || busy" :title="t('calendar.quick.createAndOpen', { mod })" @click="create(true)">
        {{ t('common.open') }}
      </button>
    </div>
  </div>
</template>
