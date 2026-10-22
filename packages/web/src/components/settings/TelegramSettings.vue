<script setup lang="ts">
// Link the user's Telegram account: the app shows a one-time code, the user sends it to the bot
// (or opens the t.me deep link, which sends it for them). The page polls until the link lands.
// Below, the chats the bot listens in: the server's first account changes them (allowing a chat
// the bot ignored lately, or one by its id), everyone else sees them.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { authApi, type ChannelState, type TelegramChat } from '../../lib/api.ts'
import { confirmDialog } from '../../lib/overlays.ts'
import AppIcon from '../AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import { errorText, field, primary, secondary } from './styles.ts'

const status = ref<{ linked: boolean; bot?: string } | null>(null)
const code = ref<{ code: string; expiresAt: string; bot?: string } | null>(null)
const error = ref('')
let timer: ReturnType<typeof setInterval> | undefined

const deepLink = computed(() => (code.value?.bot ? `https://t.me/${code.value.bot}?start=link-${code.value.code}` : ''))

const channels = ref<ChannelState['telegram'] | null>(null)
const newChat = ref('')
const savingChats = ref(false)

async function load() {
  try {
    status.value = await authApi.telegram()
  } catch (failure) {
    error.value = (failure as Error).message
  }
}
onMounted(load)
onMounted(async () => {
  channels.value = (await authApi.channels().catch(() => null))?.telegram ?? null
})

async function setChats(chats: TelegramChat[]) {
  savingChats.value = true
  error.value = ''
  try {
    channels.value = (await authApi.setTelegramChats(chats)).telegram
  } catch (failure) {
    error.value = (failure as Error).message
  } finally {
    savingChats.value = false
  }
}

const allowChat = (chat: TelegramChat) => setChats([...(channels.value?.allowedChats ?? []), { id: chat.id, ...(chat.title ? { title: chat.title } : {}) }])
const removeChat = (id: number) => setChats((channels.value?.allowedChats ?? []).filter((c) => c.id !== id))

async function addChat() {
  const id = Number(newChat.value.trim())
  if (!Number.isInteger(id) || id === 0) {
    error.value = 'A chat id is a whole number, e.g. -1001234567890 for a group (send /id to the bot there).'
    return
  }
  await allowChat({ id })
  newChat.value = ''
}

async function anyChat() {
  const ok = await confirmDialog({
    title: 'Listen in any chat?',
    message: 'The bot then saves what linked accounts send it in any chat, private or group. Others are still ignored.',
    confirmLabel: 'Listen in any chat',
  })
  if (ok) await setChats([])
}

const chatName = (chat: TelegramChat) => chat.title ?? (chat.id > 0 ? 'Private chat' : 'Group')

function stopPolling() {
  clearInterval(timer)
  timer = undefined
}
onBeforeUnmount(stopPolling)

async function start() {
  error.value = ''
  try {
    code.value = await authApi.telegramCode()
  } catch (failure) {
    error.value = (failure as Error).message
    return
  }
  stopPolling()
  timer = setInterval(async () => {
    if (code.value && Date.parse(code.value.expiresAt) <= Date.now()) {
      code.value = null
      stopPolling()
      return
    }
    await load()
    if (status.value?.linked) {
      code.value = null
      stopPolling()
    }
  }, 3000)
}

async function unlink() {
  const ok = await confirmDialog({
    title: 'Unlink Telegram?',
    message: 'Messages you send to the bot are no longer saved until you link it again.',
    confirmLabel: 'Unlink',
    danger: true,
  })
  if (!ok) return
  try {
    await authApi.unlinkTelegram()
    await load()
  } catch (failure) {
    error.value = (failure as Error).message
  }
}
</script>

<template>
  <SettingsSection id="telegram" title="Telegram" description="Send text, links, photos, voice messages and files to the bot; they land in today's daily note of your capture space.">
    <template v-if="status">
      <div v-if="status.linked" class="flex flex-wrap items-center gap-3 text-sm">
        <span class="flex items-center gap-1.5"><AppIcon fallback="ph:check-circle" class="text-accent" /> Linked<template v-if="status.bot"> to <a :href="`https://t.me/${status.bot}`" target="_blank" rel="noopener" class="text-accent hover:underline">@{{ status.bot }}</a></template></span>
        <button :class="secondary" @click="unlink">Unlink</button>
      </div>
      <div v-else-if="code" class="rounded-xl border border-line bg-canvas p-3 text-sm">
        <p v-if="code.bot" class="mb-3">
          Open <a :href="`https://t.me/${code.bot}`" target="_blank" rel="noopener" class="text-accent hover:underline">@{{ code.bot }}</a> and send:
        </p>
        <p v-else class="mb-3">Send this to Vasta's bot:</p>
        <code class="block rounded-md bg-surface px-3 py-2 font-mono text-base tracking-wider ring-1 ring-line">/link {{ code.code }}</code>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <a v-if="deepLink" :href="deepLink" target="_blank" rel="noopener" :class="primary" class="inline-flex items-center gap-1.5"><AppIcon fallback="ph:telegram-logo" /> Open in Telegram</a>
          <button :class="secondary" @click="code = null">Cancel</button>
          <span class="text-xs text-ink-faint">The code works once, for 10 minutes. This page updates when the bot links you.</span>
        </div>
      </div>
      <div v-else class="flex flex-wrap items-center gap-3 text-sm">
        <span class="text-ink-soft">Not linked.</span>
        <button :class="primary" @click="start">Link Telegram</button>
        <span v-if="!status.bot" class="text-xs text-ink-faint">The server has no bot running right now (TELEGRAM_BOT_TOKEN), so the code cannot be sent yet.</span>
      </div>
    </template>
    <div v-if="channels?.running" class="mt-6" data-testid="telegram-chats">
      <h3 class="text-sm font-medium">Chats</h3>
      <p class="mt-1 text-sm text-ink-soft">
        <template v-if="channels.allowedChats.length">The bot saves what linked accounts send in these chats and ignores the others.</template>
        <template v-else>The bot saves what linked accounts send in any chat, private or group.</template>
        Messages from people who are not linked are never saved.
      </p>
      <ul v-if="channels.allowedChats.length" class="mt-3 divide-y divide-line rounded-xl border border-line text-sm">
        <li v-for="chat in channels.allowedChats" :key="chat.id" class="flex items-center gap-3 px-3 py-2">
          <AppIcon :fallback="chat.id > 0 ? 'ph:user' : 'ph:users-three'" class="text-ink-soft" />
          <span class="min-w-0 flex-1 truncate">{{ chatName(chat) }} <span class="text-xs text-ink-faint">{{ chat.id }}</span></span>
          <button v-if="channels.manage" class="text-xs text-ink-soft hover:text-red-600" :disabled="savingChats" @click="removeChat(chat.id)">Remove</button>
        </li>
      </ul>
      <template v-if="channels.manage">
        <div v-if="channels.allowedChats.length && channels.ignoredChats?.length" class="mt-4">
          <h4 class="text-xs text-ink-faint">Ignored lately</h4>
          <ul class="mt-1 divide-y divide-line rounded-xl border border-dashed border-line text-sm">
            <li v-for="chat in channels.ignoredChats" :key="chat.id" class="flex items-center gap-3 px-3 py-2">
              <AppIcon :fallback="chat.id > 0 ? 'ph:user' : 'ph:users-three'" class="text-ink-faint" />
              <span class="min-w-0 flex-1 truncate">{{ chatName(chat) }} <span class="text-xs text-ink-faint">{{ chat.id }}</span></span>
              <button :class="secondary" class="!py-1 text-xs" :disabled="savingChats" @click="allowChat(chat)">Allow</button>
            </li>
          </ul>
        </div>
        <form class="mt-4 flex flex-wrap items-center gap-2" @submit.prevent="addChat">
          <input v-model="newChat" :class="field" class="!mt-0 !w-56" inputmode="numeric" placeholder="Chat id, e.g. -1001234567890" aria-label="Chat id" />
          <button :class="secondary" :disabled="!newChat.trim() || savingChats">{{ channels.allowedChats.length ? 'Add chat' : 'Listen only in this chat' }}</button>
          <button v-if="channels.allowedChats.length" type="button" class="text-xs text-ink-soft hover:underline" :disabled="savingChats" @click="anyChat">Listen in any chat</button>
        </form>
        <p class="mt-2 text-xs text-ink-faint">Send /id to the bot in a chat it listens in to see the id; a message in a chat it ignores shows up under “Ignored lately”.</p>
      </template>
      <p v-else class="mt-2 text-xs text-ink-faint">The account that set up this server chooses the chats.</p>
    </div>
    <p v-if="error" :class="errorText" class="mt-2">{{ error }}</p>
  </SettingsSection>
</template>
