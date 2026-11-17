<script setup lang="ts">
// The editor of an insistent reminder (server/src/insistent.ts): when it starts, what it shows,
// how it is answered, and its ladder (the channels each step goes through, minutes apart, repeated
// until answered), with what snoozing costs. An existing one shows its honest stats too: how often
// it was done, snoozed, skipped or ignored, so it can be tuned when it is too much or too easy to
// ignore. Opened by an object's "Remind me…" and Settings › Reminders (lib/insistent.ts).
import { computed, onMounted, ref, watch } from 'vue'
import { habitRemindAt, type ObjectSummary } from '@vasta/core'
import { authApi, type AckMode, type LadderStep, type NagChannel, type ReminderSettings, type RuleContent, type RuleInput, type RuleWhen } from '../lib/api.ts'
import { CHANNELS, PRESETS, closeReminderEditor, presetOf, reminderEditor } from '../lib/insistent.ts'
import { desktop } from '../lib/platform.ts'
import { summaryOf, systemType, typesById } from '../lib/state.ts'
import AppIcon from './AppIcon.vue'
import ModalDialog from './ModalDialog.vue'
import ObjectPicker from './ObjectPicker.vue'
import PopoverMenu from './PopoverMenu.vue'
import ReminderStats from './ReminderStats.vue'

const existing = reminderEditor.rule
const objectId = existing?.objectId ?? reminderEditor.objectId
const object = computed(() => (objectId ? summaryOf(objectId) : undefined))
const type = computed(() => (object.value ? typesById.value.get(object.value.typeId) : undefined))
const isHabit = computed(() => type.value?.system === 'habit')
const isTask = computed(() => type.value?.system === 'task')
const habitTime = computed(() => (isHabit.value && object.value ? habitRemindAt(object.value) : undefined))
/** A date property with a time (a task's due, a meeting's start), or its own date with one. */
const hasTime = computed(() => {
  const o = object.value
  const t = type.value
  if (!o || !t || isHabit.value) return false
  return t.properties.some((p) => p.kind === 'date' && o.props[p.id]?.kind === 'date' && (o.props[p.id]!.value as { resolution?: string }).resolution === 'time') || o.date?.resolution === 'time'
})

// The form -------------------------------------------------------------------------
const title = ref(existing?.title ?? '')
const when = ref<RuleWhen>(existing?.when ?? (habitTime.value ? { kind: 'object' } : hasTime.value ? { kind: 'object', before: 0 } : { kind: 'daily', at: '09:00' }))
const content = ref<RuleContent>(existing?.content ?? (objectId ? { kind: 'target' } : { kind: 'tag', tagId: '', count: 1 }))
const ack = ref<AckMode>(existing?.ack ?? (isHabit.value || isTask.value ? 'done' : 'ok'))
const repeat = ref<number | null>(existing?.repeat ?? 15)
const steps = ref<LadderStep[]>(structuredClone(existing?.steps ?? PRESETS[1]!.steps))
const snooze = ref(existing?.snooze ?? 15)
const climbAfter = ref<number | null>(existing?.climbAfter ?? 2)
const escapeAfter = ref(existing?.escapeAfter ?? 10)
const paused = ref(!!existing?.paused)
const busy = ref(false)
const error = ref('')

// The object may not have loaded when the dialog opened: its defaults follow once it has.
watch([habitTime, hasTime, isHabit, isTask], () => {
  if (existing) return
  when.value = habitTime.value ? { kind: 'object' } : hasTime.value ? { kind: 'object', before: 0 } : when.value.kind === 'object' ? { kind: 'daily', at: '09:00' } : when.value
  if (isHabit.value || isTask.value) ack.value = ack.value === 'ok' ? 'done' : ack.value
})

const settings = ref<ReminderSettings | null>(null)
onMounted(async () => {
  try {
    settings.value = await authApi.reminders()
  } catch {}
})
/** Why a channel would not reach the user now; '' when it would. */
function channelGap(id: NagChannel): string {
  const s = settings.value
  if (!s) return ''
  if (id === 'ntfy') return s.ntfy ? '' : 'Set up ntfy in Settings › Reminders'
  if (id === 'telegram') return s.telegram && s.telegramReady ? '' : 'Turn on Telegram in Settings › Reminders'
  if (id === 'push') return s.push?.devices.length ? '' : 'Turn on notifications on a phone or browser'
  if (id === 'desktop') return s.desktop ? '' : 'Desktop notifications are off'
  if (id === 'takeover') return s.takeoverApps || desktop.value?.takeover ? '' : 'Needs Vasta for desktop 0.10 or later, open'
  return ''
}

// When -------------------------------------------------------------------------------
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const whenKind = computed({
  get: () => when.value.kind,
  set: (kind) => {
    const days = when.value.kind !== 'object' ? when.value.days : undefined
    when.value = kind === 'object' ? (isHabit.value ? { kind } : { kind, before: 0 }) : kind === 'daily' ? { kind, at: '09:00', ...(days ? { days } : {}) } : { kind, after: '08:00', ...(days ? { days } : {}) }
  },
})
const days = computed(() => (when.value.kind === 'object' ? [] : (when.value.days ?? [])))
function toggleDay(day: number) {
  if (when.value.kind === 'object') return
  const all = days.value.length ? days.value : [0, 1, 2, 3, 4, 5, 6]
  const next = all.includes(day) ? all.filter((d) => d !== day) : [...all, day].sort()
  when.value = { ...when.value, days: next.length === 7 ? undefined : next }
}
const latestOn = computed({
  get: () => when.value.kind === 'wake' && !!when.value.latest,
  set: (on) => {
    if (when.value.kind !== 'wake') return
    const { latest: _latest, ...rest } = when.value
    when.value = on ? { ...rest, latest: '11:00' } : rest
  },
})

// What it shows -------------------------------------------------------------------
const tagType = computed(() => systemType('tag'))
const queryType = computed(() => systemType('query'))
const pickerFor = ref<'tag' | 'query' | null>(null)
const pickerAnchor = ref<HTMLElement | null>(null)
const picked = computed(() => (content.value.kind === 'tag' && content.value.tagId ? summaryOf(content.value.tagId) : content.value.kind === 'query' && content.value.queryId ? summaryOf(content.value.queryId) : undefined))
const count = computed({
  get: () => (content.value.kind === 'tag' || content.value.kind === 'query' ? (content.value.count ?? 1) : 1),
  set: (n) => {
    if (content.value.kind === 'tag' || content.value.kind === 'query') content.value = { ...content.value, count: n }
  },
})
const contentKind = computed({
  get: () => content.value.kind,
  set: (kind) => {
    content.value = kind === 'tag' ? { kind, tagId: '', count: count.value } : kind === 'query' ? { kind, queryId: '', count: count.value } : { kind }
    if (kind === 'tasks' && (ack.value === 'type' || ack.value === 'say')) ack.value = isHabit.value || isTask.value ? 'done' : 'ok'
  },
})
function pick(o: ObjectSummary) {
  content.value = pickerFor.value === 'query' ? { kind: 'query', queryId: o.id, count: count.value } : { kind: 'tag', tagId: o.id, count: count.value }
  pickerFor.value = null
}
function openPicker(kind: 'tag' | 'query', event: MouseEvent) {
  pickerAnchor.value = event.currentTarget as HTMLElement
  pickerFor.value = kind
}

const ACKS = computed(() => [
  ...(isHabit.value || isTask.value ? [{ value: 'done' as const, label: isHabit.value ? 'Doing the habit' : 'Doing the task', icon: 'ph:check-circle', hint: isHabit.value ? 'Done for the day, here or wherever you mark it' : 'Marked done, here or anywhere' }] : []),
  { value: 'ok' as const, label: 'OK', icon: 'ph:hand-tap', hint: 'A tap says you saw it' },
  { value: 'type' as const, label: 'Typing it', icon: 'ph:keyboard', hint: 'Word for word: dismissing it becomes the ritual', needsText: true },
  { value: 'say' as const, label: 'Saying it out loud', icon: 'ph:microphone', hint: 'Speech recognition listens (typing works where it cannot)', needsText: true },
])
const textAnswer = computed(() => ack.value === 'type' || ack.value === 'say')

// The ladder ------------------------------------------------------------------------
const preset = computed(() => presetOf({ repeat: repeat.value, steps: steps.value }) ?? 'custom')
function usePreset(id: string) {
  const p = PRESETS.find((x) => x.id === id)
  if (!p) return
  repeat.value = p.repeat
  steps.value = structuredClone(p.steps)
}
function toggleChannel(step: LadderStep, id: NagChannel) {
  step.channels = step.channels.includes(id) ? step.channels.filter((c) => c !== id) : CHANNELS.map((c) => c.id).filter((c) => c === id || step.channels.includes(c))
}
function addStep() {
  const last = steps.value.at(-1)!
  steps.value.push({ after: last.after + (repeat.value ?? 15), channels: [...last.channels], urgent: true })
}
const usesTakeover = computed(() => steps.value.some((s) => s.channels.includes('takeover')))

// Saving ----------------------------------------------------------------------------
function input(): RuleInput {
  return {
    ...(title.value.trim() || !objectId ? { title: title.value.trim() } : {}),
    when: when.value,
    content: content.value,
    ack: ack.value,
    repeat: repeat.value,
    steps: steps.value,
    snooze: snooze.value,
    climbAfter: climbAfter.value,
    escapeAfter: escapeAfter.value,
    paused: paused.value,
  }
}

async function save() {
  busy.value = true
  error.value = ''
  try {
    const rule = existing ? await authApi.updateReminderRule(existing.id, input()) : await authApi.createReminderRule({ ...input(), ...(objectId ? { objectId } : {}) })
    reminderEditor.saved?.(rule)
    closeReminderEditor()
  } catch (failure) {
    error.value = (failure as Error).message
  } finally {
    busy.value = false
  }
}

async function remove() {
  if (!existing) return
  busy.value = true
  try {
    await authApi.deleteReminderRule(existing.id)
    reminderEditor.saved?.(null)
    closeReminderEditor()
  } catch (failure) {
    error.value = (failure as Error).message
  } finally {
    busy.value = false
  }
}

const heading = computed(() => (existing ? 'Insistent reminder' : object.value ? `Remind me of “${object.value.title || 'this'}”` : 'New insistent reminder'))
const chip = (on: boolean) => (on ? 'border-ink bg-ink text-surface' : 'border-line text-ink-soft hover:bg-hover')
</script>

<template>
  <ModalDialog :title="heading" width="44rem" @close="closeReminderEditor">
    <template #icon><AppIcon fallback="ph:bell-ringing" class="text-ink-faint" /></template>
    <form id="reminder-form" class="space-y-6 text-sm" @submit.prevent="save">
      <ReminderStats v-if="existing" :stats="existing.stats" />

      <label v-if="!objectId || title" class="block text-xs text-ink-faint">
        Title
        <input v-model="title" class="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-line-strong" :placeholder="objectId ? object?.title : 'Affirmation, Water, Stretch…'" maxlength="120" />
      </label>

      <!-- When -->
      <fieldset class="space-y-2.5">
        <legend class="mb-2 font-medium">When it starts</legend>
        <div class="flex flex-wrap gap-1.5">
          <button v-if="habitTime || hasTime" type="button" class="rounded-full border px-3 py-1" :class="chip(whenKind === 'object')" @click="whenKind = 'object'">
            {{ habitTime ? `At its “Remind at”, ${habitTime}` : 'At its own time' }}
          </button>
          <button type="button" class="rounded-full border px-3 py-1" :class="chip(whenKind === 'daily')" @click="whenKind = 'daily'">At a time of day</button>
          <button type="button" class="rounded-full border px-3 py-1" :class="chip(whenKind === 'wake')" @click="whenKind = 'wake'">When I'm first at the computer</button>
        </div>
        <div v-if="when.kind === 'object' && !isHabit" class="flex items-center gap-2 text-ink-soft">
          <select v-model.number="when.before" class="rounded-lg border border-line bg-surface px-2 py-1.5" aria-label="Minutes before it starts">
            <option :value="0">When it starts</option>
            <option v-for="m in [5, 10, 15, 30, 60, 120]" :key="m" :value="m">{{ m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}` }} before</option>
          </select>
        </div>
        <p v-if="when.kind === 'object' && isHabit" class="text-xs text-ink-faint">On the days the habit repeats on, while it is not done. Change the time on the habit's page.</p>
        <div v-if="when.kind === 'daily'" class="flex flex-wrap items-center gap-2 text-ink-soft">
          at <input v-model="when.at" type="time" class="rounded-lg border border-line bg-surface px-2 py-1.5" aria-label="Time" required />
        </div>
        <div v-if="when.kind === 'wake'" class="space-y-2 text-ink-soft">
          <div class="flex flex-wrap items-center gap-2">
            the first time after <input v-model="when.after" type="time" class="rounded-lg border border-line bg-surface px-2 py-1.5" aria-label="After" required />
            <label class="ml-2 flex items-center gap-1.5"><input v-model="latestOn" type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" /> by</label>
            <input v-if="when.latest" v-model="when.latest" type="time" class="rounded-lg border border-line bg-surface px-2 py-1.5" aria-label="At the latest" />
            <span v-if="when.latest">anyway</span>
          </div>
          <p class="text-xs text-ink-faint">The desktop app tells the server when you come back to the computer or it wakes up. Without it open, only “by … anyway” starts it.</p>
        </div>
        <div v-if="when.kind !== 'object'" class="flex gap-1" role="group" aria-label="Weekdays">
          <button
            v-for="(letter, day) in WEEKDAYS"
            :key="day"
            type="button"
            class="grid h-8 w-8 place-items-center rounded-full border text-xs font-medium"
            :class="chip(!days.length || days.includes(day))"
            :title="WEEKDAY_NAMES[day]"
            :aria-pressed="!days.length || days.includes(day)"
            @click="toggleDay(day)"
          >
            {{ letter }}
          </button>
        </div>
      </fieldset>

      <!-- What it shows -->
      <fieldset class="space-y-2.5">
        <legend class="mb-2 font-medium">What it shows</legend>
        <div class="flex flex-wrap gap-1.5">
          <button v-if="objectId" type="button" class="rounded-full border px-3 py-1" :class="chip(contentKind === 'target')" @click="contentKind = 'target'">This {{ type?.name.toLowerCase() ?? 'object' }}</button>
          <button type="button" class="rounded-full border px-3 py-1" :class="chip(contentKind === 'tag')" @click="contentKind = 'tag'">Random from a tag</button>
          <button v-if="queryType" type="button" class="rounded-full border px-3 py-1" :class="chip(contentKind === 'query')" @click="contentKind = 'query'">Random from a query</button>
          <button type="button" class="rounded-full border px-3 py-1" :class="chip(contentKind === 'tasks')" @click="contentKind = 'tasks'">Today's tasks</button>
        </div>
        <div v-if="content.kind === 'tag' || content.kind === 'query'" class="flex flex-wrap items-center gap-2 text-ink-soft">
          <select v-model.number="count" class="rounded-lg border border-line bg-surface px-2 py-1.5" aria-label="How many">
            <option v-for="n in 5" :key="n" :value="n">{{ n }}</option>
          </select>
          {{ count === 1 ? 'object' : 'objects' }} from
          <button type="button" class="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-ink hover:bg-hover" @click="openPicker(content.kind, $event)">
            <AppIcon :fallback="content.kind === 'tag' ? 'ph:tag' : 'ph:funnel'" :size="14" />
            {{ picked?.title || (content.kind === 'tag' ? 'Pick a tag…' : 'Pick a query…') }}
          </button>
          <span class="text-xs text-ink-faint">Picked anew each time, not the ones of last time.</span>
        </div>
        <PopoverMenu :open="!!pickerFor" :anchor="pickerAnchor" width="20rem" @update:open="(open: boolean) => !open && (pickerFor = null)">
          <ObjectPicker v-if="pickerFor" no-create :type-ids="pickerFor === 'tag' ? (tagType ? [tagType.id] : []) : queryType ? [queryType.id] : []" @pick="pick" />
        </PopoverMenu>
      </fieldset>

      <!-- How it is answered -->
      <fieldset>
        <legend class="mb-2 font-medium">It stops when I answer by</legend>
        <div class="grid gap-1.5 sm:grid-cols-2">
          <label
            v-for="option in ACKS"
            :key="option.value"
            class="flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2.5"
            :class="[ack === option.value ? 'border-ink' : 'border-line hover:bg-hover', option.needsText && content.kind === 'tasks' ? 'pointer-events-none opacity-40' : '']"
          >
            <input v-model="ack" type="radio" :value="option.value" class="sr-only" :disabled="option.needsText && content.kind === 'tasks'" />
            <AppIcon :fallback="option.icon" class="mt-0.5 text-ink-soft" />
            <span>
              {{ option.label }}
              <span class="block text-xs text-ink-faint">{{ option.hint }}</span>
            </span>
          </label>
        </div>
        <p v-if="textAnswer && isHabit" class="mt-2 text-xs text-ink-faint">Saying or typing it also marks the habit done for the day.</p>
        <p class="mt-2 text-xs text-ink-faint">Swiping a notification away does not count. “Not today” asks for a reason.</p>
      </fieldset>

      <!-- The ladder -->
      <fieldset class="space-y-3">
        <legend class="mb-2 font-medium">How insistent</legend>
        <div class="grid gap-1.5 sm:grid-cols-3">
          <button
            v-for="p in PRESETS"
            :key="p.id"
            type="button"
            class="rounded-xl border px-3 py-2.5 text-left"
            :class="preset === p.id ? 'border-ink' : 'border-line hover:bg-hover'"
            @click="usePreset(p.id)"
          >
            <span class="font-medium">{{ p.label }}</span>
            <span class="block text-xs text-ink-faint">{{ p.description }}</span>
          </button>
        </div>

        <div class="flex flex-wrap items-center gap-2 text-ink-soft">
          Repeat
          <select v-model="repeat" class="rounded-lg border border-line bg-surface px-2 py-1.5" aria-label="Repeat every">
            <option :value="null">only at each step</option>
            <option v-for="m in [2, 5, 10, 15, 20, 30, 45, 60, 90, 120]" :key="m" :value="m">every {{ m }} minutes</option>
          </select>
          until answered, or the day ends.
        </div>

        <ol class="space-y-2" data-ladder>
          <li v-for="(step, i) in steps" :key="i" class="rounded-xl border border-line px-3 py-2.5">
            <div class="flex flex-wrap items-center gap-2">
              <span class="grid h-6 w-6 place-items-center rounded-full bg-hover text-xs font-semibold">{{ i + 1 }}</span>
              <template v-if="i === 0">At the start</template>
              <template v-else>
                After <input v-model.number="step.after" type="number" min="1" max="720" class="w-16 rounded-lg border border-line bg-surface px-2 py-1" aria-label="Minutes after the start" /> min
              </template>
              <label class="ml-auto flex items-center gap-1.5 text-xs text-ink-soft" title="ntfy at its highest priority; phone notifications that stay until answered">
                <input v-model="step.urgent" type="checkbox" class="h-3.5 w-3.5 accent-[var(--color-accent)]" /> Urgent
              </label>
              <button v-if="i > 0" type="button" class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink" title="Remove this step" @click="steps.splice(i, 1)"><AppIcon fallback="ph:x" :size="13" /></button>
            </div>
            <div class="mt-2 flex flex-wrap gap-1.5">
              <button
                v-for="channel in CHANNELS"
                :key="channel.id"
                type="button"
                class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
                :class="[chip(step.channels.includes(channel.id)), channelGap(channel.id) ? 'border-dashed opacity-55' : '']"
                :title="channelGap(channel.id) || channel.hint"
                @click="toggleChannel(step, channel.id)"
              >
                <AppIcon :fallback="channel.icon" :size="13" /> {{ channel.label }}
              </button>
            </div>
          </li>
        </ol>
        <button v-if="steps.length < 6" type="button" class="text-xs text-accent hover:underline" @click="addStep">+ Add a step</button>
        <p v-if="steps.some((s) => s.channels.some((c) => channelGap(c)))" class="text-xs text-ink-faint">Dashed channels are not set up yet: hover one to see why. Until then that step skips them.</p>
      </fieldset>

      <!-- Snoozing -->
      <fieldset class="flex flex-wrap items-center gap-2 text-ink-soft">
        <legend class="mb-2 font-medium text-ink">Snoozing has a cost</legend>
        Snooze for
        <select v-model.number="snooze" class="rounded-lg border border-line bg-surface px-2 py-1.5" aria-label="Snooze minutes">
          <option v-for="m in [5, 10, 15, 30, 60]" :key="m" :value="m">{{ m }} min</option>
        </select>
        ; every
        <select v-model="climbAfter" class="rounded-lg border border-line bg-surface px-2 py-1.5" aria-label="Snoozes per step">
          <option :value="null">— (never climbs)</option>
          <option v-for="n in [1, 2, 3, 4, 5]" :key="n" :value="n">{{ n }}</option>
        </select>
        {{ climbAfter === 1 ? 'snooze climbs' : 'snoozes climb' }} one step of the ladder.
      </fieldset>

      <fieldset v-if="usesTakeover" class="flex flex-wrap items-center gap-2 text-ink-soft">
        <legend class="mb-2 font-medium text-ink">The takeover</legend>
        The desktop app covers every screen and Space with it. The way out (counted as skipped) shows after
        <select v-model.number="escapeAfter" class="rounded-lg border border-line bg-surface px-2 py-1.5" aria-label="Seconds before the way out">
          <option v-for="n in [5, 10, 20, 30, 60]" :key="n" :value="n">{{ n }} seconds</option>
        </select>
      </fieldset>

      <label v-if="existing" class="flex items-center gap-2.5"><input v-model="paused" type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" /> Paused</label>
    </form>

    <template #footer>
      <button v-if="existing" type="button" class="rounded-lg px-3 py-1.5 text-sm text-red-600 hover:bg-hover dark:text-red-400" :disabled="busy" @click="remove">Delete</button>
      <span v-if="error" class="text-sm text-red-600 dark:text-red-400">{{ error }}</span>
      <button type="button" class="ml-auto rounded-lg px-3 py-1.5 text-sm text-ink-soft hover:bg-hover" @click="closeReminderEditor">Cancel</button>
      <button type="submit" form="reminder-form" class="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-40" :disabled="busy">{{ existing ? 'Save' : 'Remind me' }}</button>
    </template>
  </ModalDialog>
</template>
