<script setup lang="ts">
// Opens the first pinned item, like a start page; falls back to a short welcome.
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { openToday } from '../lib/actions.ts'
import { typesById, ui, workspace } from '../lib/state.ts'
import AppIcon from '../components/AppIcon.vue'
import { objectPath } from '../lib/open.ts'

const router = useRouter()

onMounted(() => {
  const first = workspace.space?.sidebar[0]?.items[0]
  if (first) void router.replace(typesById.value.has(first) ? `/t/${first}` : objectPath(first))
})
</script>

<template>
  <div class="mx-auto max-w-xl px-8 py-24 text-center">
    <h1 class="text-2xl font-semibold">{{ workspace.space?.name }}</h1>
    <div class="mt-6 flex justify-center gap-2 text-sm">
      <button class="flex items-center gap-2 rounded-lg border border-line px-3 py-2 hover:bg-hover" @click="openToday">
        <AppIcon fallback="ph:calendar-check" /> Today
      </button>
      <button class="flex items-center gap-2 rounded-lg border border-line px-3 py-2 hover:bg-hover" @click="ui.paletteOpen = true">
        <AppIcon fallback="ph:magnifying-glass" /> Search
      </button>
    </div>
  </div>
</template>
