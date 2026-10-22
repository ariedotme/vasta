<script setup lang="ts">
// Details of an event from a subscribed calendar (read-only), with a way to start notes for it.
import { computed, ref } from 'vue'
import type { CalendarEntry, CalendarSource } from '@vasta/core'
import { entryTime, formatDayShort, minutesInto } from '../../lib/calendar.ts'
import { swatchClasses } from '../../lib/colors.ts'
import AppIcon from '../AppIcon.vue'
import QuickCreate from './QuickCreate.vue'

const props = defineProps<{ entry: CalendarEntry; source?: CalendarSource | undefined }>()
const emit = defineEmits<{ done: [] }>()

const creating = ref(false)
const when = computed(() => {
  const days = props.entry.endDay !== props.entry.startDay ? `${formatDayShort(props.entry.startDay)} – ${formatDayShort(props.entry.endDay)}` : formatDayShort(props.entry.startDay)
  const time = entryTime(props.entry)
  return time ? `${days}, ${time}` : days
})
</script>

<template>
  <QuickCreate
    v-if="creating"
    :day="entry.startDay"
    :minutes="entry.allDay ? undefined : minutesInto(entry.startDay, entry.start)"
    :title="entry.title"
    :end="entry.end"
    @done="emit('done')"
  />
  <div v-else class="space-y-2 p-2 text-sm">
    <div class="flex items-start gap-2">
      <span class="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" :class="swatchClasses[source?.color ?? 'sky']" />
      <div class="min-w-0">
        <div class="font-semibold leading-snug">{{ entry.title }}</div>
        <div class="text-xs text-ink-soft">{{ when }}</div>
      </div>
    </div>
    <div v-if="entry.recurring" class="flex items-center gap-1.5 text-xs text-ink-soft"><AppIcon fallback="ph:repeat" :size="13" /> Repeating event</div>
    <div v-if="entry.location" class="flex items-start gap-1.5 text-xs text-ink-soft"><AppIcon fallback="ph:map-pin" :size="13" class="mt-px shrink-0" />{{ entry.location }}</div>
    <p v-if="entry.description" class="max-h-40 overflow-y-auto whitespace-pre-line text-xs text-ink-soft">{{ entry.description }}</p>
    <a v-if="entry.url" :href="entry.url" target="_blank" rel="noopener noreferrer" class="flex items-center gap-1.5 truncate text-xs text-accent hover:underline">
      <AppIcon fallback="ph:arrow-square-out" :size="13" />{{ entry.url }}
    </a>
    <div class="flex items-center gap-1.5 border-t border-line pt-2 text-xs text-ink-faint">
      <AppIcon fallback="ph:calendar-dots" :size="13" />{{ source?.name ?? 'Subscribed calendar' }}
      <button class="ml-auto flex items-center gap-1 rounded-md bg-hover px-2 py-1 text-ink-soft hover:text-ink" @click="creating = true">
        <AppIcon fallback="ph:note-pencil" :size="13" /> Create note
      </button>
    </div>
  </div>
</template>
