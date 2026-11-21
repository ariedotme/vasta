<script setup lang="ts">
// The user's bearer tokens for capture channels (browser extension, Shortcuts), scripts and agents
// (the MCP endpoint and the CLI, docs/agents.md). A new token's secret is shown once, next to the
// server address the channels need.
import { computed, onMounted, ref } from 'vue'
import type { ApiToken, TokenScope } from '@vasta/core'
import { api } from '../../lib/api.ts'
import { formatRelative } from '../../lib/format.ts'
import { t } from '../../lib/i18n.ts'
import { confirmDialog } from '../../lib/overlays.ts'
import AppIcon from '../AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import { errorText, secondary } from './styles.ts'

const tokens = ref<ApiToken[]>([])
const name = ref('')
const scope = ref<TokenScope>('capture')
const created = ref<{ token: ApiToken; secret: string } | null>(null)
const copied = ref('')
const error = ref('')
const server = location.origin
const iPhone = /iPhone|iPad/.test(navigator.userAgent)
/** A token for the whole API just made: the agent commands below include it. */
const agentToken = computed(() => (created.value?.token.scope === 'api' ? created.value.secret : '<token>'))
const agentCommands = computed(() => [
  { key: 'claude', label: 'Claude Code', text: `claude mcp add --transport http vasta ${server}/mcp --header "Authorization: Bearer ${agentToken.value}"` },
  { key: 'codex', label: t('settings.tokens.codexLabel'), text: `[mcp_servers.vasta]\nurl = "${server}/mcp"\nbearer_token_env_var = "VASTA_TOKEN"` },
  { key: 'cli', label: t('settings.tokens.cliLabel'), text: `vasta login ${server} ${agentToken.value}` },
])

async function load() {
  try {
    tokens.value = await api.tokens()
  } catch (failure) {
    error.value = (failure as Error).message
  }
}
onMounted(load)

async function create() {
  if (!name.value.trim()) return
  error.value = ''
  try {
    created.value = await api.createToken(name.value.trim(), scope.value)
    name.value = ''
    scope.value = 'capture'
    await load()
  } catch (failure) {
    error.value = (failure as Error).message
  }
}

async function revoke(token: ApiToken) {
  const ok = await confirmDialog({
    title: t('settings.tokens.revokeTitle', { name: token.name }),
    message: t('settings.tokens.revokeMessage'),
    confirmLabel: t('settings.revoke'),
    danger: true,
  })
  if (!ok) return
  try {
    await api.revokeToken(token.id)
    if (created.value?.token.id === token.id) created.value = null
    await load()
  } catch (failure) {
    error.value = (failure as Error).message
  }
}

async function copy(what: string, text: string) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = what
    setTimeout(() => (copied.value = ''), 1500)
  } catch {}
}
</script>

<template>
  <SettingsSection
    id="tokens"
    :title="t('settings.section.tokens')"
    :description="t('settings.tokens.description')"
  >
    <div v-if="created" class="mb-4 rounded-xl border border-line bg-canvas p-3 text-sm">
      <div class="mb-2 flex items-center gap-2 font-medium">
        <AppIcon fallback="ph:check-circle" class="text-accent" /> {{ t('settings.tokens.createdHeading', { name: created.token.name }) }}
        <button class="ml-auto rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink" :title="t('settings.tokens.hideTitle')" @click="created = null"><AppIcon fallback="ph:x" :size="14" /></button>
      </div>
      <p class="mb-2 text-ink-soft">{{ t('settings.tokens.createdHint') }}</p>
      <div v-for="row in [{ key: 'server', label: t('settings.tokens.serverAddress'), value: server }, { key: 'token', label: t('settings.tokens.tokenLabel'), value: created.secret }]" :key="row.key" class="mt-1.5">
        <div class="text-xs text-ink-faint">{{ row.label }}</div>
        <div class="flex items-center gap-2">
          <code class="min-w-0 flex-1 truncate rounded-md bg-surface px-2 py-1 font-mono text-xs ring-1 ring-line">{{ row.value }}</code>
          <button :class="secondary" class="!px-2 !py-1 text-xs" @click="copy(row.key, row.value)">{{ copied === row.key ? t('settings.copied') : t('settings.copy') }}</button>
        </div>
      </div>
    </div>

    <ul v-if="tokens.length" class="mb-3 divide-y divide-line rounded-xl border border-line">
      <li v-for="token in tokens" :key="token.id" class="flex items-center gap-3 px-3 py-2 text-sm">
        <AppIcon :fallback="token.scope === 'api' ? 'ph:terminal-window' : token.scope === 'notify' ? 'ph:bell' : 'ph:tray-arrow-down'" class="shrink-0 text-ink-faint" />
        <div class="min-w-0 flex-1">
          <div class="truncate">{{ token.name }}<span v-if="token.scope === 'api'" class="text-ink-faint">{{ t('settings.tokens.scopeApiBadge') }}</span><span v-else-if="token.scope === 'notify'" class="text-ink-faint">{{ t('settings.tokens.scopeNotifyBadge') }}</span></div>
          <div class="truncate text-xs text-ink-faint">
            {{ t('settings.tokens.createdRelative', { when: formatRelative(token.createdAt) }) }} · {{ token.lastUsedAt ? t('settings.tokens.lastUsedRelative', { when: formatRelative(token.lastUsedAt) }) : t('settings.tokens.neverUsed') }}
          </div>
        </div>
        <button class="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-ink" :title="t('settings.revoke')" @click="revoke(token)"><AppIcon fallback="ph:trash" :size="14" /></button>
      </li>
    </ul>
    <p v-else class="mb-3 text-sm text-ink-faint">{{ t('settings.tokens.empty') }}</p>

    <form class="flex flex-wrap items-center gap-2" @submit.prevent="create">
      <input v-model="name" class="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-line-strong" :placeholder="t('settings.tokens.namePlaceholder')" maxlength="60" />
      <select v-model="scope" class="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm outline-none" :title="t('settings.tokens.scopeTitle')">
        <option value="capture">{{ t('settings.tokens.scopeCapture') }}</option>
        <option value="api">{{ t('settings.tokens.scopeApi') }}</option>
      </select>
      <button type="submit" :class="secondary" :disabled="!name.trim()">{{ t('settings.tokens.createButton') }}</button>
    </form>
    <p v-if="error" :class="errorText" class="mt-2">{{ error }}</p>

    <!-- iOS Safari cannot be a share target, so the iPhone's share sheet goes through a Shortcut. -->
    <details class="mt-4 rounded-xl border border-line px-3 py-2 text-sm" :open="iPhone">
      <summary class="flex cursor-pointer items-center gap-2 font-medium">
        <AppIcon fallback="ph:device-mobile" class="text-ink-soft" /> {{ t('settings.tokens.iphoneSummary') }}
      </summary>
      <p class="mt-2 text-ink-soft">
        {{ t('settings.tokens.iphoneIntro') }}
      </p>
      <ol class="mt-2 list-decimal space-y-1.5 pl-5 text-ink-soft">
        <li>{{ t('settings.tokens.iphoneStep1Before') }}<b>{{ t('settings.tokens.iphoneStep1Show') }}</b>{{ t('settings.tokens.iphoneStep1Mid') }}<b>{{ t('settings.tokens.iphoneStep1Urls') }}</b>{{ t('settings.tokens.iphoneStep1And') }}<b>{{ t('settings.tokens.iphoneStep1Pages') }}</b>.</li>
        <li>
          {{ t('settings.tokens.iphoneStep2Add') }}<b>{{ t('settings.tokens.iphoneStep2Get') }}</b>{{ t('settings.tokens.iphoneStep2Url') }}
          <code class="break-all rounded bg-hover px-1 text-xs">{{ server }}/api/capture/weblink</code>{{ t('settings.tokens.iphoneStep2Method') }}<b>POST</b>{{ t('settings.tokens.iphoneStep2Header') }}
          <code class="rounded bg-hover px-1 text-xs">Authorization</code> = <code class="rounded bg-hover px-1 text-xs">Bearer</code>{{ t('settings.tokens.iphoneStep2PlusToken') }}
          <b>JSON</b>{{ t('settings.tokens.iphoneStep2With') }}<code class="rounded bg-hover px-1 text-xs">url</code> = <i>{{ t('settings.tokens.iphoneStep2ShortcutInput') }}</i>{{ t('settings.tokens.iphoneStep2And') }}
          <code class="rounded bg-hover px-1 text-xs">channel</code> = <code class="rounded bg-hover px-1 text-xs">shortcuts</code>.
        </li>
        <li>{{ t('settings.tokens.iphoneStep3Before') }}<b>{{ t('settings.tokens.iphoneStep3Ask') }}</b>{{ t('settings.tokens.iphoneStep3Mid') }}<code class="rounded bg-hover px-1 text-xs">note</code>{{ t('settings.tokens.iphoneStep3Text') }}<code class="rounded bg-hover px-1 text-xs">text</code>{{ t('settings.tokens.iphoneStep3To') }}<code class="break-all rounded bg-hover px-1 text-xs">{{ server }}/api/capture/note</code>.</li>
      </ol>
      <div class="mt-3 flex flex-wrap gap-2">
        <button type="button" :class="secondary" class="!px-2 !py-1 text-xs" @click="copy('weblink-url', `${server}/api/capture/weblink`)">
          {{ copied === 'weblink-url' ? t('settings.copied') : t('settings.tokens.copyWeblinkUrl') }}
        </button>
        <button v-if="created" type="button" :class="secondary" class="!px-2 !py-1 text-xs" @click="copy('bearer', `Bearer ${created.secret}`)">
          {{ copied === 'bearer' ? t('settings.copied') : t('settings.tokens.copyBearer') }}
        </button>
      </div>
      <p class="mt-2 text-xs text-ink-faint">{{ t('settings.tokens.iphonePwaBefore') }}<b>{{ t('settings.tokens.iphonePwaAdd') }}</b>{{ t('settings.tokens.iphonePwaAfter') }}</p>
    </details>

    <!-- Agents read and write through the MCP endpoint (POST /mcp) with a whole-API token. -->
    <details class="mt-2 rounded-xl border border-line px-3 py-2 text-sm">
      <summary class="flex cursor-pointer items-center gap-2 font-medium">
        <AppIcon fallback="ph:robot" class="text-ink-soft" /> {{ t('settings.tokens.agentsSummary') }}
      </summary>
      <p class="mt-2 text-ink-soft">
        {{ t('settings.tokens.agentsIntroBefore') }}
        <code class="break-all rounded bg-hover px-1 text-xs">{{ server }}/mcp</code>{{ t('settings.tokens.agentsIntroMid') }}<b>{{ t('settings.tokens.agentsIntroWholeApi') }}</b>{{ t('settings.tokens.agentsIntroAfter') }}
      </p>
      <div v-for="command in agentCommands" :key="command.key" class="mt-2">
        <div class="text-xs text-ink-faint">{{ command.label }}</div>
        <div class="flex items-start gap-2">
          <pre class="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-md bg-surface px-2 py-1 font-mono text-xs ring-1 ring-line">{{ command.text }}</pre>
          <button type="button" :class="secondary" class="!px-2 !py-1 text-xs" @click="copy(command.key, command.text)">{{ copied === command.key ? t('settings.copied') : t('settings.copy') }}</button>
        </div>
      </div>
    </details>
  </SettingsSection>
</template>
