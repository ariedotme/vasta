<script setup lang="ts">
// Opens the first pinned item that still opens, like a start page; falls back to a short welcome.
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { openToday, sidebarItemPath } from '../lib/actions.ts'
import { t } from '../lib/i18n.ts'
import { typesById, ui, workspace } from '../lib/state.ts'
import { firstOpenItem } from '../lib/view-pins.ts'
import AppIcon from '../components/AppIcon.vue'

const router = useRouter()

onMounted(() => {
  const first = firstOpenItem(typesById.value, workspace.space?.sidebar[0]?.items ?? [])
  if (first) void router.replace(sidebarItemPath(first))
})
</script>

<template>
  <div class="mx-auto max-w-xl px-8 py-24 text-center">
    <h1 class="text-2xl font-semibold">{{ workspace.space?.name }}</h1>
    <div class="mt-6 flex justify-center gap-2 text-sm">
      <button class="flex items-center gap-2 rounded-lg border border-line px-3 py-2 hover:bg-hover" @click="openToday">
        <AppIcon fallback="ph:calendar-check" /> {{ t('common.today') }}
      </button>
      <button class="flex items-center gap-2 rounded-lg border border-line px-3 py-2 hover:bg-hover" @click="ui.paletteOpen = true">
        <AppIcon fallback="ph:magnifying-glass" /> {{ t('common.search') }}
      </button>
    </div>
  </div>
</template>
