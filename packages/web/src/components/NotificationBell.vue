<script setup lang="ts">
// The bell: someone assigned you, mentioned you, or commented on something you follow. A dot
// counts what is unread; opening one marks it read.
import { onMounted, ref } from 'vue'
import type { Notice } from '../lib/api.ts'
import { formatRelative } from '../lib/format.ts'
import { notices, readNotices, refreshNotices, watchNotices } from '../lib/notices.ts'
import { personName } from '../lib/people.ts'
import AppIcon from './AppIcon.vue'
import PersonAvatar from './PersonAvatar.vue'
import PopoverMenu from './PopoverMenu.vue'
import { openObject } from '../lib/open.ts'

defineProps<{ buttonClass: string; size?: number; placement?: 'top-start' | 'bottom-end' }>()
const anchor = ref<HTMLElement | null>(null)
const open = ref(false)
onMounted(watchNotices)

function toggle() {
  open.value = !open.value
  if (open.value) void refreshNotices()
}

const VERBS: Record<Notice['kind'], string> = { assigned: 'assigned you', mentioned: 'mentioned you in', comment: 'commented on' }

function go(notice: Notice) {
  open.value = false
  if (!notice.read) void readNotices([notice.id])
  void openObject(notice.objectId)
}
</script>

<template>
  <button ref="anchor" :class="buttonClass" class="relative" :title="notices.unread ? `Notifications (${notices.unread} unread)` : 'Notifications'" @click="toggle">
    <AppIcon :fallback="notices.unread ? 'ph:bell-ringing' : 'ph:bell'" :size="size ?? 17" />
    <span v-if="notices.unread" class="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-red-500 px-1 text-[10px] font-semibold leading-4 text-white">{{
      notices.unread > 99 ? '99+' : notices.unread
    }}</span>
  </button>
  <PopoverMenu v-model:open="open" :anchor="anchor" :placement="placement ?? 'top-start'" width="22rem">
    <div class="flex items-center px-2.5 pb-1.5 pt-1">
      <span class="text-sm font-semibold">Notifications</span>
      <button v-if="notices.unread" class="ml-auto text-xs text-ink-faint hover:text-ink" @click="readNotices()">Mark all read</button>
    </div>
    <p v-if="!notices.items.length" class="px-2.5 pb-3 pt-1 text-sm text-ink-faint">
      Nothing yet. You hear here when someone assigns you, mentions you, or comments on what you made or are on.
    </p>
    <div class="max-h-[60vh] overflow-y-auto">
      <button
        v-for="notice in notices.items"
        :key="notice.id"
        class="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-hover"
        :class="notice.read ? 'text-ink-soft' : ''"
        @click="go(notice)"
      >
        <PersonAvatar v-if="notice.actor" :id="notice.actor" :size="22" class="mt-0.5" />
        <span class="min-w-0 flex-1">
          <span class="block">
            <span class="font-medium" :class="notice.read ? '' : 'text-ink'">{{ notice.actor ? personName(notice.actor) : 'Someone' }}</span>
            {{ VERBS[notice.kind] }}
            <span class="font-medium" :class="notice.read ? '' : 'text-ink'">{{ notice.title || 'something deleted' }}</span>
          </span>
          <span v-if="notice.text" class="mt-0.5 line-clamp-2 block text-xs text-ink-soft">{{ notice.text }}</span>
          <span class="mt-0.5 block text-xs text-ink-faint">{{ formatRelative(notice.at) }}</span>
        </span>
        <span v-if="!notice.read" class="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />
      </button>
    </div>
  </PopoverMenu>
</template>
