<script setup lang="ts">
// Reminders (server/src/insistent.ts): every one the user has, with its honest stats,
// the ones going on now, a new free-standing one ("an affirmation every morning"), and quiet
// hours, which all of them wait out. Each object's own are also under its "Remind me…".
import { computed, onMounted, ref } from 'vue'
import { authApi, type InsistentRule, type NagView } from '../../lib/api.ts'
import { CHANNELS, ladderText, openReminderEditor, whenText } from '../../lib/insistent.ts'
import { desktop } from '../../lib/platform.ts'
import { summaryOf } from '../../lib/state.ts'
import AppIcon from '../AppIcon.vue'
import ReminderStats from '../ReminderStats.vue'
import SettingsSection from './SettingsSection.vue'
import { errorText, field, secondary } from './styles.ts'

const rules = ref<InsistentRule[] | null>(null)
const going = ref<NagView[]>([])
const unavailable = ref('')
const quietOn = ref(false)
const quiet = ref({ from: '22:00', to: '07:30' })
const takeoverApps = ref(0)
const error = ref('')
const note = ref('')

async function load() {
  try {
    const [list, nags, settings] = await Promise.all([authApi.reminderRules(), authApi.nags(), authApi.reminders()])
    rules.value = list
    going.value = nags
    quietOn.value = !!settings.quiet
    if (settings.quiet) quiet.value = { ...settings.quiet }
    takeoverApps.value = settings.takeoverApps ?? 0
  } catch (failure) {
    unavailable.value = (failure as Error).message
  }
}
onMounted(load)

async function saveQuiet() {
  error.value = ''
  note.value = ''
  try {
    await authApi.saveReminders({ quiet: quietOn.value ? quiet.value : null })
    note.value = 'Saved'
  } catch (failure) {
    error.value = (failure as Error).message
  }
}

const edit = (rule?: InsistentRule) => openReminderEditor({ ...(rule ? { rule } : {}), saved: () => void load() })
const objectTime = (rule: InsistentRule) => {
  const object = rule.objectId ? summaryOf(rule.objectId) : undefined
  const remind = object?.props.remind
  return rule.when.kind === 'object' && remind?.kind === 'text' ? remind.value : undefined
}
const icons = (rule: InsistentRule) => [...new Set(rule.steps.flatMap((s) => s.channels))].map((c) => CHANNELS.find((x) => x.id === c)!)
const ackIcon = { ok: 'ph:hand-tap', done: 'ph:check-circle', type: 'ph:keyboard', say: 'ph:microphone' } as const
const anyTakeover = computed(() => rules.value?.some((r) => !r.paused && r.steps.some((s) => s.channels.includes('takeover') || s.channels.includes('popup'))))
</script>

<template>
  <SettingsSection
    id="reminders"
    title="Reminders"
    description="Reminders that ask until you really answer: OK, done, typed, said out loud, snoozed or skipped with a reason. Each has a style: a pop-up over everything, the whole screen, notifications, or escalating through your channels. Set one on any object with “Remind me…” in its menu, or here."
  >
    <p v-if="unavailable" class="text-sm text-ink-soft">{{ unavailable }}</p>
    <div v-else-if="rules" class="space-y-5">
      <div v-if="going.length" class="space-y-1.5" data-going>
        <h3 class="text-sm font-medium">Going on now</h3>
        <RouterLink v-for="nag in going" :key="nag.id" :to="`/remind/${nag.id}`" class="flex items-center gap-2 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm hover:brightness-95 dark:border-sky-800 dark:bg-sky-950/40">
          <AppIcon fallback="ph:bell-ringing" class="text-sky-600 dark:text-sky-400" />
          <span class="min-w-0 flex-1 truncate font-medium">{{ nag.title }}</span>
          <span class="text-xs text-ink-faint">{{ nag.sent }}× sent<template v-if="nag.snoozes"> · snoozed {{ nag.snoozes }}×</template></span>
          <span class="text-xs font-medium text-accent">Answer</span>
        </RouterLink>
      </div>

      <ul v-if="rules.length" class="divide-y divide-line rounded-lg border border-line" data-rules>
        <li v-for="rule in rules" :key="rule.id" class="px-3 py-3 text-sm" :class="rule.paused ? 'opacity-60' : ''">
          <div class="flex items-start gap-2">
            <AppIcon :fallback="ackIcon[rule.ack]" class="mt-0.5 text-ink-faint" />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-x-2">
                <RouterLink v-if="rule.object && !rule.object.deleted" :to="`/o/${rule.object.id}`" class="font-medium hover:underline">{{ rule.name }}</RouterLink>
                <span v-else class="font-medium">{{ rule.name }}<span v-if="rule.object?.deleted" class="ml-1 text-xs font-normal text-ink-faint">(its object is gone)</span></span>
                <span v-if="rule.paused" class="rounded bg-hover px-1.5 text-xs text-ink-soft">Paused</span>
              </div>
              <p class="text-xs text-ink-faint">{{ whenText(rule, objectTime(rule)) }} · {{ ladderText(rule) }}</p>
              <div class="mt-1.5 flex items-center gap-1 text-ink-faint">
                <AppIcon v-for="c in icons(rule)" :key="c.id" :fallback="c.icon" :size="13" :title="c.label" />
              </div>
              <ReminderStats class="mt-2" :stats="rule.stats" compact />
            </div>
            <button type="button" class="rounded-md px-2 py-1 text-xs text-ink-soft hover:bg-hover hover:text-ink" @click="edit(rule)">Edit</button>
          </div>
        </li>
      </ul>
      <p v-else class="text-sm text-ink-faint">None yet.</p>
      <button type="button" :class="secondary" @click="edit()"><AppIcon fallback="ph:plus" :size="13" class="mr-1 inline" /> New reminder…</button>
      <p v-if="anyTakeover && !takeoverApps && !desktop?.takeover" class="text-xs text-amber-700 dark:text-amber-400">Some reminders pop up or take the screen: that needs Vasta for desktop open (0.11 or later for the pop-up). Until then they arrive as notifications.</p>

      <div class="space-y-2 border-t border-line pt-4">
        <label class="flex items-center gap-2.5 text-sm">
          <input v-model="quietOn" type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" @change="saveQuiet" />
          Quiet hours
        </label>
        <div v-if="quietOn" class="flex flex-wrap items-center gap-2 pl-6 text-sm text-ink-soft">
          No reminder asks from
          <input v-model="quiet.from" type="time" :class="field" class="!mt-0 !w-32" aria-label="Quiet from" @change="saveQuiet" />
          to
          <input v-model="quiet.to" type="time" :class="field" class="!mt-0 !w-32" aria-label="Quiet until" @change="saveQuiet" />
          <span class="w-full text-xs text-ink-faint">What falls due then waits until they end.</span>
        </div>
        <span v-if="note" class="text-sm text-ink-soft">{{ note }}</span>
        <p v-if="error" :class="errorText">{{ error }}</p>
      </div>
    </div>
  </SettingsSection>
</template>
