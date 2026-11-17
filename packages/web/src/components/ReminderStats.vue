<script setup lang="ts">
// An insistent reminder's honest stats (the last 30 days, server/src/insistent.ts): the last two
// weeks as a strip, how often it was answered, snoozed, skipped or ignored, how long answers take,
// the reasons given for "Not today", and a hint when it seems too much or too easy to ignore.
import { computed } from 'vue'
import type { NagOutcome, RuleStats } from '../lib/api.ts'

const props = defineProps<{ stats: RuleStats; compact?: boolean }>()

const COLORS: Record<NagOutcome | 'open', string> = {
  done: 'bg-emerald-500',
  ok: 'bg-emerald-500',
  typed: 'bg-emerald-500',
  said: 'bg-emerald-500',
  skipped: 'bg-amber-400',
  escaped: 'bg-amber-400',
  ignored: 'bg-rose-400',
  open: 'bg-sky-400',
}
const NAMES: Record<NagOutcome | 'open', string> = { done: 'done', ok: 'seen', typed: 'typed', said: 'said', skipped: 'skipped', escaped: 'escaped the takeover', ignored: 'ignored', open: 'going on' }
const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })

const closed = computed(() => props.stats.total - props.stats.open)
const parts = computed(() => {
  const s = props.stats
  return [
    `answered ${s.answered} of ${closed.value}`,
    s.medianMinutes !== null ? `after ${s.medianMinutes < 1 ? 'under a minute' : `${s.medianMinutes} min`} (median)` : '',
    s.snoozes ? `snoozed ${s.snoozes === 1 ? 'once' : `${s.snoozes} times`}` : '',
    s.skipped ? `skipped ${s.skipped}` : '',
    s.ignored ? `ignored ${s.ignored}` : '',
    s.tookOver ? `took the screen ${s.tookOver === 1 ? 'once' : `${s.tookOver} times`}${s.escaped ? ` (escaped ${s.escaped})` : ''}` : '',
  ].filter(Boolean)
})
/** What the numbers suggest, once there are enough of them. */
const hint = computed(() => {
  const s = props.stats
  const n = closed.value
  if (n < 5) return ''
  if (s.ignored / n >= 0.3) return 'Easy to ignore: try a louder ladder, or another time.'
  if (s.escaped / n >= 0.3) return 'You often escape the takeover: it may be too much, or at a bad time.'
  if (s.snoozes / n >= 2) return 'Snoozed a lot: the time may be wrong.'
  if (s.answered / n >= 0.9 && (s.medianMinutes ?? 99) <= 2 && s.escalated / n < 0.2) return 'Answered right away almost every time: it could be gentler.'
  return ''
})
</script>

<template>
  <section class="space-y-2" :class="compact ? '' : 'rounded-xl bg-raised px-3.5 py-3 ring-1 ring-line'" data-reminder-stats>
    <div class="flex items-center gap-1" aria-label="The last 14 days">
      <span
        v-for="d in stats.days"
        :key="d.day"
        class="h-3 w-3 rounded-full"
        :class="d.outcome ? COLORS[d.outcome] : 'bg-line'"
        :title="`${day(d.day)}: ${d.outcome ? NAMES[d.outcome] : 'nothing'}`"
      />
      <span v-if="!compact" class="ml-1.5 text-xs text-ink-faint">last 14 days</span>
    </div>
    <p v-if="!stats.total" class="text-xs text-ink-faint">Nothing yet: its first time is still to come.</p>
    <p v-else class="text-xs text-ink-soft">{{ parts.join(' · ') }}</p>
    <template v-if="!compact">
      <p v-if="hint" class="text-xs font-medium text-amber-700 dark:text-amber-400">{{ hint }}</p>
      <ul v-if="stats.reasons.length" class="space-y-0.5 text-xs text-ink-faint">
        <li v-for="r in stats.reasons" :key="r.day + r.reason">Not on {{ day(r.day) }}: “{{ r.reason }}”</li>
      </ul>
    </template>
  </section>
</template>
