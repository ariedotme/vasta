<script setup lang="ts">
// One filter: field, operator and value. The value editor depends on the field's kind.
import { computed, ref } from 'vue'
import type { Filter, FilterOperator, FilterValue, Id } from '@vasta/core'
import { OPERATORS, UNARY_OPERATORS } from '@vasta/core'
import { chip } from '../lib/colors.ts'
import { filterFieldOptions, IDS_OPERATOR_LABELS, OPERATOR_LABELS } from '../lib/query.ts'
import { systemType, workspace } from '../lib/state.ts'
import AppIcon from './AppIcon.vue'
import ObjectChip from './ObjectChip.vue'
import ObjectPicker from './ObjectPicker.vue'
import PersonAvatar from './PersonAvatar.vue'
import { meId, people, personName } from '../lib/people.ts'
import { sprintSettings, sprintTypeId } from '../lib/sprints.ts'

const props = defineProps<{ filter: Filter; typeIds: Id[] }>()
const emit = defineEmits<{ update: [filter: Filter]; remove: [] }>()

const fields = computed(() => filterFieldOptions(props.typeIds))
// Related objects' fields are listed under their relation.
const fieldGroups = computed(() => {
  const groups = new Map<string, typeof fields.value>()
  for (const f of fields.value) groups.set(f.through ?? '', [...(groups.get(f.through ?? '') ?? []), f])
  return [...groups].map(([through, options]) => ({ through, options }))
})
const field = computed(() => fields.value.find((f) => f.field === props.filter.field))
const kind = computed(() => field.value?.kind ?? 'text')
const operators = computed(() => OPERATORS[kind.value])
const label = (op: FilterOperator) => (kind.value === 'ids' ? IDS_OPERATOR_LABELS[op] : undefined) ?? OPERATOR_LABELS[op]
const needsValue = computed(() => !UNARY_OPERATORS.includes(props.filter.operator))

function setField(name: string) {
  const next = fields.value.find((f) => f.field === name)
  if (!next) return
  emit('update', { kind: 'filter', field: name, operator: OPERATORS[next.kind][0]! })
}

function setOperator(operator: FilterOperator) {
  const next: Filter = { ...props.filter, operator }
  if (UNARY_OPERATORS.includes(operator)) delete next.value
  emit('update', next)
}

function setValue(value: FilterValue | undefined) {
  const next: Filter = { ...props.filter }
  if (value) next.value = value
  else delete next.value
  emit('update', next)
}

// Text and numbers -----------------------------------------------------------
const literalText = computed(() => (props.filter.value?.kind === 'literal' && !Array.isArray(props.filter.value.value) ? String(props.filter.value.value) : ''))
function setLiteral(raw: string) {
  if (kind.value === 'number') setValue(raw === '' || Number.isNaN(Number(raw)) ? undefined : { kind: 'literal', value: Number(raw) })
  else setValue(raw ? { kind: 'literal', value: raw } : undefined)
}

// Dates ----------------------------------------------------------------------
type DateMode = 'today' | 'exact' | 'parent'
const dateMode = computed<DateMode>(() => {
  const value = props.filter.value
  if (value?.kind === 'variable') return value.name === 'today' ? 'today' : 'parent'
  return 'exact'
})
const offset = computed(() => (props.filter.value?.kind === 'variable' ? (props.filter.value.offsetDays ?? 0) : 0))
function setDateMode(mode: DateMode) {
  if (mode === 'today') setValue({ kind: 'variable', name: 'today' })
  else if (mode === 'parent') setValue({ kind: 'variable', name: 'parent', field: 'createdAt' })
  else setValue(undefined)
}
function setOffset(raw: string) {
  const days = Math.trunc(Number(raw)) || 0
  setValue({ kind: 'variable', name: 'today', ...(days ? { offsetDays: days } : {}) })
}

// Lists of ids (tags, selects, relations, types) ----------------------------
const ids = computed<Id[]>(() => {
  const value = props.filter.value
  if (value?.kind !== 'literal') return []
  return Array.isArray(value.value) ? value.value : [String(value.value)]
})
const isParent = computed(() => props.filter.value?.kind === 'variable' && props.filter.value.name === 'parent' && !props.filter.value.field)
const selectOptions = computed(() => (field.value?.def?.kind === 'select' ? field.value.def.options : undefined))
const pickerTypes = computed<Id[]>(() => {
  if (props.filter.field === 'tags') return [systemType('tag')?.id ?? '']
  if (props.filter.field === 'collections') return [systemType('collection')?.id ?? '']
  return field.value?.def?.kind === 'relation' ? field.value.def.targetTypeIds : []
})
const picking = ref(false)

function toggleId(id: Id) {
  const next = ids.value.includes(id) ? ids.value.filter((i) => i !== id) : [...ids.value, id]
  setValue(next.length ? { kind: 'literal', value: next } : undefined)
}
// People: "Me" (whoever looks) or chosen members.
const isPerson = computed(() => field.value?.def?.kind === 'person' || ['createdBy', 'updatedBy'].includes(field.value?.field.split('.').pop() ?? ''))
const isMe = computed(() => props.filter.value?.kind === 'variable' && props.filter.value.name === 'me')
const personChoices = computed(() => {
  const listed = people.list.filter((p) => p.id !== meId()).map((p) => p.id)
  return [...listed, ...ids.value.filter((id) => !listed.includes(id))]
})
// A relation to sprints: "the current one" as well as chosen sprints.
const isSprintRelation = computed(() => field.value?.def?.kind === 'relation' && field.value.def.targetTypeIds.includes(sprintTypeId.value))
const isCurrentSprint = computed(() => props.filter.value?.kind === 'variable' && props.filter.value.name === 'current-sprint')
function toggleCurrentSprint() {
  setValue(isCurrentSprint.value ? undefined : { kind: 'variable', name: 'current-sprint' })
}

function toggleMe() {
  setValue(isMe.value ? undefined : { kind: 'variable', name: 'me' })
}

function useParent(on: boolean) {
  setValue(on ? { kind: 'variable', name: 'parent' } : undefined)
}

const control = 'rounded-md bg-hover px-1.5 py-1 text-sm outline-none'
</script>

<template>
  <div class="flex flex-wrap items-start gap-1.5">
    <select :value="filter.field" :class="control" class="max-w-44" @change="setField(($event.target as HTMLSelectElement).value)">
      <option v-if="!field" :value="filter.field">Unknown field</option>
      <template v-for="g in fieldGroups" :key="g.through">
        <option v-for="f in g.through ? [] : g.options" :key="f.field" :value="f.field">{{ f.label }}</option>
        <optgroup v-if="g.through" :label="g.through">
          <option v-for="f in g.options" :key="f.field" :value="f.field">{{ f.label }}</option>
        </optgroup>
      </template>
    </select>
    <select :value="filter.operator" :class="control" @change="setOperator(($event.target as HTMLSelectElement).value as FilterOperator)">
      <option v-for="op in operators" :key="op" :value="op">{{ label(op) }}</option>
    </select>

    <template v-if="needsValue">
      <!-- Text / number -->
      <input
        v-if="kind === 'text' || kind === 'number'"
        :value="literalText"
        :type="kind === 'number' ? 'number' : 'text'"
        :class="control"
        class="w-40"
        placeholder="Value"
        @change="setLiteral(($event.target as HTMLInputElement).value)"
      />

      <!-- Date -->
      <template v-else-if="kind === 'date'">
        <select :value="dateMode" :class="control" @change="setDateMode(($event.target as HTMLSelectElement).value as DateMode)">
          <option value="today">Today</option>
          <option value="exact">Exact date</option>
          <option value="parent">This page's date</option>
        </select>
        <span v-if="dateMode === 'today'" class="flex items-center gap-1 text-sm text-ink-soft">
          <input :value="offset" type="number" :class="control" class="w-16" title="Days from today (negative for the past)" @change="setOffset(($event.target as HTMLInputElement).value)" />
          days
        </span>
        <input v-else-if="dateMode === 'exact'" type="date" :value="literalText" :class="control" @change="setLiteral(($event.target as HTMLInputElement).value)" />
      </template>

      <!-- Ids -->
      <div v-else-if="kind === 'ids'" class="flex min-w-0 flex-1 flex-col gap-1">
        <div class="flex flex-wrap items-center gap-1">
          <template v-if="selectOptions">
            <button
              v-for="option in selectOptions"
              :key="option.id"
              class="rounded-md px-1.5 py-0.5 text-xs"
              :class="ids.includes(option.id) ? chip(option.color) : 'text-ink-faint ring-1 ring-line hover:text-ink'"
              @click="toggleId(option.id)"
            >
              {{ option.label }}
            </button>
          </template>
          <template v-else-if="isPerson">
            <button
              class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs"
              :class="isMe ? 'bg-accent/10 text-accent ring-1 ring-accent/30' : 'text-ink-faint ring-1 ring-line hover:text-ink'"
              title="Whoever is looking"
              @click="toggleMe"
            >
              <AppIcon fallback="ph:user-circle" :size="13" />Me
            </button>
            <button
              v-for="id in personChoices"
              :key="id"
              class="inline-flex items-center gap-1 rounded-md py-0.5 pl-0.5 pr-1.5 text-xs"
              :class="ids.includes(id) ? 'bg-hover text-ink ring-1 ring-line-strong' : 'text-ink-faint ring-1 ring-line hover:text-ink'"
              @click="toggleId(id)"
            >
              <PersonAvatar :id="id" :size="16" />{{ personName(id) }}
            </button>
          </template>
          <template v-else-if="filter.field === 'type'">
            <button
              v-for="t in workspace.types"
              :key="t.id"
              class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs"
              :class="ids.includes(t.id) ? chip(t.color) : 'text-ink-faint ring-1 ring-line hover:text-ink'"
              @click="toggleId(t.id)"
            >
              <AppIcon :icon="t.icon" fallback="ph:cube" :size="12" />{{ t.name }}
            </button>
          </template>
          <template v-else>
            <span v-if="isParent" class="inline-flex items-center gap-1 rounded-md bg-accent/10 px-1.5 py-0.5 text-sm text-accent">
              <AppIcon fallback="ph:arrow-elbow-left-up" :size="13" /> This page
              <button class="text-ink-faint hover:text-ink" title="Remove" @click="useParent(false)"><AppIcon fallback="ph:x" :size="11" /></button>
            </span>
            <span v-if="isCurrentSprint" class="inline-flex items-center gap-1 rounded-md bg-accent/10 px-1.5 py-0.5 text-sm text-accent">
              <AppIcon fallback="ph:flag-banner" :size="13" /> Current {{ (sprintSettings?.name ?? 'sprint').toLowerCase() }}
              <button class="text-ink-faint hover:text-ink" title="Remove" @click="toggleCurrentSprint"><AppIcon fallback="ph:x" :size="11" /></button>
            </span>
            <ObjectChip v-for="id in ids" :key="id" :id="id" :tag="filter.field === 'tags'" removable @remove="toggleId(id)" />
            <button v-if="isSprintRelation && !isCurrentSprint && !ids.length" class="rounded-md px-1.5 py-0.5 text-sm text-ink-faint hover:bg-hover hover:text-ink" title="Whichever has today in its dates" @click="toggleCurrentSprint">
              Current {{ (sprintSettings?.name ?? 'sprint').toLowerCase() }}
            </button>
            <button v-if="!isParent && !isCurrentSprint" class="rounded-md px-1.5 py-0.5 text-sm text-ink-faint hover:bg-hover hover:text-ink" @click="picking = !picking">
              {{ ids.length ? '+' : 'Choose…' }}
            </button>
            <button v-if="!isParent && !ids.length" class="rounded-md px-1.5 py-0.5 text-sm text-ink-faint hover:bg-hover hover:text-ink" title="Match the page this query is embedded in" @click="useParent(true)">
              This page
            </button>
          </template>
        </div>
        <div v-if="picking && !selectOptions && !isPerson && filter.field !== 'type'" class="w-64 rounded-lg border border-line bg-surface p-1 shadow-sm">
          <ObjectPicker :type-ids="pickerTypes.filter(Boolean)" :exclude="ids" @pick="toggleId($event.id), (picking = false)" />
        </div>
      </div>
    </template>

    <button class="ml-auto rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink" title="Remove filter" @click="emit('remove')">
      <AppIcon fallback="ph:x" :size="14" />
    </button>
  </div>
</template>
