<script setup lang="ts">
// One calendar entry: a compact chip (month cells, all-day row) or a timed block (day columns).
// Objects open on click; occurrences of repeating dates and external events emit `details`;
// tasks get a checkbox. Entries the page allows move by dragging (after a long press on touch
// screens), and timed blocks resize by their bottom edge (lib/calendar-drag.ts).
import { computed, inject } from 'vue'
import type { CalendarEntry, CalendarSource } from '@vasta/core'
import { entryTime, isDone, setTaskDone } from '../../lib/calendar.ts'
import { ENTRY_DRAGGING, drag, pressEntry } from '../../lib/calendar-drag.ts'
import { chip } from '../../lib/colors.ts'
import { displayTitle } from '../../lib/format.ts'
import { summaryOf, typesById } from '../../lib/state.ts'
import AppIcon from '../AppIcon.vue'

const props = defineProps<{
  entry: CalendarEntry
  variant: 'chip' | 'block'
  source?: CalendarSource | undefined
  /** The entry started on an earlier day (multi-day chips repeat on each day). */
  continued?: boolean
  /** It goes on after the last day shown in its row. */
  continues?: boolean
}>()
const emit = defineEmits<{ details: [entry: CalendarEntry, element: HTMLElement] }>()

const dragging = inject(ENTRY_DRAGGING, undefined)
const movable = computed(() => !!dragging?.movable(props.entry))
const resizable = computed(() => props.variant === 'block' && !!dragging?.resizable(props.entry))

const summary = computed(() => (props.entry.objectId ? summaryOf(props.entry.objectId) : undefined))
const type = computed(() => typesById.value.get(summary.value?.typeId ?? ''))
const isTask = computed(() => type.value?.system === 'task' && props.entry.field === 'due')
const done = computed(() => isTask.value && isDone(type.value, summary.value?.props.status?.kind === 'select' ? summary.value.props.status.value : undefined))
const title = computed(() => (props.entry.kind === 'external' ? (props.entry.title ?? '') : displayTitle(summary.value, type.value)))
const color = computed(() => (props.entry.kind === 'external' ? (props.source?.color ?? 'sky') : (type.value?.color ?? 'gray')))
const fieldName = computed(() => (props.entry.field && props.entry.field !== 'date' ? type.value?.properties.find((p) => p.id === props.entry.field)?.name : undefined))
const time = computed(() => entryTime(props.entry))
const tooltip = computed(() =>
  [title.value, time.value, props.entry.kind === 'external' ? props.source?.name : [type.value?.name, fieldName.value].filter(Boolean).join(' · ')].filter(Boolean).join('\n')
)
const lifted = computed(() => drag.active && drag.entry?.key === props.entry.key)

function toggleDone() {
  if (props.entry.objectId) void setTaskDone(props.entry.objectId, type.value, !done.value)
}

/** Single dates of objects open the object; the rest show details. */
const opens = computed(() => !!props.entry.objectId && !props.entry.recurring)

function onClick(event: MouseEvent | KeyboardEvent) {
  if (opens.value) return
  event.preventDefault()
  emit('details', props.entry, event.currentTarget as HTMLElement)
}

let lastPointer = ''
function onPointerDown(event: PointerEvent, mode: 'move' | 'resize') {
  lastPointer = event.pointerType
  if (!dragging || (mode === 'move' ? !movable.value : !resizable.value)) return
  pressEntry(event, props.entry, mode, dragging.drop)
}

function onContextMenu(event: MouseEvent) {
  // A long press waits to drag: no link menu from the browser.
  if (lastPointer === 'touch' && movable.value) event.preventDefault()
}
</script>

<template>
  <!-- Occurrences of repeating dates open their details, so they are no links. -->
  <component
    :is="opens ? 'RouterLink' : 'div'"
    :to="opens ? `/o/${entry.objectId}` : undefined"
    :role="opens ? undefined : 'button'"
    :tabindex="opens ? undefined : 0"
    :title="tooltip"
    draggable="false"
    data-calendar-entry
    class="vasta-entry group/entry relative flex w-full min-w-0 text-left text-xs leading-tight"
    :class="[
      chip(color),
      variant === 'chip' ? 'items-center gap-1 rounded-md px-1.5 py-[3px]' : 'h-full flex-col gap-0.5 overflow-hidden rounded-md border-l-[3px] border-current/40 px-1.5 py-1',
      done ? 'opacity-60' : '',
      continued ? 'rounded-l-none' : '',
      continues ? 'rounded-r-none' : '',
      movable ? 'vasta-movable cursor-grab' : '',
      lifted ? 'opacity-40' : '',
    ]"
    @click="onClick"
    @keydown.enter="!opens && onClick($event)"
    @pointerdown="onPointerDown($event, 'move')"
    @contextmenu="onContextMenu"
  >
    <span class="flex min-w-0 items-center gap-1">
      <button
        v-if="isTask"
        class="shrink-0 rounded-sm hover:opacity-70"
        :title="done ? 'Mark as to do' : 'Mark as done'"
        @click.prevent.stop="toggleDone"
      >
        <AppIcon :fallback="done ? 'ph:check-circle-fill' : 'ph:circle'" :size="13" />
      </button>
      <AppIcon v-else-if="entry.kind === 'external'" fallback="ph:calendar-dots" :size="12" class="shrink-0 opacity-70" />
      <AppIcon v-else :icon="summary?.icon ?? type?.icon" fallback="ph:cube" :size="12" class="shrink-0 opacity-80" />
      <span v-if="variant === 'chip' && time && !continued" class="shrink-0 tabular-nums opacity-70">{{ time.split(' – ')[0] }}</span>
      <span class="truncate font-medium" :class="done ? 'line-through' : ''">{{ title }}</span>
      <AppIcon v-if="entry.recurring" fallback="ph:repeat" :size="11" class="shrink-0 opacity-60" />
    </span>
    <span v-if="variant === 'block' && time" class="truncate tabular-nums opacity-70">{{ time }}</span>
    <span v-if="variant === 'block' && entry.location" class="truncate opacity-70">{{ entry.location }}</span>
    <span
      v-if="resizable"
      class="vasta-resize absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize max-md:h-3"
      title="Drag to change the end"
      @pointerdown.stop="onPointerDown($event, 'resize')"
      @click.prevent.stop
    />
  </component>
</template>
