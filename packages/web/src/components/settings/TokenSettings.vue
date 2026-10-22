<script setup lang="ts">
// The user's bearer tokens for capture channels (browser extension, Shortcuts), scripts and agents
// (the MCP endpoint and the CLI, docs/agents.md). A new token's secret is shown once, next to the
// server address the channels need.
import { computed, onMounted, ref } from 'vue'
import type { ApiToken, TokenScope } from '@vasta/core'
import { api } from '../../lib/api.ts'
import { formatRelative } from '../../lib/format.ts'
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
  { key: 'codex', label: 'Codex (~/.codex/config.toml, with VASTA_TOKEN in the environment)', text: `[mcp_servers.vasta]\nurl = "${server}/mcp"\nbearer_token_env_var = "VASTA_TOKEN"` },
  { key: 'cli', label: 'The vasta command (packages/cli in the repository)', text: `vasta login ${server} ${agentToken.value}` },
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
    title: `Revoke “${token.name}”?`,
    message: 'Whatever uses this token stops working until it gets a new one.',
    confirmLabel: 'Revoke',
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
    title="Capture tokens"
    description="Each channel gets its own token, so you can revoke one without touching the others. Captures go to your capture space."
  >
    <div v-if="created" class="mb-4 rounded-xl border border-line bg-canvas p-3 text-sm">
      <div class="mb-2 flex items-center gap-2 font-medium">
        <AppIcon fallback="ph:check-circle" class="text-accent" /> Token “{{ created.token.name }}” created
        <button class="ml-auto rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink" title="Hide" @click="created = null"><AppIcon fallback="ph:x" :size="14" /></button>
      </div>
      <p class="mb-2 text-ink-soft">Copy it now: it is not shown again. Paste both into the browser extension or the Shortcut.</p>
      <div v-for="row in [{ key: 'server', label: 'Server address', value: server }, { key: 'token', label: 'Token', value: created.secret }]" :key="row.key" class="mt-1.5">
        <div class="text-xs text-ink-faint">{{ row.label }}</div>
        <div class="flex items-center gap-2">
          <code class="min-w-0 flex-1 truncate rounded-md bg-surface px-2 py-1 font-mono text-xs ring-1 ring-line">{{ row.value }}</code>
          <button :class="secondary" class="!px-2 !py-1 text-xs" @click="copy(row.key, row.value)">{{ copied === row.key ? 'Copied' : 'Copy' }}</button>
        </div>
      </div>
    </div>

    <ul v-if="tokens.length" class="mb-3 divide-y divide-line rounded-xl border border-line">
      <li v-for="token in tokens" :key="token.id" class="flex items-center gap-3 px-3 py-2 text-sm">
        <AppIcon :fallback="token.scope === 'api' ? 'ph:terminal-window' : token.scope === 'notify' ? 'ph:bell' : 'ph:tray-arrow-down'" class="shrink-0 text-ink-faint" />
        <div class="min-w-0 flex-1">
          <div class="truncate">{{ token.name }}<span v-if="token.scope === 'api'" class="text-ink-faint"> · whole API</span><span v-else-if="token.scope === 'notify'" class="text-ink-faint"> · made by the desktop app; deleting it stops its notifications until it makes another</span></div>
          <div class="truncate text-xs text-ink-faint">
            Created {{ formatRelative(token.createdAt) }} · {{ token.lastUsedAt ? `last used ${formatRelative(token.lastUsedAt)}` : 'never used' }}
          </div>
        </div>
        <button class="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-ink" title="Revoke" @click="revoke(token)"><AppIcon fallback="ph:trash" :size="14" /></button>
      </li>
    </ul>
    <p v-else class="mb-3 text-sm text-ink-faint">No tokens yet.</p>

    <form class="flex flex-wrap items-center gap-2" @submit.prevent="create">
      <input v-model="name" class="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm outline-none focus:border-line-strong" placeholder="Name, e.g. browser or iPhone" maxlength="60" />
      <select v-model="scope" class="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm outline-none" title="What the token may call">
        <option value="capture">Capture only</option>
        <option value="api">Whole API (scripts, agents)</option>
      </select>
      <button type="submit" :class="secondary" :disabled="!name.trim()">Create token</button>
    </form>
    <p v-if="error" :class="errorText" class="mt-2">{{ error }}</p>

    <!-- iOS Safari cannot be a share target, so the iPhone's share sheet goes through a Shortcut. -->
    <details class="mt-4 rounded-xl border border-line px-3 py-2 text-sm" :open="iPhone">
      <summary class="flex cursor-pointer items-center gap-2 font-medium">
        <AppIcon fallback="ph:device-mobile" class="text-ink-soft" /> Use on iPhone
      </summary>
      <p class="mt-2 text-ink-soft">
        Save links and text from any app's share sheet with a Shortcut. Create a capture token named “iPhone” above, then in the
        Shortcuts app:
      </p>
      <ol class="mt-2 list-decimal space-y-1.5 pl-5 text-ink-soft">
        <li>New shortcut → <b>Show in Share Sheet</b> (in its details), accepting <b>URLs</b> and <b>Safari web pages</b>.</li>
        <li>
          Add <b>Get Contents of URL</b>: URL
          <code class="break-all rounded bg-hover px-1 text-xs">{{ server }}/api/capture/weblink</code>, method <b>POST</b>, header
          <code class="rounded bg-hover px-1 text-xs">Authorization</code> = <code class="rounded bg-hover px-1 text-xs">Bearer</code> + your token, request body
          <b>JSON</b> with <code class="rounded bg-hover px-1 text-xs">url</code> = <i>Shortcut Input</i> and
          <code class="rounded bg-hover px-1 text-xs">channel</code> = <code class="rounded bg-hover px-1 text-xs">shortcuts</code>.
        </li>
        <li>Optionally <b>Ask for Input</b> first and send the answer as <code class="rounded bg-hover px-1 text-xs">note</code>; for plain text, post <code class="rounded bg-hover px-1 text-xs">text</code> to <code class="break-all rounded bg-hover px-1 text-xs">{{ server }}/api/capture/note</code>.</li>
      </ol>
      <div class="mt-3 flex flex-wrap gap-2">
        <button type="button" :class="secondary" class="!px-2 !py-1 text-xs" @click="copy('weblink-url', `${server}/api/capture/weblink`)">
          {{ copied === 'weblink-url' ? 'Copied' : 'Copy the weblink address' }}
        </button>
        <button v-if="created" type="button" :class="secondary" class="!px-2 !py-1 text-xs" @click="copy('bearer', `Bearer ${created.secret}`)">
          {{ copied === 'bearer' ? 'Copied' : 'Copy “Bearer” + token' }}
        </button>
      </div>
      <p class="mt-2 text-xs text-ink-faint">Also: Safari → Share → <b>Add to Home Screen</b> installs Vasta as an app.</p>
    </details>

    <!-- Agents read and write through the MCP endpoint (POST /mcp) with a whole-API token. -->
    <details class="mt-2 rounded-xl border border-line px-3 py-2 text-sm">
      <summary class="flex cursor-pointer items-center gap-2 font-medium">
        <AppIcon fallback="ph:robot" class="text-ink-soft" /> Use with agents
      </summary>
      <p class="mt-2 text-ink-soft">
        Agents such as Claude Code and Codex can search, read and write your notes through Vasta's MCP server at
        <code class="break-all rounded bg-hover px-1 text-xs">{{ server }}/mcp</code>. Create a token with <b>Whole API</b> above (one per agent), then:
      </p>
      <div v-for="command in agentCommands" :key="command.key" class="mt-2">
        <div class="text-xs text-ink-faint">{{ command.label }}</div>
        <div class="flex items-start gap-2">
          <pre class="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-md bg-surface px-2 py-1 font-mono text-xs ring-1 ring-line">{{ command.text }}</pre>
          <button type="button" :class="secondary" class="!px-2 !py-1 text-xs" @click="copy(command.key, command.text)">{{ copied === command.key ? 'Copied' : 'Copy' }}</button>
        </div>
      </div>
    </details>
  </SettingsSection>
</template>
