<script setup lang="ts">
// Reminders in the open space (server/src/insistent.ts, server/src/reminders.ts):
// ongoing alerts ("Going on now"), custom rules in this space with their honest stats, and
// automatic reminders for this space's tasks, events, habits and food.
import { computed, ref, watch } from 'vue'
import { isNutritionOn } from '@vasta/core'
import { authApi, type AutoReminderStyle, type InsistentRule, type NagView, type SpaceReminders } from '../../lib/api.ts'
import { CHANNELS, ladderText, openReminderEditor, whenText } from '../../lib/insistent.ts'
import { desktop } from '../../lib/platform.ts'
import { summaryOf, systemType, workspace } from '../../lib/state.ts'
import AppIcon from '../AppIcon.vue'
import ReminderStats from '../ReminderStats.vue'
import SettingsSection from './SettingsSection.vue'
import { errorText, field, label, secondary } from './styles.ts'

const spaceId = computed(() => workspace.space?.id)
const spaceName = computed(() => workspace.space?.name ?? 'this space')
const tracksFood = computed(() => !!workspace.space && isNutritionOn(workspace.space))
const habitType = computed(() => systemType('habit'))

const rules = ref<InsistentRule[] | null>(null)
const going = ref<NagView[]>([])
const auto = ref<SpaceReminders | null>(null)
const savedAuto = ref<SpaceReminders | null>(null)
const unavailable = ref('')
const takeoverApps = ref(0)
const saving = ref(false)
const error = ref('')
const note = ref('')
let loadSeq = 0

const LEADS: { value: number | null; label: string }[] = [
  { value: null, label: 'Off' },
  { value: 0, label: 'When they start' },
  { value: 5, label: '5 minutes before' },
  { value: 10, label: '10 minutes before' },
  { value: 15, label: '15 minutes before' },
  { value: 30, label: '30 minutes before' },
  { value: 60, label: '1 hour before' },
]
const AUTO_STYLES: { value: AutoReminderStyle; label: string }[] = [
  { value: 'plain', label: 'Simple notification' },
  { value: 'popup', label: 'Pop-up' },
  { value: 'fullscreen', label: 'Full screen' },
  { value: 'notification', label: 'Repeating notification' },
  { value: 'escalating', label: 'Escalating' },
  { value: 'relentless', label: 'Relentless' },
]
const MEAL_LEADS: { value: number | null; label: string }[] = [
  { value: null, label: 'Off' },
  { value: 30, label: '30 minutes after its time' },
  { value: 60, label: '1 hour after its time' },
  { value: 90, label: '1½ hours after its time' },
  { value: 120, label: '2 hours after its time' },
]
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function cloneSpace(sp: SpaceReminders): SpaceReminders {
  return { ...sp, food: { ...sp.food, week: sp.food.week ? { ...sp.food.week } : null } }
}

async function load() {
  const id = spaceId.value
  if (!id) return
  const seq = ++loadSeq
  unavailable.value = ''
  error.value = ''
  note.value = ''
  try {
    const [list, nags, settings] = await Promise.all([authApi.reminderRules({ spaceId: id }), authApi.nags(id), authApi.reminders(id)])
    if (seq !== loadSeq) return
    rules.value = list
    going.value = nags
    if (settings.space) {
      savedAuto.value = cloneSpace(settings.space)
      auto.value = cloneSpace(settings.space)
    }
    takeoverApps.value = settings.takeoverApps ?? 0
  } catch (failure) {
    if (seq !== loadSeq) return
    unavailable.value = (failure as Error).message
  }
}
watch(spaceId, () => void load(), { immediate: true })

const dayLeftOn = computed({
  get: () => auto.value?.food.dayLeft !== null,
  set: (on) => {
    if (!auto.value) return
    auto.value.food.dayLeft = on ? (savedAuto.value?.food.dayLeft ?? '18:00') : null
    void saveAuto()
  },
})
const weekOn = computed({
  get: () => auto.value?.food.week !== null,
  set: (on) => {
    if (!auto.value) return
    auto.value.food.week = on ? { ...(savedAuto.value?.food.week ?? { day: 0, at: '20:00' }) } : null
    void saveAuto()
  },
})

let noteTimer: ReturnType<typeof setTimeout> | undefined
async function saveAuto() {
  const id = spaceId.value
  const current = auto.value
  if (!id || !current) return
  saving.value = true
  error.value = ''
  note.value = ''
  try {
    const updated = await authApi.saveReminders({
      spaceId: id,
      habits: current.habits,
      habitsStyle: current.habitsStyle,
      tasksBefore: current.tasksBefore,
      tasksStyle: current.tasksStyle,
      eventsBefore: current.eventsBefore,
      eventsStyle: current.eventsStyle,
      food: current.food,
    })
    if (updated.space && spaceId.value === id) {
      savedAuto.value = cloneSpace(updated.space)
      auto.value = cloneSpace(updated.space)
    }
    note.value = 'Saved'
    clearTimeout(noteTimer)
    noteTimer = setTimeout(() => (note.value = ''), 2000)
  } catch (failure) {
    error.value = (failure as Error).message
  } finally {
    saving.value = false
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
const usesDesktopWindow = (style: AutoReminderStyle) => style === 'popup' || style === 'fullscreen' || style === 'escalating' || style === 'relentless'
const anyTakeover = computed(() => {
  if (rules.value?.some((r) => !r.paused && r.steps.some((s) => s.channels.includes('takeover') || s.channels.includes('popup')))) return true
  const a = auto.value
  if (!a) return false
  return (
    (a.tasksBefore !== null && usesDesktopWindow(a.tasksStyle)) ||
    (a.eventsBefore !== null && usesDesktopWindow(a.eventsStyle)) ||
    (a.habits && usesDesktopWindow(a.habitsStyle))
  )
})
</script>

<template>
  <SettingsSection
    id="reminders"
    title="Reminders"
    :description="`In ${spaceName}: custom reminders that ask until you answer, ongoing alerts, and automatic reminders for tasks, events, habits and food. Delivery channels and quiet hours live under Reminder channels.`"
  >
    <p v-if="unavailable" class="text-sm text-ink-soft">{{ unavailable }}</p>
    <div v-else-if="rules" class="space-y-6">
      <div v-if="going.length" class="space-y-1.5" data-going>
        <h3 class="text-sm font-medium">Going on now</h3>
        <RouterLink v-for="nag in going" :key="nag.id" :to="`/remind/${nag.id}`" class="flex items-center gap-2 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm hover:brightness-95 dark:border-sky-800 dark:bg-sky-950/40">
          <AppIcon fallback="ph:bell-ringing" class="text-sky-600 dark:text-sky-400" />
          <span class="min-w-0 flex-1 truncate font-medium">{{ nag.title }}</span>
          <span class="text-xs text-ink-faint">{{ nag.sent }}× sent<template v-if="nag.snoozes"> · snoozed {{ nag.snoozes }}×</template></span>
          <span class="text-xs font-medium text-accent">Answer</span>
        </RouterLink>
      </div>

      <div class="space-y-3">
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
        <p v-else class="text-sm text-ink-faint">No custom reminders in {{ spaceName }} yet.</p>
        <button type="button" :class="secondary" @click="edit()"><AppIcon fallback="ph:plus" :size="13" class="mr-1 inline" /> New reminder…</button>
      </div>

      <div v-if="auto" class="space-y-4 border-t border-line pt-5" data-auto-reminders>
        <div>
          <h3 class="text-sm font-medium">Automatic reminders in {{ spaceName }}</h3>
          <p class="mt-0.5 text-xs text-ink-faint">
            Apply to objects in this space automatically. Setting a reminder on an individual object (“Remind me…”) overrides these — pausing it silences that object.
          </p>
        </div>

        <!-- Tasks -->
        <div class="space-y-1.5">
          <div class="flex flex-wrap items-end gap-2.5">
            <label :class="label" class="min-w-44 flex-1">
              Timed tasks
              <select v-model="auto.tasksBefore" :class="field" :disabled="saving" aria-label="Timed tasks lead time" @change="saveAuto">
                <option v-for="lead in LEADS" :key="String(lead.value)" :value="lead.value">{{ lead.label }}</option>
              </select>
            </label>
            <label v-if="auto.tasksBefore !== null" :class="label" class="min-w-44 flex-1">
              Style
              <select v-model="auto.tasksStyle" :class="field" :disabled="saving" aria-label="Timed tasks reminder style" @change="saveAuto">
                <option v-for="s in AUTO_STYLES" :key="s.value" :value="s.value">{{ s.label }}</option>
              </select>
            </label>
          </div>
          <p class="text-xs text-ink-faint">Tasks with a due time, while not done.</p>
        </div>

        <!-- Events -->
        <div class="space-y-1.5">
          <div class="flex flex-wrap items-end gap-2.5">
            <label :class="label" class="min-w-44 flex-1">
              Timed events
              <select v-model="auto.eventsBefore" :class="field" :disabled="saving" aria-label="Timed events lead time" @change="saveAuto">
                <option v-for="lead in LEADS" :key="String(lead.value)" :value="lead.value">{{ lead.label }}</option>
              </select>
            </label>
            <label v-if="auto.eventsBefore !== null" :class="label" class="min-w-44 flex-1">
              Style
              <select v-model="auto.eventsStyle" :class="field" :disabled="saving" aria-label="Timed events reminder style" @change="saveAuto">
                <option v-for="s in AUTO_STYLES" :key="s.value" :value="s.value">{{ s.label }}</option>
              </select>
            </label>
          </div>
          <p class="text-xs text-ink-faint">Objects with a time on the calendar (other than tasks) and events of subscribed calendars.</p>
        </div>

        <!-- Habits -->
        <div class="space-y-2">
          <label class="flex items-start gap-2.5 text-sm">
            <input v-model="auto.habits" type="checkbox" class="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" :disabled="saving" @change="saveAuto" />
            <span>
              Habits, at their “Remind at” time, while not done that day
              <span class="block text-xs text-ink-faint">
                Set the time on each habit's page (“8:00”, “21h30”).
                <RouterLink v-if="habitType" :to="`/t/${habitType.id}`" class="text-accent hover:underline">Your habits</RouterLink>
              </span>
            </span>
          </label>
          <div v-if="auto.habits" class="pl-6">
            <label :class="label" class="max-w-xs">
              Style
              <select v-model="auto.habitsStyle" :class="field" :disabled="saving" aria-label="Habits reminder style" @change="saveAuto">
                <option v-for="s in AUTO_STYLES" :key="s.value" :value="s.value">{{ s.label }}</option>
              </select>
            </label>
          </div>
        </div>

        <!-- Food (only when this space tracks food) -->
        <div v-if="tracksFood" class="space-y-3 border-t border-line pt-4" data-food-reminders>
          <h4 class="flex items-center gap-1.5 text-sm font-medium"><AppIcon fallback="ph:bowl-food" class="text-ink-faint" /> Food</h4>
          <div class="flex flex-wrap items-center gap-2.5 text-sm">
            <label class="flex items-center gap-2.5">
              <input v-model="dayLeftOn" type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" :disabled="saving" />
              What is left of the day, at
            </label>
            <input v-if="auto.food.dayLeft !== null" v-model="auto.food.dayLeft" type="time" :class="field" class="!mt-0 !w-36" :disabled="saving" aria-label="Time for what is left of the day" @change="saveAuto" />
            <span class="block w-full pl-6 text-xs text-ink-faint">“600 kcal left today · 40 g protein to go · the week is on track”, against the day's share of the weekly budget when the goal has one.</span>
          </div>
          <div class="flex flex-wrap items-center gap-2.5 text-sm">
            <label class="flex items-center gap-2.5">
              <input v-model="weekOn" type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" :disabled="saving" />
              The week's summary, on
            </label>
            <template v-if="auto.food.week">
              <select v-model="auto.food.week.day" :class="field" class="!mt-0 !w-36" :disabled="saving" aria-label="Day of the week's summary" @change="saveAuto">
                <option v-for="(name, index) in WEEKDAYS" :key="name" :value="index">{{ name }}</option>
              </select>
              at
              <input v-model="auto.food.week.at" type="time" :class="field" class="!mt-0 !w-36" :disabled="saving" aria-label="Time of the week's summary" @change="saveAuto" />
            </template>
            <span class="block w-full pl-6 text-xs text-ink-faint">Within the budget or over it, protein a day, days on target and the streak, for the week ending that day (Monday to Sunday).</span>
          </div>
          <label :class="label" class="max-w-xs">
            Meals with nothing logged
            <select v-model="auto.food.mealsAfter" :class="field" :disabled="saving" @change="saveAuto">
              <option v-for="lead in MEAL_LEADS" :key="String(lead.value)" :value="lead.value">{{ lead.label }}</option>
            </select>
            <span class="mt-1 block">At each meal's usual time (Settings › Food tracking), plus this.</span>
          </label>
        </div>

        <p v-if="note" class="text-sm text-ink-soft">{{ note }}</p>
        <p v-if="error" :class="errorText">{{ error }}</p>
      </div>

      <p v-if="anyTakeover && !takeoverApps && !desktop?.takeover" class="text-xs text-amber-700 dark:text-amber-400">
        Some reminders pop up or take the screen: that needs Vasta for desktop open (0.11 or later for the pop-up). Until then they arrive as notifications.
      </p>
    </div>
  </SettingsSection>
</template>
