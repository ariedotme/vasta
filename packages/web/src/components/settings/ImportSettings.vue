<script setup lang="ts">
// Import from Capacities: choose the ZIP of a full export, the space folder in it (an export can
// hold several) and where it goes (a new space, or one of yours), then read what was done.
import { computed, ref } from 'vue'
import type { Id } from '@vasta/core'
import { api, type CapacitiesImportReport } from '../../lib/api.ts'
import { importExport, readExport, type ExportArchive, type ImportProgress } from '../../lib/capacities-import.ts'
import { t } from '../../lib/i18n.ts'
import { loadWorkspace, workspace } from '../../lib/state.ts'
import SettingsSection from './SettingsSection.vue'
import { errorText, label, primary, secondary } from './styles.ts'

const NEW_SPACE = ''

const archive = ref<ExportArchive | null>(null)
const fileName = ref('')
const folder = ref('')
const target = ref<Id>(NEW_SPACE)
const busy = ref(false)
const progress = ref<ImportProgress | null>(null)
const error = ref('')
const done = ref<{ report: CapacitiesImportReport; tooLarge: string[]; spaceId: Id } | null>(null)
const input = ref<HTMLInputElement | null>(null)

const chosen = computed(() => archive.value?.spaces.find((s) => s.name === folder.value))

async function choose(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  ;(event.target as HTMLInputElement).value = ''
  if (!file) return
  error.value = ''
  done.value = null
  archive.value = null
  busy.value = true
  try {
    archive.value = await readExport(file)
    fileName.value = file.name
    folder.value = archive.value.spaces[0]!.name
    target.value = NEW_SPACE
  } catch (failure) {
    error.value = (failure as Error).message
  } finally {
    busy.value = false
  }
}

async function start() {
  if (!archive.value || !chosen.value) return
  busy.value = true
  error.value = ''
  let made: { id: Id; name: string } | undefined
  try {
    if (!target.value) made = await api.createSpace({ name: chosen.value.name })
    const spaceId = made?.id ?? target.value
    const outcome = await importExport(archive.value, chosen.value.name, spaceId, (p) => (progress.value = p))
    done.value = { ...outcome, spaceId }
    archive.value = null
    await loadWorkspace(spaceId)
  } catch (failure) {
    error.value = (failure as Error).message
    // A new space the import never filled is not left behind.
    if (made) await api.deleteSpace(made.id, made.name).catch(() => undefined)
  } finally {
    busy.value = false
    progress.value = null
  }
}

const progressText = computed(() => {
  const p = progress.value
  if (!p) return busy.value ? t('settings.import.readingFile') : ''
  return p.phase === 'media'
    ? t('settings.import.sendingFiles', { done: p.done, total: p.total })
    : t('settings.import.importingNotes', { total: p.total })
})

const typeCounts = computed(() => Object.entries(done.value?.report.objectsByType ?? {}).sort((a, b) => b[1] - a[1]))
const notesCount = (n: number) => (n === 1 ? t('settings.import.notesCount.one') : t('settings.import.notesCount.other', { count: n }))
const filesCount = (n: number) => (n === 1 ? t('settings.import.filesCount.one') : t('settings.import.filesCount.other', { count: n }))
</script>

<template>
  <SettingsSection id="import" :title="t('settings.section.import')" :description="t('settings.import.description')">
    <div class="space-y-4 text-sm">
      <p class="text-ink-soft">
        {{ t('settings.import.intro') }}
      </p>

      <div class="flex flex-wrap items-center gap-2">
        <input ref="input" type="file" accept=".zip,application/zip" class="hidden" @change="choose" />
        <button :class="secondary" :disabled="busy" @click="input?.click()">{{ t('settings.import.chooseExport') }}</button>
        <span v-if="archive" class="text-ink-soft">{{ fileName }}</span>
      </div>

      <div v-if="archive && chosen" class="space-y-3">
        <label v-if="archive.spaces.length > 1" :class="label" class="max-w-xs">
          {{ t('settings.import.spaceInExport') }}
          <select v-model="folder" class="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none" :disabled="busy">
            <option v-for="space in archive.spaces" :key="space.name" :value="space.name">{{ space.name }}</option>
          </select>
        </label>
        <label :class="label" class="max-w-xs">
          {{ t('settings.import.importInto') }}
          <select v-model="target" class="mt-1 w-full rounded-lg border border-line bg-surface px-2 py-1.5 text-sm text-ink outline-none" :disabled="busy">
            <option :value="NEW_SPACE">{{ t('settings.import.newSpaceOption', { name: chosen.name }) }}</option>
            <option v-for="space in workspace.spaces" :key="space.id" :value="space.id">{{ space.name }}</option>
          </select>
          <span v-if="target" class="mt-1 block">{{ t('settings.import.existingSpaceHint') }}</span>
        </label>
        <p class="text-ink-soft">{{ t('settings.import.notesAndFiles', { notes: notesCount(chosen.notes), files: filesCount(chosen.files) }) }}</p>
        <button :class="primary" :disabled="busy" @click="start">{{ t('settings.import.action') }}</button>
      </div>

      <p v-if="busy && progressText" class="text-ink-soft">{{ progressText }}</p>
      <p v-if="error" :class="errorText">{{ error }}</p>

      <div v-if="done" class="space-y-3 rounded-lg bg-hover/60 p-4">
        <p class="font-medium">{{ done.report.objects === 1 ? t('settings.import.importedObjects.one') : t('settings.import.importedObjects.other', { count: done.report.objects }) }}</p>
        <ul class="space-y-1 text-ink-soft">
          <li v-if="done.report.types.created.length">{{ t('settings.import.newTypes', { list: done.report.types.created.join(', ') }) }}</li>
          <li v-if="done.report.types.matched.length">{{ t('settings.import.matchedTypes', { list: done.report.types.matched.join(', ') }) }}</li>
          <li v-if="done.report.tags.created || done.report.tags.matched">
            {{ t('settings.import.tagsSummary', { created: done.report.tags.created }) }}<template v-if="done.report.tags.matched">{{ t('settings.import.tagsMatched', { matched: done.report.tags.matched }) }}</template>.
          </li>
          <li v-if="done.report.mergedDailyNotes">{{ done.report.mergedDailyNotes === 1 ? t('settings.import.mergedDailyNotes.one') : t('settings.import.mergedDailyNotes.other', { count: done.report.mergedDailyNotes }) }}</li>
          <li v-if="done.report.media.attached">{{ done.report.media.attached === 1 ? t('settings.import.filesAttached.one') : t('settings.import.filesAttached.other', { count: done.report.media.attached }) }}</li>
        </ul>
        <details class="text-ink-soft">
          <summary class="cursor-pointer">{{ t('settings.import.byType') }}</summary>
          <ul class="mt-1 grid grid-cols-2 gap-x-4 sm:grid-cols-3">
            <li v-for="[name, count] in typeCounts" :key="name">{{ name }}: {{ count }}</li>
          </ul>
        </details>

        <div v-if="done.report.queries.length" class="text-ink-soft">
          <p class="text-ink">{{ t('settings.import.queriesHeading') }}</p>
          <p>{{ t('settings.import.queriesBody', { list: done.report.queries.join(', ') }) }}</p>
        </div>
        <details v-if="done.report.media.missing.length || done.tooLarge.length" class="text-ink-soft">
          <summary class="cursor-pointer text-ink">{{ done.report.media.missing.length + done.tooLarge.length === 1 ? t('settings.import.filesNotImported.one') : t('settings.import.filesNotImported.other', { count: done.report.media.missing.length + done.tooLarge.length }) }}</summary>
          <p class="mt-1">{{ done.tooLarge.length ? t('settings.import.missingOrLargeReason') : t('settings.import.missingReason') }}</p>
          <ul class="mt-1 list-disc pl-5">
            <li v-for="path in [...done.report.media.missing, ...done.tooLarge]" :key="path">{{ path }}</li>
          </ul>
        </details>
        <details v-if="done.report.unresolvedLinks.length" class="text-ink-soft">
          <summary class="cursor-pointer text-ink">{{ done.report.unresolvedLinks.length === 1 ? t('settings.import.unresolvedLinks.one') : t('settings.import.unresolvedLinks.other', { count: done.report.unresolvedLinks.length }) }}</summary>
          <p class="mt-1">{{ t('settings.import.keptAsText') }}</p>
          <ul class="mt-1 list-disc pl-5">
            <li v-for="name in done.report.unresolvedLinks" :key="name">{{ name }}</li>
          </ul>
        </details>
        <details v-if="done.report.skipped.length || Object.keys(done.report.warnings).length" class="text-ink-soft">
          <summary class="cursor-pointer text-ink">{{ t('settings.import.leftOut') }}</summary>
          <ul class="mt-1 list-disc pl-5">
            <li v-for="path in done.report.skipped" :key="path">{{ path }}</li>
            <li v-for="(count, warning) in done.report.warnings" :key="warning">{{ warning }}: {{ count }}</li>
          </ul>
        </details>
        <p class="text-ink-faint">{{ t('settings.import.accentsHint') }}</p>
      </div>
    </div>
  </SettingsSection>
</template>
