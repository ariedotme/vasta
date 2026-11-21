<script setup lang="ts">
// Change the logged-in user's password. Other browsers and devices are logged out by the server.
import { computed, ref } from 'vue'
import { authApi } from '../lib/api.ts'
import { t } from '../lib/i18n.ts'
import { ui } from '../lib/state.ts'
import ModalDialog from './ModalDialog.vue'

const current = ref('')
const next = ref('')
const repeat = ref('')
const error = ref('')
const done = ref(false)
const busy = ref(false)

const mismatch = computed(() => !!repeat.value && next.value !== repeat.value)
const ready = computed(() => !!current.value && next.value.length >= 8 && next.value === repeat.value && !busy.value)

async function submit() {
  if (!ready.value) return
  busy.value = true
  error.value = ''
  try {
    await authApi.changePassword(current.value, next.value)
    done.value = true
  } catch (failure) {
    error.value = (failure as Error).message
  } finally {
    busy.value = false
  }
}

const field = 'mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-line-strong'
</script>

<template>
  <ModalDialog :title="t('password.title')" width="26rem" @close="ui.passwordOpen = false">
    <p v-if="done" class="text-sm">{{ t('password.done') }}</p>
    <form v-else id="password-form" class="space-y-3" @submit.prevent="submit">
      <input type="text" autocomplete="username" class="hidden" aria-hidden="true" tabindex="-1" />
      <label class="block text-sm font-medium">{{ t('password.current') }}<input v-model="current" type="password" autocomplete="current-password" :class="field" /></label>
      <label class="block text-sm font-medium">{{ t('password.new') }}<input v-model="next" type="password" autocomplete="new-password" :class="field" /></label>
      <label class="block text-sm font-medium">{{ t('password.repeat') }}<input v-model="repeat" type="password" autocomplete="new-password" :class="field" /></label>
      <p class="text-xs text-ink-faint">{{ t('auth.minChars') }}</p>
      <p v-if="mismatch" class="text-sm text-red-600 dark:text-red-400">{{ t('password.mismatch') }}</p>
      <p v-if="error" class="text-sm text-red-600 dark:text-red-400">{{ error }}</p>
    </form>
    <template #footer>
      <div class="ml-auto flex gap-2">
        <button class="rounded-lg px-3 py-1.5 text-sm hover:bg-hover" @click="ui.passwordOpen = false">{{ done ? t('common.close') : t('common.cancel') }}</button>
        <button
          v-if="!done"
          type="submit"
          form="password-form"
          class="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-40"
          :disabled="!ready"
        >
          {{ t('password.title') }}
        </button>
      </div>
    </template>
  </ModalDialog>
</template>
