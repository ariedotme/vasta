<script setup lang="ts">
// Read-only rendering of a property value (tables, cards). A formula is computed from `object`.
import { computed } from 'vue'
import type { FormulaSubject, PropertyDef, PropertyValue } from '@vasta/core'
import { chip } from '../lib/colors.ts'
import { formatDate } from '../lib/format.ts'
import { formatFormula, formulaValue } from '../lib/properties.ts'
import AppIcon from './AppIcon.vue'
import ObjectChip from './ObjectChip.vue'
import PersonChip from './PersonChip.vue'

// `wrap`: in a table column, long values take several lines (true) or one (false).
const props = defineProps<{ def: PropertyDef; value: PropertyValue | undefined; object?: FormulaSubject; wrap?: boolean }>()

const formula = computed(() => (props.def.kind === 'formula' && props.object ? formulaValue(props.object, props.def) : undefined))
</script>

<template>
  <template v-if="formula">
    <!-- Where values wrap (the object page) there is room for what is wrong. -->
    <span v-if="formula.kind === 'error'" class="text-xs text-red-600" :title="formula.message">{{ wrap ? `Error: ${formula.message}` : 'Error' }}</span>
    <AppIcon v-else-if="formula.kind === 'checkbox'" :fallback="formula.value ? 'ph:check-square-fill' : 'ph:square'" class="text-ink-soft" />
    <span v-else :class="[wrap ? 'whitespace-pre-wrap break-words' : 'truncate', formula.kind === 'number' ? 'tabular-nums' : '']">{{ formatFormula(formula) }}</span>
  </template>
  <span v-else-if="!value" />
  <span v-else-if="value.kind === 'select' && def.kind === 'select'" class="flex gap-1" :class="wrap === false ? 'overflow-hidden' : 'flex-wrap'">
    <span v-for="id in value.value" :key="id" class="rounded-md px-1.5 py-0.5 text-xs" :class="chip(def.options.find((o) => o.id === id)?.color)">
      {{ def.options.find((o) => o.id === id)?.label ?? '?' }}
    </span>
  </span>
  <span v-else-if="value.kind === 'relation'" class="flex gap-1" :class="wrap === false ? 'overflow-hidden' : 'flex-wrap'" @click.stop>
    <ObjectChip v-for="id in value.value" :key="id" :id="id" />
  </span>
  <span v-else-if="value.kind === 'person'" class="flex gap-1" :class="wrap === false ? 'overflow-hidden' : 'flex-wrap'">
    <PersonChip v-for="id in value.value" :key="id" :id="id" />
  </span>
  <span v-else-if="value.kind === 'date'" class="whitespace-nowrap">{{ formatDate(value.value) }}</span>
  <AppIcon v-else-if="value.kind === 'checkbox'" :fallback="value.value ? 'ph:check-square-fill' : 'ph:square'" class="text-ink-soft" />
  <a v-else-if="value.kind === 'url'" :href="value.value" target="_blank" rel="noopener noreferrer" class="truncate text-accent hover:underline" @click.stop>{{ value.value }}</a>
  <span v-else :class="wrap ? 'whitespace-pre-wrap break-words' : 'truncate'">{{ value.value }}</span>
</template>
