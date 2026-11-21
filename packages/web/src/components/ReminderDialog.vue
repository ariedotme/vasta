<script setup lang="ts">
// The editor of a reminder (server/src/insistent.ts), in parts: when it starts, what it shows,
// how it reaches you (a style: a pop-up, the whole screen, notifications, escalating; or steps of
// its own, each through some channels, minutes apart, repeated until answered) and how it is
// answered, with what snoozing costs. An existing one shows its honest stats too: how often
// it was done, snoozed, skipped or ignored, so it can be tuned when it is too much or too easy to
// ignore. Opened by an object's "Remind me…" and Settings › Reminders (lib/insistent.ts).
import { computed, onMounted, ref, watch } from 'vue'
import { addDays, habitRemindAt, type ObjectSummary } from '@vasta/core'
import { authApi, type AckMode, type LadderStep, type NagChannel, type ReminderSettings, type RuleContent, type RuleInput, type RuleWhen } from '../lib/api.ts'
import { locale, t, tc, typeName } from '../lib/i18n.ts'
import { CHANNELS, STYLES, closeReminderEditor, reminderEditor, styleOf } from '../lib/insistent.ts'
import { desktop } from '../lib/platform.ts'
import { summaryOf, systemType, typesById, workspace } from '../lib/state.ts'
import AppIcon from './AppIcon.vue'
import ModalDialog from './ModalDialog.vue'
import ObjectPicker from './ObjectPicker.vue'
import PopoverMenu from './PopoverMenu.vue'
import ReminderStats from './ReminderStats.vue'

/** A deep copy that also takes Vue's reactive proxies (structuredClone refuses them). */
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const existing = reminderEditor.rule ? copy(reminderEditor.rule) : undefined
const objectId = existing?.objectId ?? reminderEditor.objectId
const object = computed(() => (objectId ? summaryOf(objectId) : undefined))
const type = computed(() => (object.value ? typesById.value.get(object.value.typeId) : undefined))
const isHabit = computed(() => type.value?.system === 'habit')
const isTask = computed(() => type.value?.system === 'task')
const habitTime = computed(() => (isHabit.value && object.value ? habitRemindAt(object.value) : undefined))
/** A date property with a time (a task's due, a meeting's start), or its own date with one. */
const hasTime = computed(() => {
  const o = object.value
  const typeDef = type.value
  if (!o || !typeDef || isHabit.value) return false
  return typeDef.properties.some((p) => p.kind === 'date' && o.props[p.id]?.kind === 'date' && (o.props[p.id]!.value as { resolution?: string }).resolution === 'time') || o.date?.resolution === 'time'
})

// The form -------------------------------------------------------------------------
const title = ref(existing?.title ?? '')
const when = ref<RuleWhen>(existing?.when ?? (habitTime.value ? { kind: 'object' } : hasTime.value ? { kind: 'object', before: 0 } : { kind: 'daily', at: '09:00' }))
const content = ref<RuleContent>(existing?.content ?? (objectId ? { kind: 'target' } : { kind: 'tag', tagId: '', count: 1 }))
const ack = ref<AckMode>(existing?.ack ?? (isHabit.value || isTask.value ? 'done' : 'ok'))
// A new one pops up when the desktop app is there to show it, else it is a notification.
const firstStyle = STYLES.find((s) => s.id === (desktop.value?.takeover ? 'popup' : 'notification'))!
const repeat = ref<number | null>(existing ? existing.repeat : firstStyle.repeat)
const steps = ref<LadderStep[]>(copy(existing?.steps ?? firstStyle.steps))
const snooze = ref(existing?.snooze ?? 15)
const climbAfter = ref<number | null>(existing?.climbAfter ?? 2)
const escapeAfter = ref(existing?.escapeAfter ?? 10)
const skipIfEmpty = ref(existing ? (existing.skipIfEmpty ?? existing.content.kind === 'tasks') : content.value.kind === 'tasks')
const paused = ref(!!existing?.paused)
/** The note the desktop app opens once it is answered; null: it stays out of the way. */
const openAfter = ref<string | null>(existing?.openAfter ?? null)
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
  if (id === 'ntfy') return s.ntfy ? '' : t('reminders.gap.ntfy')
  if (id === 'telegram') return s.telegram && s.telegramReady ? '' : t('reminders.gap.telegram')
  if (id === 'push') return s.push?.devices.length ? '' : t('reminders.gap.push')
  if (id === 'desktop') return s.desktop ? '' : t('reminders.gap.desktop')
  if (id === 'takeover' || id === 'popup') return s.takeoverApps || desktop.value?.takeover ? '' : t('reminders.gap.desktopApp', { version: id === 'popup' ? '0.11' : '0.10' })
  return ''
}

// When -------------------------------------------------------------------------------
const WEEKDAYS = computed(() => {
  const fmt = new Intl.DateTimeFormat(locale.value, { weekday: 'narrow', timeZone: 'UTC' })
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(`${addDays('2026-10-18', i)}T00:00:00.000Z`)))
})
const WEEKDAY_NAMES = computed(() => {
  const fmt = new Intl.DateTimeFormat(locale.value, { weekday: 'long', timeZone: 'UTC' })
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(`${addDays('2026-10-18', i)}T00:00:00.000Z`)))
})
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
const pickerFor = ref<'tag' | 'query' | 'after' | null>(null)
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
    skipIfEmpty.value = kind === 'tasks'
    if (kind === 'tasks' && (ack.value === 'type' || ack.value === 'say')) ack.value = isHabit.value || isTask.value ? 'done' : 'ok'
  },
})
function pick(o: ObjectSummary) {
  if (pickerFor.value === 'after') {
    openAfter.value = o.id
    pickerFor.value = null
    return
  }
  content.value = pickerFor.value === 'query' ? { kind: 'query', queryId: o.id, count: count.value } : { kind: 'tag', tagId: o.id, count: count.value }
  pickerFor.value = null
}
function openPicker(kind: 'tag' | 'query' | 'after', event: MouseEvent) {
  pickerAnchor.value = event.currentTarget as HTMLElement
  pickerFor.value = kind
}

const ACKS = computed(() => [
  ...(isHabit.value || isTask.value ? [{ value: 'done' as const, label: isHabit.value ? t('reminders.ack.doingHabit') : t('reminders.ack.doingTask'), icon: 'ph:check-circle', hint: isHabit.value ? t('reminders.ack.doingHabitHint') : t('reminders.ack.doingTaskHint') }] : []),
  { value: 'ok' as const, label: t('common.ok'), icon: 'ph:hand-tap', hint: t('reminders.ack.okHint') },
  { value: 'type' as const, label: t('reminders.ack.typing'), icon: 'ph:keyboard', hint: t('reminders.ack.typingHint'), needsText: true },
  { value: 'say' as const, label: t('reminders.ack.saying'), icon: 'ph:microphone', hint: t('reminders.ack.sayingHint'), needsText: true },
])
const textAnswer = computed(() => ack.value === 'type' || ack.value === 'say')

// How it reaches you: a style, or steps of its own ------------------------------------
const style = computed(() => styleOf({ repeat: repeat.value, steps: steps.value })?.id ?? 'custom')
const customizing = ref(style.value === 'custom')
function useStyle(id: string) {
  const p = STYLES.find((x) => x.id === id)
  if (!p) return
  repeat.value = p.repeat
  steps.value = copy(p.steps)
}
const desktopMissing = (channels: NagChannel[]) => channels.some((c) => (c === 'popup' || c === 'takeover') && channelGap(c))
function toggleChannel(step: LadderStep, id: NagChannel) {
  step.channels = step.channels.includes(id) ? step.channels.filter((c) => c !== id) : CHANNELS.map((c) => c.id).filter((c) => c === id || step.channels.includes(c))
}
function addStep() {
  const last = steps.value.at(-1)!
  steps.value.push({ after: last.after + (repeat.value ?? 15), channels: [...last.channels], urgent: true })
}
const usesWindow = computed(() => steps.value.some((s) => s.channels.includes('takeover') || s.channels.includes('popup')))

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
    ...(content.value.kind !== 'target' ? { skipIfEmpty: skipIfEmpty.value } : {}),
    paused: paused.value,
    openAfter: openAfter.value,
  }
}

async function save() {
  busy.value = true
  error.value = ''
  try {
    const spaceId = !objectId ? workspace.space?.id : undefined
    const rule = existing
      ? await authApi.updateReminderRule(existing.id, input())
      : await authApi.createReminderRule({ ...input(), ...(objectId ? { objectId } : {}), ...(spaceId ? { spaceId } : {}) })
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

const heading = computed(() => (existing ? t('reminders.title') : object.value ? t('reminders.remindMeOf', { title: object.value.title || t('reminders.thisFallback') }) : t('reminders.newTitle')))
const typeLower = computed(() => (type.value ? typeName(type.value).toLowerCase() : t('object.objectFallback')))
const chip = (on: boolean) => (on ? 'border-ink bg-ink text-surface' : 'border-line text-ink-soft hover:bg-hover')
</script>

<template>
  <ModalDialog :title="heading" width="44rem" @close="closeReminderEditor">
    <template #icon><AppIcon fallback="ph:bell-ringing" class="text-ink-faint" /></template>
    <form id="reminder-form" class="space-y-6 text-sm" @submit.prevent="save">
      <ReminderStats v-if="existing" :stats="existing.stats" />

      <label v-if="!objectId || title" class="block text-xs text-ink-faint">
        {{ t('object.titleLabel') }}
        <input v-model="title" class="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-line-strong" :placeholder="objectId ? object?.title : t('reminders.titlePlaceholder')" maxlength="120" />
      </label>

      <!-- When -->
      <fieldset class="space-y-2.5">
        <legend class="mb-2 font-medium">{{ t('reminders.section.when') }}</legend>
        <div class="flex flex-wrap gap-1.5">
          <button v-if="habitTime || hasTime" type="button" class="rounded-full border px-3 py-1" :class="chip(whenKind === 'object')" @click="whenKind = 'object'">
            {{ habitTime ? t('reminders.when.habitRemindAt', { time: habitTime }) : t('reminders.when.ownTime') }}
          </button>
          <button type="button" class="rounded-full border px-3 py-1" :class="chip(whenKind === 'daily')" @click="whenKind = 'daily'">{{ t('reminders.when.timeOfDay') }}</button>
          <button type="button" class="rounded-full border px-3 py-1" :class="chip(whenKind === 'wake')" @click="whenKind = 'wake'">{{ t('reminders.when.firstAtComputer') }}</button>
        </div>
        <div v-if="when.kind === 'object' && !isHabit" class="flex items-center gap-2 text-ink-soft">
          <select v-model.number="when.before" class="rounded-lg border border-line bg-surface px-2 py-1.5" :aria-label="t('reminders.when.minutesBeforeLabel')">
            <option :value="0">{{ t('reminders.when.whenItStarts') }}</option>
            <option v-for="m in [5, 10, 15, 30, 60, 120]" :key="m" :value="m">{{ m < 60 ? t('reminders.when.minutesBefore', { min: m }) : tc(m / 60, 'reminders.when.hoursBefore.one', 'reminders.when.hoursBefore.other', { hours: m / 60 }) }}</option>
          </select>
        </div>
        <p v-if="when.kind === 'object' && isHabit" class="text-xs text-ink-faint">{{ t('reminders.when.habitNote') }}</p>
        <div v-if="when.kind === 'daily'" class="flex flex-wrap items-center gap-2 text-ink-soft">
          {{ t('reminders.when.at') }} <input v-model="when.at" type="time" class="rounded-lg border border-line bg-surface px-2 py-1.5" :aria-label="t('reminders.when.timeLabel')" required />
        </div>
        <div v-if="when.kind === 'wake'" class="space-y-2 text-ink-soft">
          <div class="flex flex-wrap items-center gap-2">
            {{ t('reminders.when.firstAfter') }} <input v-model="when.after" type="time" class="rounded-lg border border-line bg-surface px-2 py-1.5" :aria-label="t('reminders.when.afterLabel')" required />
            <label class="ml-2 flex items-center gap-1.5"><input v-model="latestOn" type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" /> {{ t('reminders.when.by') }}</label>
            <input v-if="when.latest" v-model="when.latest" type="time" class="rounded-lg border border-line bg-surface px-2 py-1.5" :aria-label="t('reminders.when.latestLabel')" />
            <span v-if="when.latest">{{ t('reminders.when.anyway') }}</span>
          </div>
          <p class="text-xs text-ink-faint">{{ t('reminders.when.wakeHint') }}</p>
        </div>
        <div v-if="when.kind !== 'object'" class="flex gap-1" role="group" :aria-label="t('reminders.when.weekdaysLabel')">
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
        <legend class="mb-2 font-medium">{{ t('reminders.section.what') }}</legend>
        <div class="flex flex-wrap gap-1.5">
          <button v-if="objectId" type="button" class="rounded-full border px-3 py-1" :class="chip(contentKind === 'target')" @click="contentKind = 'target'">{{ t('reminders.what.thisType', { type: typeLower }) }}</button>
          <button type="button" class="rounded-full border px-3 py-1" :class="chip(contentKind === 'tag')" @click="contentKind = 'tag'">{{ t('reminders.what.randomTag') }}</button>
          <button v-if="queryType" type="button" class="rounded-full border px-3 py-1" :class="chip(contentKind === 'query')" @click="contentKind = 'query'">{{ t('reminders.what.randomQuery') }}</button>
          <button type="button" class="rounded-full border px-3 py-1" :class="chip(contentKind === 'tasks')" @click="contentKind = 'tasks'">{{ t('reminders.what.todaysTasks') }}</button>
        </div>
        <div v-if="content.kind === 'tag' || content.kind === 'query'" class="flex flex-wrap items-center gap-2 text-ink-soft">
          <select v-model.number="count" class="rounded-lg border border-line bg-surface px-2 py-1.5" :aria-label="t('reminders.what.howManyLabel')">
            <option v-for="n in 5" :key="n" :value="n">{{ n }}</option>
          </select>
          {{ tc(count, 'reminders.what.objectsFrom.one', 'reminders.what.objectsFrom.other') }}
          <button type="button" class="flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-ink hover:bg-hover" @click="openPicker(content.kind, $event)">
            <AppIcon :fallback="content.kind === 'tag' ? 'ph:tag' : 'ph:funnel'" :size="14" />
            {{ picked?.title || (content.kind === 'tag' ? t('reminders.what.pickTag') : t('reminders.what.pickQuery')) }}
          </button>
          <span class="text-xs text-ink-faint">{{ t('reminders.what.pickedAnew') }}</span>
        </div>
        <PopoverMenu :open="!!pickerFor" :anchor="pickerAnchor" width="20rem" @update:open="(open: boolean) => !open && (pickerFor = null)">
          <ObjectPicker v-if="pickerFor === 'after'" no-create @pick="pick" />
          <ObjectPicker v-else-if="pickerFor" no-create :type-ids="pickerFor === 'tag' ? (tagType ? [tagType.id] : []) : queryType ? [queryType.id] : []" @pick="pick" />
        </PopoverMenu>
        <label v-if="content.kind !== 'target'" class="flex items-start gap-2.5 text-sm">
          <input v-model="skipIfEmpty" type="checkbox" class="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
          <span>
            {{ content.kind === 'tasks' ? t('reminders.what.skipNoTasks') : t('reminders.what.skipNothingMatches') }}
            <span class="block text-xs text-ink-faint">
              {{ content.kind === 'tasks' ? t('reminders.what.skipNoTasksHint') : t('reminders.what.skipNothingMatchesHint') }}
            </span>
          </span>
        </label>
      </fieldset>

      <!-- How it reaches you -->
      <fieldset class="space-y-3">
        <legend class="mb-2 font-medium">{{ t('reminders.section.how') }}</legend>
        <div class="grid gap-1.5 sm:grid-cols-3" data-styles>
          <button
            v-for="p in STYLES"
            :key="p.id"
            type="button"
            class="rounded-xl border px-3 py-2.5 text-left"
            :class="[style === p.id ? 'border-ink' : 'border-line hover:bg-hover', p.desktop && desktopMissing(p.steps[0]!.channels) ? 'border-dashed' : '']"
            :title="p.desktop ? channelGap(p.steps[0]!.channels[0]!) || undefined : undefined"
            @click="useStyle(p.id)"
          >
            <span class="flex items-center gap-1.5 font-medium"><AppIcon :fallback="p.icon" :size="14" /> {{ p.label }}</span>
            <span class="block text-xs text-ink-faint">{{ p.description }}</span>
          </button>
          <button type="button" class="rounded-xl border px-3 py-2.5 text-left" :class="style === 'custom' ? 'border-ink' : 'border-line hover:bg-hover'" @click="customizing = true">
            <span class="flex items-center gap-1.5 font-medium"><AppIcon fallback="ph:sliders-horizontal" :size="14" /> {{ t('reminders.style.custom') }}</span>
            <span class="block text-xs text-ink-faint">{{ t('reminders.style.customDesc') }}</span>
          </button>
        </div>
        <p v-if="desktopMissing(steps.flatMap((s) => s.channels))" class="text-xs text-ink-faint">{{ t('reminders.how.desktopFallback') }}</p>
        <button v-if="!customizing" type="button" class="text-xs text-accent hover:underline" @click="customizing = true">{{ t('reminders.how.customizeSteps') }}</button>

        <template v-if="customizing">
        <div class="flex flex-wrap items-center gap-2 text-ink-soft">
          {{ t('reminders.how.repeat') }}
          <select v-model="repeat" class="rounded-lg border border-line bg-surface px-2 py-1.5" :aria-label="t('reminders.how.repeatLabel')">
            <option :value="null">{{ t('reminders.how.onlyAtEachStep') }}</option>
            <option v-for="m in [2, 5, 10, 15, 20, 30, 45, 60, 90, 120]" :key="m" :value="m">{{ t('reminders.how.everyMinutes', { min: m }) }}</option>
          </select>
          {{ t('reminders.how.untilAnswered') }}
        </div>

        <ol class="space-y-2" data-ladder>
          <li v-for="(step, i) in steps" :key="i" class="rounded-xl border border-line px-3 py-2.5">
            <div class="flex flex-wrap items-center gap-2">
              <span class="grid h-6 w-6 place-items-center rounded-full bg-hover text-xs font-semibold">{{ i + 1 }}</span>
              <template v-if="i === 0">{{ t('reminders.how.atTheStart') }}</template>
              <template v-else>
                {{ t('reminders.how.after') }} <input v-model.number="step.after" type="number" min="1" max="720" class="w-16 rounded-lg border border-line bg-surface px-2 py-1" :aria-label="t('reminders.how.minutesAfterLabel')" /> {{ t('reminders.how.minUnit') }}
              </template>
              <label class="ml-auto flex items-center gap-1.5 text-xs text-ink-soft" :title="t('reminders.how.urgentTitle')">
                <input v-model="step.urgent" type="checkbox" class="h-3.5 w-3.5 accent-[var(--color-accent)]" /> {{ t('reminders.how.urgent') }}
              </label>
              <button v-if="i > 0" type="button" class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink" :title="t('reminders.how.removeStep')" @click="steps.splice(i, 1)"><AppIcon fallback="ph:x" :size="13" /></button>
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
        <button v-if="steps.length < 6" type="button" class="text-xs text-accent hover:underline" @click="addStep">{{ t('reminders.how.addStep') }}</button>
        <p v-if="steps.some((s) => s.channels.some((c) => channelGap(c)))" class="text-xs text-ink-faint">{{ t('reminders.how.dashedHint') }}</p>
        </template>
      </fieldset>

      <!-- How it is answered -->
      <fieldset>
        <legend class="mb-2 font-medium">{{ t('reminders.section.ack') }}</legend>
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
        <p v-if="textAnswer && isHabit" class="mt-2 text-xs text-ink-faint">{{ t('reminders.ack.textMarksHabit') }}</p>
        <p class="mt-2 text-xs text-ink-faint">{{ t('reminders.ack.swipeHint') }}</p>
      </fieldset>

      <!-- Afterwards -->
      <fieldset v-if="usesWindow" class="space-y-2">
        <legend class="mb-2 font-medium">{{ t('reminders.section.after') }}</legend>
        <div class="flex flex-wrap items-center gap-1.5">
          <button type="button" class="rounded-full border px-3 py-1" :class="chip(!openAfter)" @click="openAfter = null">{{ t('reminders.after.stayOut') }}</button>
          <button type="button" class="flex items-center gap-1.5 rounded-full border px-3 py-1" :class="chip(!!openAfter)" @click="openPicker('after', $event)">
            <AppIcon fallback="ph:arrow-square-out" :size="13" />
            {{ openAfter ? t('reminders.after.openNote', { title: summaryOf(openAfter)?.title || t('reminders.after.aNote') }) : t('reminders.after.openNotePlaceholder') }}
          </button>
        </div>
        <p class="text-xs text-ink-faint">{{ openAfter ? t('reminders.after.comesForward') : t('reminders.after.staysHidden') }}</p>
      </fieldset>

      <!-- Snoozing -->
      <fieldset class="flex flex-wrap items-center gap-2 text-ink-soft">
        <legend class="mb-2 font-medium text-ink">{{ steps.length > 1 ? t('reminders.section.snoozeCost') : t('reminders.section.snooze') }}</legend>
        {{ t('reminders.snooze.for') }}
        <select v-model.number="snooze" class="rounded-lg border border-line bg-surface px-2 py-1.5" :aria-label="t('reminders.snooze.minutesLabel')">
          <option v-for="m in [5, 10, 15, 30, 60]" :key="m" :value="m">{{ t('reminders.snooze.min', { min: m }) }}</option>
        </select>
        <template v-if="steps.length > 1">{{ t('reminders.snooze.every') }}
        <select v-model="climbAfter" class="rounded-lg border border-line bg-surface px-2 py-1.5" :aria-label="t('reminders.snooze.perStepLabel')">
          <option :value="null">{{ t('reminders.snooze.neverClimbs') }}</option>
          <option v-for="n in [1, 2, 3, 4, 5]" :key="n" :value="n">{{ n }}</option>
        </select>
        {{ tc(climbAfter ?? 2, 'reminders.snooze.climbs.one', 'reminders.snooze.climbs.other') }}</template>
      </fieldset>

      <fieldset v-if="usesWindow" class="flex flex-wrap items-center gap-2 text-ink-soft">
        <legend class="mb-2 font-medium text-ink">{{ t('reminders.section.escape') }}</legend>
        {{ t('reminders.escape.text') }}
        <select v-model.number="escapeAfter" class="rounded-lg border border-line bg-surface px-2 py-1.5" :aria-label="t('reminders.escape.secondsLabel')">
          <option v-for="n in [5, 10, 20, 30, 60]" :key="n" :value="n">{{ t('reminders.escape.seconds', { seconds: n }) }}</option>
        </select>
      </fieldset>

      <label v-if="existing" class="flex items-start gap-2.5">
        <input v-model="paused" type="checkbox" class="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
        <span>
          {{ t('reminders.paused') }}
          <span v-if="when.kind === 'object'" class="block text-xs text-ink-faint">{{ t('reminders.pausedHint', { type: typeLower }) }}</span>
        </span>
      </label>
    </form>

    <template #footer>
      <button v-if="existing" type="button" class="rounded-lg px-3 py-1.5 text-sm text-red-600 hover:bg-hover dark:text-red-400" :disabled="busy" @click="remove">{{ t('common.delete') }}</button>
      <span v-if="error" class="text-sm text-red-600 dark:text-red-400">{{ error }}</span>
      <button type="button" class="ml-auto rounded-lg px-3 py-1.5 text-sm text-ink-soft hover:bg-hover" @click="closeReminderEditor">{{ t('common.cancel') }}</button>
      <button type="submit" form="reminder-form" class="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-40" :disabled="busy">{{ existing ? t('common.save') : t('reminders.remindMe') }}</button>
    </template>
  </ModalDialog>
</template>
