<script setup lang="ts">
// Reminders: where they go (an ntfy topic, on ntfy.sh or your own server, the Telegram bot, and
// system notifications in the desktop app) and what reminds you (habits at their "Remind at" time,
// timed events and tasks before they start, and in spaces that track food: what is left of the
// day, the week's summary, meals with nothing logged). The server sends them
// (server/src/reminders.ts), so ntfy and Telegram get them with every app closed.
import { computed, onMounted, ref } from 'vue'
import { isNutritionOn } from '@vasta/core'
import { authApi, type FoodReminders, type ReminderSettings, type WorkNotifications } from '../../lib/api.ts'
import { desktop as desktopApp } from '../../lib/platform.ts'
import { systemType, workspace } from '../../lib/state.ts'
import AppIcon from '../AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import { errorText, field, label, primary, secondary } from './styles.ts'

const current = ref<ReminderSettings | null>(null)
const unavailable = ref('')
const server = ref('https://ntfy.sh')
const topic = ref('')
const token = ref('')
const telegram = ref(false)
const desktop = ref(true)
const habits = ref(true)
const food = ref<FoodReminders>({ dayLeft: '18:00', week: { day: 0, at: '20:00' }, mealsAfter: null })
const eventsBefore = ref<number | null>(10)
const work = ref<WorkNotifications>({ assigned: true, mentioned: true, comments: true })
const busy = ref(false)
const error = ref('')
const note = ref('')

const LEADS: { value: number | null; label: string }[] = [
  { value: null, label: 'No event reminders' },
  { value: 0, label: 'When they start' },
  { value: 5, label: '5 minutes before' },
  { value: 10, label: '10 minutes before' },
  { value: 15, label: '15 minutes before' },
  { value: 30, label: '30 minutes before' },
  { value: 60, label: '1 hour before' },
]
const MEAL_LEADS: { value: number | null; label: string }[] = [
  { value: null, label: 'Off' },
  { value: 30, label: '30 minutes after its time' },
  { value: 60, label: '1 hour after its time' },
  { value: 90, label: '1½ hours after its time' },
  { value: 120, label: '2 hours after its time' },
]
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Some space of the user tracks food. */
const tracksFood = computed(() => workspace.spaces.some((s) => isNutritionOn(s)))
// Checkboxes over the nullable times: turning one back on brings its last time (or the default).
const dayLeftOn = computed({ get: () => food.value.dayLeft !== null, set: (on) => (food.value.dayLeft = on ? (current.value?.food.dayLeft ?? '18:00') : null) })
const weekOn = computed({ get: () => food.value.week !== null, set: (on) => (food.value.week = on ? { ...(current.value?.food.week ?? { day: 0, at: '20:00' }) } : null) })

function show(settings: ReminderSettings) {
  current.value = settings
  server.value = settings.ntfy?.server ?? 'https://ntfy.sh'
  topic.value = settings.ntfy?.topic ?? ''
  token.value = ''
  telegram.value = settings.telegram
  desktop.value = settings.desktop
  habits.value = settings.habits
  food.value = { ...settings.food, week: settings.food.week && { ...settings.food.week } }
  eventsBefore.value = settings.eventsBefore
  work.value = { ...settings.work }
}

onMounted(async () => {
  try {
    show(await authApi.reminders())
  } catch (failure) {
    unavailable.value = (failure as Error).message
  }
})

const dirty = computed(() => {
  const s = current.value
  if (!s) return false
  return (
    server.value.trim() !== (s.ntfy?.server ?? 'https://ntfy.sh') ||
    topic.value.trim() !== (s.ntfy?.topic ?? '') ||
    !!token.value.trim() ||
    telegram.value !== s.telegram ||
    desktop.value !== s.desktop ||
    habits.value !== s.habits ||
    JSON.stringify(food.value) !== JSON.stringify(s.food) ||
    eventsBefore.value !== s.eventsBefore ||
    JSON.stringify(work.value) !== JSON.stringify(s.work)
  )
})

async function save() {
  busy.value = true
  error.value = ''
  note.value = ''
  try {
    show(
      await authApi.saveReminders({
        ntfy: topic.value.trim() ? { server: server.value.trim(), topic: topic.value.trim(), ...(token.value.trim() ? { token: token.value.trim() } : {}) } : null,
        telegram: telegram.value,
        desktop: desktop.value,
        habits: habits.value,
        eventsBefore: eventsBefore.value,
        food: food.value,
        work: work.value,
      })
    )
    note.value = 'Saved'
  } catch (failure) {
    error.value = (failure as Error).message
  } finally {
    busy.value = false
  }
}

async function clearToken() {
  busy.value = true
  try {
    show(await authApi.saveReminders({ ntfy: { server: server.value.trim(), topic: topic.value.trim(), token: '' } }))
  } catch (failure) {
    error.value = (failure as Error).message
  } finally {
    busy.value = false
  }
}

async function test() {
  if (dirty.value) await save()
  if (error.value) return
  busy.value = true
  note.value = ''
  try {
    const results = await authApi.testReminders()
    const names: Record<string, string> = { ntfy: 'ntfy', telegram: 'Telegram', desktop: 'Desktop app' }
    note.value = results.map((r) => `${names[r.channel] ?? r.channel}: ${r.ok ? 'sent' : r.error}`).join(' · ')
  } catch (failure) {
    error.value = (failure as Error).message
  } finally {
    busy.value = false
  }
}

const habitType = computed(() => systemType('habit'))
</script>

<template>
  <SettingsSection id="reminders" title="Reminders" description="Sent by the server, so they arrive with the app closed: on your phone and computer through ntfy, from the Telegram bot, or as notifications of the desktop app.">
    <p v-if="unavailable" class="text-sm text-ink-soft">{{ unavailable }}</p>
    <form v-else-if="current" class="space-y-5" @submit.prevent="save">
      <div>
        <h3 class="mb-2 flex items-center gap-1.5 text-sm font-medium"><AppIcon fallback="ph:bell-ringing" class="text-ink-faint" /> ntfy</h3>
        <div class="grid gap-3 sm:grid-cols-2">
          <label :class="label">
            Server
            <input v-model="server" :class="field" placeholder="https://ntfy.sh" inputmode="url" autocomplete="off" />
            <span class="mt-1 block">Where the Vasta server reaches it: ntfy.sh, or your own (on the same Docker network, e.g. http://ntfy).</span>
          </label>
          <label :class="label">
            Topic
            <input v-model="topic" :class="field" placeholder="my-vasta-7f3k" autocomplete="off" />
          </label>
          <label :class="label" class="sm:col-span-2">
            Access token <span class="text-ink-faint">(for a protected topic)</span>
            <input v-model="token" :class="field" type="password" autocomplete="off" :placeholder="current.ntfy?.hasToken ? 'Saved; type a new one to replace it' : 'tk_…'" />
            <span class="mt-1 block">
              Subscribe to the topic in the ntfy app on your phone or computer. On ntfy.sh anyone who knows a topic's name can read it: pick one hard to guess, or use your own server.
              <button v-if="current.ntfy?.hasToken" type="button" class="text-accent hover:underline" @click="clearToken">Remove the token</button>
            </span>
          </label>
        </div>
      </div>

      <label class="flex items-start gap-2.5 text-sm" :class="current.telegramReady ? '' : 'opacity-60'">
        <input v-model="telegram" type="checkbox" class="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" :disabled="!current.telegramReady" />
        <span>
          Also from the Telegram bot
          <span class="block text-xs text-ink-faint">{{ current.telegramReady ? 'In your chat with the bot.' : 'Link your Telegram account below first (and the server needs the bot running).' }}</span>
        </span>
      </label>

      <label class="flex items-start gap-2.5 text-sm">
        <input v-model="desktop" type="checkbox" class="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
        <span>
          Also as notifications of the desktop app
          <span class="block text-xs text-ink-faint">
            While Vasta for desktop (0.1.10 or later) runs, even with its window closed; clicking one opens the page.
            <template v-if="current.desktopApps">Open now: {{ current.desktopApps === 1 ? '1 app' : `${current.desktopApps} apps` }}.</template>
            <template v-else-if="desktopApp && !desktopApp.notify">This app is older: update it to get them.</template>
            <template v-else>No desktop app is open right now.</template>
          </span>
        </span>
      </label>

      <div class="space-y-3 border-t border-line pt-4">
        <label class="flex items-start gap-2.5 text-sm">
          <input v-model="habits" type="checkbox" class="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
          <span>
            Habits, at their “Remind at” time, while not done that day
            <span class="block text-xs text-ink-faint">
              Set the time on each habit's page (“8:00”, “21h30”).
              <RouterLink v-if="habitType" :to="`/t/${habitType.id}`" class="text-accent hover:underline">Your habits</RouterLink>
            </span>
          </span>
        </label>
        <label :class="label" class="max-w-xs">
          Timed events and tasks
          <select v-model="eventsBefore" :class="field">
            <option v-for="lead in LEADS" :key="String(lead.value)" :value="lead.value">{{ lead.label }}</option>
          </select>
          <span class="mt-1 block">Objects with a time on the calendar, tasks not done, and events of subscribed calendars.</span>
        </label>
      </div>

      <div class="space-y-2 border-t border-line pt-4" data-work-notifications>
        <h3 class="flex items-center gap-1.5 text-sm font-medium"><AppIcon fallback="ph:users" class="text-ink-faint" /> Others' work</h3>
        <p class="text-xs text-ink-faint">The bell lists all of these; here, which also come through the channels above.</p>
        <label class="flex items-center gap-2.5 text-sm"><input v-model="work.assigned" type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" /> Someone assigns me</label>
        <label class="flex items-center gap-2.5 text-sm"><input v-model="work.mentioned" type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" /> Someone mentions me in a comment</label>
        <label class="flex items-center gap-2.5 text-sm">
          <input v-model="work.comments" type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" /> Comments on what I made, am assigned to, or commented on
        </label>
      </div>

      <div v-if="tracksFood" class="space-y-3 border-t border-line pt-4" data-food-reminders>
        <h3 class="flex items-center gap-1.5 text-sm font-medium"><AppIcon fallback="ph:bowl-food" class="text-ink-faint" /> Food</h3>
        <div class="flex flex-wrap items-center gap-2.5 text-sm">
          <label class="flex items-center gap-2.5">
            <input v-model="dayLeftOn" type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" />
            What is left of the day, at
          </label>
          <input v-if="food.dayLeft !== null" v-model="food.dayLeft" type="time" :class="field" class="!mt-0 !w-36" aria-label="Time for what is left of the day" />
          <span class="block w-full pl-6 text-xs text-ink-faint">“600 kcal left today · 40 g protein to go · the week is on track”, against the day's share of the weekly budget when the goal has one.</span>
        </div>
        <div class="flex flex-wrap items-center gap-2.5 text-sm">
          <label class="flex items-center gap-2.5">
            <input v-model="weekOn" type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" />
            The week's summary, on
          </label>
          <template v-if="food.week">
            <select v-model="food.week.day" :class="field" class="!mt-0 !w-36" aria-label="Day of the week's summary">
              <option v-for="(name, index) in WEEKDAYS" :key="name" :value="index">{{ name }}</option>
            </select>
            at
            <input v-model="food.week.at" type="time" :class="field" class="!mt-0 !w-36" aria-label="Time of the week's summary" />
          </template>
          <span class="block w-full pl-6 text-xs text-ink-faint">Within the budget or over it, protein a day, days on target and the streak, for the week ending that day (Monday to Sunday).</span>
        </div>
        <label :class="label" class="max-w-xs">
          Meals with nothing logged
          <select v-model="food.mealsAfter" :class="field">
            <option v-for="lead in MEAL_LEADS" :key="String(lead.value)" :value="lead.value">{{ lead.label }}</option>
          </select>
          <span class="mt-1 block">At each meal's usual time (Settings › Food tracking), plus this.</span>
        </label>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button type="submit" :class="primary" :disabled="!dirty || busy">Save</button>
        <button type="button" :class="secondary" :disabled="busy || (!topic.trim() && !telegram && !desktop)" @click="test">Send a test</button>
        <span v-if="note" class="text-sm text-ink-soft">{{ note }}</span>
        <span v-if="error" :class="errorText">{{ error }}</span>
      </div>
    </form>
  </SettingsSection>
</template>
