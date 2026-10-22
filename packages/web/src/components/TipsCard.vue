<script setup lang="ts">
// Getting started: a few things worth knowing on the first days, each with a way to try it.
// Hidden for good with "Hide tips" (lib/tips.ts).
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { newTypeFlow, openToday } from '../lib/actions.ts'
import { keysOf } from '../lib/shortcuts.ts'
import { ui } from '../lib/state.ts'
import { askServerAdmin, hideTips, serverAdmin, tipsHidden } from '../lib/tips.ts'
import AppIcon from './AppIcon.vue'

const router = useRouter()
onMounted(askServerAdmin)

const tips = computed(() => [
  { icon: 'ph:magnifying-glass', text: `Press ${keysOf('search')} and type a line to capture it. “/Task Call Ana due:friday” makes a task with a date.`, action: 'Try it', run: () => (ui.paletteOpen = true) },
  { icon: 'ph:shapes', text: 'Make a type for anything you keep: books, people, recipes. Give it properties and views.', action: 'New type', run: newTypeFlow },
  { icon: 'ph:at', text: 'In a note, type @ to link a page and @@ to embed it. Each page lists what links to it.' },
  { icon: 'ph:calendar-check', text: `Each day has a note. Press ${keysOf('today')} to open today.`, action: 'Open today', run: openToday },
  { icon: 'ph:device-mobile', text: 'On a phone, add Vasta to the home screen from the browser. On a computer, get the desktop app.', action: 'How', run: () => router.push('/settings#device') },
  ...(serverAdmin.value ? [{ icon: 'ph:users-three', text: 'Invite people with a link. They make their own account.', action: 'Invite', run: () => router.push('/settings#server') }] : []),
])
</script>

<template>
  <section v-if="!tipsHidden" class="rounded-xl border border-line bg-canvas/60 p-4 text-sm text-ink" data-tips>
    <div class="mb-2 flex items-center gap-2">
      <AppIcon fallback="ph:lightbulb" class="text-accent" />
      <h2 class="font-semibold">Getting started</h2>
      <button class="ml-auto rounded-md px-2 py-0.5 text-xs text-ink-faint hover:bg-hover hover:text-ink" @click="hideTips">Hide tips</button>
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
