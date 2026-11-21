<script setup lang="ts">
// A strip at the top while the server cannot be reached. With the local replica, edits are kept
// on the device and sync later; without it, nobody should take an edit for saved. Quieter, while
// a new device makes its first copy of a big space.
import { onBeforeUnmount, ref, watch } from 'vue'
import { locale, t } from '../lib/i18n.ts'
import { offline, probe } from '../lib/network.ts'
import { pokeReplica, replica, useReplica } from '../lib/replica.ts'
import { isDesktop, updateApp } from '../lib/platform.ts'
import { updateAvailable } from '../lib/version.ts'
import AppIcon from './AppIcon.vue'

let timer: ReturnType<typeof setInterval> | undefined
watch(
  offline,
  (value) => {
    clearInterval(timer)
    if (value)
      timer = setInterval(() => {
        void probe()
        pokeReplica()
      }, 10_000)
  },
  { immediate: true }
)
onBeforeUnmount(() => clearInterval(timer))

// Only once the first copy has taken a moment: a small space is done before anyone could read it.
const filling = ref(false)
let fillTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => replica.active && !replica.ready,
  (value) => {
    clearTimeout(fillTimer)
    filling.value = false
    if (value) fillTimer = setTimeout(() => (filling.value = true), 2000)
  },
  { immediate: true }
)
onBeforeUnmount(() => clearTimeout(fillTimer))
const count = (n: number) => n.toLocaleString(locale.value)

</script>

<template>
  <div v-if="replica.needsUpdate || updateAvailable" class="flex shrink-0 items-center justify-center gap-2 bg-amber-100 px-4 py-1.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200" role="status">
    <AppIcon fallback="ph:arrow-clockwise" :size="14" />
    <span v-if="replica.needsUpdate">{{ isDesktop ? t('banner.updateNeedsDesktop') : t('banner.updateNeedsWeb') }}</span>
    <span v-else>{{ t('banner.updateOut') }}</span>
    <button class="rounded-md bg-amber-200/70 px-2 py-0.5 font-medium hover:bg-amber-200 dark:bg-amber-900" @click="updateApp">{{ isDesktop ? t('banner.update') : t('banner.reload') }}</button>
  </div>
  <div v-else-if="offline" class="flex shrink-0 items-center justify-center gap-2 bg-amber-100 px-4 py-1.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200" role="status">
    <AppIcon fallback="ph:cloud-slash" :size="14" />
    <span v-if="useReplica()">
      {{ replica.pending ? t('banner.offlineReplicaPending', { count: replica.pending }) : t('banner.offlineReplica') }}
    </span>
    <span v-else>{{ t('banner.offlineReadOnly') }}</span>
  </div>
  <div v-else-if="filling" class="flex shrink-0 items-center justify-center gap-2 bg-raised px-4 py-1.5 text-xs text-ink-soft" role="status">
    <AppIcon fallback="ph:cloud-arrow-down" :size="14" />
    <span>
      {{ replica.filling ? t('banner.fillingProgress', { done: count(replica.filling.done), total: count(replica.filling.total) }) : t('banner.filling') }}
    </span>
  </div>
</template>
