<script setup lang="ts">
// Logging in. On a server without accounts, creating the first one with the setup code from the
// server's log instead; with an invite link (?invite=…), making an account with it.
import { computed, onMounted, ref } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import { authApi } from '../lib/api.ts'
import { join, logIn, session, setUp } from '../lib/session.ts'

const code = ref('')
const name = ref('')
const username = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)

const inviteCode = new URLSearchParams(location.search).get('invite') ?? ''
const invite = ref<{ invitedBy: string; spaceName?: string } | null>(null)
onMounted(async () => {
  if (!inviteCode || session.noUsers) return
  try {
    invite.value = await authApi.invite(inviteCode)
  } catch (failure) {
    error.value = (failure as Error).message
  }
})

const mode = computed(() => (session.noUsers ? 'setup' : invite.value ? 'join' : 'login'))
const ready = () => !!username.value.trim() && !!password.value && (mode.value !== 'setup' || !!code.value.trim())

async function submit() {
  if (!ready() || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const account = { name: name.value.trim(), username: username.value.trim(), password: password.value }
    if (mode.value === 'setup') await setUp({ code: code.value, ...account })
    else if (mode.value === 'join') {
      await join({ code: inviteCode, ...account })
      history.replaceState(null, '', location.pathname)
    } else await logIn(account.username, account.password)
  } catch (failure) {
    error.value = (failure as Error).message
    if (mode.value === 'login') password.value = ''
  } finally {
    busy.value = false
  }
}

const field = 'mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-line-strong'
</script>

<template>
  <div class="grid h-full place-items-center bg-canvas px-4">
    <form class="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-sm" @submit.prevent="submit">
      <div class="mb-5 flex items-center gap-2">
        <AppIcon fallback="ph:planet" class="text-ink-soft" :size="20" />
        <h1 class="text-lg font-semibold">{{ mode === 'login' ? 'Vasta' : 'Welcome to Vasta' }}</h1>
      </div>
      <template v-if="mode === 'setup'">
        <p class="mb-4 text-sm text-ink-soft">
          Create the first account. It owns this server's spaces and can invite others later. The setup code is in the server's log
          (<code class="text-ink">docker logs vasta</code>).
        </p>
        <label class="block text-sm font-medium" for="setup-code">Setup code</label>
        <input id="setup-code" v-model="code" autocomplete="off" autocapitalize="characters" spellcheck="false" autofocus placeholder="XXXX-XXXX-XXXX" :class="[field, 'font-mono uppercase']" />
      </template>
      <p v-else-if="mode === 'join' && invite" class="mb-4 text-sm text-ink-soft">
        {{ invite.invitedBy || 'Someone' }} invited you to this Vasta server<template v-if="invite.spaceName">, to the space “{{ invite.spaceName }}”</template>. Make your
        account.
      </p>
      <template v-if="mode !== 'login'">
        <label :class="['block text-sm font-medium', mode === 'setup' && 'mt-3']" for="setup-name">Your name</label>
        <input id="setup-name" v-model="name" autocomplete="name" :autofocus="mode === 'join'" :class="field" />
      </template>
      <label :class="['block text-sm font-medium', mode !== 'login' && 'mt-3']" for="login-username">Username</label>
      <input id="login-username" v-model="username" autocomplete="username" autocapitalize="none" :autofocus="mode === 'login'" :class="field" />
      <label class="mt-3 block text-sm font-medium" for="login-password">Password</label>
      <input id="login-password" v-model="password" type="password" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" :class="field" />
      <p v-if="mode !== 'login'" class="mt-1 text-xs text-ink-faint">At least 8 characters.</p>
      <p v-if="error" class="mt-3 text-sm text-red-600 dark:text-red-400">{{ error }}</p>
      <button
        type="submit"
        class="mt-5 w-full rounded-lg bg-ink px-3 py-2 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-40"
        :disabled="busy || !ready()"
      >
        {{ mode === 'login' ? (busy ? 'Logging in…' : 'Log in') : busy ? 'Creating…' : 'Create account' }}
      </button>
    </form>
  </div>
</template>
