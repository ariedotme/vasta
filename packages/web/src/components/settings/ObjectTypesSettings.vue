<script setup lang="ts">
// Settings › Object types: central grid of custom and built-in types for this space.
// Click any card to edit it in TypeSettings, or create a new type (blank or from a template).
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { ObjectType } from '@vasta/core'
import { deleteTypeFlow } from '../../lib/actions.ts'
import { t, tc, typeName } from '../../lib/i18n.ts'
import { notice, workspace } from '../../lib/state.ts'
import AppIcon from '../AppIcon.vue'
import NewTypeDialog from '../NewTypeDialog.vue'
import TypeIcon from '../TypeIcon.vue'
import TypeSettings from '../TypeSettings.vue'
import SettingsSection from './SettingsSection.vue'
import { primary } from './styles.ts'

const router = useRouter()

const activeTypes = computed(() => workspace.types.filter((item) => !item.deletedAt))
const customTypes = computed(() => activeTypes.value.filter((item) => !item.system).sort((a, b) => typeName(a).localeCompare(typeName(b))))
const builtinTypes = computed(() => activeTypes.value.filter((item) => !!item.system).sort((a, b) => typeName(a).localeCompare(typeName(b))))

const editingId = ref<string | null>(null)
const editingType = computed(() => (editingId.value ? workspace.types.find((item) => item.id === editingId.value) ?? null : null))
const createOpen = ref(false)

function openTypePage(type: ObjectType) {
  void router.push(`/t/${type.id}`)
}

async function onDelete(type: ObjectType) {
  await deleteTypeFlow(type)
}

function onCreated(payload: { type: ObjectType; createdCount: number; fromTemplate: boolean }) {
  createOpen.value = false
  if (!payload.fromTemplate) {
    // Blank custom type: open TypeSettings right here so properties can be added immediately.
    editingId.value = payload.type.id
    return
  }
  notice.value = {
    message:
      payload.createdCount > 1
        ? tc(payload.createdCount, 'newType.importedToast.one', 'newType.importedToast.other', { name: typeName(payload.type) })
        : t('newType.importedSingleToast', { name: typeName(payload.type) }),
    action: { label: t('common.open'), run: () => router.push(`/t/${payload.type.id}`) },
  }
}
</script>

<template>
  <SettingsSection id="object-types" :title="t('settings.section.objectTypes')" :description="t('settings.objectTypes.description')">
    <template #actions>
      <button :class="primary" class="ml-auto inline-flex items-center gap-1.5" @click="createOpen = true">
        <AppIcon fallback="ph:plus" :size="14" />
        {{ t('nav.newType') }}
      </button>
    </template>

    <div class="space-y-6">
      <!-- Custom types -->
      <div>
        <h3 class="mb-2.5 text-xs font-medium text-ink-faint">{{ t('settings.objectTypes.customHeading') }}</h3>
        <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4">
          <div
            v-for="item in customTypes"
            :key="item.id"
            role="button"
            tabindex="0"
            class="group relative flex cursor-pointer flex-col items-center rounded-xl border border-line bg-surface px-3 py-4 text-center transition-colors hover:border-line-strong hover:bg-hover/40"
            @click="editingId = item.id"
            @keydown.enter="editingId = item.id"
          >
            <div class="absolute right-1.5 top-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
              <button
                type="button"
                class="rounded p-1 text-ink-faint hover:bg-hover hover:text-ink"
                :title="t('common.open')"
                @click.stop="openTypePage(item)"
              >
                <AppIcon fallback="ph:arrow-up-right" :size="13" />
              </button>
              <button
                type="button"
                class="rounded p-1 text-ink-faint hover:bg-hover hover:text-red-600"
                :title="t('common.delete')"
                @click.stop="onDelete(item)"
              >
                <AppIcon fallback="ph:trash" :size="13" />
              </button>
            </div>
            <TypeIcon :icon="item.icon" :color="item.color" :size="24" />
            <div class="mt-2 w-full truncate text-sm font-medium text-ink">{{ typeName(item) }}</div>
            <div class="mt-0.5 text-xs tabular-nums text-ink-faint">{{ workspace.counts[item.id] ?? 0 }}</div>
          </div>

          <button
            type="button"
            class="flex flex-col items-center justify-center rounded-xl border border-dashed border-line px-3 py-4 text-center text-ink-soft transition-colors hover:border-line-strong hover:bg-hover/40 hover:text-ink"
            @click="createOpen = true"
          >
            <AppIcon fallback="ph:plus" :size="22" class="text-ink-faint" />
            <span class="mt-1.5 text-sm font-medium">{{ t('common.create') }}</span>
          </button>
        </div>
      </div>

      <!-- Built-in types -->
      <div class="border-t border-line pt-5">
        <h3 class="mb-2.5 text-xs font-medium text-ink-faint">{{ t('settings.objectTypes.builtinHeading') }}</h3>
        <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4">
          <div
            v-for="item in builtinTypes"
            :key="item.id"
            role="button"
            tabindex="0"
            class="group relative flex cursor-pointer flex-col items-center rounded-xl border border-line bg-surface px-3 py-4 text-center transition-colors hover:border-line-strong hover:bg-hover/40"
            @click="editingId = item.id"
            @keydown.enter="editingId = item.id"
          >
            <button
              type="button"
              class="absolute right-1.5 top-1.5 rounded p-1 text-ink-faint opacity-0 transition-opacity hover:bg-hover hover:text-ink group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              :title="t('common.open')"
              @click.stop="openTypePage(item)"
            >
              <AppIcon fallback="ph:arrow-up-right" :size="13" />
            </button>
            <TypeIcon :icon="item.icon" :color="item.color" :size="24" />
            <div class="mt-2 w-full truncate text-sm font-medium text-ink">{{ typeName(item) }}</div>
            <div class="mt-0.5 text-xs tabular-nums text-ink-faint">{{ workspace.counts[item.id] ?? 0 }}</div>
          </div>
        </div>
      </div>
    </div>

    <TypeSettings v-if="editingType" :key="editingType.id" :type="editingType" @close="editingId = null" />
    <NewTypeDialog v-if="createOpen" @close="createOpen = false" @created="onCreated" />
  </SettingsSection>
</template>
