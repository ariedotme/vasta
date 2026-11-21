<script setup lang="ts">
// Which capture channels are on: the Telegram bot, capture tokens (the API, the browser extension,
// Shortcuts), the desktop app's quick capture. Email is not there yet.
import { onMounted, ref } from 'vue'
import { authApi, type ChannelState } from '../../lib/api.ts'
import { t } from '../../lib/i18n.ts'
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
  <SettingsSection id="channels" :title="t('settings.section.channels')" :description="t('settings.channels.description')">
    <ul v-if="state" class="divide-y divide-line rounded-xl border border-line text-sm">
      <li class="flex items-start gap-3 px-3 py-2.5">
        <AppIcon fallback="ph:telegram-logo" class="mt-0.5 text-ink-soft" />
        <div class="min-w-0 flex-1">
          <div class="font-medium">{{ t('settings.section.telegram') }}</div>
          <div v-if="state.telegram.running" class="text-ink-soft">
            <template v-if="state.telegram.bot">@{{ state.telegram.bot }}</template><template v-else>{{ t('settings.channels.theBot') }}</template>
            · {{ state.telegram.linked ? t('settings.channels.linked') : t('settings.channels.notLinked') }}
            · {{ state.telegram.allowedChats.length ? (state.telegram.allowedChats.length === 1 ? t('settings.channels.listensChats.one') : t('settings.channels.listensChats.other', { count: state.telegram.allowedChats.length })) : t('settings.channels.listensAnyChat') }}
          </div>
          <div v-else class="text-ink-soft">{{ t('settings.channels.telegramOff') }}</div>
        </div>
        <button v-if="state.telegram.running" class="shrink-0 text-xs text-accent hover:underline" @click="jump('telegram')">{{ t('common.settings') }}</button>
        <span class="shrink-0 rounded-full px-2 py-0.5 text-xs" :class="state.telegram.running ? 'bg-accent/10 text-accent' : 'bg-hover text-ink-faint'">{{ state.telegram.running ? t('settings.channels.on') : t('settings.channels.off') }}</span>
      </li>
      <li class="flex items-start gap-3 px-3 py-2.5">
        <AppIcon fallback="ph:key" class="mt-0.5 text-ink-soft" />
        <div class="min-w-0 flex-1">
          <div class="font-medium">{{ t('settings.channels.apiTitle') }}</div>
          <div class="text-ink-soft">{{ state.tokens ? (state.tokens === 1 ? t('settings.channels.tokensCount.one') : t('settings.channels.tokensCount.other', { count: state.tokens })) : t('settings.channels.makeTokenHint') }}</div>
        </div>
        <button class="shrink-0 text-xs text-accent hover:underline" @click="jump('tokens')">{{ t('settings.channels.tokensLink') }}</button>
        <span class="shrink-0 rounded-full px-2 py-0.5 text-xs" :class="state.tokens ? 'bg-accent/10 text-accent' : 'bg-hover text-ink-faint'">{{ state.tokens ? t('settings.channels.on') : t('settings.channels.off') }}</span>
      </li>
      <li class="flex items-start gap-3 px-3 py-2.5">
        <AppIcon fallback="ph:lightning" class="mt-0.5 text-ink-soft" />
        <div class="min-w-0 flex-1">
          <div class="font-medium">{{ t('settings.channels.desktopTitle') }}</div>
          <div class="text-ink-soft">{{ isDesktop ? t('settings.channels.desktopOn', { shortcut: desktop?.shortcut ? formatShortcut(desktop.shortcut) : t('settings.channels.theShortcut') }) : t('settings.channels.desktopOff') }}</div>
        </div>
        <span class="shrink-0 rounded-full px-2 py-0.5 text-xs" :class="isDesktop ? 'bg-accent/10 text-accent' : 'bg-hover text-ink-faint'">{{ isDesktop ? t('settings.channels.on') : t('settings.channels.elsewhere') }}</span>
      </li>
      <li class="flex items-start gap-3 px-3 py-2.5">
        <AppIcon fallback="ph:envelope-simple" class="mt-0.5 text-ink-faint" />
        <div class="min-w-0 flex-1">
          <div class="font-medium text-ink-soft">{{ t('settings.channels.email') }}</div>
          <div class="text-ink-faint">{{ t('settings.channels.notAvailable') }}</div>
        </div>
      </li>
    </ul>
    <p v-if="error" :class="errorText">{{ error }}</p>
  </SettingsSection>
</template>
