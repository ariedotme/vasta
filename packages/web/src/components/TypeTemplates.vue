<script setup lang="ts">
// A type's templates in its settings: open one to edit it, make one the default, delete, add; and
// the snippets that apply to the type (made in Settings › Snippets).
import { scopeHolds, type ObjectRecord, type ObjectType } from '@vasta/core'
import { computed, onMounted } from 'vue'
import { dayKey } from '../lib/actions.ts'
import { t, typeName, typePluralName } from '../lib/i18n.ts'
import { typesById } from '../lib/state.ts'
import { deleteTemplate, loadTemplates, newTemplate, setDefaultTemplate, snippets, templatesOf } from '../lib/templates.ts'
import AppIcon from './AppIcon.vue'
import { objectPath } from '../lib/open.ts'

const props = defineProps<{ type: ObjectType }>()
/** Before leaving for a template's page (the settings may have unsaved changes). */
const emit = defineEmits<{ leave: [path: string] }>()

onMounted(() => void loadTemplates())
const list = computed(() => templatesOf(props.type.id))
const forType = computed(() =>
  snippets.value.filter((s) => s.template?.kind === 'snippet' && scopeHolds(s.template.scope && { ...s.template.scope, when: '' }, undefined, props.type, { today: dayKey(), timeZone: 'UTC', types: typesById.value }))
)
const isDefault = (tpl: ObjectRecord) => tpl.template?.kind === 'template' && !!tpl.template.default

async function create() {
  emit('leave', '')
  await newTemplate(props.type)
}
const open = (tpl: ObjectRecord) => emit('leave', objectPath(tpl.id))
</script>

<template>
  <section class="mt-6" data-type-templates>
    <div class="mb-2 flex items-baseline gap-2">
      <h3 class="text-sm font-semibold">{{ t('views.templates') }}</h3>
      <span class="text-xs text-ink-faint">{{ t('typeSettings.templatesHint', { plural: typePluralName(type).toLowerCase() }) }}</span>
    </div>
    <div v-if="list.length" class="divide-y divide-line rounded-xl border border-line">
      <div v-for="tpl in list" :key="tpl.id" class="flex items-center gap-2 px-3 py-1.5">
        <button class="rounded-md p-1 hover:bg-hover" :class="isDefault(tpl) ? 'text-amber-500' : 'text-ink-faint hover:text-ink'" :title="isDefault(tpl) ? t('typeSettings.defaultUnsetTitle') : t('typeSettings.makeDefaultTitle')" @click="setDefaultTemplate(tpl, !isDefault(tpl))">
          <AppIcon :fallback="isDefault(tpl) ? 'ph:star-fill' : 'ph:star'" :size="15" />
        </button>
        <button class="min-w-0 flex-1 truncate text-left text-sm hover:underline" @click="open(tpl)">{{ tpl.template!.name }}</button>
        <span v-if="isDefault(tpl)" class="text-xs text-ink-faint">{{ t('common.default') }}</span>
        <button class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-red-600" :title="t('common.delete')" @click="deleteTemplate(tpl)">
          <AppIcon fallback="ph:trash" :size="15" />
        </button>
      </div>
    </div>
    <button class="mt-2 flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-hover" @click="create">
      <AppIcon fallback="ph:plus" :size="14" /> {{ t('typeSettings.newTemplate') }}
    </button>
    <p class="mt-2 text-xs text-ink-faint">{{ t('typeSettings.saveAsTemplateHint', { type: typeName(type).toLowerCase() }) }}</p>
    <div v-if="forType.length" class="mt-3 text-xs text-ink-faint">
      {{ t('typeSettings.snippetsForType') }}
      <template v-for="(s, i) in forType" :key="s.id">
        <span v-if="i">, </span><button class="text-ink-soft hover:underline" @click="open(s)">{{ s.template!.name }}</button>
      </template>
      · <button class="text-ink-soft hover:underline" @click="emit('leave', '/settings#snippets')">{{ t('typeSettings.manageSnippets') }}</button>
    </div>
  </section>
</template>
