<script setup lang="ts">
// An insistent reminder's honest stats (the last 30 days, server/src/insistent.ts): the last two
// weeks as a strip, how often it was answered, snoozed, skipped or ignored, how long answers take,
// the reasons given for "Not today", and a hint when it seems too much or too easy to ignore.
import { computed } from 'vue'
import type { NagOutcome, RuleStats } from '../lib/api.ts'
import { locale, t, tc } from '../lib/i18n.ts'
import type { MessageKey } from '../locales/en.ts'

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
const NAME_KEYS: Record<NagOutcome | 'open', MessageKey> = {
  done: 'reminders.outcome.done',
  ok: 'reminders.outcome.ok',
  typed: 'reminders.outcome.typed',
  said: 'reminders.outcome.said',
  skipped: 'reminders.outcome.skipped',
  escaped: 'reminders.outcome.escaped',
  ignored: 'reminders.outcome.ignored',
  open: 'reminders.outcome.open',
}
const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString(locale.value, { weekday: 'short', day: 'numeric', month: 'short' })

const closed = computed(() => props.stats.total - props.stats.open)
const parts = computed(() => {
  const s = props.stats
  return [
    t('reminders.stats.answeredOf', { answered: s.answered, total: closed.value }),
    s.medianMinutes !== null
      ? t('reminders.stats.afterMedian', { time: s.medianMinutes < 1 ? t('reminders.stats.underAMinute') : t('reminders.snooze.min', { min: s.medianMinutes }) })
      : '',
    s.snoozes ? tc(s.snoozes, 'reminders.stats.snoozed.one', 'reminders.stats.snoozed.other') : '',
    s.skipped ? t('reminders.stats.skipped', { count: s.skipped }) : '',
    s.ignored ? t('reminders.stats.ignored', { count: s.ignored }) : '',
    s.tookOver
      ? `${tc(s.tookOver, 'reminders.stats.tookScreen.one', 'reminders.stats.tookScreen.other')}${s.escaped ? t('reminders.stats.escapedSuffix', { count: s.escaped }) : ''}`
      : '',
  ].filter(Boolean)
})
/** What the numbers suggest, once there are enough of them. */
const hint = computed(() => {
  const s = props.stats
  const n = closed.value
  if (n < 5) return ''
  if (s.ignored / n >= 0.3) return t('reminders.stats.hintIgnored')
  if (s.escaped / n >= 0.3) return t('reminders.stats.hintEscaped')
  if (s.snoozes / n >= 2) return t('reminders.stats.hintSnoozed')
  if (s.answered / n >= 0.9 && (s.medianMinutes ?? 99) <= 2 && s.escalated / n < 0.2) return t('reminders.stats.hintGentle')
  return ''
})
</script>

<template>
  <section class="space-y-2" :class="compact ? '' : 'rounded-xl bg-raised px-3.5 py-3 ring-1 ring-line'" data-reminder-stats>
    <div class="flex items-center gap-1" :aria-label="t('reminders.stats.last14Aria')">
      <span
        v-for="d in stats.days"
        :key="d.day"
        class="h-3 w-3 rounded-full"
        :class="d.outcome ? COLORS[d.outcome] : 'bg-line'"
        :title="`${day(d.day)}: ${d.outcome ? t(NAME_KEYS[d.outcome]) : t('reminders.outcome.nothing')}`"
      />
      <span v-if="!compact" class="ml-1.5 text-xs text-ink-faint">{{ t('reminders.stats.last14') }}</span>
    </div>
    <p v-if="!stats.total" class="text-xs text-ink-faint">{{ t('reminders.stats.empty') }}</p>
    <p v-else class="text-xs text-ink-soft">{{ parts.join(' · ') }}</p>
    <template v-if="!compact">
      <p v-if="hint" class="text-xs font-medium text-amber-700 dark:text-amber-400">{{ hint }}</p>
      <ul v-if="stats.reasons.length" class="space-y-0.5 text-xs text-ink-faint">
        <li v-for="r in stats.reasons" :key="r.day + r.reason">{{ t('reminders.stats.notOn', { day: day(r.day), reason: r.reason }) }}</li>
      </ul>
    </template>
  </section>
</template>
