<script setup lang="ts">
// Move the notes of the desktop app's own server to a Vasta server: make an account there with its
// setup code (a new server) or an invite link (someone else's), then the local server sends every
// space, its rich text and files (server/src/transfer.ts). The notes on this computer stay; at the
// end the app switches to the other server, where the user logs in with the new password.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { migrationApi, type MigrationState } from '../../lib/api.ts'
import { t } from '../../lib/i18n.ts'
import { switchToServer } from '../../lib/platform.ts'
import { session } from '../../lib/session.ts'
import AppIcon from '../AppIcon.vue'
import ModalDialog from '../ModalDialog.vue'
import { errorText, field, label, primary } from './styles.ts'

const emit = defineEmits<{ close: [] }>()

const code = ref('')
const server = ref('')
const name = ref(session.user?.name ?? '')
const username = ref(session.user?.username ?? '')
const password = ref('')
const repeat = ref('')
const state = ref<MigrationState>({ phase: 'idle', done: 0, total: 0 })
const error = ref('')
const busy = ref(false)
/** Back on the form after a failure, to change what was typed. */
const editing = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined

/** An invite link names its server; a setup code or an invite code needs the address. */
const linkHost = computed(() => {
  const text = code.value.trim()
  if (!/^https?:\/\//i.test(text)) return ''
  const url = URL.parse(text)
  return url?.searchParams.get('invite') ? url.host : ''
})
const host = computed(() => (state.value.server ? new URL(state.value.server).host : linkHost.value || server.value.trim()))
const running = computed(() => ['account', 'notes', 'media'].includes(state.value.phase))
const mismatch = computed(() => !!repeat.value && password.value !== repeat.value)
const ready = computed(
  () => !!code.value.trim() && (!!linkHost.value || !!server.value.trim()) && !!username.value.trim() && password.value.length >= 8 && password.value === repeat.value && !busy.value
)

const STEPS = computed(() => [
  { phase: 'account', label: t('settings.migrate.stepAccount') },
  { phase: 'notes', label: t('settings.migrate.stepNotes') },
  { phase: 'media', label: t('settings.migrate.stepMedia') },
] as const)
const order = ['account', 'notes', 'media', 'done']
const stepState = (phase: string) => {
  const at = order.indexOf(state.value.phase === 'failed' ? (state.value.step ?? 'account') : state.value.phase)
  const step = order.indexOf(phase)
  if (state.value.phase === 'failed' && step === at) return 'failed'
  return step < at ? 'done' : step === at ? 'now' : 'next'
}
const progress = computed(() => (state.value.total ? Math.round((state.value.done / state.value.total) * 100) : 0))

async function poll() {
  try {
    state.value = await migrationApi.state()
  } catch {}
  if (running.value) {
    timer = setTimeout(poll, 400)
  } else if (state.value.phase === 'failed' && state.value.step === 'account') {
    // Nothing moved yet (a wrong code, a taken username): fix it on the form.
    editing.value = true
    error.value = state.value.error ?? ''
  }
}

async function start() {
  if (!ready.value) return
  busy.value = true
  error.value = ''
  editing.value = false
  try {
    state.value = await migrationApi.start({
      server: server.value,
      code: code.value,
      username: username.value,
      name: name.value,
      password: password.value,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    void poll()
  } catch (failure) {
    error.value = (failure as Error).message
    editing.value = true
  } finally {
    busy.value = false
  }
}

async function switchOver() {
  if (state.value.server) await switchToServer(state.value.server)
}

/** Nothing closes it while notes are on their way. */
function close() {
  if (!running.value) emit('close')
}

onMounted(poll)
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <ModalDialog :title="t('settings.migrate.title')" width="30rem" @close="close">
    <template #icon><AppIcon fallback="ph:arrows-left-right" class="text-ink-faint" /></template>

    <!-- The form: where, and the account to make there. -->
    <form v-if="state.phase === 'idle' || editing" id="migrate-form" class="space-y-4" @submit.prevent="start">
      <p class="text-sm text-ink-soft">{{ t('settings.migrate.intro') }}</p>
      <label :class="label">
        {{ t('settings.migrate.codeLabel') }}
        <input v-model="code" :class="field" type="text" spellcheck="false" autocomplete="off" :placeholder="t('settings.migrate.codePlaceholder')" autofocus />
        <span class="mt-1 block">{{ t('settings.migrate.codeHint') }}</span>
      </label>
      <label v-if="!linkHost" :class="label">
        {{ t('settings.migrate.serverAddress') }}
        <input v-model="server" :class="field" type="text" inputmode="url" spellcheck="false" autocomplete="url" placeholder="notes.example.org" />
      </label>
      <p v-else class="flex items-center gap-2 text-sm text-ink-soft"><AppIcon fallback="ph:hard-drives" :size="16" class="text-ink-faint" /> {{ t('settings.migrate.serverHost', { host: linkHost }) }}</p>

      <div class="grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
        <label :class="label">{{ t('settings.migrate.name') }}<input v-model="name" :class="field" type="text" autocomplete="name" /></label>
        <label :class="label">{{ t('settings.migrate.username') }}<input v-model="username" :class="field" type="text" autocomplete="username" spellcheck="false" /></label>
        <label :class="label">{{ t('settings.migrate.password') }}<input v-model="password" :class="field" type="password" autocomplete="new-password" /></label>
        <label :class="label">{{ t('settings.migrate.repeatPassword') }}<input v-model="repeat" :class="field" type="password" autocomplete="new-password" /></label>
      </div>
      <p class="text-xs text-ink-faint">{{ t('settings.migrate.passwordHint') }}</p>
      <p v-if="mismatch" :class="errorText">{{ t('settings.migrate.passwordMismatch') }}</p>
      <p v-if="error" :class="errorText">{{ error }}</p>
    </form>

    <!-- Under way, done or stopped: the steps. -->
    <div v-else class="space-y-5">
      <p v-if="state.phase === 'done'" class="text-sm">
        {{ t('settings.migrate.doneBefore') }}<strong>{{ host }}</strong>{{ t('settings.migrate.doneAfter') }}
      </p>
      <p v-else-if="running" class="text-sm text-ink-soft">{{ t('settings.migrate.running', { host }) }}</p>

      <ol class="space-y-3">
        <li v-for="step in STEPS" :key="step.phase" class="flex items-center gap-3 text-sm">
          <span class="grid size-6 shrink-0 place-items-center rounded-full border" :class="{
            'border-ink bg-ink text-surface': stepState(step.phase) === 'done',
            'border-line-strong': stepState(step.phase) === 'now',
            'border-line text-ink-faint': stepState(step.phase) === 'next',
            'border-red-500 text-red-600 dark:text-red-400': stepState(step.phase) === 'failed',
          }">
            <AppIcon v-if="stepState(step.phase) === 'done'" fallback="ph:check-bold" :size="12" />
            <AppIcon v-else-if="stepState(step.phase) === 'failed'" fallback="ph:x-bold" :size="12" />
            <span v-else-if="stepState(step.phase) === 'now'" class="size-3 animate-spin rounded-full border-2 border-line border-t-ink-soft" />
          </span>
          <span class="flex-1" :class="stepState(step.phase) === 'next' ? 'text-ink-faint' : ''">{{ step.label }}</span>
          <span v-if="stepState(step.phase) === 'now' && state.total" class="tabular-nums text-xs text-ink-faint">{{ t('settings.migrate.progress', { done: state.done, total: state.total }) }}</span>
        </li>
      </ol>
      <div v-if="running && state.total" class="h-1 overflow-hidden rounded-full bg-hover">
        <div class="h-full rounded-full bg-ink transition-[width] duration-300" :style="{ width: `${progress}%` }" />
      </div>

      <p v-if="state.phase === 'failed'" :class="errorText">{{ state.error }}</p>
      <p v-if="state.phase === 'done'" class="rounded-xl border border-line bg-canvas p-3 text-sm text-ink-soft">
        {{ t('settings.migrate.doneBoxBeforeUser') }}<strong class="text-ink">{{ username || t('settings.migrate.yourNewAccount') }}</strong>{{ t('settings.migrate.doneBoxMid') }}
        <strong class="text-ink">{{ host }}</strong>{{ t('settings.migrate.doneBoxAfterHost') }}
      </p>
    </div>

    <template #footer>
      <div class="ml-auto flex gap-2">
        <button v-if="!running" class="rounded-lg px-3 py-1.5 text-sm hover:bg-hover" @click="close">{{ state.phase === 'done' ? t('settings.migrate.notNow') : t('common.cancel') }}</button>
        <button v-if="state.phase === 'idle' || editing" type="submit" form="migrate-form" :class="primary" :disabled="!ready">{{ t('settings.migrate.moveMyNotes') }}</button>
        <template v-else-if="state.phase === 'failed'">
          <button class="rounded-lg px-3 py-1.5 text-sm hover:bg-hover" @click="editing = true">{{ t('settings.migrate.changeDetails') }}</button>
          <!-- The account is made already: trying again goes on with it. -->
          <button :class="primary" :disabled="!ready" @click="start">{{ t('settings.migrate.tryAgain') }}</button>
        </template>
        <button v-else-if="state.phase === 'done'" :class="primary" @click="switchOver">{{ t('settings.migrate.switchTo', { host }) }}</button>
      </div>
    </template>
  </ModalDialog>
</template>
