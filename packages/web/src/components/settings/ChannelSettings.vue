<script setup lang="ts">
// Which capture channels are on: the Telegram bot, capture tokens (the API, the browser extension,
// Shortcuts), the desktop app's quick capture. Email is not there yet.
import { onMounted, ref } from 'vue'
import { authApi, type ChannelState } from '../../lib/api.ts'
import { desktop, formatShortcut, isDesktop } from '../../lib/platform.ts'
import AppIcon from '../AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import { errorText } from './styles.ts'

const state = ref<ChannelState | null>(null)
const error = ref('')

onMounted(async () => {
  try {
    state.value = await authApi.channels()
  } catch (failure) {
    error.value = (failure as Error).message
  }
})

const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
</script>

<template>
  <SettingsSection id="channels" title="Capture channels" description="Ways to send things to today's daily note from outside the app.">
    <ul v-if="state" class="divide-y divide-line rounded-xl border border-line text-sm">
      <li class="flex items-start gap-3 px-3 py-2.5">
        <AppIcon fallback="ph:telegram-logo" class="mt-0.5 text-ink-soft" />
        <div class="min-w-0 flex-1">
          <div class="font-medium">Telegram</div>
          <div v-if="state.telegram.running" class="text-ink-soft">
            <template v-if="state.telegram.bot">@{{ state.telegram.bot }}</template><template v-else>The bot</template>
            · {{ state.telegram.linked ? 'linked to your account' : 'not linked to your account' }}
            · {{ state.telegram.allowedChats.length ? `listens in ${state.telegram.allowedChats.length} ${state.telegram.allowedChats.length === 1 ? 'chat' : 'chats'}` : 'listens in any chat' }}
          </div>
          <div v-else class="text-ink-soft">Off: the server runs no bot (TELEGRAM_BOT_TOKEN in its .env).</div>
        </div>
        <button v-if="state.telegram.running" class="shrink-0 text-xs text-accent hover:underline" @click="jump('telegram')">Settings</button>
        <span class="shrink-0 rounded-full px-2 py-0.5 text-xs" :class="state.telegram.running ? 'bg-accent/10 text-accent' : 'bg-hover text-ink-faint'">{{ state.telegram.running ? 'On' : 'Off' }}</span>
      </li>
      <li class="flex items-start gap-3 px-3 py-2.5">
        <AppIcon fallback="ph:key" class="mt-0.5 text-ink-soft" />
        <div class="min-w-0 flex-1">
          <div class="font-medium">Capture API, browser extension, Shortcuts</div>
          <div class="text-ink-soft">{{ state.tokens ? `${state.tokens} capture ${state.tokens === 1 ? 'token' : 'tokens'}` : 'Make a capture token to use them.' }}</div>
        </div>
        <button class="shrink-0 text-xs text-accent hover:underline" @click="jump('tokens')">Tokens</button>
        <span class="shrink-0 rounded-full px-2 py-0.5 text-xs" :class="state.tokens ? 'bg-accent/10 text-accent' : 'bg-hover text-ink-faint'">{{ state.tokens ? 'On' : 'Off' }}</span>
      </li>
      <li class="flex items-start gap-3 px-3 py-2.5">
        <AppIcon fallback="ph:lightning" class="mt-0.5 text-ink-soft" />
        <div class="min-w-0 flex-1">
          <div class="font-medium">Desktop quick capture</div>
          <div class="text-ink-soft">{{ isDesktop ? `${desktop?.shortcut ? formatShortcut(desktop.shortcut) : 'The shortcut'} from any app, in this desktop app.` : 'In the desktop app; This device has the download.' }}</div>
        </div>
        <span class="shrink-0 rounded-full px-2 py-0.5 text-xs" :class="isDesktop ? 'bg-accent/10 text-accent' : 'bg-hover text-ink-faint'">{{ isDesktop ? 'On' : 'Elsewhere' }}</span>
      </li>
      <li class="flex items-start gap-3 px-3 py-2.5">
        <AppIcon fallback="ph:envelope-simple" class="mt-0.5 text-ink-faint" />
        <div class="min-w-0 flex-1">
          <div class="font-medium text-ink-soft">Email</div>
          <div class="text-ink-faint">Not available yet.</div>
        </div>
      </li>
    </ul>
    <p v-if="error" :class="errorText">{{ error }}</p>
  </SettingsSection>
</template>
