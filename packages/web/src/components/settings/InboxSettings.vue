<script setup lang="ts">
// The word for inbox items marked as dealt with, and whether those fade; saved to the account as
// soon as they change, so every device shows the same.
import { ref } from 'vue'
import { authApi } from '../../lib/api.ts'
import { t } from '../../lib/i18n.ts'
import { reviewed } from '../../lib/inbox.ts'
import { session } from '../../lib/session.ts'
import SettingsSection from './SettingsSection.vue'
import { errorText, field, label } from './styles.ts'

const word = ref(session.user!.inbox?.reviewedLabel ?? '')
const fade = ref(!!session.user!.inbox?.fadeReviewed)
const error = ref('')
const saved = ref(false)

async function save() {
  const current = session.user!.inbox ?? {}
  if (word.value.trim() === (current.reviewedLabel ?? '') && fade.value === !!current.fadeReviewed) return
  error.value = ''
  try {
    session.user = await authApi.updateProfile({ inbox: { reviewedLabel: word.value.trim(), fadeReviewed: fade.value } })
    word.value = session.user.inbox?.reviewedLabel ?? ''
    saved.value = true
    setTimeout(() => (saved.value = false), 2000)
  } catch (failure) {
    error.value = (failure as Error).message
  }
}
</script>

<template>
  <SettingsSection id="inbox" :title="t('settings.section.inbox')">
    <div class="space-y-4">
      <label :class="label" class="max-w-xs">
        {{ t('settings.inbox.wordLabel') }}
        <input v-model="word" :class="field" :placeholder="t('settings.inbox.defaultReviewed')" maxlength="40" @change="save" @keydown.enter="($event.target as HTMLInputElement).blur()" />
        <span class="mt-1 block">{{ t('settings.inbox.wordHint', { word: reviewed.lower }) }}</span>
      </label>
      <label class="flex items-start gap-2.5 text-sm">
        <input v-model="fade" type="checkbox" class="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" @change="save" />
        <span>
          {{ t('settings.inbox.fadeLabel', { word: reviewed.lower }) }}
          <span class="block text-xs text-ink-faint">{{ t('settings.inbox.fadeHint') }}</span>
        </span>
      </label>
      <p v-if="saved || error" class="text-sm" :class="error ? errorText : 'text-ink-soft'">{{ error || t('settings.saved') }}</p>
    </div>
  </SettingsSection>
</template>
