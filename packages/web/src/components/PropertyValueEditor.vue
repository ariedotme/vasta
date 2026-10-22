<script setup lang="ts">
// Editor for one property value, chosen by the property's kind.
import { computed, ref } from 'vue'
import type { ObjectSummary, PropertyDef, PropertyValue, SelectOption, SelectPropertyDef } from '@vasta/core'
import { createObject } from '../lib/actions.ts'
import { chip, colorNames } from '../lib/colors.ts'
import AppIcon from './AppIcon.vue'
import DateValueEditor from './DateValueEditor.vue'
import ObjectChip from './ObjectChip.vue'
import ObjectPicker from './ObjectPicker.vue'
import PersonChip from './PersonChip.vue'
import PersonPicker from './PersonPicker.vue'
import PopoverMenu from './PopoverMenu.vue'

const props = defineProps<{ def: PropertyDef; value: PropertyValue | undefined }>()
const emit = defineEmits<{
  update: [value: PropertyValue | undefined]
  /** A select option was created; the parent saves it on the type. */
  addOption: [option: SelectOption]
}>()

const anchor = ref<HTMLElement | null>(null)
const open = ref(false)

const text = computed(() => (props.value && 'value' in props.value && typeof props.value.value === 'string' ? props.value.value : ''))
const ids = computed(() => (props.value?.kind === 'relation' || props.value?.kind === 'select' || props.value?.kind === 'person' ? props.value.value : []))
const options = computed(() => (props.def.kind === 'select' ? props.def.options : []))

function setText(raw: string) {
  const kind = props.def.kind as 'text' | 'url'
  emit('update', raw ? { kind, value: raw } : undefined)
}

function setNumber(raw: string) {
  emit('update', raw === '' || Number.isNaN(Number(raw)) ? undefined : { kind: 'number', value: Number(raw) })
}

function toggleOption(id: string) {
  const def = props.def as SelectPropertyDef
  const current = ids.value
  const next = current.includes(id) ? current.filter((x) => x !== id) : def.multiple ? [...current, id] : [id]
  emit('update', next.length ? { kind: 'select', value: next } : undefined)
  if (!def.multiple) open.value = false
}

const newOption = ref('')
function createOption() {
  const label = newOption.value.trim()
  if (!label) return
  const option: SelectOption = { id: crypto.randomUUID(), label, color: colorNames[(options.value.length * 5) % colorNames.length] }
  emit('addOption', option)
  newOption.value = ''
  toggleOption(option.id)
}

function addRelation(object: ObjectSummary) {
  if (props.def.kind !== 'relation') return
  const next = props.def.multiple ? [...new Set([...ids.value, object.id])] : [object.id]
  emit('update', { kind: 'relation', value: next })
  if (!props.def.multiple) open.value = false
}

async function createRelated(title: string) {
  if (props.def.kind !== 'relation') return
  const typeId = props.def.targetTypeIds[0]
  if (!typeId) return
  const created = await createObject(typeId, { title }, false)
  addRelation({ ...created, preview: '' })
}

function togglePerson(id: string) {
  if (props.def.kind !== 'person') return
  const next = ids.value.includes(id) ? ids.value.filter((x) => x !== id) : props.def.multiple ? [...ids.value, id] : [id]
  emit('update', next.length ? { kind: 'person', value: next } : undefined)
  if (!props.def.multiple) open.value = false
}

function removeRelation(id: string) {
  const next = ids.value.filter((x) => x !== id)
  emit('update', next.length ? { kind: 'relation', value: next } : undefined)
}
</script>

<template>
  <div class="min-h-8 flex min-w-0 flex-1 items-center">
    <input
      v-if="def.kind === 'text'"
      :value="text"
      class="w-full rounded-md bg-transparent px-2 py-1 outline-none hover:bg-hover focus:bg-hover"
      placeholder="Empty"
      @change="setText(($event.target as HTMLInputElement).value)"
    />

    <div v-else-if="def.kind === 'url'" class="flex w-full items-center gap-1">
      <input
        :value="text"
        class="w-full rounded-md bg-transparent px-2 py-1 outline-none hover:bg-hover focus:bg-hover"
        placeholder="https://"
        @change="setText(($event.target as HTMLInputElement).value)"
      />
      <a v-if="text" :href="text" target="_blank" rel="noopener noreferrer" class="text-ink-faint hover:text-accent"><AppIcon fallback="ph:arrow-square-out" /></a>
    </div>

    <input
      v-else-if="def.kind === 'number'"
      type="number"
      :value="value?.kind === 'number' ? value.value : ''"
      class="w-full rounded-md bg-transparent px-2 py-1 outline-none hover:bg-hover focus:bg-hover"
      placeholder="Empty"
      @change="setNumber(($event.target as HTMLInputElement).value)"
    />

    <label v-else-if="def.kind === 'checkbox'" class="px-2 py-1">
      <input
        type="checkbox"
        class="h-4 w-4 accent-[var(--color-accent)]"
        :checked="value?.kind === 'checkbox' && value.value"
        @change="emit('update', { kind: 'checkbox', value: ($event.target as HTMLInputElement).checked })"
      />
    </label>

    <DateValueEditor
      v-else-if="def.kind === 'date'"
      :value="value?.kind === 'date' ? value.value : undefined"
      :with-time="def.withTime"
      @update="emit('update', $event ? { kind: 'date', value: $event } : undefined)"
    />

    <template v-else-if="def.kind === 'select'">
      <button ref="anchor" class="flex min-h-8 w-full flex-wrap items-center gap-1 rounded-md px-1.5 py-1 text-left hover:bg-hover" @click="open = !open">
        <span v-for="id in ids" :key="id" class="rounded-md px-2 py-0.5 text-sm" :class="chip(options.find((o) => o.id === id)?.color)">
          {{ options.find((o) => o.id === id)?.label ?? '?' }}
        </span>
        <span v-if="!ids.length" class="px-0.5 text-ink-faint">Empty</span>
      </button>
      <PopoverMenu v-model:open="open" :anchor="anchor">
        <button
          v-for="option in options"
          :key="option.id"
          class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-hover"
          @click="toggleOption(option.id)"
        >
          <span class="rounded-md px-2 py-0.5" :class="chip(option.color)">{{ option.label }}</span>
          <AppIcon v-if="ids.includes(option.id)" fallback="ph:check" class="ml-auto text-accent" />
        </button>
        <input
          v-model="newOption"
          class="mt-1 w-full rounded-lg bg-hover px-2.5 py-1.5 text-sm outline-none placeholder:text-ink-faint"
          placeholder="New option…"
          @keydown.enter.prevent="createOption"
        />
      </PopoverMenu>
    </template>

    <template v-else-if="def.kind === 'relation'">
      <div class="flex w-full flex-wrap items-center gap-1 px-1.5 py-1">
        <ObjectChip v-for="id in ids" :key="id" :id="id" removable @remove="removeRelation(id)" />
        <button ref="anchor" class="rounded-md px-1 text-ink-faint hover:bg-hover hover:text-ink" title="Add" @click="open = !open">
          <AppIcon fallback="ph:plus" :size="14" />
        </button>
      </div>
      <PopoverMenu v-model:open="open" :anchor="anchor" width="18rem">
        <ObjectPicker :type-ids="def.targetTypeIds" :exclude="ids" @pick="addRelation" @create="createRelated" />
      </PopoverMenu>
    </template>

    <template v-else-if="def.kind === 'person'">
      <button ref="anchor" class="flex min-h-8 w-full flex-wrap items-center gap-1 rounded-md px-1.5 py-1 text-left hover:bg-hover" @click="open = !open">
        <PersonChip v-for="id in ids" :key="id" :id="id" />
        <span v-if="!ids.length" class="px-0.5 text-ink-faint">Empty</span>
      </button>
      <PopoverMenu v-model:open="open" :anchor="anchor" width="16rem">
        <PersonPicker :selected="ids" @toggle="togglePerson" />
      </PopoverMenu>
    </template>
  </div>
</template>
