<script setup lang="ts">
// Reminder channels (account-wide, across all spaces): where reminders reach you (ntfy, the
// Telegram bot, desktop app notifications, and Web Push on phones and browsers), quiet hours, and
// notifications about others' work. Per-space reminders (tasks, events, habits, food, custom rules)
// live in Settings › Reminders (InsistentSettings.vue).
import { computed, onMounted, ref } from 'vue'
import { isNutritionOn } from '@vasta/core'
import { authApi, type PushDevice, type PushKinds, type ReminderSettings, type WorkNotifications } from '../../lib/api.ts'
import { t } from '../../lib/i18n.ts'
import { desktop as desktopApp } from '../../lib/platform.ts'
import { currentSubscription, deviceName, pushUnsupported, subscribe } from '../../lib/push.ts'
import { workspace } from '../../lib/state.ts'
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
const quietOn = ref(false)
const quiet = ref({ from: '22:00', to: '07:30' })
const work = ref<WorkNotifications>({ assigned: true, mentioned: true, comments: true })
const busy = ref(false)
const error = ref('')
const note = ref('')

/** Some space of the user tracks food (used for per-device Web Push toggles). */
const tracksFood = computed(() => workspace.spaces.some((s) => isNutritionOn(s)))

function show(settings: ReminderSettings) {
  current.value = settings
  server.value = settings.ntfy?.server ?? 'https://ntfy.sh'
  topic.value = settings.ntfy?.topic ?? ''
  token.value = ''
  telegram.value = settings.telegram
  desktop.value = settings.desktop
  quietOn.value = !!settings.quiet
  if (settings.quiet) quiet.value = { ...settings.quiet }
  work.value = { ...settings.work }
}

onMounted(async () => {
  try {
    show(await authApi.reminders())
  } catch (failure) {
    unavailable.value = (failure as Error).message
  }
  await findThisDevice()
})

// Notifications on devices (Web Push) -----------------------------------------
const pushWhy = computed(() => pushUnsupported())
/** This browser's subscription endpoint, to tell which listed device is this one. */
const thisEndpoint = ref<string | null>(null)
const pushBusy = ref(false)
const pushError = ref('')
const devices = computed(() => current.value?.push?.devices ?? [])
const thisDevice = computed(() => devices.value.find((d) => d.endpoint === thisEndpoint.value))
const KINDS = computed(() => [
  { key: 'habits' as const, label: t('settings.reminderChannels.kindHabits') },
  { key: 'events' as const, label: t('settings.reminderChannels.kindEvents') },
  ...(tracksFood.value ? [{ key: 'food' as const, label: t('settings.reminderChannels.kindFood') }] : []),
  { key: 'work' as const, label: t('settings.reminderChannels.kindWork') },
  { key: 'insistent' as const, label: t('settings.reminderChannels.kindInsistent') },
])

async function findThisDevice() {
  try {
    const subscription = await currentSubscription()
    thisEndpoint.value = subscription?.endpoint ?? null
    // Still subscribed here but no longer listed (removed elsewhere, or a new server key): tell the server again.
    if (subscription && current.value?.push && !thisDevice.value) {
      show(await authApi.addPushDevice(subscription.toJSON(), deviceName()))
    }
  } catch {
    thisEndpoint.value = null
  }
}

async function pushStep(step: () => Promise<void>) {
  pushBusy.value = true
  pushError.value = ''
  try {
    await step()
  } catch (failure) {
    pushError.value = (failure as Error).message
  } finally {
    pushBusy.value = false
  }
}

const turnOnHere = () =>
  pushStep(async () => {
    const subscription = await subscribe(current.value!.push!.publicKey)
    thisEndpoint.value = subscription.endpoint
    show(await authApi.addPushDevice(subscription.toJSON(), deviceName()))
  })

const setKind = (device: PushDevice, kind: keyof PushKinds, on: boolean) => pushStep(async () => show(await authApi.updatePushDevice(device.id, { kinds: { [kind]: on } })))

const removeDevice = (device: PushDevice) =>
  pushStep(async () => {
    if (device.endpoint === thisEndpoint.value) {
      await (await currentSubscription())?.unsubscribe()
      thisEndpoint.value = null
    }
    show(await authApi.removePushDevice(device.id))
  })

const dirty = computed(() => {
  const s = current.value
  if (!s) return false
  const nextQuiet = quietOn.value ? quiet.value : null
  return (
    server.value.trim() !== (s.ntfy?.server ?? 'https://ntfy.sh') ||
    topic.value.trim() !== (s.ntfy?.topic ?? '') ||
    !!token.value.trim() ||
    telegram.value !== s.telegram ||
    desktop.value !== s.desktop ||
    JSON.stringify(nextQuiet) !== JSON.stringify(s.quiet) ||
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
        quiet: quietOn.value ? quiet.value : null,
        work: work.value,
      })
    )
    note.value = t('settings.saved')
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
    const names: Record<string, string> = { ntfy: 'ntfy', telegram: 'Telegram', desktop: t('settings.reminderChannels.testDesktop') }
    const name = (channel: string) => names[channel] ?? channel.replace(/^push:/, '')
    note.value = results.map((r) => `${name(r.channel)}: ${r.ok ? t('settings.reminderChannels.testSent') : r.error}`).join(' · ')
    // A device the push service no longer knows was removed: show the list as it is now.
    if (results.some((r) => r.channel.startsWith('push:') && !r.ok)) show(await authApi.reminders())
  } catch (failure) {
    error.value = (failure as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <SettingsSection
    id="reminder-channels"
    :title="t('settings.section.reminderChannels')"
    :description="t('settings.reminderChannels.description')"
  >
    <p v-if="unavailable" class="text-sm text-ink-soft">{{ unavailable }}</p>
    <form v-else-if="current" class="space-y-5" @submit.prevent="save">
      <div>
        <h3 class="mb-2 flex items-center gap-1.5 text-sm font-medium"><AppIcon fallback="ph:bell-ringing" class="text-ink-faint" /> ntfy</h3>
        <div class="grid gap-3 sm:grid-cols-2">
          <label :class="label">
            {{ t('settings.reminderChannels.ntfyServer') }}
            <input v-model="server" :class="field" placeholder="https://ntfy.sh" inputmode="url" autocomplete="off" />
            <span class="mt-1 block">{{ t('settings.reminderChannels.ntfyServerHint') }}</span>
          </label>
          <label :class="label">
            {{ t('settings.reminderChannels.ntfyTopic') }}
            <input v-model="topic" :class="field" placeholder="my-vasta-7f3k" autocomplete="off" />
          </label>
          <label :class="label" class="sm:col-span-2">
            {{ t('settings.reminderChannels.ntfyAccessToken') }} <span class="text-ink-faint">{{ t('settings.reminderChannels.ntfyProtectedHint') }}</span>
            <input v-model="token" :class="field" type="password" autocomplete="off" :placeholder="current.ntfy?.hasToken ? t('settings.reminderChannels.ntfyTokenSavedPlaceholder') : 'tk_…'" />
            <span class="mt-1 block">
              {{ t('settings.reminderChannels.ntfySubscribeHint') }}
              <button v-if="current.ntfy?.hasToken" type="button" class="text-accent hover:underline" @click="clearToken">{{ t('settings.reminderChannels.ntfyRemoveToken') }}</button>
            </span>
          </label>
        </div>
      </div>

      <label class="flex items-start gap-2.5 text-sm" :class="current.telegramReady ? '' : 'opacity-60'">
        <input v-model="telegram" type="checkbox" class="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" :disabled="!current.telegramReady" />
        <span>
          {{ t('settings.reminderChannels.alsoTelegram') }}
          <span class="block text-xs text-ink-faint">{{ current.telegramReady ? t('settings.reminderChannels.telegramReady') : t('settings.reminderChannels.telegramNotReady') }}</span>
        </span>
      </label>

      <label class="flex items-start gap-2.5 text-sm">
        <input v-model="desktop" type="checkbox" class="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
        <span>
          {{ t('settings.reminderChannels.alsoDesktop') }}
          <span class="block text-xs text-ink-faint">
            {{ t('settings.reminderChannels.desktopHint') }}
            <template v-if="current.desktopApps">{{ current.desktopApps === 1 ? t('settings.reminderChannels.desktopOpenNow.one') : t('settings.reminderChannels.desktopOpenNow.other', { count: current.desktopApps }) }}</template>
            <template v-else-if="desktopApp && !desktopApp.notify">{{ t('settings.reminderChannels.desktopOlder') }}</template>
            <template v-else>{{ t('settings.reminderChannels.desktopNoneOpen') }}</template>
          </span>
        </span>
      </label>

      <div v-if="current.push" class="space-y-2" data-push-devices>
        <h3 class="flex items-center gap-1.5 text-sm font-medium"><AppIcon fallback="ph:device-mobile" class="text-ink-faint" /> {{ t('settings.reminderChannels.pushHeading') }}</h3>
        <p class="text-xs text-ink-faint">{{ t('settings.reminderChannels.pushHint') }}</p>
        <ul v-if="devices.length" class="divide-y divide-line rounded-lg border border-line">
          <li v-for="device in devices" :key="device.id" class="px-3 py-2.5 text-sm">
            <div class="flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate font-medium">
                {{ device.name }}
                <span v-if="device.endpoint === thisEndpoint" class="ml-1 text-xs font-normal text-ink-faint">{{ t('settings.reminderChannels.thisDevice') }}</span>
              </span>
              <button type="button" class="text-xs text-ink-faint hover:text-ink" :disabled="pushBusy" @click="removeDevice(device)">{{ t('common.remove') }}</button>
            </div>
            <div class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
              <label v-for="kind in KINDS" :key="kind.key" class="flex items-center gap-1.5 text-ink-soft">
                <input
                  type="checkbox"
                  class="h-3.5 w-3.5 accent-[var(--color-accent)]"
                  :checked="device.kinds[kind.key]"
                  :disabled="pushBusy"
                  @change="setKind(device, kind.key, ($event.target as HTMLInputElement).checked)"
                />
                {{ kind.label }}
              </label>
            </div>
          </li>
        </ul>
        <p v-if="pushWhy" class="text-xs text-ink-faint">{{ pushWhy }}</p>
        <button v-else-if="!thisDevice" type="button" :class="secondary" :disabled="pushBusy" @click="turnOnHere">{{ t('settings.reminderChannels.turnOnHere') }}</button>
        <p v-if="pushError" :class="errorText">{{ pushError }}</p>
      </div>

      <div class="space-y-2 border-t border-line pt-4" data-quiet-hours>
        <label class="flex items-center gap-2.5 text-sm">
          <input v-model="quietOn" type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" />
          {{ t('settings.reminderChannels.quietHours') }}
        </label>
        <div v-if="quietOn" class="flex flex-wrap items-center gap-2 pl-6 text-sm text-ink-soft">
          {{ t('settings.reminderChannels.quietFrom') }}
          <input v-model="quiet.from" type="time" :class="field" class="!mt-0 !w-32" :aria-label="t('settings.reminderChannels.quietFromAria')" />
          {{ t('settings.reminderChannels.quietTo') }}
          <input v-model="quiet.to" type="time" :class="field" class="!mt-0 !w-32" :aria-label="t('settings.reminderChannels.quietToAria')" />
          <span class="w-full text-xs text-ink-faint">{{ t('settings.reminderChannels.quietHint') }}</span>
        </div>
      </div>

      <div class="space-y-2 border-t border-line pt-4" data-work-notifications>
        <h3 class="flex items-center gap-1.5 text-sm font-medium"><AppIcon fallback="ph:users" class="text-ink-faint" /> {{ t('settings.reminderChannels.workHeading') }}</h3>
        <p class="text-xs text-ink-faint">{{ t('settings.reminderChannels.workHint') }}</p>
        <label class="flex items-center gap-2.5 text-sm"><input v-model="work.assigned" type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" /> {{ t('settings.reminderChannels.workAssigned') }}</label>
        <label class="flex items-center gap-2.5 text-sm"><input v-model="work.mentioned" type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" /> {{ t('settings.reminderChannels.workMentioned') }}</label>
        <label class="flex items-center gap-2.5 text-sm">
          <input v-model="work.comments" type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" /> {{ t('settings.reminderChannels.workComments') }}
        </label>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button type="submit" :class="primary" :disabled="!dirty || busy">{{ t('common.save') }}</button>
        <button type="button" :class="secondary" :disabled="busy || (!topic.trim() && !telegram && !desktop && !devices.length)" @click="test">{{ t('settings.reminderChannels.sendTest') }}</button>
        <span v-if="note" class="text-sm text-ink-soft">{{ note }}</span>
        <span v-if="error" :class="errorText">{{ error }}</span>
      </div>
    </form>
  </SettingsSection>
</template>
