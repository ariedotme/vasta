<script setup lang="ts">
// Sprints in the open space: on (a Sprint type, a Sprint field on tasks, and the views "Current
// sprint" and "Backlog") or off (hidden; nothing is deleted), and the word the space uses for them.
import { computed, ref, watch } from 'vue'
import { setSprints, sprintSettings, sprintsOn, sprintTypeId } from '../../lib/sprints.ts'
import { workspace } from '../../lib/state.ts'
import AppIcon from '../AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import { errorText, field, label, secondary } from './styles.ts'

const busy = ref(false)
const error = ref('')
const name = ref('')
const pluralName = ref('')
// The saved words, not the settings object: a reload of the space (a sync) must not undo typing.
watch(() => sprintSettings.value?.name, (saved) => (name.value = saved ?? 'Sprint'), { immediate: true })
watch(() => sprintSettings.value?.pluralName, (saved) => (pluralName.value = saved ?? 'Sprints'), { immediate: true })
const spaceName = computed(() => workspace.space?.name ?? 'this space')
const dirty = computed(() => !!sprintSettings.value && (name.value.trim() !== sprintSettings.value.name || pluralName.value.trim() !== sprintSettings.value.pluralName))

async function run(change: () => Promise<unknown>) {
  busy.value = true
  error.value = ''
  try {
    await change()
  } catch (failure) {
    error.value = (failure as Error).message
  } finally {
    busy.value = false
  }
}

const toggle = () => run(() => setSprints({ enabled: !sprintsOn.value }))
/** A new singular brings its plural along unless the plural was changed too. */
function nameTyped() {
  if (sprintSettings.value && pluralName.value === sprintSettings.value.pluralName) pluralName.value = name.value.trim() ? `${name.value.trim()}s` : ''
}
const rename = () => run(() => setSprints({ name: name.value, pluralName: pluralName.value }))
</script>

<template>
  <SettingsSection id="sprints" title="Sprints">
    <div class="space-y-4">
      <label class="flex items-start gap-2.5 text-sm">
        <input :checked="sprintsOn" type="checkbox" class="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" :disabled="busy" @change="toggle" />
        <span>
          Plan work in {{ (sprintSettings?.pluralName ?? 'sprints').toLowerCase() }} in {{ spaceName }}
          <span class="block text-xs text-ink-faint">
            Time boxes with dates and a goal. Tasks get a {{ sprintSettings?.name ?? 'Sprint' }} field, and the Tasks page the views “Current {{ (sprintSettings?.name ?? 'sprint').toLowerCase() }}” (a board) and “Backlog”. Turning them off hides them and keeps everything.
          </span>
        </span>
      </label>
      <form v-if="sprintSettings" class="flex flex-wrap items-end gap-3" @submit.prevent="rename">
        <label :class="label" class="min-w-0 flex-1">
          Called
          <input v-model="name" :class="field" placeholder="Sprint" maxlength="40" @input="nameTyped" />
        </label>
        <label :class="label" class="min-w-0 flex-1">
          Plural
          <input v-model="pluralName" :class="field" placeholder="Sprints" maxlength="40" />
        </label>
        <button type="submit" :class="secondary" class="mb-0.5" :disabled="!dirty || !name.trim() || busy">Rename</button>
      </form>
      <RouterLink v-if="sprintsOn" :to="`/t/${sprintTypeId}`" class="inline-flex items-center gap-1 text-sm text-accent hover:underline">
        {{ sprintSettings?.pluralName }} <AppIcon fallback="ph:arrow-right" :size="13" />
      </RouterLink>
      <p v-if="error" :class="errorText">{{ error }}</p>
    </div>
  </SettingsSection>
</template>
