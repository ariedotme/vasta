<script setup lang="ts">
// The word for inbox items marked as dealt with, and whether those fade; saved to the account as
// soon as they change, so every device shows the same.
import { ref } from 'vue'
import { authApi } from '../../lib/api.ts'
import { DEFAULT_REVIEWED_LABEL, reviewed } from '../../lib/inbox.ts'
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
  <SettingsSection id="inbox" title="Inbox">
    <div class="space-y-4">
      <label :class="label" class="max-w-xs">
        Word for items you dealt with
        <input v-model="word" :class="field" :placeholder="DEFAULT_REVIEWED_LABEL" maxlength="40" @change="save" @keydown.enter="($event.target as HTMLInputElement).blur()" />
        <span class="mt-1 block">The inbox offers “Mark {{ reviewed.lower }}” and hides those items until you show them.</span>
      </label>
      <label class="flex items-start gap-2.5 text-sm">
        <input v-model="fade" type="checkbox" class="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" @change="save" />
        <span>
          Fade {{ reviewed.lower }} items
          <span class="block text-xs text-ink-faint">In the inbox and in the daily notes. Otherwise they only show the check.</span>
        </span>
      </label>
      <p v-if="saved || error" class="text-sm" :class="error ? errorText : 'text-ink-soft'">{{ error || 'Saved' }}</p>
    </div>
  </SettingsSection>
</template>
