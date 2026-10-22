<script setup lang="ts">
// The logged-in user's name, time zone and capture space; the password opens PasswordDialog.
import { computed, ref } from 'vue'
import { authApi } from '../../lib/api.ts'
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
  <SettingsSection id="account" title="Account">
    <form class="grid gap-4 sm:grid-cols-2" @submit.prevent="save">
      <label :class="label">
        Name
        <input v-model="name" :class="field" autocomplete="name" />
      </label>
      <label :class="label">
        Username
        <input :value="user.username" :class="field" class="text-ink-soft" disabled />
      </label>
      <label :class="label">
        Time zone
        <input v-model="timeZone" :class="field" list="settings-zones" placeholder="The server's zone" />
        <datalist id="settings-zones"><option v-for="zone in zones" :key="zone" :value="zone" /></datalist>
        <span class="mt-1 block">
          Decides which day captures land on.
          <button v-if="timeZone !== deviceZone" type="button" class="text-accent hover:underline" @click="timeZone = deviceZone">Use {{ deviceZone }}</button>
        </span>
      </label>
      <label :class="label">
        Capture space
        <select v-model="captureSpaceId" :class="field">
          <option value="">First space ({{ workspace.spaces[0]?.name }})</option>
          <option v-for="space in workspace.spaces" :key="space.id" :value="space.id">{{ space.name }}</option>
        </select>
        <span class="mt-1 block">Where Telegram, the browser extension and Shortcuts save. Quick capture uses it too, or the open space when none is chosen.</span>
      </label>
      <div class="flex items-center gap-2 sm:col-span-2">
        <button type="submit" :class="primary" :disabled="!dirty || busy">Save</button>
        <button type="button" :class="secondary" @click="ui.passwordOpen = true">Change password…</button>
        <span v-if="saved" class="text-sm text-ink-soft">Saved</span>
        <span v-if="error" :class="errorText">{{ error }}</span>
      </div>
    </form>
  </SettingsSection>
</template>
