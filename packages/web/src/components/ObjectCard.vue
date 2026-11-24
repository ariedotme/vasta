<script setup lang="ts">
// Card used by grid, wall, gallery and kanban views. Appearance and fields follow the view's own
// per-layout CardSettings (`card`); when `card.cardFields` is unset, automatic mode shows the first
// few non-empty properties (leaving out `hide`) and tags.
import { computed, ref } from 'vue'
import type { CardSettings, ObjectSummary, ObjectType, PropertyDef } from '@vasta/core'
import { BLOCKED_PROPERTY_ID } from '@vasta/core'
import { resolveCard, type CardVariant } from '../lib/cards.ts'
import { imageOf } from '../lib/media.ts'
import { chip, iconTextClasses } from '../lib/colors.ts'
import { displayTitle } from '../lib/format.ts'
import { propName, t, typeName } from '../lib/i18n.ts'
import { formulaValue } from '../lib/properties.ts'
import AppIcon from './AppIcon.vue'
import ObjectChip from './ObjectChip.vue'
import PropertyDisplay from './PropertyDisplay.vue'
import ObjectLink from './ObjectLink.vue'

const props = defineProps<{
  object: ObjectSummary
  type: ObjectType | undefined
  variant: CardVariant
  card?: CardSettings
  hide?: string[]
}>()

const appearance = computed(() => resolveCard(props.variant, props.card))
const broken = ref(false)
const image = computed(() => (broken.value ? undefined : imageOf(props.object)))

const imageClass = computed(() => {
  const fit = appearance.value.fit ? 'object-contain' : 'object-cover'
  const size = appearance.value.size
  if (props.variant === 'gallery') return `${fit} aspect-[4/3]`
  if (props.variant === 'wall') return `${fit} ${size === 'sm' ? 'max-h-44' : size === 'lg' ? 'max-h-80' : 'max-h-64'}`
  if (props.variant === 'kanban') return `${fit} ${size === 'sm' ? 'h-24' : size === 'lg' ? 'h-48' : 'h-36'}`
  return `${fit} ${size === 'sm' ? 'h-24' : size === 'lg' ? 'h-44' : 'h-32'}`
})

function hasValue(p: PropertyDef): boolean {
  if (p.kind === 'rich-text') return false
  if (p.kind === 'formula') return !['empty', 'error'].includes(formulaValue(props.object, p).kind)
  const value = props.object.props[p.id]
  if (!value) return false
  if (value.kind === 'text' || value.kind === 'url') return value.value.trim().length > 0
  if (value.kind === 'select' || value.kind === 'relation' || value.kind === 'person') return value.value.length > 0
  return true
}

const blocked = computed(() => {
  const value = props.object.props[BLOCKED_PROPERTY_ID]
  return value?.kind === 'checkbox' && value.value
})

type CardRow = { kind: 'prop'; def: PropertyDef } | { kind: 'tags' }
const manualFields = computed(() => props.card?.cardFields !== undefined)

const rows = computed<CardRow[]>(() => {
  const defs = props.type?.properties ?? []
  const saved = props.card?.cardFields
  if (saved !== undefined) {
    const out: CardRow[] = []
    for (const id of saved) {
      if (id === 'tags') {
        if (props.object.tagIds.length) out.push({ kind: 'tags' })
        continue
      }
      if (id === BLOCKED_PROPERTY_ID) continue
      const def = defs.find((p) => p.id === id)
      if (def && hasValue(def)) out.push({ kind: 'prop', def })
    }
    return out
  }
  const out: CardRow[] = defs
    .filter((p) => p.id !== BLOCKED_PROPERTY_ID && !props.hide?.includes(p.id) && hasValue(p))
    .slice(0, props.variant === 'wall' ? 4 : 2)
    .map((def) => ({ kind: 'prop', def }))
  if (props.object.tagIds.length && !props.hide?.includes('tags')) out.push({ kind: 'tags' })
  return out
})
</script>

<template>
  <ObjectLink
    :id="object.id"
    class="group flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm transition hover:border-line-strong hover:shadow-md"
    :class="variant === 'wall' ? 'mb-3 break-inside-avoid' : ''"
  >
    <img
      v-if="appearance.cover && image"
      :src="image"
      alt=""
      loading="lazy"
      draggable="false"
      class="w-full bg-hover"
      :class="imageClass"
      @error="broken = true"
    />
    <div v-else-if="variant === 'gallery' && appearance.cover" class="grid aspect-[4/3] w-full place-items-center bg-hover text-ink-faint">
      <AppIcon :icon="type?.icon" fallback="ph:image" :size="28" />
    </div>
    <div class="flex flex-1 flex-col gap-1.5 p-3">
      <span v-if="variant !== 'kanban'" class="inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium" :class="chip(type?.color)">
        <AppIcon :icon="type?.icon" fallback="ph:cube" :size="12" />{{ type ? typeName(type) : '' }}
      </span>
      <div class="flex items-start gap-1.5 font-semibold leading-snug">
        <AppIcon v-if="object.icon" :icon="object.icon" :class="type?.color ? iconTextClasses[type.color] : ''" class="mt-0.5" />
        <span class="line-clamp-3">{{ displayTitle(object, type) }}</span>
        <span v-if="blocked" class="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-md bg-red-100 px-1.5 py-0.5 text-[11px] font-medium text-red-700 dark:bg-red-950 dark:text-red-300" :title="t('builtin.prop.blocked')">
          <AppIcon fallback="ph:flag-fill" :size="11" /> {{ t('builtin.prop.blocked') }}
        </span>
      </div>
      <p
        v-if="appearance.preview && object.preview"
        class="text-sm text-ink-soft"
        :class="variant === 'wall' ? 'line-clamp-[10] whitespace-pre-line' : 'line-clamp-2'"
      >
        {{ object.preview }}
      </p>
      <template v-for="(row, i) in rows" :key="row.kind === 'tags' ? 'tags' : row.def.id">
        <div
          v-if="row.kind === 'tags'"
          class="flex flex-wrap items-center gap-1"
          :class="!manualFields && i === rows.length - 1 ? 'mt-auto pt-1' : 'pt-0.5'"
          @click.prevent
        >
          <span v-if="appearance.labels" class="mr-0.5 text-xs text-ink-faint">{{ t('builtin.type.tag.other') }}</span>
          <ObjectChip v-for="id in object.tagIds" :key="id" :id="id" tag />
        </div>
        <div v-else class="flex min-w-0 items-baseline gap-1.5 text-xs text-ink-soft">
          <!-- Formulas always say what they are; other properties follow the view's Show labels choice. -->
          <span v-if="appearance.labels || row.def.kind === 'formula'" class="shrink-0 text-ink-faint">{{ propName(row.def) }}</span>
          <PropertyDisplay :def="row.def" :value="object.props[row.def.id]" :object="object" />
        </div>
      </template>
    </div>
  </ObjectLink>
</template>
