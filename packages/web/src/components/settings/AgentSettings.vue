<script setup lang="ts">
// What agents (Claude Code, Codex, the Claude app… through the MCP, docs/agents.md) see and do in
// the open space: instructions sent to them when they connect, the objects marked as agent
// context, and what is kept from them (the whole space, or tags) or read-only. Owners change it
// (the server enforces it); everyone reads it.
import { computed, ref, watch } from 'vue'
import { builtinTypeId, tagPath, type Id, type ObjectSummary } from '@vasta/core'
import { api } from '../../lib/api.ts'
import { t } from '../../lib/i18n.ts'
import { session } from '../../lib/session.ts'
import { workspace } from '../../lib/state.ts'
import AppIcon from '../AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import { errorText, field, label, primary } from './styles.ts'

const space = computed(() => workspace.space)
const settings = computed(() => space.value?.agents ?? {})

const instructions = ref('')
const busy = ref(false)
const error = ref('')
const isOwner = ref(false)
const tags = ref<ObjectSummary[]>([])
const context = ref<ObjectSummary[]>([])
const tagToHide = ref('')

// The saved text, not the settings object: a reload of the space (a sync) must not undo typing.
watch(() => settings.value.instructions, (saved) => (instructions.value = saved ?? ''), { immediate: true })
watch(
  () => space.value?.id,
  async (spaceId) => {
    if (!spaceId) return
    error.value = ''
    try {
      const [members, found] = await Promise.all([api.members(spaceId), api.objectsOfType(builtinTypeId(spaceId, 'tag'))])
      isOwner.value = members.some((m) => m.userId === session.user?.id && m.role === 'owner')
      tags.value = found
    } catch (failure) {
      error.value = (failure as Error).message
    }
  },
  { immediate: true }
)
watch(
  () => settings.value.context?.join(','),
  async () => {
    const ids = settings.value.context ?? []
    context.value = ids.length ? (await api.summaries(ids).catch(() => [])).filter((o) => !o.deletedAt) : []
  },
  { immediate: true }
)

const pathOf = (id: Id) => tagPath(id, (at) => tags.value.find((item) => item.id === at)) || t('settings.agents.deletedTag')
const hiddenTags = computed(() => (settings.value.hiddenTagIds ?? []).map((id) => ({ id, path: pathOf(id) })))
const tagChoices = computed(() =>
  tags.value
    .filter((item) => !item.deletedAt && !settings.value.hiddenTagIds?.includes(item.id))
    .map((item) => ({ id: item.id, path: pathOf(item.id) }))
    .sort((a, b) => a.path.localeCompare(b.path))
)
const dirty = computed(() => instructions.value.trim() !== (settings.value.instructions ?? ''))

async function save(change: Record<string, unknown>) {
  if (!space.value) return
  busy.value = true
  error.value = ''
  try {
    const { context: _context, ...current } = settings.value
    const saved = await api.setAgentSettings(space.value.id, { ...current, ...change })
    workspace.space = saved
    const index = workspace.spaces.findIndex((s) => s.id === saved.id)
    if (index >= 0) workspace.spaces[index] = saved
  } catch (failure) {
    error.value = (failure as Error).message
  } finally {
    busy.value = false
  }
}

const saveInstructions = () => save({ instructions: instructions.value })
function hideTag() {
  if (!tagToHide.value) return
  void save({ hiddenTagIds: [...(settings.value.hiddenTagIds ?? []), tagToHide.value] })
  tagToHide.value = ''
}
const showTag = (id: Id) => save({ hiddenTagIds: (settings.value.hiddenTagIds ?? []).filter((item) => item !== id) })

async function unmark(id: Id) {
  if (!space.value) return
  try {
    workspace.space = await api.setAgentContext(space.value.id, id, false)
  } catch (failure) {
    error.value = (failure as Error).message
  }
}
</script>

<template>
  <SettingsSection id="agents" :title="t('settings.section.agents')">
    <p class="mb-4 text-sm text-ink-soft">
      {{ t('settings.agents.intro', { space: space?.name ?? t('settings.thisSpace') }) }}
    </p>
    <div class="space-y-5">
      <form class="space-y-2" @submit.prevent="saveInstructions">
        <label :class="label">
          {{ t('settings.agents.instructionsLabel') }}
          <textarea
            v-model="instructions"
            :class="field"
            rows="5"
            maxlength="8000"
            :disabled="!isOwner"
            :placeholder="t('settings.agents.instructionsPlaceholder')"
          />
        </label>
        <div class="flex items-center gap-3">
          <button type="submit" :class="primary" :disabled="!dirty || busy || !isOwner">{{ t('common.save') }}</button>
          <span class="text-xs text-ink-faint">{{ t('settings.agents.instructionsHint') }}</span>
        </div>
      </form>

      <div>
        <h3 class="mb-1 text-sm font-medium">{{ t('settings.agents.contextHeading') }}</h3>
        <p class="mb-2 text-xs text-ink-faint">{{ t('settings.agents.contextHint') }}</p>
        <ul v-if="context.length" class="divide-y divide-line rounded-xl border border-line">
          <li v-for="object in context" :key="object.id" class="flex items-center gap-2 px-3 py-2 text-sm">
            <RouterLink :to="`/o/${object.id}`" class="min-w-0 flex-1 truncate hover:underline">{{ object.title || t('common.untitled') }}</RouterLink>
            <button class="text-ink-faint hover:text-ink" :title="t('settings.agents.unmarkTitle')" @click="unmark(object.id)"><AppIcon fallback="ph:x" :size="14" /></button>
          </li>
        </ul>
        <p v-else class="text-sm text-ink-faint">{{ t('settings.agents.contextEmpty') }}</p>
      </div>

      <div class="space-y-2">
        <h3 class="text-sm font-medium">{{ t('settings.agents.accessHeading') }}</h3>
        <label class="flex items-start gap-2.5 text-sm">
          <input :checked="!!settings.readOnly" type="checkbox" class="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" :disabled="busy || !isOwner" @change="save({ readOnly: !settings.readOnly })" />
          <span>{{ t('settings.agents.readOnly') }} <span class="block text-xs text-ink-faint">{{ t('settings.agents.readOnlyHint') }}</span></span>
        </label>
        <label class="flex items-start gap-2.5 text-sm">
          <input :checked="!!settings.hidden" type="checkbox" class="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" :disabled="busy || !isOwner" @change="save({ hidden: !settings.hidden })" />
          <span>{{ t('settings.agents.hideSpace') }} <span class="block text-xs text-ink-faint">{{ t('settings.agents.hideSpaceHint') }}</span></span>
        </label>
      </div>

      <div>
        <h3 class="mb-1 text-sm font-medium">{{ t('settings.agents.hiddenTagsHeading') }}</h3>
        <p class="mb-2 text-xs text-ink-faint">{{ t('settings.agents.hiddenTagsHint') }}</p>
        <div v-if="hiddenTags.length" class="mb-2 flex flex-wrap gap-1.5">
          <span v-for="tag in hiddenTags" :key="tag.id" class="inline-flex items-center gap-1 rounded-full bg-hover px-2 py-0.5 text-sm">
            #{{ tag.path }}
            <button v-if="isOwner" class="text-ink-faint hover:text-ink" :title="t('settings.agents.showAgainTitle')" :disabled="busy" @click="showTag(tag.id)"><AppIcon fallback="ph:x" :size="12" /></button>
          </span>
        </div>
        <form v-if="isOwner" class="flex items-center gap-2" @submit.prevent="hideTag">
          <select v-model="tagToHide" class="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none">
            <option value="">{{ t('settings.agents.chooseTag') }}</option>
            <option v-for="tag in tagChoices" :key="tag.id" :value="tag.id">#{{ tag.path }}</option>
          </select>
          <button type="submit" :class="primary" :disabled="!tagToHide || busy">{{ t('settings.agents.hide') }}</button>
        </form>
      </div>

      <p v-if="!isOwner" class="text-xs text-ink-faint">{{ t('settings.agents.ownersOnly') }}</p>
      <p v-if="error" :class="errorText">{{ error }}</p>
    </div>
  </SettingsSection>
</template>
