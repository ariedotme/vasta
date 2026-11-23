<script setup lang="ts">
// Create a new object type: "Create your own" sits front and center at the top, followed by
// a growing catalog of ready-made templates. Templates with relation properties pointing to
// other templates let you import the referenced type too (chaining recursively), link an
// existing type in the space, or ignore the property.
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import type { ColorName, Icon, Id, ObjectType } from '@vasta/core'
import { api } from '../lib/api.ts'
import { chip, colorNames, swatchClasses } from '../lib/colors.ts'
import { t, tc, typeName } from '../lib/i18n.ts'
import { kindIcon } from '../lib/properties.ts'
import { refreshCounts, replaceType, workspace } from '../lib/state.ts'
import {
  CATALOG_CATEGORIES,
  buildTemplateProperties,
  defaultRelationDecision,
  findMatchingExistingType,
  listedCatalogTemplates,
  relationDecisionKey,
  resolveImportChain,
  templateByKey,
  type CatalogPropertyDef,
  type RelationDecision,
  type TypeTemplate,
} from '../lib/type-catalog.ts'
import AppIcon from './AppIcon.vue'
import ColorPicker from './ColorPicker.vue'
import IconPicker from './IconPicker.vue'
import ModalDialog from './ModalDialog.vue'
import PopoverMenu from './PopoverMenu.vue'
import TypeIcon from './TypeIcon.vue'

const emit = defineEmits<{
  close: []
  created: [payload: { type: ObjectType; createdCount: number; fromTemplate: boolean }]
}>()

// ---------------------------------------------------------------------------
// 1. Create your own (primary path)

const customName = ref('')
const customIcon = ref<Icon>({ kind: 'icon', value: 'ph:cube' })
const customColor = ref<ColorName>(colorNames[Math.floor(Math.random() * colorNames.length)] ?? 'blue')
const nameInput = ref<HTMLInputElement | null>(null)
const iconAnchor = ref<HTMLElement | null>(null)
const iconOpen = ref(false)
const colorAnchor = ref<HTMLElement | null>(null)
const colorOpen = ref(false)
const busy = ref(false)
const error = ref('')

onMounted(() => {
  void nextTick(() => nameInput.value?.focus())
})

async function createCustom() {
  const name = customName.value.trim()
  if (!name || !workspace.space || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const created = await api.createType({
      spaceId: workspace.space.id,
      name,
      pluralName: name,
      icon: customIcon.value,
    })
    const saved = await api.saveType({ ...created, color: customColor.value })
    replaceType(saved)
    void refreshCounts()
    emit('created', { type: saved, createdCount: 1, fromTemplate: false })
  } catch (failure) {
    error.value = (failure as Error).message
  } finally {
    busy.value = false
  }
}

// ---------------------------------------------------------------------------
// 2. Catalog & chained template import

const existingTypes = computed(() => workspace.types.filter((item) => !item.deletedAt).sort((a, b) => typeName(a).localeCompare(typeName(b))))
const visibleTemplates = computed(() => listedCatalogTemplates())

const groupedTemplates = computed(() =>
  CATALOG_CATEGORIES.map((category) => ({
    category,
    templates: visibleTemplates.value.filter((tpl) => tpl.category === category.id),
  })).filter((group) => group.templates.length > 0)
)

const selectedTemplateKey = ref<string | null>(null)
const selectedTemplate = computed(() => (selectedTemplateKey.value ? templateByKey(selectedTemplateKey.value) : undefined))
const decisions = reactive<Record<string, RelationDecision>>({})

function pickTemplate(tpl: TypeTemplate) {
  error.value = ''
  for (const key of Object.keys(decisions)) delete decisions[key]
  selectedTemplateKey.value = tpl.key
}

function backToCatalog() {
  error.value = ''
  selectedTemplateKey.value = null
  void nextTick(() => nameInput.value?.focus())
}

const importChain = computed(() =>
  selectedTemplateKey.value ? resolveImportChain(selectedTemplateKey.value, decisions, existingTypes.value) : []
)

const importedKeys = computed(() => new Set(importChain.value.map((node) => node.template.key)))

function decisionFor(templateKey: string, prop: Extract<CatalogPropertyDef, { kind: 'relation' }>): RelationDecision {
  const key = relationDecisionKey(templateKey, prop.id)
  if (decisions[key]) return decisions[key]!
  const target = prop.targetTemplateKey ? templateByKey(prop.targetTemplateKey) : undefined
  if (!target) return { mode: 'ignore' }
  return defaultRelationDecision(target, existingTypes.value)
}

function setDecision(templateKey: string, propId: string, next: RelationDecision) {
  decisions[relationDecisionKey(templateKey, propId)] = next
}

function pickExistingMode(templateKey: string, prop: Extract<CatalogPropertyDef, { kind: 'relation' }>) {
  const target = prop.targetTemplateKey ? templateByKey(prop.targetTemplateKey) : undefined
  const matched = target ? findMatchingExistingType(target, existingTypes.value) : undefined
  const fallbackId = matched?.id ?? existingTypes.value[0]?.id
  if (!fallbackId) return
  setDecision(templateKey, prop.id, { mode: 'existing', typeId: fallbackId })
}

function isTargetAlreadyEarlier(nodeIndex: number, targetKey: string): boolean {
  for (let i = 0; i < nodeIndex; i++) {
    if (importChain.value[i]?.template.key === targetKey) return true
  }
  return false
}

function parentLabel(requiredBy: { templateKey: string; propertyId: string }): string {
  const parent = templateByKey(requiredBy.templateKey)
  if (!parent) return ''
  const prop = parent.properties.find((p) => p.id === requiredBy.propertyId)
  return prop ? `${t(parent.nameKey)} · ${t(prop.nameKey)}` : t(parent.nameKey)
}

async function importSelectedTemplate() {
  if (!workspace.space || !importChain.value.length || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const chain = importChain.value
    // Pass 1: create every type in the chain so all IDs exist (supports cyclic relations too).
    const createdByKey = new Map<string, ObjectType>()
    const createdIdsByKey = new Map<string, Id>()
    for (const node of chain) {
      const created = await api.createType({
        spaceId: workspace.space.id,
        name: t(node.template.nameKey),
        pluralName: t(node.template.pluralNameKey),
        icon: node.template.icon,
      })
      createdByKey.set(node.template.key, created)
      createdIdsByKey.set(node.template.key, created.id)
    }

    // Pass 2: save color, description and all resolved properties for each created type.
    const savedList: ObjectType[] = []
    for (const node of chain) {
      const base = createdByKey.get(node.template.key)!
      const properties = buildTemplateProperties(
        node.template,
        base.properties,
        decisions,
        createdIdsByKey,
        existingTypes.value
      )
      const saved = await api.saveType({
        ...base,
        color: node.template.color,
        description: t(node.template.descriptionKey),
        properties,
      })
      replaceType(saved)
      savedList.push(saved)
    }

    void refreshCounts()
    emit('created', { type: savedList[0]!, createdCount: savedList.length, fromTemplate: true })
  } catch (failure) {
    error.value = (failure as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <ModalDialog :title="selectedTemplate ? t('newType.templateTitle', { name: t(selectedTemplate.nameKey) }) : t('newType.title')" width="42rem" @close="emit('close')">
    <!-- Step 1: Create your own (prominent) + Template catalog below -->
    <div v-if="!selectedTemplate" class="space-y-6">
      <section class="rounded-xl border border-line bg-raised p-4">
        <div class="mb-3">
          <h3 class="text-sm font-semibold text-ink">{{ t('newType.createOwnTitle') }}</h3>
          <p class="mt-0.5 text-xs text-ink-soft">{{ t('newType.createOwnDescription') }}</p>
        </div>
        <form class="flex flex-wrap items-center gap-2" @submit.prevent="createCustom">
          <button
            ref="iconAnchor"
            type="button"
            class="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-surface hover:bg-hover"
            :title="t('object.changeIcon')"
            @click="iconOpen = !iconOpen"
          >
            <TypeIcon :icon="customIcon" :color="customColor" :size="18" />
          </button>
          <PopoverMenu v-model:open="iconOpen" :anchor="iconAnchor" width="auto">
            <div class="p-2">
              <IconPicker :icon="customIcon" @pick="(icon) => { if (icon) customIcon = icon; iconOpen = false }" />
            </div>
          </PopoverMenu>

          <button
            ref="colorAnchor"
            type="button"
            class="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line bg-surface hover:bg-hover"
            :title="t('object.color')"
            @click="colorOpen = !colorOpen"
          >
            <span class="h-4 w-4 rounded-full" :class="swatchClasses[customColor]" />
          </button>
          <PopoverMenu v-model:open="colorOpen" :anchor="colorAnchor" width="auto">
            <div class="p-2">
              <ColorPicker :color="customColor" @pick="(c) => { customColor = c; colorOpen = false }" />
            </div>
          </PopoverMenu>

          <input
            ref="nameInput"
            v-model="customName"
            type="text"
            :disabled="busy"
            :placeholder="t('actions.newTypePlaceholder')"
            class="h-9 min-w-[10rem] flex-1 rounded-lg border border-line bg-surface px-3 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent"
          />
          <button
            type="submit"
            class="h-9 rounded-lg bg-ink px-4 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-40"
            :disabled="!customName.trim() || busy"
          >
            {{ busy ? t('object.saving') : t('common.create') }}
          </button>
        </form>
        <p v-if="error" class="mt-2 text-xs text-red-600">{{ error }}</p>
      </section>

      <!-- Template catalog -->
      <section v-if="groupedTemplates.length" class="space-y-4">
        <div class="flex items-baseline justify-between gap-2">
          <div>
            <h3 class="text-sm font-semibold text-ink">{{ t('newType.catalogTitle') }}</h3>
            <p class="mt-0.5 text-xs text-ink-soft">{{ t('newType.catalogDescription') }}</p>
          </div>
        </div>

        <div v-for="group in groupedTemplates" :key="group.category.id" class="space-y-2">
          <h4 class="text-xs font-medium text-ink-faint">{{ t(group.category.labelKey) }}</h4>
          <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3">
            <button
              v-for="tpl in group.templates"
              :key="tpl.key"
              type="button"
              class="group flex flex-col items-start rounded-xl border border-line bg-surface p-3.5 text-left transition-colors hover:border-line-strong hover:bg-hover/40"
              @click="pickTemplate(tpl)"
            >
              <div class="flex w-full items-start justify-between gap-2">
                <TypeIcon :icon="tpl.icon" :color="tpl.color" :size="22" />
                <span
                  v-if="findMatchingExistingType(tpl, existingTypes)"
                  class="rounded-md bg-hover px-1.5 py-0.5 text-[11px] text-ink-faint"
                >
                  {{ t('newType.alreadyInSpace') }}
                </span>
              </div>
              <div class="mt-2.5 text-sm font-semibold text-ink">{{ t(tpl.pluralNameKey) }}</div>
              <p class="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-soft">{{ t(tpl.descriptionKey) }}</p>
              <div class="mt-2.5 text-[11px] text-ink-faint">
                {{ tc(tpl.properties.length, 'newType.propertiesCount.one', 'newType.propertiesCount.other') }}
              </div>
            </button>
          </div>
        </div>
      </section>
    </div>

    <!-- Step 2: Template details & chained dependency resolution -->
    <div v-else class="space-y-4">
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-soft hover:bg-hover hover:text-ink"
        @click="backToCatalog"
      >
        <AppIcon fallback="ph:arrow-left" :size="13" />
        {{ t('newType.backToCatalog') }}
      </button>

      <div class="space-y-3">
        <div
          v-for="(node, nodeIndex) in importChain"
          :key="node.template.key"
          class="rounded-xl border border-line bg-surface p-4"
          :class="node.depth > 0 ? 'ml-4 border-l-2 border-l-accent/50 bg-raised/50' : ''"
        >
          <div class="flex items-start gap-3">
            <TypeIcon :icon="node.template.icon" :color="node.template.color" :size="24" />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="text-sm font-semibold text-ink">{{ t(node.template.nameKey) }}</h3>
                <span v-if="node.requiredBy" class="rounded-md bg-hover px-1.5 py-0.5 text-[11px] text-ink-soft">
                  {{ t('newType.chainedFrom', { source: parentLabel(node.requiredBy) }) }}
                </span>
              </div>
              <p class="mt-0.5 text-xs text-ink-soft">{{ t(node.template.descriptionKey) }}</p>
            </div>
          </div>

          <div class="mt-3 divide-y divide-line rounded-lg border border-line bg-surface">
            <div v-for="prop in node.template.properties" :key="prop.id" class="px-3 py-2 text-xs">
              <!-- Relation pointing to another catalog template -->
              <template v-if="prop.kind === 'relation' && prop.targetTemplateKey && templateByKey(prop.targetTemplateKey)">
                <div class="flex flex-wrap items-center gap-2">
                  <AppIcon :fallback="kindIcon('relation')" :size="14" class="shrink-0 text-ink-faint" />
                  <span class="font-medium text-ink">{{ t(prop.nameKey) }}</span>
                  <AppIcon fallback="ph:arrow-right" :size="11" class="text-ink-faint" />
                  <span
                    class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium"
                    :class="chip(templateByKey(prop.targetTemplateKey)!.color)"
                  >
                    <AppIcon :icon="templateByKey(prop.targetTemplateKey)!.icon" fallback="ph:cube" :size="11" />
                    {{ t(templateByKey(prop.targetTemplateKey)!.nameKey) }}
                  </span>
                </div>

                <!-- Target already being imported earlier in the chain (cycle / diamond) -->
                <div v-if="isTargetAlreadyEarlier(nodeIndex, prop.targetTemplateKey)" class="mt-2 flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    class="rounded-md border px-2 py-1 text-xs transition-colors"
                    :class="decisionFor(node.template.key, prop).mode !== 'ignore' ? 'border-accent bg-accent/10 font-medium text-ink' : 'border-line text-ink-soft hover:bg-hover'"
                    @click="setDecision(node.template.key, prop.id, { mode: 'import' })"
                  >
                    {{ t('newType.linkImporting', { type: t(templateByKey(prop.targetTemplateKey)!.nameKey) }) }}
                  </button>
                  <button
                    type="button"
                    class="rounded-md border px-2 py-1 text-xs transition-colors"
                    :class="decisionFor(node.template.key, prop).mode === 'ignore' ? 'border-accent bg-accent/10 font-medium text-ink' : 'border-line text-ink-soft hover:bg-hover'"
                    @click="setDecision(node.template.key, prop.id, { mode: 'ignore' })"
                  >
                    {{ t('newType.ignoreProperty') }}
                  </button>
                </div>

                <!-- Normal dependency choice: import too / use existing / ignore -->
                <div v-else class="mt-2 flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    class="rounded-md border px-2 py-1 text-xs transition-colors"
                    :class="decisionFor(node.template.key, prop).mode === 'import' ? 'border-accent bg-accent/10 font-medium text-ink' : 'border-line text-ink-soft hover:bg-hover'"
                    @click="setDecision(node.template.key, prop.id, { mode: 'import' })"
                  >
                    {{
                      importedKeys.has(prop.targetTemplateKey) && decisionFor(node.template.key, prop).mode !== 'import'
                        ? t('newType.linkImporting', { type: t(templateByKey(prop.targetTemplateKey)!.nameKey) })
                        : t('newType.importToo', { type: t(templateByKey(prop.targetTemplateKey)!.nameKey) })
                    }}
                  </button>

                  <button
                    v-if="existingTypes.length"
                    type="button"
                    class="rounded-md border px-2 py-1 text-xs transition-colors"
                    :class="decisionFor(node.template.key, prop).mode === 'existing' ? 'border-accent bg-accent/10 font-medium text-ink' : 'border-line text-ink-soft hover:bg-hover'"
                    @click="pickExistingMode(node.template.key, prop)"
                  >
                    {{ t('newType.useExisting') }}
                  </button>

                  <select
                    v-if="decisionFor(node.template.key, prop).mode === 'existing'"
                    :value="(decisionFor(node.template.key, prop) as { mode: 'existing'; typeId: Id }).typeId"
                    class="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink outline-none focus:border-accent"
                    @change="setDecision(node.template.key, prop.id, { mode: 'existing', typeId: ($event.target as HTMLSelectElement).value })"
                  >
                    <option v-for="existing in existingTypes" :key="existing.id" :value="existing.id">{{ typeName(existing) }}</option>
                  </select>

                  <button
                    type="button"
                    class="rounded-md border px-2 py-1 text-xs transition-colors"
                    :class="decisionFor(node.template.key, prop).mode === 'ignore' ? 'border-accent bg-accent/10 font-medium text-ink' : 'border-line text-ink-soft hover:bg-hover'"
                    @click="setDecision(node.template.key, prop.id, { mode: 'ignore' })"
                  >
                    {{ t('newType.ignoreProperty') }}
                  </button>
                </div>
              </template>

              <!-- Standard property -->
              <div v-else class="flex flex-wrap items-center gap-2">
                <AppIcon :fallback="kindIcon(prop.kind)" :size="14" class="shrink-0 text-ink-faint" />
                <span class="font-medium text-ink">{{ t(prop.nameKey) }}</span>
                <div v-if="prop.kind === 'select'" class="flex flex-wrap gap-1">
                  <span
                    v-for="(opt, idx) in prop.options"
                    :key="idx"
                    class="rounded px-1.5 py-0.5 text-[11px]"
                    :class="chip(opt.color)"
                  >
                    {{ t(opt.labelKey) }}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <template v-if="selectedTemplate" #footer>
      <span v-if="error" class="text-sm text-red-600">{{ error }}</span>
      <button type="button" class="ml-auto rounded-lg px-3 py-1.5 text-sm text-ink-soft hover:bg-hover hover:text-ink" @click="backToCatalog">
        {{ t('common.cancel') }}
      </button>
      <button
        type="button"
        class="rounded-lg bg-ink px-3.5 py-1.5 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-40"
        :disabled="busy"
        @click="importSelectedTemplate"
      >
        {{
          busy
            ? t('object.saving')
            : importChain.length === 1
              ? t('newType.createSingle', { name: t(selectedTemplate.nameKey) })
              : t('newType.createMultiple', { count: importChain.length })
        }}
      </button>
    </template>
  </ModalDialog>
</template>
