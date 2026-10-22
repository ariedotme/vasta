<script setup lang="ts">
// The server's accounts and invite links. The server's first account (who set it up) sees who has
// an account and makes links that let someone make their own, once, within a week, optionally
// joining one of its spaces; everyone else learns whom to ask.
import { onMounted, ref } from 'vue'
import type { Id, SpaceRole } from '@vasta/core'
import { authApi, type ServerAccounts } from '../../lib/api.ts'
import { formatRelative } from '../../lib/format.ts'
import { confirmDialog } from '../../lib/overlays.ts'
import { workspace } from '../../lib/state.ts'
import AppIcon from '../AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import { errorText, secondary } from './styles.ts'

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
onMounted(load)

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
  const ok = await confirmDialog({ title: 'Revoke this invite?', message: 'The link stops working.', confirmLabel: 'Revoke', danger: true })
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
  <SettingsSection id="server" title="Server accounts" description="Who has an account on this server. People join with an invite link and choose their own password.">
    <p v-if="accounts && !accounts.admin" class="text-sm text-ink-soft">
      {{ accounts.adminName || 'The server’s first account' }} manages the accounts on this server. Ask them for an invite link for someone new.
    </p>
    <template v-else-if="accounts?.admin">
      <ul class="mb-4 divide-y divide-line rounded-xl border border-line">
        <li v-for="user in accounts.users" :key="user.id" class="flex items-center gap-3 px-3 py-2 text-sm">
          <AppIcon fallback="ph:user" class="shrink-0 text-ink-faint" />
          <div class="min-w-0 flex-1 truncate">
            {{ user.name }} <span class="text-ink-faint">@{{ user.username }}</span>
          </div>
          <span class="shrink-0 text-xs text-ink-faint">joined {{ formatRelative(user.createdAt) }}</span>
        </li>
      </ul>

      <div v-if="link" class="mb-4 rounded-xl border border-line bg-canvas p-3 text-sm">
        <div class="mb-1 flex items-center gap-2 font-medium">
          <AppIcon fallback="ph:check-circle" class="text-accent" /> Invite link ready
          <button class="ml-auto rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink" title="Hide" @click="link = ''"><AppIcon fallback="ph:x" :size="14" /></button>
        </div>
        <p class="mb-2 text-ink-soft">Send it to the person. It works once, for 7 days. It is not shown again.</p>
        <div class="flex items-center gap-2">
          <code class="min-w-0 flex-1 truncate rounded-md bg-surface px-2 py-1 font-mono text-xs ring-1 ring-line" data-invite-link>{{ link }}</code>
          <button :class="secondary" class="!px-2 !py-1 text-xs" @click="copy">{{ copied ? 'Copied' : 'Copy' }}</button>
        </div>
      </div>

      <form class="flex flex-wrap items-center gap-2" @submit.prevent="invite">
        <select v-model="spaceId" class="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2 py-1.5 text-sm outline-none" title="A space the new account joins">
          <option value="">No shared space</option>
          <option v-for="space in workspace.spaces" :key="space.id" :value="space.id">Join “{{ space.name }}”</option>
        </select>
        <select v-if="spaceId" v-model="role" class="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm outline-none" title="As what">
          <option value="editor">as editor</option>
          <option value="owner">as owner</option>
        </select>
        <button type="submit" :class="secondary">Create invite link</button>
      </form>

      <template v-if="accounts.invites.length">
        <h3 class="mt-4 mb-1.5 text-xs font-medium text-ink-faint">Open invites</h3>
        <ul class="divide-y divide-line rounded-xl border border-line">
          <li v-for="open in accounts.invites" :key="open.id" class="flex items-center gap-3 px-3 py-2 text-sm">
            <AppIcon fallback="ph:link" class="shrink-0 text-ink-faint" />
            <div class="min-w-0 flex-1 truncate">
              {{ open.spaceName ? `Joins “${open.spaceName}” as ${open.role}` : 'No shared space' }}
              <span class="text-xs text-ink-faint"> · made {{ formatRelative(open.createdAt) }}</span>
            </div>
            <button class="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-ink" title="Revoke" @click="revoke(open.id)"><AppIcon fallback="ph:trash" :size="14" /></button>
          </li>
        </ul>
      </template>
    </template>
    <p v-if="error" :class="errorText" class="mt-2">{{ error }}</p>
  </SettingsSection>
</template>
