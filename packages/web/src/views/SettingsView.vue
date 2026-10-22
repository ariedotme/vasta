<script setup lang="ts">
// Settings: account, spaces and members, capture channels and tokens, Telegram, sessions. Everything `vasta` does on the
// server's terminal, except creating accounts. A side list jumps to a section and marks the one in view.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from '../components/AppIcon.vue'
import AccountSettings from '../components/settings/AccountSettings.vue'
import AppearanceSettings from '../components/settings/AppearanceSettings.vue'
import ChannelSettings from '../components/settings/ChannelSettings.vue'
import DesktopSettings from '../components/settings/DesktopSettings.vue'
import DeviceSettings from '../components/settings/DeviceSettings.vue'
import InboxSettings from '../components/settings/InboxSettings.vue'
import NutritionSettings from '../components/settings/NutritionSettings.vue'
import SprintSettings from '../components/settings/SprintSettings.vue'
import ReminderSettings from '../components/settings/ReminderSettings.vue'
import ServerAccountsSettings from '../components/settings/ServerAccountsSettings.vue'
import SessionSettings from '../components/settings/SessionSettings.vue'
import SpaceSettings from '../components/settings/SpaceSettings.vue'
import TelegramSettings from '../components/settings/TelegramSettings.vue'
import TokenSettings from '../components/settings/TokenSettings.vue'
import { SECTIONS } from '../components/settings/sections.ts'
import { isDesktop } from '../lib/platform.ts'

const root = ref<HTMLElement | null>(null)
const current = ref(SECTIONS[0]!.id)

const jump = (id: string) => {
  current.value = id
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
}

// The section in view: the last one whose top has passed the upper third of the page.
let scroller: HTMLElement | null = null
function onScroll() {
  if (!scroller) return
  const line = scroller.getBoundingClientRect().top + scroller.clientHeight / 3
  let id = SECTIONS[0]!.id
  for (const section of SECTIONS) {
    const top = document.getElementById(section.id)?.getBoundingClientRect().top
    if (top !== undefined && top <= line) id = section.id
  }
  // At the bottom the last sections cannot reach the line: mark the last one.
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) id = SECTIONS.at(-1)!.id
  current.value = id
}
onMounted(() => {
  scroller = root.value?.closest('main') ?? null
  scroller?.addEventListener('scroll', onScroll, { passive: true })
  // /settings#server opens at that section (links from tips and elsewhere).
  const id = location.hash.slice(1)
  if (SECTIONS.some((s) => s.id === id)) requestAnimationFrame(() => jump(id))
})
onBeforeUnmount(() => scroller?.removeEventListener('scroll', onScroll))
</script>

<template>
  <div ref="root" class="mx-auto flex max-w-5xl gap-10 px-4 py-8 sm:px-8 md:py-12">
    <nav class="sticky top-12 hidden h-fit w-48 shrink-0 lg:block" aria-label="Settings sections">
      <h1 class="mb-4 px-2.5 text-2xl font-bold tracking-tight">Settings</h1>
      <button
        v-for="section in SECTIONS"
        :key="section.id"
        class="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm"
        :class="current === section.id ? 'bg-hover font-medium text-ink' : 'text-ink-soft hover:bg-hover hover:text-ink'"
        :aria-current="current === section.id ? 'true' : undefined"
        @click="jump(section.id)"
      >
        <AppIcon :fallback="section.icon" :size="16" :class="current === section.id ? 'text-ink' : 'text-ink-faint'" />
        {{ section.label }}
      </button>
    </nav>

    <div class="min-w-0 max-w-2xl flex-1 space-y-6 max-md:space-y-0">
      <div class="lg:hidden">
        <h1 class="text-2xl font-bold tracking-tight">Settings</h1>
        <nav class="-mx-1 mt-3 mb-6 flex flex-wrap gap-1 text-sm">
          <button v-for="section in SECTIONS" :key="section.id" class="flex items-center gap-1.5 rounded-md px-2 py-1 text-ink-soft ring-1 ring-line hover:bg-hover hover:text-ink max-md:py-1.5" @click="jump(section.id)">
            <AppIcon :fallback="section.icon" :size="14" class="text-ink-faint" /> {{ section.label }}
          </button>
        </nav>
      </div>
      <DeviceSettings />
      <DesktopSettings v-if="isDesktop" />
      <AppearanceSettings />
      <AccountSettings />
      <SpaceSettings />
      <ServerAccountsSettings />
      <SprintSettings />
      <InboxSettings />
      <NutritionSettings />
      <ReminderSettings />
      <ChannelSettings />
      <TokenSettings />
      <TelegramSettings />
      <SessionSettings />
    </div>
  </div>
</template>
