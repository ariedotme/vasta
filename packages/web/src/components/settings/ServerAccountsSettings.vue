<script setup lang="ts">
// The server's accounts and invite links. The server's first account (who set it up) sees who has
// an account and makes links that let someone make their own, once, within a week, optionally
// joining one of its spaces; everyone else learns whom to ask. On the desktop app's own server
// (Start on this computer) there is one account: the section says so and moves the notes to a
// server instead (MigrateDialog).
import { onMounted, ref } from 'vue'
import type { Id, SpaceRole } from '@vasta/core'
import { authApi, type ServerAccounts } from '../../lib/api.ts'
import { formatRelative } from '../../lib/format.ts'
import { t } from '../../lib/i18n.ts'
import { confirmDialog } from '../../lib/overlays.ts'
import { isLocalServer } from '../../lib/platform.ts'
import { workspace } from '../../lib/state.ts'
import AppIcon from '../AppIcon.vue'
import MigrateDialog from './MigrateDialog.vue'
import SettingsSection from './SettingsSection.vue'
import { errorText, primary, secondary } from './styles.ts'

const local = isLocalServer()
const migrating = ref(false)

const accounts = ref<ServerAccounts | null>(null)
const spaceId = ref<Id | ''>('')
const role = ref<SpaceRole>('editor')
const link = ref('')
const copied = ref(false)
const error = ref('')

const linkOf = (code: string) => `${location.origin}/?invite=${encodeURIComponent(code)}`

async function load() {
  try {
    accounts.value = await authApi.accounts()
  } catch (failure) {
    error.value = (failure as Error).message
  }
}
onMounted(() => {
  if (!local) void load()
})

async function invite() {
  error.value = ''
  try {
    const { code } = await authApi.createInvite(spaceId.value || undefined, role.value)
    link.value = linkOf(code)
    copied.value = false
    await load()
  } catch (failure) {
    error.value = (failure as Error).message
  }
}

async function revoke(id: Id) {
  const ok = await confirmDialog({
    title: t('settings.server.revokeInviteTitle'),
    message: t('settings.server.revokeInviteMessage'),
    confirmLabel: t('settings.revoke'),
    danger: true,
  })
  if (!ok) return
  try {
    await authApi.revokeInvite(id)
    link.value = ''
    await load()
  } catch (failure) {
    error.value = (failure as Error).message
  }
}

async function copy() {
  try {
    await navigator.clipboard.writeText(link.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {}
}
</script>

<template>
  <SettingsSection v-if="local" id="server" :title="t('settings.section.server')">
    <div class="rounded-xl border border-line bg-canvas p-4">
      <div class="flex items-start gap-3">
        <span class="grid size-9 shrink-0 place-items-center rounded-lg border border-line bg-surface text-ink-soft"><AppIcon fallback="ph:laptop" :size="18" /></span>
        <div class="min-w-0 text-sm">
          <p class="font-medium">{{ t('settings.server.localTitle') }}</p>
          <p class="mt-0.5 text-ink-soft">{{ t('settings.server.localIntro') }}</p>
        </div>
      </div>
      <ul class="mt-4 space-y-2 border-t border-line pt-4 text-sm text-ink-soft">
        <li class="flex gap-2.5"><AppIcon fallback="ph:devices" :size="16" class="mt-0.5 shrink-0 text-ink-faint" /> {{ t('settings.server.localBullet1') }}</li>
        <li class="flex gap-2.5"><AppIcon fallback="ph:users-three" :size="16" class="mt-0.5 shrink-0 text-ink-faint" /> {{ t('settings.server.localBullet2') }}</li>
        <li class="flex gap-2.5"><AppIcon fallback="ph:copy" :size="16" class="mt-0.5 shrink-0 text-ink-faint" /> {{ t('settings.server.localBullet3') }}</li>
      </ul>
      <div class="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" :class="primary" @click="migrating = true">{{ t('settings.server.moveToServer') }}</button>
        <a href="https://github.com/ariedotme/vasta#self-hosting" target="_blank" rel="noreferrer" class="text-sm text-ink-soft underline underline-offset-2 hover:text-ink">{{ t('settings.server.howToRun') }}</a>
      </div>
    </div>
    <MigrateDialog v-if="migrating" @close="migrating = false" />
  </SettingsSection>
  <SettingsSection v-else id="server" :title="t('settings.section.serverAccounts')" :description="t('settings.server.accountsDesc')">
    <p v-if="accounts && !accounts.admin" class="text-sm text-ink-soft">
      {{ t('settings.server.managedBy', { admin: accounts.adminName || t('settings.server.firstAccountFallback') }) }}
    </p>
    <template v-else-if="accounts?.admin">
      <ul class="mb-4 divide-y divide-line rounded-xl border border-line">
        <li v-for="user in accounts.users" :key="user.id" class="flex items-center gap-3 px-3 py-2 text-sm">
          <AppIcon fallback="ph:user" class="shrink-0 text-ink-faint" />
          <div class="min-w-0 flex-1 truncate">
            {{ user.name }} <span class="text-ink-faint">@{{ user.username }}</span>
          </div>
          <span class="shrink-0 text-xs text-ink-faint">{{ t('settings.server.joined', { when: formatRelative(user.createdAt) }) }}</span>
        </li>
      </ul>

      <div v-if="link" class="mb-4 rounded-xl border border-line bg-canvas p-3 text-sm">
        <div class="mb-1 flex items-center gap-2 font-medium">
          <AppIcon fallback="ph:check-circle" class="text-accent" /> {{ t('settings.server.inviteReady') }}
          <button class="ml-auto rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink" :title="t('settings.server.hide')" @click="link = ''"><AppIcon fallback="ph:x" :size="14" /></button>
        </div>
        <p class="mb-2 text-ink-soft">{{ t('settings.server.inviteOnceHint') }}</p>
        <div class="flex items-center gap-2">
          <code class="min-w-0 flex-1 truncate rounded-md bg-surface px-2 py-1 font-mono text-xs ring-1 ring-line" data-invite-link>{{ link }}</code>
          <button :class="secondary" class="!px-2 !py-1 text-xs" @click="copy">{{ copied ? t('settings.copied') : t('settings.copy') }}</button>
        </div>
      </div>

      <form class="flex flex-wrap items-center gap-2" @submit.prevent="invite">
        <select v-model="spaceId" class="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm outline-none" :title="t('settings.server.spaceSelectTitle')">
          <option value="">{{ t('settings.server.noSharedSpace') }}</option>
          <option v-for="space in workspace.spaces" :key="space.id" :value="space.id">{{ t('settings.server.joinSpace', { name: space.name }) }}</option>
        </select>
        <select v-if="spaceId" v-model="role" class="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm outline-none" :title="t('settings.server.roleSelectTitle')">
          <option value="editor">{{ t('settings.server.asEditor') }}</option>
          <option value="owner">{{ t('settings.server.asOwner') }}</option>
        </select>
        <button type="submit" :class="secondary">{{ t('settings.server.createInvite') }}</button>
      </form>

      <template v-if="accounts.invites.length">
        <h3 class="mt-4 mb-1.5 text-xs font-medium text-ink-faint">{{ t('settings.server.openInvites') }}</h3>
        <ul class="divide-y divide-line rounded-xl border border-line">
          <li v-for="open in accounts.invites" :key="open.id" class="flex items-center gap-3 px-3 py-2 text-sm">
            <AppIcon fallback="ph:link" class="shrink-0 text-ink-faint" />
            <div class="min-w-0 flex-1 truncate">
              {{ open.spaceName ? t('settings.server.joinsAs', { space: open.spaceName, role: t(open.role === 'owner' ? 'settings.space.role.owner' : 'settings.space.role.editor').toLowerCase() }) : t('settings.server.noSharedSpace') }}
              <span class="text-xs text-ink-faint">{{ t('settings.server.madeWhen', { when: formatRelative(open.createdAt) }) }}</span>
            </div>
            <button class="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-ink" :title="t('settings.revoke')" @click="revoke(open.id)"><AppIcon fallback="ph:trash" :size="14" /></button>
          </li>
        </ul>
      </template>
    </template>
    <p v-if="error" :class="errorText" class="mt-2">{{ error }}</p>
  </SettingsSection>
</template>
