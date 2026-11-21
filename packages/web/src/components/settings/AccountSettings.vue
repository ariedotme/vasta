<script setup lang="ts">
// The logged-in user's name, time zone and capture space; the password opens PasswordDialog.
import { computed, ref } from 'vue'
import { authApi } from '../../lib/api.ts'
import { t } from '../../lib/i18n.ts'
import { isLocalServer } from '../../lib/platform.ts'
import { session } from '../../lib/session.ts'
import { ui, workspace } from '../../lib/state.ts'
import SettingsSection from './SettingsSection.vue'
import { errorText, field, label, primary, secondary } from './styles.ts'

const user = computed(() => session.user!)
const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone
const zones = Intl.supportedValuesOf('timeZone')

const name = ref(user.value.name)
const timeZone = ref(user.value.timeZone ?? '')
const captureSpaceId = ref(user.value.captureSpaceId ?? '')
const busy = ref(false)
const error = ref('')
const saved = ref(false)

const dirty = computed(
  () => name.value.trim() !== user.value.name || timeZone.value.trim() !== (user.value.timeZone ?? '') || captureSpaceId.value !== (user.value.captureSpaceId ?? '')
)

async function save() {
  busy.value = true
  error.value = ''
  try {
    session.user = await authApi.updateProfile({
      name: name.value,
      timeZone: timeZone.value.trim() || null,
      captureSpaceId: captureSpaceId.value || null,
    })
    name.value = session.user.name
    saved.value = true
    setTimeout(() => (saved.value = false), 2000)
  } catch (failure) {
    error.value = (failure as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <SettingsSection id="account" :title="t('settings.section.account')">
    <form class="grid gap-4 sm:grid-cols-2" @submit.prevent="save">
      <label :class="label">
        {{ t('typeSettings.name') }}
        <input v-model="name" :class="field" autocomplete="name" />
      </label>
      <label :class="label">
        {{ t('auth.username') }}
        <input :value="user.username" :class="field" class="text-ink-soft" disabled />
      </label>
      <label :class="label">
        {{ t('settings.account.timeZone') }}
        <input v-model="timeZone" :class="field" list="settings-zones" :placeholder="t('settings.account.serverZonePlaceholder')" />
        <datalist id="settings-zones"><option v-for="zone in zones" :key="zone" :value="zone" /></datalist>
        <span class="mt-1 block">
          {{ t('settings.account.timeZoneHint') }}
          <button v-if="timeZone !== deviceZone" type="button" class="text-accent hover:underline" @click="timeZone = deviceZone">{{ t('settings.account.useZone', { zone: deviceZone }) }}</button>
        </span>
      </label>
      <label :class="label">
        {{ t('settings.account.captureSpace') }}
        <select v-model="captureSpaceId" :class="field">
          <option value="">{{ t('settings.account.firstSpace', { name: workspace.spaces[0]?.name ?? '' }) }}</option>
          <option v-for="space in workspace.spaces" :key="space.id" :value="space.id">{{ space.name }}</option>
        </select>
        <span class="mt-1 block">{{ t('settings.account.captureSpaceHint') }}</span>
      </label>
      <div class="flex items-center gap-2 sm:col-span-2">
        <button type="submit" :class="primary" :disabled="!dirty || busy">{{ t('common.save') }}</button>
        <button v-if="!isLocalServer()" type="button" :class="secondary" @click="ui.passwordOpen = true">{{ t('settings.account.changePassword') }}</button>
        <span v-if="saved" class="text-sm text-ink-soft">{{ t('settings.saved') }}</span>
        <span v-if="error" :class="errorText">{{ error }}</span>
      </div>
    </form>
  </SettingsSection>
</template>
