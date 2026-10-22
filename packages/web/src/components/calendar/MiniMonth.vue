<script setup lang="ts">
// Small month calendar for jumping to a day. Dots under a day say what it holds (DAY_MARKS): a
// daily note with text, tasks due, dated objects, references to its note, events. The shown month
// is `month` (its first day), so the page can load that month's marks.
import { computed, ref, watch } from 'vue'
import { DAY_MARKS, describeMarks, formatWeekday, isToday, monthOf, stepAnchor, viewTitle, visibleDays, type DayMarks } from '../../lib/calendar.ts'
import AppIcon from '../AppIcon.vue'

const props = defineProps<{ selected: string; marks?: Map<string, DayMarks> }>()
const emit = defineEmits<{ pick: [day: string] }>()
const month = defineModel<string>('month')

const shown = ref(props.selected)
watch(() => props.selected, (day) => (shown.value = day))
watch(shown, (day) => (month.value = `${monthOf(day)}-01`), { immediate: true })
const days = computed(() => visibleDays('month', shown.value))
const dots = (day: string) => DAY_MARKS.filter((m) => props.marks?.get(day)?.[m.key])
</script>

<template>
  <div class="select-none text-sm">
    <div class="mb-2 flex items-center gap-1">
      <span class="flex-1 font-semibold first-letter:uppercase">{{ viewTitle('month', days, shown) }}</span>
      <button class="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-ink" title="Previous month" @click="shown = stepAnchor('month', shown, -1)">
        <AppIcon fallback="ph:caret-left" :size="14" />
      </button>
      <button class="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-ink" title="Next month" @click="shown = stepAnchor('month', shown, 1)">
        <AppIcon fallback="ph:caret-right" :size="14" />
      </button>
    </div>
    <div class="grid grid-cols-7 gap-y-0.5 text-center">
      <span v-for="day in days.slice(0, 7)" :key="day" class="pb-1 text-[11px] text-ink-faint first-letter:uppercase">{{ formatWeekday(day).slice(0, 2) }}</span>
      <button
        v-for="day in days"
        :key="day"
        class="relative mx-auto flex h-9 w-9 flex-col items-center justify-center rounded-lg text-[13px] tabular-nums"
        :class="[
          day === selected ? 'bg-ink font-semibold text-surface' : isToday(day) ? 'font-semibold text-accent hover:bg-hover' : 'hover:bg-hover',
          monthOf(day) !== monthOf(shown) && day !== selected ? 'text-ink-faint/70' : '',
        ]"
        :title="describeMarks(marks?.get(day))"
        @click="emit('pick', day)"
      >
        <span class="leading-none">{{ Number(day.slice(8)) }}</span>
        <span class="mt-1 flex h-1 gap-[2px]">
          <span v-for="mark in dots(day)" :key="mark.key" class="h-1 w-1 rounded-full" :class="day === selected ? 'bg-surface/80' : mark.dot" />
        </span>
      </button>
    </div>
    <div class="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-ink-faint">
      <span v-for="mark in DAY_MARKS" :key="mark.key" class="flex items-center gap-1"><span class="h-1.5 w-1.5 rounded-full" :class="mark.dot" />{{ mark.label }}</span>
    </div>
  </div>
</template>
