<script setup lang="ts">
// Getting started: a few things worth knowing on the first days, each with a way to try it.
// Hidden for good with "Hide tips" (lib/tips.ts).
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { newTypeFlow, openToday } from '../lib/actions.ts'
import { t } from '../lib/i18n.ts'
import { keysOf } from '../lib/shortcuts.ts'
import { ui } from '../lib/state.ts'
import { askServerAdmin, hideTips, serverAdmin, tipsHidden } from '../lib/tips.ts'
import AppIcon from './AppIcon.vue'

const router = useRouter()
onMounted(askServerAdmin)

const tips = computed(() => [
  { icon: 'ph:magnifying-glass', text: t('tips.search', { keys: keysOf('search') }), action: t('tips.tryIt'), run: () => (ui.paletteOpen = true) },
  { icon: 'ph:shapes', text: t('tips.types'), action: t('nav.newType'), run: newTypeFlow },
  { icon: 'ph:at', text: t('tips.links') },
  { icon: 'ph:calendar-check', text: t('tips.today', { keys: keysOf('today') }), action: t('tips.openToday'), run: openToday },
  { icon: 'ph:device-mobile', text: t('tips.devices'), action: t('tips.how'), run: () => router.push('/settings#device') },
  ...(serverAdmin.value ? [{ icon: 'ph:users-three', text: t('tips.invite'), action: t('tips.inviteAction'), run: () => router.push('/settings#server') }] : []),
])
</script>

<template>
  <section v-if="!tipsHidden" class="rounded-xl border border-line bg-canvas/60 p-4 text-sm text-ink" data-tips>
    <div class="mb-2 flex items-center gap-2">
      <AppIcon fallback="ph:lightbulb" class="text-accent" />
      <h2 class="font-semibold">{{ t('tips.title') }}</h2>
      <button class="ml-auto rounded-md px-2 py-0.5 text-xs text-ink-faint hover:bg-hover hover:text-ink" @click="hideTips">{{ t('tips.hide') }}</button>
    </div>
    <ul class="space-y-1.5">
      <li v-for="tip in tips" :key="tip.icon" class="flex items-start gap-2.5">
        <AppIcon :fallback="tip.icon" class="mt-0.5 shrink-0 text-ink-faint" />
        <span class="min-w-0 flex-1 text-ink-soft">{{ tip.text }}</span>
        <button v-if="tip.action" class="shrink-0 rounded-md px-2 py-0.5 text-xs text-accent hover:bg-hover" @click="tip.run">{{ tip.action }}</button>
      </li>
    </ul>
  </section>
</template>
