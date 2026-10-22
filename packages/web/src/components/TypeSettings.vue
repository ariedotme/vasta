<script setup lang="ts">
// Edit a type: identity (name, icon, color, description) and its property definitions.
// Changes are made on a draft and saved together.
import { computed, reactive, ref } from 'vue'
import type { ColorName, FormulaPropertyDef, Icon, ObjectType, PropertyDef, SelectOption } from '@vasta/core'
import { FORMULA_BUILTIN_FIELDS, FORMULA_FUNCTIONS, checkFormula, formulaFromNames, formulaKind, formulaToNames, formulaUses } from '@vasta/core'
import { api } from '../lib/api.ts'
import { clone } from '../lib/clone.ts'
import { chip, colorNames, iconTextClasses, swatchClasses } from '../lib/colors.ts'
import { PROPERTY_KINDS, kindIcon, kindLabel, newPropertyDef } from '../lib/properties.ts'
import { confirmDialog } from '../lib/overlays.ts'
import { replaceType, workspace } from '../lib/state.ts'
import AppIcon from './AppIcon.vue'
import ColorPicker from './ColorPicker.vue'
import IconPicker from './IconPicker.vue'
import ModalDialog from './ModalDialog.vue'
import PopoverMenu from './PopoverMenu.vue'

const props = defineProps<{ type: ObjectType }>()
const emit = defineEmits<{ close: [] }>()

const draft = ref<ObjectType>(clone(props.type))
const original = JSON.stringify(props.type)
const dirty = computed(() => JSON.stringify(draft.value) !== original)
const saving = ref(false)
const error = ref('')
const expanded = ref<string | null>(null)

const iconAnchor = ref<HTMLElement | null>(null)
const iconOpen = ref(false)
function setIcon(icon: Icon | undefined) {
  if (icon) draft.value.icon = icon
  else delete draft.value.icon
  iconOpen.value = false
}

function setColor(color: ColorName) {
  draft.value.color = color
}

// Properties ---------------------------------------------------------------

const richTextCount = computed(() => draft.value.properties.filter((p) => p.kind === 'rich-text').length)

function move(index: number, delta: number) {
  const list = draft.value.properties
  const target = index + delta
  if (target < 0 || target >= list.length) return
  ;[list[index], list[target]] = [list[target]!, list[index]!]
}

async function remove(def: PropertyDef) {
  if (def.kind === 'rich-text' && richTextCount.value <= 1) return
  const users = draft.value.properties.filter((p) => p.kind === 'formula' && p.id !== def.id && formulaUses(p.expression, def.id)).map((p) => `“${p.name}”`)
  const ok = await confirmDialog({
    title: `Delete the property “${def.name}”?`,
    message: `Values already filled in stay stored but are no longer shown.${users.length ? ` The formula${users.length > 1 ? 's' : ''} ${users.join(', ')} use${users.length > 1 ? '' : 's'} it and will show an error.` : ''}`,
    confirmLabel: 'Delete property',
    danger: true,
  })
  if (!ok) return
  draft.value.properties = draft.value.properties.filter((p) => p.id !== def.id)
}

const newName = ref('')
const newKind = ref<PropertyDef['kind']>('text')
function addProperty() {
  const name = newName.value.trim()
  if (!name) return
  const def = newPropertyDef(name, newKind.value)
  draft.value.properties.push(def)
  expanded.value = def.kind === 'select' || def.kind === 'relation' || def.kind === 'formula' ? def.id : null
  newName.value = ''
}

function addOption(def: PropertyDef, label: string) {
  if (def.kind !== 'select' || !label.trim()) return
  const option: SelectOption = { id: crypto.randomUUID(), label: label.trim(), color: colorNames[(def.options.length * 5) % colorNames.length] }
  def.options.push(option)
}

function moveOption(def: PropertyDef, index: number, delta: number) {
  if (def.kind !== 'select') return
  const target = index + delta
  if (target < 0 || target >= def.options.length) return
  ;[def.options[index], def.options[target]] = [def.options[target]!, def.options[index]!]
}

/** Relation properties shown in "Specific types" mode; the rest accept any type. */
const specific = reactive(new Set(draft.value.properties.filter((p) => p.kind === 'relation' && p.targetTypeIds.length).map((p) => p.id)))

function setAnyType(def: PropertyDef) {
  if (def.kind !== 'relation') return
  specific.delete(def.id)
  def.targetTypeIds = []
}

function toggleTarget(def: PropertyDef, typeId: string) {
  if (def.kind !== 'relation') return
  def.targetTypeIds = def.targetTypeIds.includes(typeId) ? def.targetTypeIds.filter((t) => t !== typeId) : [...def.targetTypeIds, typeId]
}

const colorFor = ref<{ option: SelectOption; anchor: HTMLElement } | null>(null)
const colorOpen = computed({ get: () => !!colorFor.value, set: (v) => !v && (colorFor.value = null) })

// Formulas ------------------------------------------------------------------
// Edited with field names ({Price}), kept on the draft with ids so renames don't break them.

/** The space's types with this one as edited so far, to read names in formulas against. */
const allTypes = computed(() => [...workspace.types.filter((t) => t.id !== draft.value.id), draft.value])
const formulaTexts = reactive(new Map<string, string>())
const formulaText = (def: FormulaPropertyDef) => formulaTexts.get(def.id) ?? formulaToNames(def.expression, draft.value, allTypes.value)

function setFormula(def: FormulaPropertyDef, text: string) {
  formulaTexts.set(def.id, text)
  def.expression = formulaFromNames(text, draft.value, allTypes.value)
}

const formulaProblem = (def: FormulaPropertyDef) => (def.expression.trim() ? checkFormula(def.expression, draft.value, allTypes.value) : undefined)

const KIND_NAMES = { number: 'a number', text: 'text', checkbox: 'true or false', date: 'a date', list: 'a list' }
const formulaGives = (def: FormulaPropertyDef) => {
  const kind = formulaKind(def, allTypes.value)
  return kind ? KIND_NAMES[kind] : undefined
}

/** Fields a formula can insert: the other properties, then the built-in fields. */
const formulaFields = (def: FormulaPropertyDef) => [
  ...draft.value.properties.filter((p) => p.id !== def.id && p.kind !== 'rich-text').map((p) => p.name),
  ...Object.values(FORMULA_BUILTIN_FIELDS),
]

// Only one property's settings are open at a time, so one textarea (a function ref: it sits in a v-for).
const formulaInput = ref<HTMLTextAreaElement | null>(null)
const setFormulaInput = (el: unknown) => (formulaInput.value = el as HTMLTextAreaElement | null)
function insertField(def: FormulaPropertyDef, name: string) {
  const text = formulaText(def)
  const input = formulaInput.value
  const at = input ? input.selectionStart : text.length
  const end = input ? input.selectionEnd : text.length
  const field = `{${name}}`
  setFormula(def, text.slice(0, at) + field + text.slice(end))
  requestAnimationFrame(() => {
    input?.focus()
    input?.setSelectionRange(at + field.length, at + field.length)
  })
}

const otherTypes = computed(() => [...workspace.types].sort((a, b) => a.name.localeCompare(b.name)))

async function save() {
  if (!draft.value.name.trim()) {
    error.value = 'The type needs a name.'
    return
  }
  saving.value = true
  error.value = ''
  try {
    draft.value.name = draft.value.name.trim()
    draft.value.pluralName = draft.value.pluralName.trim() || draft.value.name
    for (const def of draft.value.properties) def.name = def.name.trim() || 'Untitled'
    replaceType(await api.saveType(draft.value))
    emit('close')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
}

async function close() {
  if (dirty.value && !(await confirmDialog({ title: 'Discard your changes to this type?', confirmLabel: 'Discard', danger: true }))) return
  emit('close')
}
</script>

<template>
  <ModalDialog :title="`${type.name} settings`" width="44rem" @close="close">
    <!-- Identity -->
    <section class="flex gap-4">
      <button
        ref="iconAnchor"
        class="grid h-16 w-16 shrink-0 place-items-center rounded-2xl ring-1 ring-line hover:bg-hover"
        :class="chip(draft.color)"
        title="Change icon"
        @click="iconOpen = !iconOpen"
      >
        <AppIcon :icon="draft.icon" fallback="ph:cube" :size="32" />
      </button>
      <PopoverMenu v-model:open="iconOpen" :anchor="iconAnchor" width="auto">
        <div class="p-2"><IconPicker :icon="draft.icon" @pick="setIcon" /></div>
      </PopoverMenu>
      <div class="grid flex-1 grid-cols-2 gap-3">
        <label class="text-xs text-ink-faint">
          Name
          <input v-model="draft.name" class="mt-1 w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-line-strong" />
        </label>
        <label class="text-xs text-ink-faint">
          Plural name
          <input v-model="draft.pluralName" class="mt-1 w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-line-strong" />
        </label>
        <label class="col-span-2 text-xs text-ink-faint">
          Description
          <textarea
            v-model="draft.description"
            rows="2"
            class="mt-1 w-full resize-none rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-line-strong"
            placeholder="What objects of this type are for"
          />
        </label>
      </div>
    </section>
    <section class="mt-4">
      <div class="mb-1.5 text-xs text-ink-faint">Color</div>
      <ColorPicker :color="draft.color" @pick="setColor" />
    </section>

    <!-- Properties -->
    <section class="mt-6">
      <div class="mb-2 flex items-baseline gap-2">
        <h3 class="text-sm font-semibold">Properties</h3>
        <span class="text-xs text-ink-faint">Title, tags and icon are always there.</span>
      </div>
      <div class="divide-y divide-line rounded-xl border border-line">
        <div v-for="(def, index) in draft.properties" :key="def.id">
          <div class="flex items-center gap-2 px-2 py-1.5">
            <div class="flex flex-col">
              <button class="text-ink-faint hover:text-ink disabled:opacity-30" :disabled="index === 0" title="Move up" @click="move(index, -1)">
                <AppIcon fallback="ph:caret-up" :size="12" />
              </button>
              <button class="text-ink-faint hover:text-ink disabled:opacity-30" :disabled="index === draft.properties.length - 1" title="Move down" @click="move(index, 1)">
                <AppIcon fallback="ph:caret-down" :size="12" />
              </button>
            </div>
            <AppIcon :fallback="kindIcon(def.kind)" class="text-ink-faint" :title="kindLabel(def.kind)" />
            <input v-model="def.name" class="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-sm outline-none hover:bg-hover focus:bg-hover" />
            <span class="text-xs text-ink-faint">{{ kindLabel(def.kind) }}</span>
            <button
              class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink"
              :class="expanded === def.id ? 'bg-hover text-ink' : ''"
              title="Options"
              @click="expanded = expanded === def.id ? null : def.id"
            >
              <AppIcon fallback="ph:sliders-horizontal" />
            </button>
            <button
              class="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-red-600 disabled:opacity-30 disabled:hover:text-ink-faint"
              :disabled="def.kind === 'rich-text' && richTextCount <= 1"
              :title="def.kind === 'rich-text' && richTextCount <= 1 ? 'A type keeps at least one text block' : 'Delete property'"
              @click="remove(def)"
            >
              <AppIcon fallback="ph:trash" />
            </button>
          </div>

          <!-- Per-kind settings -->
          <div v-if="expanded === def.id" class="space-y-3 bg-raised px-4 py-3 text-sm">
            <label class="flex items-center gap-2">
              <input v-model="def.hideWhenEmpty" type="checkbox" class="accent-[var(--color-accent)]" />
              Hide on the object page when empty
            </label>
            <label v-if="def.kind === 'date'" class="flex items-center gap-2">
              <input v-model="def.withTime" type="checkbox" class="accent-[var(--color-accent)]" />
              Include time
            </label>

            <template v-if="def.kind === 'select'">
              <label class="flex items-center gap-2">
                <input v-model="def.multiple" type="checkbox" class="accent-[var(--color-accent)]" />
                Allow several options
              </label>
              <div class="space-y-1">
                <div v-for="(option, i) in def.options" :key="option.id" class="flex items-center gap-2">
                  <div class="flex flex-col">
                    <button class="text-ink-faint hover:text-ink disabled:opacity-30" :disabled="i === 0" @click="moveOption(def, i, -1)"><AppIcon fallback="ph:caret-up" :size="11" /></button>
                    <button class="text-ink-faint hover:text-ink disabled:opacity-30" :disabled="i === def.options.length - 1" @click="moveOption(def, i, 1)"><AppIcon fallback="ph:caret-down" :size="11" /></button>
                  </div>
                  <button
                    class="h-5 w-5 shrink-0 rounded-full"
                    :class="swatchClasses[option.color ?? 'gray']"
                    title="Color"
                    @click="colorFor = { option, anchor: $event.currentTarget as HTMLElement }"
                  />
                  <input v-model="option.label" class="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 outline-none focus:border-line-strong" />
                  <select v-model="option.status" class="rounded-md border border-line bg-surface px-1.5 py-1 text-xs text-ink-soft" title="Status meaning (used by boards and tasks)">
                    <option :value="undefined">No status</option>
                    <option value="todo">To do</option>
                    <option value="doing">In progress</option>
                    <option value="done">Done</option>
                  </select>
                  <button class="text-ink-faint hover:text-red-600" title="Delete option" @click="def.options.splice(i, 1)">
                    <AppIcon fallback="ph:x" :size="14" />
                  </button>
                </div>
                <input
                  class="mt-1 w-full rounded-md border border-dashed border-line bg-transparent px-2 py-1 outline-none placeholder:text-ink-faint focus:border-line-strong"
                  placeholder="Add an option and press Enter"
                  @keydown.enter.prevent="addOption(def, ($event.target as HTMLInputElement).value), (($event.target as HTMLInputElement).value = '')"
                />
              </div>
            </template>

            <label v-if="def.kind === 'person'" class="flex items-center gap-2">
              <input v-model="def.multiple" type="checkbox" class="accent-[var(--color-accent)]" />
              Allow several people
            </label>

            <template v-if="def.kind === 'formula'">
              <div>
                <textarea
                  :ref="setFormulaInput"
                  :value="formulaText(def)"
                  rows="2"
                  spellcheck="false"
                  class="w-full resize-y rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-xs outline-none focus:border-line-strong"
                  placeholder="{Price} * {Quantity}"
                  @input="setFormula(def, ($event.target as HTMLTextAreaElement).value)"
                />
                <p v-if="formulaProblem(def)" class="mt-1 text-xs text-red-600">{{ formulaProblem(def) }}</p>
                <p v-else-if="def.expression.trim() && formulaGives(def)" class="mt-1 text-xs text-ink-faint">Gives {{ formulaGives(def) }}.</p>
                <p v-else-if="!def.expression.trim()" class="mt-1 text-xs text-ink-faint">
                  Fields go in braces, a related object's field after a dot: <code>{Author.Country}</code>. Text in quotes; <code>+ - * / %</code>,
                  <code>= != &lt; &gt;</code>, <code>and or not</code>.
                </p>
              </div>
              <div>
                <div class="mb-1 text-xs text-ink-faint">Insert a field</div>
                <div class="flex flex-wrap gap-1">
                  <button
                    v-for="name in formulaFields(def)"
                    :key="name"
                    class="rounded-md border border-line bg-surface px-1.5 py-0.5 text-xs hover:bg-hover"
                    @mousedown.prevent
                    @click="insertField(def, name)"
                  >
                    {{ name }}
                  </button>
                </div>
              </div>
              <details class="text-xs">
                <summary class="cursor-pointer text-ink-faint hover:text-ink">Functions</summary>
                <dl class="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  <template v-for="fn in FORMULA_FUNCTIONS" :key="fn.name">
                    <dt class="font-mono">{{ fn.usage }}</dt>
                    <dd class="text-ink-soft">{{ fn.description }}</dd>
                  </template>
                </dl>
                <p class="mt-1.5 text-ink-faint">Dates: <code>{Due} - today()</code> gives days, <code>{Start} + 7</code> a week later.</p>
              </details>
            </template>

            <template v-if="def.kind === 'relation'">
              <label class="flex items-center gap-2">
                <input v-model="def.multiple" type="checkbox" class="accent-[var(--color-accent)]" />
                Allow several objects
              </label>
              <div>
                <div class="mb-1.5 text-xs text-ink-faint">Can link to</div>
                <div class="mb-2 inline-flex rounded-lg bg-hover p-0.5 text-sm">
                  <button
                    class="rounded-md px-3 py-1"
                    :class="!specific.has(def.id) ? 'bg-surface font-medium shadow-sm' : 'text-ink-soft'"
                    @click="setAnyType(def)"
                  >
                    Any type
                  </button>
                  <button
                    class="rounded-md px-3 py-1"
                    :class="specific.has(def.id) ? 'bg-surface font-medium shadow-sm' : 'text-ink-soft'"
                    @click="specific.add(def.id)"
                  >
                    Specific types
                  </button>
                </div>
                <p v-if="specific.has(def.id) && def.targetTypeIds.length === 0" class="mb-1.5 text-xs text-amber-600">
                  Pick at least one type; with none picked it links to any type.
                </p>
                <div v-if="specific.has(def.id)" class="grid grid-cols-2 gap-x-3 gap-y-0.5">
                  <label v-for="t in otherTypes" :key="t.id" class="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-hover">
                    <input type="checkbox" class="accent-[var(--color-accent)]" :checked="def.targetTypeIds.includes(t.id)" @change="toggleTarget(def, t.id)" />
                    <AppIcon :icon="t.icon" fallback="ph:cube" :size="14" :class="t.color ? iconTextClasses[t.color] : 'text-ink-soft'" />
                    <span class="truncate">{{ t.name }}</span>
                  </label>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>

      <form class="mt-2 flex gap-2" @submit.prevent="addProperty">
        <input
          v-model="newName"
          class="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm outline-none placeholder:text-ink-faint focus:border-line-strong"
          placeholder="New property name"
        />
        <select v-model="newKind" class="rounded-lg border border-line bg-surface px-2 text-sm">
          <option v-for="k in PROPERTY_KINDS" :key="k.kind" :value="k.kind">{{ k.label }}</option>
        </select>
        <button class="rounded-lg border border-line px-3 text-sm hover:bg-hover disabled:opacity-40" :disabled="!newName.trim()">Add</button>
      </form>
    </section>

    <PopoverMenu v-model:open="colorOpen" :anchor="colorFor?.anchor" width="auto">
      <div class="p-2">
        <ColorPicker :color="colorFor?.option.color" @pick="(c) => { if (colorFor) colorFor.option.color = c; colorFor = null }" />
      </div>
    </PopoverMenu>

    <template #footer>
      <span v-if="error" class="text-sm text-red-600">{{ error }}</span>
      <span v-else-if="dirty" class="text-xs text-ink-faint">Unsaved changes</span>
      <button class="ml-auto rounded-lg px-3 py-1.5 text-sm hover:bg-hover" @click="close">Cancel</button>
      <button class="rounded-lg bg-ink px-3 py-1.5 text-sm font-medium text-surface disabled:opacity-40" :disabled="!dirty || saving" @click="save">
        {{ saving ? 'Saving…' : 'Save' }}
      </button>
    </template>
  </ModalDialog>
</template>
