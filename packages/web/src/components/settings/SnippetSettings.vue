<script setup lang="ts">
// The space's snippets (core's templates.ts): pieces of text inserted with / in the editor. Each
// has a name, an optional trigger word and where it applies: some types, types that have some
// properties, and a condition on the object's values. Their text is edited on their own page.
import { scopeAppliesSomewhere, type ObjectRecord, type PropertyDef, type SnippetScope } from '@vasta/core'
import { computed, onMounted, ref } from 'vue'
import { PROPERTY_KINDS } from '../../lib/properties.ts'
import { workspace } from '../../lib/state.ts'
import { deleteTemplate, loadTemplates, saveAsSnippet, saveSnippetInfo, snippets } from '../../lib/templates.ts'
import AppIcon from '../AppIcon.vue'
import SettingsSection from './SettingsSection.vue'
import { field, label, secondary } from './styles.ts'
import { openObject } from '../../lib/open.ts'

onMounted(() => void loadTemplates())
const list = computed(() => snippets.value)
const open = ref<string | null>(null)
const kinds = PROPERTY_KINDS.filter((k) => k.kind !== 'formula' && k.kind !== 'rich-text')
const types = computed(() => workspace.types.filter((t) => !t.deletedAt))

const infoOf = (snippet: ObjectRecord) => (snippet.template?.kind === 'snippet' ? snippet.template : undefined)
const scopeOf = (snippet: ObjectRecord): SnippetScope => structuredClone(infoOf(snippet)?.scope ?? {})

/** In words: "everywhere", "Tasks, Books", "types with Due"… */
function describe(snippet: ObjectRecord): string {
  const scope = infoOf(snippet)?.scope
  if (!scope || (!scope.typeIds?.length && !scope.requires?.length && !scope.when?.trim())) return 'Everywhere'
  const parts: string[] = []
  if (scope.typeIds?.length) parts.push(scope.typeIds.map((id) => workspace.types.find((t) => t.id === id)?.pluralName ?? '?').join(', '))
  if (scope.requires?.length) parts.push(`with ${scope.requires.map((r) => `${r.name}${r.set ? ' set' : ''}`).join(' and ')}`)
  if (scope.when?.trim()) parts.push(`when ${scope.when}`)
  return parts.join(' · ')
}

async function save(snippet: ObjectRecord, change: { trigger?: string; scope?: SnippetScope }) {
  const info = infoOf(snippet)
  if (!info) return
  const scope = change.scope ?? info.scope
  const clean: SnippetScope | undefined = scope && {
    ...(scope.typeIds?.length ? { typeIds: scope.typeIds } : {}),
    ...(scope.requires?.filter((r) => r.name.trim()).length ? { requires: scope.requires.filter((r) => r.name.trim()).map((r) => ({ ...r, name: r.name.trim() })) } : {}),
    ...(scope.when?.trim() ? { when: scope.when.trim() } : {}),
  }
  await saveSnippetInfo(snippet, { trigger: change.trigger ?? info.trigger ?? '', ...(clean && Object.keys(clean).length ? { scope: clean } : {}) })
}

function toggleType(snippet: ObjectRecord, typeId: string) {
  const scope = scopeOf(snippet)
  const ids = new Set(scope.typeIds ?? [])
  if (ids.has(typeId)) ids.delete(typeId)
  else ids.add(typeId)
  void save(snippet, { scope: { ...scope, typeIds: [...ids] } })
}

function addRequirement(snippet: ObjectRecord) {
  const scope = scopeOf(snippet)
  void save(snippet, { scope: { ...scope, requires: [...(scope.requires ?? []), { name: 'Due', kind: 'date' }] } })
}

function setRequirement(snippet: ObjectRecord, index: number, change: Partial<{ name: string; kind: PropertyDef['kind']; set: boolean }>) {
  const scope = scopeOf(snippet)
  const requires = [...(scope.requires ?? [])]
  requires[index] = { ...requires[index]!, ...change }
  if (change.set === false) delete requires[index]!.set
  void save(snippet, { scope: { ...scope, requires } })
}

function removeRequirement(snippet: ObjectRecord, index: number) {
  const scope = scopeOf(snippet)
  void save(snippet, { scope: { ...scope, requires: (scope.requires ?? []).filter((_, i) => i !== index) } })
}
</script>

<template>
  <SettingsSection id="snippets" title="Snippets" description="Pieces of text you insert with / in the editor: a signature, a stand-up, a checklist. They take the same placeholders as templates.">
    <template #actions>
      <button :class="secondary" class="ml-auto flex items-center gap-1.5" @click="saveAsSnippet([], true)"><AppIcon fallback="ph:plus" :size="14" /> New snippet</button>
    </template>
    <p v-if="!list.length" class="text-sm text-ink-faint">No snippets yet. Select some text and choose “Save as snippet”, or make one here.</p>
    <div v-else class="divide-y divide-line rounded-xl border border-line">
      <div v-for="snippet in list" :key="snippet.id" class="px-3 py-2">
        <div class="flex items-center gap-2">
          <AppIcon fallback="ph:brackets-curly" class="text-ink-faint" />
          <button class="min-w-0 truncate text-sm font-medium hover:underline" @click="openObject(snippet.id)">{{ snippet.template!.name }}</button>
          <span v-if="infoOf(snippet)?.trigger" class="font-mono text-xs text-ink-faint">/{{ infoOf(snippet)!.trigger }}</span>
          <span class="min-w-0 flex-1 truncate text-xs" :class="scopeAppliesSomewhere(infoOf(snippet)?.scope, workspace.types) ? 'text-ink-faint' : 'text-amber-600'">
            {{ scopeAppliesSomewhere(infoOf(snippet)?.scope, workspace.types) ? describe(snippet) : 'Applies nowhere' }}
          </span>
          <button class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink" :title="open === snippet.id ? 'Close' : 'Where it applies'" @click="open = open === snippet.id ? null : snippet.id">
            <AppIcon :fallback="open === snippet.id ? 'ph:caret-up' : 'ph:sliders-horizontal'" :size="15" />
          </button>
          <button class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-red-600" title="Delete" @click="deleteTemplate(snippet)"><AppIcon fallback="ph:trash" :size="15" /></button>
        </div>
        <div v-if="open === snippet.id" class="mt-3 space-y-4 pb-2 pl-6">
          <label :class="label" class="max-w-xs">
            Trigger
            <input :value="infoOf(snippet)?.trigger ?? ''" :class="field" placeholder="sig" @change="save(snippet, { trigger: ($event.target as HTMLInputElement).value })" />
            <span class="mt-1 block">Typing /{{ infoOf(snippet)?.trigger || 'sig' }} finds it first.</span>
          </label>
          <div>
            <div :class="label">Types (none: any type)</div>
            <div class="mt-1.5 flex flex-wrap gap-1.5">
              <button
                v-for="t in types"
                :key="t.id"
                class="rounded-md px-2 py-0.5 text-xs ring-1"
                :class="infoOf(snippet)?.scope?.typeIds?.includes(t.id) ? 'bg-ink text-surface ring-ink' : 'text-ink-soft ring-line hover:bg-hover'"
                @click="toggleType(snippet, t.id)"
              >
                {{ t.name }}
              </button>
            </div>
          </div>
          <div>
            <div :class="label">Properties the type has (all of them)</div>
            <div v-for="(r, i) in infoOf(snippet)?.scope?.requires ?? []" :key="i" class="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
              <input :value="r.name" class="w-36 rounded-lg border border-line bg-surface px-2 py-1 text-sm outline-none focus:border-line-strong" placeholder="Due" @change="setRequirement(snippet, i, { name: ($event.target as HTMLInputElement).value })" />
              <select :value="r.kind" class="rounded-lg border border-line bg-surface px-2 py-1 text-sm" @change="setRequirement(snippet, i, { kind: ($event.target as HTMLSelectElement).value as PropertyDef['kind'] })">
                <option v-for="k in kinds" :key="k.kind" :value="k.kind">{{ k.label }}</option>
              </select>
              <label class="flex items-center gap-1.5 text-xs text-ink-soft">
                <input type="checkbox" class="accent-[var(--color-accent)]" :checked="!!r.set" @change="setRequirement(snippet, i, { set: ($event.target as HTMLInputElement).checked })" /> with a value
              </label>
              <button class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink" title="Remove" @click="removeRequirement(snippet, i)"><AppIcon fallback="ph:x" :size="13" /></button>
            </div>
            <button class="mt-1.5 text-xs text-ink-soft hover:underline" @click="addRequirement(snippet)">+ Add a property</button>
          </div>
          <label :class="label">
            Only when (a formula on the object’s values)
            <input :value="infoOf(snippet)?.scope?.when ?? ''" :class="field" class="font-mono" placeholder='prop("Status") != "Done"' @change="save(snippet, { scope: { ...scopeOf(snippet), when: ($event.target as HTMLInputElement).value } })" />
          </label>
        </div>
      </div>
    </div>
  </SettingsSection>
</template>
