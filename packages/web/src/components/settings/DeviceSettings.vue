<script setup lang="ts">
// This device: whether it keeps a local copy of the spaces (and works offline), how far it synced,
// and why not when it does not; changes the server refused, until dismissed. In a browser, a link to
// download the desktop app (inside it, DesktopSettings).
import { ref } from 'vue'
import type { RefusedChange } from '@vasta/core/client'
import { formatRelative } from '../../lib/format.ts'
import { isDesktop } from '../../lib/platform.ts'
import { dismissRefused, replica, syncNow, useReplica } from '../../lib/replica.ts'
import AppIcon from '../AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import { secondary } from './styles.ts'
import ObjectLink from '../ObjectLink.vue'

const KIND: Record<RefusedChange['table'], string> = { objects: '', types: 'Type ', spaces: 'Space ', calendar_sources: 'Calendar ' }

const syncing = ref(false)
async function sync() {
  syncing.value = true
  await syncNow()
  syncing.value = false
}
const count = (n: number) => n.toLocaleString()

/** Vasta's source code (AGPL-3.0 offers it to everyone who uses Vasta over the network) and its releases. */
const SOURCE = 'https://github.com/ariedotme/vasta'

/** The web app's version: the commit it was built from, and when. */
const revision = __VASTA_REVISION__
const built = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(__VASTA_BUILT__))
</script>

<template>
  <SettingsSection id="device" title="This device">
    <div class="space-y-1.5 text-sm">
      <p v-if="useReplica()">
        Keeps a copy of your spaces: works offline, changes sync when the connection is back.
      </p>
      <template v-else-if="replica.active">
        <p>Making a copy of your spaces for offline use<template v-if="replica.filling">: {{ count(replica.filling.done) }} of {{ count(replica.filling.total) }} items</template>. Until it is done, this device works online.</p>
        <p v-if="replica.offline" class="text-ink-soft">Paused: the server cannot be reached. It goes on when the connection is back.</p>
      </template>
      <p v-else class="text-amber-700 dark:text-amber-300">Works only online, without a copy of your spaces. {{ replica.reason }}</p>
      <p v-if="useReplica()" class="text-ink-soft">
        {{ replica.syncing ? 'Syncing…' : replica.lastSyncAt ? `Last synced ${formatRelative(replica.lastSyncAt)}` : 'Not synced yet in this session' }}<template v-if="replica.pending">
          · {{ replica.pending }} {{ replica.pending === 1 ? 'change' : 'changes' }} waiting</template
        ><template v-if="replica.offline"> · offline</template>
      </p>
      <div v-if="replica.refused.length" class="mt-3 rounded-lg border border-red-200 p-3 dark:border-red-900">
        <div class="flex items-center gap-2">
          <p class="flex-1 font-medium text-red-700 dark:text-red-400">The server did not take {{ replica.refused.length === 1 ? 'this change' : 'these changes' }}</p>
          <button v-if="replica.refused.length > 1" class="rounded-md px-2 py-0.5 text-xs text-ink-soft hover:bg-hover hover:text-ink max-md:py-1.5" @click="dismissRefused()">Dismiss all</button>
        </div>
        <p class="mt-0.5 text-xs text-ink-soft">It stays as you left it on this device only; other devices keep the server’s version.</p>
        <ul class="mt-2 space-y-1.5">
          <li v-for="change in replica.refused" :key="change.id" class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <ObjectLink v-if="change.table === 'objects'" :id="change.rowId" class="font-medium hover:underline">{{ change.title || 'Untitled' }}</ObjectLink>
              <span v-else class="font-medium">{{ KIND[change.table] }}{{ change.title || change.rowId }}</span>
              <span class="text-ink-soft"> · {{ change.reason }} · {{ formatRelative(change.at) }}</span>
            </div>
            <button class="shrink-0 rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink max-md:p-2" title="Dismiss" @click="dismissRefused(change.id)"><AppIcon fallback="ph:x" :size="14" /></button>
          </li>
        </ul>
      </div>
      <p v-if="!isDesktop" class="mt-3 text-ink-soft">
        Desktop app for macOS, Windows and Linux:
        <a :href="`${SOURCE}/releases/latest`" class="text-accent hover:underline" target="_blank" rel="noopener">download</a>
      </p>
      <p class="text-xs text-ink-faint" data-testid="web-version">
        Vasta {{ revision }}, from {{ built }}<template v-if="isDesktop">. This part comes from the server and updates with it (the banner’s Update); the desktop app around it has its own version below.</template> ·
        <a :href="SOURCE" class="hover:underline" target="_blank" rel="noopener">Source code</a>
      </p>
    </div>
    <button v-if="useReplica()" :class="[secondary, 'mt-3']" :disabled="syncing" @click="sync">{{ syncing ? 'Syncing…' : 'Sync now' }}</button>
  </SettingsSection>
</template>
