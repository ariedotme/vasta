<script setup lang="ts">
// This device: whether it keeps a local copy of the spaces (and works offline), how far it synced,
// and why not when it does not; changes the server refused, until dismissed. In a browser, a link to
// download the desktop app (inside it, DesktopSettings).
import { computed, ref } from 'vue'
import type { RefusedChange } from '@vasta/core/client'
import { formatRelative } from '../../lib/format.ts'
import { locale, t, tc } from '../../lib/i18n.ts'
import { isDesktop } from '../../lib/platform.ts'
import { dismissRefused, replica, syncNow, useReplica } from '../../lib/replica.ts'
import AppIcon from '../AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import { secondary } from './styles.ts'
import ObjectLink from '../ObjectLink.vue'

const kindPrefix = (table: RefusedChange['table']) =>
  table === 'types' ? t('settings.device.kindType') : table === 'spaces' ? t('settings.device.kindSpace') : table === 'calendar_sources' ? t('settings.device.kindCalendar') : ''

const syncing = ref(false)
async function sync() {
  syncing.value = true
  await syncNow()
  syncing.value = false
}
const count = (n: number) => n.toLocaleString(locale.value)

/** Vasta's source code (AGPL-3.0 offers it to everyone who uses Vasta over the network) and its releases. */
const SOURCE = 'https://github.com/ariedotme/vasta'

/** The web app's version: the commit it was built from, and when. */
const revision = __VASTA_REVISION__
const built = computed(() => new Intl.DateTimeFormat(locale.value, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(__VASTA_BUILT__)))
</script>

<template>
  <SettingsSection id="device" :title="t('settings.section.device')">
    <div class="space-y-1.5 text-sm">
      <p v-if="useReplica()">
        {{ t('settings.device.keepsCopy') }}
      </p>
      <template v-else-if="replica.active">
        <p>{{ t('settings.device.makingCopy', { progress: replica.filling ? t('settings.device.copyProgress', { done: count(replica.filling.done), total: count(replica.filling.total) }) : '' }) }}</p>
        <p v-if="replica.offline" class="text-ink-soft">{{ t('settings.device.pausedOffline') }}</p>
      </template>
      <p v-else class="text-amber-700 dark:text-amber-300">{{ t('settings.device.onlineOnly', { reason: replica.reason ?? '' }) }}</p>
      <p v-if="useReplica()" class="text-ink-soft">
        {{ replica.syncing ? t('calendar.sources.syncing') : replica.lastSyncAt ? t('settings.device.lastSynced', { when: formatRelative(replica.lastSyncAt) }) : t('settings.device.notSyncedSession') }}<template v-if="replica.pending">{{ tc(replica.pending, 'settings.device.pending.one', 'settings.device.pending.other') }}</template><template v-if="replica.offline">{{ t('settings.device.offlineBadge') }}</template>
      </p>
      <div v-if="replica.refused.length" class="mt-3 rounded-lg border border-red-200 p-3 dark:border-red-900">
        <div class="flex items-center gap-2">
          <p class="flex-1 font-medium text-red-700 dark:text-red-400">{{ tc(replica.refused.length, 'settings.device.refused.one', 'settings.device.refused.other') }}</p>
          <button v-if="replica.refused.length > 1" class="rounded-md px-2 py-0.5 text-xs text-ink-soft hover:bg-hover hover:text-ink max-md:py-1.5" @click="dismissRefused()">{{ t('settings.device.dismissAll') }}</button>
        </div>
        <p class="mt-0.5 text-xs text-ink-soft">{{ t('settings.device.refusedHint') }}</p>
        <ul class="mt-2 space-y-1.5">
          <li v-for="change in replica.refused" :key="change.id" class="flex items-start gap-2">
            <div class="min-w-0 flex-1">
              <ObjectLink v-if="change.table === 'objects'" :id="change.rowId" class="font-medium hover:underline">{{ change.title || t('common.untitled') }}</ObjectLink>
              <span v-else class="font-medium">{{ kindPrefix(change.table) }}{{ change.title || change.rowId }}</span>
              <span class="text-ink-soft"> · {{ change.reason }} · {{ formatRelative(change.at) }}</span>
            </div>
            <button class="shrink-0 rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink max-md:p-2" :title="t('common.dismiss')" @click="dismissRefused(change.id)"><AppIcon fallback="ph:x" :size="14" /></button>
          </li>
        </ul>
      </div>
      <p v-if="!isDesktop" class="mt-3 text-ink-soft">
        {{ t('settings.device.desktopAppFor') }}
        <a :href="`${SOURCE}/releases/latest`" class="text-accent hover:underline" target="_blank" rel="noopener">{{ t('settings.device.download') }}</a>
      </p>
      <p class="text-xs text-ink-faint" data-testid="web-version">
        {{ t('settings.device.webVersion', { revision, built }) }}<template v-if="isDesktop">{{ t('settings.device.desktopWebHint') }}</template> ·
        <a :href="SOURCE" class="hover:underline" target="_blank" rel="noopener">{{ t('settings.device.sourceCode') }}</a>
      </p>
    </div>
    <button v-if="useReplica()" :class="[secondary, 'mt-3']" :disabled="syncing" @click="sync">{{ syncing ? t('calendar.sources.syncing') : t('calendar.sources.syncNow') }}</button>
  </SettingsSection>
</template>
