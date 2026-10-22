<script setup lang="ts">
// A strip at the top while the server cannot be reached. With the local replica, edits are kept
// on the device and sync later; without it, nobody should take an edit for saved. Quieter, while
// a new device makes its first copy of a big space.
import { onBeforeUnmount, ref, watch } from 'vue'
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
const count = (n: number) => n.toLocaleString()

</script>

<template>
  <div v-if="replica.needsUpdate || updateAvailable" class="flex shrink-0 items-center justify-center gap-2 bg-amber-100 px-4 py-1.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200" role="status">
    <AppIcon fallback="ph:arrow-clockwise" :size="14" />
    <span v-if="replica.needsUpdate">A new version of Vasta is out. Changes stay on this device until you {{ isDesktop ? 'update' : 'reload' }}.</span>
    <span v-else>A new version of Vasta is out.</span>
    <button class="rounded-md bg-amber-200/70 px-2 py-0.5 font-medium hover:bg-amber-200 dark:bg-amber-900" @click="updateApp">{{ isDesktop ? 'Update' : 'Reload' }}</button>
  </div>
  <div v-else-if="offline" class="flex shrink-0 items-center justify-center gap-2 bg-amber-100 px-4 py-1.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200" role="status">
    <AppIcon fallback="ph:cloud-slash" :size="14" />
    <span v-if="useReplica()">
      Offline: changes are kept on this device<template v-if="replica.pending"> ({{ replica.pending }} waiting)</template> and sync when the connection is back.
    </span>
    <span v-else>Offline: you can read what was opened before, but changes are not saved.</span>
  </div>
  <div v-else-if="filling" class="flex shrink-0 items-center justify-center gap-2 bg-raised px-4 py-1.5 text-xs text-ink-soft" role="status">
    <AppIcon fallback="ph:cloud-arrow-down" :size="14" />
    <span>
      Making a copy for offline use<template v-if="replica.filling">: {{ count(replica.filling.done) }} of {{ count(replica.filling.total) }}</template>. Everything works meanwhile.
    </span>
  </div>
</template>
