<script setup lang="ts">
// Where the user is logged in: each browser or installed app, with the last time it was used.
// One can be logged out, or all but this one (a lost phone).
import { computed, onMounted, ref } from 'vue'
import { authApi, type SessionInfo } from '../../lib/api.ts'
import { formatRelative } from '../../lib/format.ts'
import { confirmDialog } from '../../lib/overlays.ts'
import AppIcon from '../AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import { errorText, secondary } from './styles.ts'

const sessions = ref<SessionInfo[]>([])
const error = ref('')
const others = computed(() => sessions.value.filter((s) => !s.current).length)

async function load() {
  try {
    sessions.value = await authApi.sessions()
  } catch (failure) {
    error.value = (failure as Error).message
  }
}
onMounted(load)

/** "Safari on iPhone" from a user agent string; good enough to tell devices apart. */
function describe(agent: string | undefined): { label: string; icon: string } {
  if (!agent) return { label: 'Unknown browser', icon: 'ph:globe' }
  const device = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android' : /Mac OS X/.test(agent) ? 'Mac' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : ''
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\/|FxiOS/.test(agent) ? 'Firefox' : /Chrome\/|CriOS/.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : /Mobile\//.test(agent) ? 'Home Screen app' : ''
  const label = [browser, device].filter(Boolean).join(' on ') || agent.slice(0, 60)
  return { label, icon: device === 'iPhone' || device === 'Android' ? 'ph:device-mobile' : device === 'iPad' ? 'ph:device-tablet' : 'ph:desktop' }
}

async function revoke(item: SessionInfo) {
  const ok = await confirmDialog({ title: 'Log out this session?', message: `${describe(item.userAgent).label} will have to log in again.`, confirmLabel: 'Log out', danger: true })
  if (!ok) return
  try {
    await authApi.revokeSession(item.id)
    await load()
  } catch (failure) {
    error.value = (failure as Error).message
  }
}

async function revokeOthers() {
  const ok = await confirmDialog({
    title: 'Log out everywhere else?',
    message: `${others.value} other ${others.value === 1 ? 'session' : 'sessions'} will have to log in again. This one stays.`,
    confirmLabel: 'Log out others',
    danger: true,
  })
  if (!ok) return
  try {
    await authApi.revokeOtherSessions()
    await load()
  } catch (failure) {
    error.value = (failure as Error).message
  }
}
</script>

<template>
  <SettingsSection id="sessions" title="Sessions" description="Browsers and installed apps logged in to your account.">
    <ul class="mb-3 divide-y divide-line rounded-xl border border-line">
      <li v-for="item in sessions" :key="item.id" class="flex items-center gap-3 px-3 py-2 text-sm">
        <AppIcon :fallback="describe(item.userAgent).icon" class="shrink-0 text-ink-faint" />
        <div class="min-w-0 flex-1">
          <div class="truncate" :title="item.userAgent">
            {{ describe(item.userAgent).label }}<span v-if="item.current" class="text-accent"> · this one</span>
          </div>
          <div class="truncate text-xs text-ink-faint">
            Logged in {{ formatRelative(item.createdAt) }}<template v-if="item.lastSeenAt && !item.current"> · last used {{ formatRelative(item.lastSeenAt) }}</template>
          </div>
        </div>
        <button v-if="!item.current" class="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-ink" title="Log out" @click="revoke(item)">
          <AppIcon fallback="ph:sign-out" :size="14" />
        </button>
      </li>
    </ul>
    <button :class="secondary" :disabled="!others" @click="revokeOthers">Log out everywhere else</button>
    <p v-if="error" :class="errorText" class="mt-2">{{ error }}</p>
  </SettingsSection>
</template>
