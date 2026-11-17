<script setup lang="ts">
// An insistent reminder going on (server/src/insistent.ts), and the one place it is answered:
// opened from its notifications, and shown by the desktop app over the whole screen
// (?takeover=1, App.vue shows it alone). It is answered the way its rule says: OK, doing the habit
// or task, typing its text, or saying it out loud (one phrase after another); snoozing has a cost
// (every few snoozes it climbs a step), and "Not today" asks why. The takeover always offers a
// way out after a few seconds, recorded as skipped.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { SAID_MATCH, TYPED_MATCH, textMatch } from '@vasta/core'
import AppIcon from '../components/AppIcon.vue'
import { authApi, type NagAnswer, type NagView } from '../lib/api.ts'
import { closeTakeover, takeoverReady } from '../lib/platform.ts'
import { listen, speechLanguage, speechUnavailable, type Listening } from '../lib/speech.ts'

const props = defineProps<{ id: string }>()
const route = useRoute()
const takeover = route.query.takeover === '1'
/** The desktop app's floating pop-up (?popup=1): a small window, so a tighter layout. */
const popup = takeover && route.query.popup === '1'

const nag = ref<NagView | null>(null)
const error = ref('')
const busy = ref(false)
/** What happened here, once answered (or snoozed). */
const after = ref<{ icon: string; title: string; text: string } | null>(null)
/** Answered for real (green), let go (amber), or missed (grey). */
const tone = computed(() => {
  const outcome = nag.value?.outcome
  if (after.value?.icon === 'ph:alarm') return 'text-sky-600 dark:text-sky-400'
  if (outcome === 'skipped' || outcome === 'escaped') return 'text-amber-600 dark:text-amber-400'
  if (outcome === 'ignored') return 'text-ink-faint'
  return 'text-emerald-600 dark:text-emerald-400'
})

async function load() {
  try {
    const view = await authApi.nag(props.id)
    // Answered elsewhere (the phone, Telegram) while this was open.
    if (view.outcome && !after.value && nag.value && !nag.value.outcome) finish(view, 'elsewhere')
    nag.value = view
  } catch (failure) {
    error.value = (failure as Error).message
    // A takeover that cannot show its reminder must not sit on the screen.
    if (takeover && !nag.value) closeTakeover()
  }
}

let poll: ReturnType<typeof setInterval> | undefined
onMounted(async () => {
  await load()
  if (route.query.skip !== undefined && nag.value && !nag.value.outcome) askingWhy.value = true
  poll = setInterval(() => void (document.hidden || after.value || load()), 20_000)
})
onBeforeUnmount(() => {
  clearInterval(poll)
  listening.value?.stop()
})

const typeLabel = computed(() => (nag.value?.object?.system === 'habit' ? 'Habit' : nag.value?.object?.system === 'task' ? 'Task' : 'Reminder'))
const status = computed(() => {
  const n = nag.value
  if (!n) return ''
  const parts = [n.sent > 1 ? `Reminder ${n.sent}` : 'Reminder', n.snoozes ? `snoozed ${n.snoozes === 1 ? 'once' : `${n.snoozes} times`}` : '', n.steps > 1 ? `step ${n.step + 1} of ${n.steps}` : '']
  return parts.filter(Boolean).join(' · ')
})
/** Snoozes left before snoozing climbs a step. */
const snoozeCost = computed(() => {
  const n = nag.value
  if (!n?.climbAfter || n.steps <= 1 || n.step >= n.steps - 1) return ''
  const left = n.climbAfter - (n.snoozes % n.climbAfter)
  return left === 1 ? 'This snooze climbs a step.' : `${left} more snoozes climb a step.`
})

// Typing or saying the text, one phrase after another ----------------------------
const index = ref(0)
const texts = ref<string[]>([])
const input = ref('')
const heard = ref('')
const matched = ref(false)
const typing = ref(false)
const listening = ref<Listening | null>(null)
const speechError = ref('')
const whyNoSpeech = speechUnavailable()
const saying = computed(() => nag.value?.ack === 'say' && !typing.value && !whyNoSpeech)
const current = computed(() => nag.value?.expected[index.value] ?? '')
const progress = computed(() => (current.value ? textMatch(current.value, saying.value ? heard.value : input.value) : 0))

// Typed text is checked on Enter, not while typing: a phrase that is mostly there already would
// pass before the user finished it.
const typedError = ref('')
watch(input, () => (typedError.value = ''))
function submitTyped() {
  if (!current.value || matched.value || saying.value || !input.value.trim()) return
  if (textMatch(current.value, input.value) >= TYPED_MATCH) accept(input.value)
  else typedError.value = 'Not quite yet: check it and press Enter again.'
}

function accept(text: string) {
  matched.value = true
  texts.value[index.value] = text
  listening.value?.stop()
  listening.value = null
  setTimeout(() => {
    matched.value = false
    input.value = ''
    heard.value = ''
    if (index.value + 1 < (nag.value?.expected.length ?? 0)) {
      index.value++
      if (saying.value) startListening()
    } else void answer(saying.value ? 'said' : 'typed', { texts: texts.value })
  }, 650)
}

function startListening() {
  speechError.value = ''
  heard.value = ''
  listening.value?.stop()
  listening.value = listen(
    speechLanguage(current.value),
    (text) => {
      heard.value = text
      if (!matched.value && textMatch(current.value, text) >= SAID_MATCH) accept(text)
    },
    (failure) => {
      listening.value = null
      if (failure) speechError.value = failure
    }
  )
}

function toggleListening() {
  if (listening.value) {
    listening.value.stop()
    listening.value = null
  } else startListening()
}

// Answers -----------------------------------------------------------------------
const askingWhy = ref(false)
const reason = ref('')

async function answer(kind: NagAnswer, extra: { texts?: string[]; reason?: string } = {}) {
  if (!nag.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const view = await authApi.answerNag(nag.value.id, kind, extra)
    finish(view, kind)
    nag.value = view
  } catch (failure) {
    error.value = (failure as Error).message
    // The way out works even when the server cannot be reached.
    if (kind === 'escape' && takeover) closeTakeover()
    // A phrase the server did not take: say it again.
    if (kind === 'said' || kind === 'typed') {
      index.value = 0
      texts.value = []
    }
  } finally {
    busy.value = false
  }
}

function finish(view: NagView, kind: NagAnswer | 'elsewhere') {
  listening.value?.stop()
  const until = new Date(Date.now() + view.snooze * 60_000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const habit = view.object?.system === 'habit'
  after.value =
    kind === 'snooze'
      ? { icon: 'ph:alarm', title: `Snoozed until ${until}`, text: snoozeCost.value ? `It comes back then. ${snoozeCost.value.replace('This snooze climbs', 'It climbed')}` : 'It comes back then.' }
      : view.outcome === 'skipped'
        ? { icon: 'ph:moon-stars', title: 'Not today', text: 'Noted why. It is back tomorrow.' }
        : view.outcome === 'escaped'
          ? { icon: 'ph:door-open', title: 'Let go for now', text: 'Counted as skipped.' }
          : view.outcome === 'said'
            ? { icon: 'ph:microphone', title: 'Said out loud', text: habit ? 'Done for today.' : 'That counts.' }
            : view.outcome === 'typed'
              ? { icon: 'ph:keyboard', title: 'Written down', text: habit ? 'Done for today.' : 'That counts.' }
              : view.outcome === 'ignored'
                ? { icon: 'ph:clock-counter-clockwise', title: 'This one is over', text: 'Its day ended before an answer.' }
                : { icon: 'ph:check-circle', title: view.outcome === 'ok' ? 'Seen' : 'Done', text: kind === 'elsewhere' ? 'Answered somewhere else.' : 'That counts.' }
  // Answered (not snoozed, skipped or let go): the note it opens afterwards, if it has one.
  const answered = view.outcome === 'ok' || view.outcome === 'done' || view.outcome === 'typed' || view.outcome === 'said'
  const open = answered && view.openAfter ? `o/${view.openAfter.id}` : undefined
  if (takeover) setTimeout(() => closeTakeover(open), kind === 'snooze' ? 1800 : 1400)
}

const skip = () => {
  if (!reason.value.trim()) return
  void answer('skip', { reason: reason.value })
}

// The takeover's way out ---------------------------------------------------------
const escapeIn = ref(0)
let countdown: ReturnType<typeof setInterval> | undefined
watch(
  () => nag.value?.escapeAfter,
  (seconds) => {
    if (!takeover || !seconds || countdown) return
    escapeIn.value = seconds
    countdown = setInterval(() => {
      escapeIn.value = Math.max(0, escapeIn.value - 1)
      if (!escapeIn.value) clearInterval(countdown)
    }, 1000)
  },
  { immediate: true }
)
onBeforeUnmount(() => clearInterval(countdown))

const open = computed(() => !!nag.value && !nag.value.outcome && !after.value)
// The takeover stays only once the reminder and its way out show; one answered already goes.
watch(
  () => nag.value,
  (view) => {
    if (!takeover || !view) return
    if (view.outcome && !after.value) closeTakeover()
    else takeoverReady()
  },
  { immediate: true }
)
</script>

<template>
  <div
    class="flex min-h-full flex-col items-center justify-center px-5"
    :class="[takeover ? 'h-full bg-canvas' : '', popup ? 'overflow-hidden rounded-2xl border border-line py-6' : 'py-10']"
    :data-takeover="takeover || undefined"
  >
    <!-- The desktop takeover has no title bar: its top edge moves the window (it is full screen anyway). -->
    <div v-if="takeover" class="fixed inset-x-0 top-0 h-8" data-tauri-drag-region />

    <p v-if="error && !nag" class="text-sm text-ink-soft">{{ error }}</p>
    <p v-else-if="!nag" class="text-sm text-ink-faint">Loading…</p>

    <!-- Answered: here, or before this page opened. -->
    <div v-else-if="!open" class="w-full max-w-md text-center" data-remind-done>
      <div class="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-full bg-surface text-3xl shadow-sm ring-1 ring-line" :class="tone">
        <AppIcon :fallback="after?.icon ?? 'ph:check-circle'" :size="34" />
      </div>
      <h1 class="text-2xl font-semibold tracking-tight">{{ after?.title ?? 'Already answered' }}</h1>
      <p class="mt-2 text-ink-soft">{{ after?.text ?? nag.reason ?? nag.title }}</p>
      <div v-if="!takeover" class="mt-6 flex justify-center gap-2 text-sm">
        <RouterLink v-if="nag.object" :to="`/o/${nag.object.id}`" class="rounded-lg border border-line px-3 py-1.5 hover:bg-hover">Open {{ typeLabel.toLowerCase() }}</RouterLink>
        <RouterLink to="/settings#reminders" class="rounded-lg border border-line px-3 py-1.5 hover:bg-hover">Reminders</RouterLink>
      </div>
    </div>

    <article v-else class="w-full max-w-xl" data-remind>
      <p class="mb-3 flex items-center justify-center gap-1.5 text-xs font-medium uppercase tracking-wider text-ink-faint">
        <AppIcon :fallback="nag.ack === 'say' ? 'ph:microphone' : nag.ack === 'type' ? 'ph:keyboard' : 'ph:bell-ringing'" :size="14" />
        {{ status }}
      </p>
      <h1 class="text-center font-bold tracking-tight" :class="popup ? 'text-2xl' : 'text-3xl md:text-4xl'">{{ nag.title }}</h1>

      <!-- Saying or typing the text: one phrase at a time. -->
      <section v-if="nag.expected.length" :class="popup ? 'mt-5' : 'mt-8'">
        <div v-if="nag.expected.length > 1" class="mb-4 flex justify-center gap-1.5" aria-hidden="true">
          <span v-for="(_, i) in nag.expected" :key="i" class="h-1.5 w-8 rounded-full transition-colors" :class="i < index || (i === index && matched) ? 'bg-emerald-500' : i === index ? 'bg-ink-faint' : 'bg-line'" />
        </div>
        <blockquote
          class="rounded-2xl border bg-surface text-center leading-snug font-medium shadow-sm transition-colors"
          :class="[popup ? 'px-5 py-5 text-xl' : 'px-6 py-7 text-2xl md:text-[1.75rem]', matched ? 'border-emerald-400 text-emerald-700 dark:text-emerald-300' : 'border-line']"
          data-phrase
        >
          “{{ current }}”
        </blockquote>

        <div v-if="saying" class="mt-6 flex flex-col items-center gap-3">
          <button
            type="button"
            class="relative grid h-20 w-20 place-items-center rounded-full shadow-lg transition-transform active:scale-95"
            :class="listening ? 'bg-rose-500 text-white' : 'bg-ink text-surface'"
            :title="listening ? 'Stop listening' : 'Say it'"
            :disabled="busy || matched"
            @click="toggleListening"
          >
            <span v-if="listening" class="absolute inset-0 animate-ping rounded-full bg-rose-400/50" />
            <AppIcon :fallback="listening ? 'ph:stop-fill' : 'ph:microphone-fill'" :size="32" class="relative" />
          </button>
          <p class="min-h-6 max-w-md text-center text-ink-soft" aria-live="polite">
            <template v-if="heard">{{ heard }}</template>
            <template v-else-if="listening">Listening… say it out loud.</template>
            <template v-else>Tap and say it out loud.</template>
          </p>
          <div v-if="listening && heard" class="h-1 w-40 overflow-hidden rounded-full bg-line"><div class="h-full bg-emerald-500 transition-all" :style="{ width: `${Math.min(100, Math.round((progress / SAID_MATCH) * 100))}%` }" /></div>
          <p v-if="speechError" class="text-sm text-red-600 dark:text-red-400">{{ speechError }}</p>
          <button type="button" class="text-xs text-ink-faint hover:text-ink" @click="(typing = true), listening?.stop(), (listening = null)">Type it instead</button>
        </div>
        <form v-else class="mt-6" @submit.prevent="submitTyped">
          <input
            v-model="input"
            class="w-full rounded-xl border border-line bg-surface px-4 py-3 text-center text-lg outline-none focus:border-line-strong"
            :placeholder="nag.ack === 'say' ? 'Type it (or say it, where the microphone works)' : 'Type it, word for word'"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            :disabled="busy || matched"
            autofocus
            data-type-it
          />
          <p class="mt-2 text-center text-xs" :class="typedError ? 'text-amber-700 dark:text-amber-400' : 'text-ink-faint'" data-type-hint>{{ typedError || 'Press Enter when you are done.' }}</p>
          <p v-if="nag.ack === 'say' && whyNoSpeech" class="mt-2 text-center text-xs text-ink-faint">{{ whyNoSpeech }}</p>
          <button v-else-if="nag.ack === 'say' && typing" type="button" class="mt-2 block w-full text-center text-xs text-ink-faint hover:text-ink" @click="(typing = false), startListening()">Say it instead</button>
        </form>
      </section>

      <!-- What it shows: the object's text, random picks, today's tasks. -->
      <section v-else-if="nag.items.length || nag.tasks" class="mt-6 space-y-3">
        <div v-for="item in nag.items" :key="item.id" class="rounded-2xl border border-line bg-surface px-5 py-4 shadow-sm">
          <RouterLink v-if="item.title" :to="`/o/${item.id}`" class="font-medium hover:underline">{{ item.title }}</RouterLink>
          <p v-if="item.text" class="mt-1 whitespace-pre-line text-ink-soft">{{ item.text }}</p>
        </div>
        <ul v-if="nag.tasks" class="divide-y divide-line rounded-2xl border border-line bg-surface shadow-sm">
          <li v-for="task in nag.tasks" :key="task.id" class="px-5 py-3">
            <RouterLink :to="`/o/${task.id}`" class="hover:underline">{{ task.title }}</RouterLink>
          </li>
          <li v-if="!nag.tasks.length" class="px-5 py-3 text-ink-faint">No tasks due today.</li>
        </ul>
      </section>

      <div class="mt-8 flex flex-col items-center gap-3">
        <button v-if="nag.ack === 'done' || nag.ack === 'ok'" type="button" class="min-w-48 rounded-xl bg-ink px-6 py-3 text-base font-semibold text-surface shadow-sm hover:opacity-90 disabled:opacity-40" :disabled="busy" data-answer @click="answer(nag.ack)">
          {{ nag.ack === 'done' ? (nag.object?.system === 'habit' ? 'Done for today' : 'Mark done') : 'OK, got it' }}
        </button>

        <div v-if="!askingWhy" class="flex flex-wrap items-center justify-center gap-2 text-sm">
          <button type="button" class="rounded-lg border border-line px-3 py-1.5 hover:bg-hover disabled:opacity-40" :disabled="busy" :title="snoozeCost || undefined" @click="answer('snooze')">
            Snooze {{ nag.snooze }} min
          </button>
          <button type="button" class="rounded-lg border border-line px-3 py-1.5 hover:bg-hover disabled:opacity-40" :disabled="busy" @click="askingWhy = true">Not today…</button>
        </div>
        <p v-if="snoozeCost && !askingWhy" class="text-xs text-ink-faint">{{ snoozeCost }}</p>

        <form v-if="askingWhy" class="w-full max-w-md" @submit.prevent="skip">
          <label class="block text-sm text-ink-soft">
            Why not today? One line, for your stats.
            <input v-model="reason" class="mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-line-strong" maxlength="200" placeholder="Sick, travelling, did it another way…" autofocus data-reason />
          </label>
          <div class="mt-2 flex justify-end gap-2 text-sm">
            <button type="button" class="rounded-lg px-3 py-1.5 text-ink-soft hover:bg-hover" @click="askingWhy = false">Back</button>
            <button type="submit" class="rounded-lg bg-ink px-3 py-1.5 font-medium text-surface disabled:opacity-40" :disabled="busy || !reason.trim()">Skip today</button>
          </div>
        </form>
        <p v-if="error" class="text-sm text-red-600 dark:text-red-400">{{ error }}</p>
      </div>

      <!-- The takeover never traps anyone. -->
      <div v-if="takeover" class="text-center text-xs text-ink-faint" :class="popup ? 'mt-6' : 'mt-10'">
        <span v-if="escapeIn">You can leave in {{ escapeIn }} s</span>
        <button v-else type="button" class="underline-offset-2 hover:text-ink hover:underline" data-escape @click="answer('escape')">Let me go (counts as skipped)</button>
      </div>
    </article>
  </div>
</template>
