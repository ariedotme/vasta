<script setup lang="ts">
// A type's templates in its settings: open one to edit it, make one the default, delete, add; and
// the snippets that apply to the type (made in Settings › Snippets).
import { scopeHolds, type ObjectRecord, type ObjectType } from '@vasta/core'
import { computed, onMounted } from 'vue'
import { dayKey } from '../lib/actions.ts'
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
const isDefault = (t: ObjectRecord) => t.template?.kind === 'template' && !!t.template.default

async function create() {
  emit('leave', '')
  await newTemplate(props.type)
}
const open = (t: ObjectRecord) => emit('leave', objectPath(t.id))
</script>

<template>
  <section class="mt-6" data-type-templates>
    <div class="mb-2 flex items-baseline gap-2">
      <h3 class="text-sm font-semibold">Templates</h3>
      <span class="text-xs text-ink-faint">New {{ type.pluralName.toLowerCase() }} can start from one; the default is used by New and typed lines.</span>
    </div>
    <div v-if="list.length" class="divide-y divide-line rounded-xl border border-line">
      <div v-for="t in list" :key="t.id" class="flex items-center gap-2 px-3 py-1.5">
        <button class="rounded-md p-1 hover:bg-hover" :class="isDefault(t) ? 'text-amber-500' : 'text-ink-faint hover:text-ink'" :title="isDefault(t) ? 'The default (click to unset)' : 'Make it the default'" @click="setDefaultTemplate(t, !isDefault(t))">
          <AppIcon :fallback="isDefault(t) ? 'ph:star-fill' : 'ph:star'" :size="15" />
        </button>
        <button class="min-w-0 flex-1 truncate text-left text-sm hover:underline" @click="open(t)">{{ t.template!.name }}</button>
        <span v-if="isDefault(t)" class="text-xs text-ink-faint">Default</span>
        <button class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-red-600" title="Delete" @click="deleteTemplate(t)">
          <AppIcon fallback="ph:trash" :size="15" />
        </button>
      </div>
    </div>
    <button class="mt-2 flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-hover" @click="create">
      <AppIcon fallback="ph:plus" :size="14" /> New template
    </button>
    <p class="mt-2 text-xs text-ink-faint">Or open any {{ type.name.toLowerCase() }} and choose “Save as template…” in its ⋯ menu.</p>
    <div v-if="forType.length" class="mt-3 text-xs text-ink-faint">
      Snippets for this type:
      <template v-for="(s, i) in forType" :key="s.id">
        <span v-if="i">, </span><button class="text-ink-soft hover:underline" @click="open(s)">{{ s.template!.name }}</button>
      </template>
      · <button class="text-ink-soft hover:underline" @click="emit('leave', '/settings#snippets')">Manage snippets</button>
    </div>
  </section>
</template>
