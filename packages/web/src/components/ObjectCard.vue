<script setup lang="ts">
// Card used by grid, wall, gallery and kanban views. A board chooses the fields its cards show
// (`fields`), or leaves out the ones its columns and lanes already say (`hide`).
import { computed, ref } from 'vue'
import type { ObjectSummary, ObjectType, PropertyDef } from '@vasta/core'
import { BLOCKED_PROPERTY_ID } from '@vasta/core'
import { imageOf } from '../lib/media.ts'
import { chip, iconTextClasses } from '../lib/colors.ts'
import { displayTitle } from '../lib/format.ts'
import { formulaValue } from '../lib/properties.ts'
import AppIcon from './AppIcon.vue'
import ObjectChip from './ObjectChip.vue'
import PropertyDisplay from './PropertyDisplay.vue'

const props = defineProps<{ object: ObjectSummary; type: ObjectType | undefined; variant: 'grid' | 'wall' | 'gallery' | 'kanban'; fields?: PropertyDef[]; hide?: string[] }>()

const broken = ref(false)
const image = computed(() => (broken.value ? undefined : imageOf(props.object)))
const hasValue = (p: PropertyDef) => (p.kind === 'formula' ? !['empty', 'error'].includes(formulaValue(props.object, p).kind) : p.kind !== 'rich-text' && !!props.object.props[p.id])
const blocked = computed(() => {
  const value = props.object.props[BLOCKED_PROPERTY_ID]
  return value?.kind === 'checkbox' && value.value
})
const shownProps = computed(() =>
  props.fields
    ? props.fields.filter((p) => p.id !== BLOCKED_PROPERTY_ID && hasValue(p))
    : (props.type?.properties ?? []).filter((p) => p.id !== BLOCKED_PROPERTY_ID && !props.hide?.includes(p.id) && hasValue(p)).slice(0, props.variant === 'wall' ? 4 : 2)
)
</script>

<template>
  <RouterLink
    :to="`/o/${object.id}`"
    class="group flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm transition hover:border-line-strong hover:shadow-md"
    :class="variant === 'wall' ? 'mb-3 break-inside-avoid' : ''"
  >
    <img
      v-if="image && variant !== 'kanban'"
      :src="image"
      alt=""
      loading="lazy"
      class="w-full bg-hover object-cover"
      @error="broken = true"
      :class="variant === 'gallery' ? 'aspect-[4/3]' : variant === 'wall' ? 'max-h-64' : 'h-32'"
    />
    <div v-else-if="variant === 'gallery'" class="grid aspect-[4/3] w-full place-items-center bg-hover text-ink-faint">
      <AppIcon :icon="type?.icon" fallback="ph:image" :size="28" />
    </div>
    <div class="flex flex-1 flex-col gap-1.5 p-3">
      <span v-if="variant !== 'kanban'" class="inline-flex w-fit items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium" :class="chip(type?.color)">
        <AppIcon :icon="type?.icon" fallback="ph:cube" :size="12" />{{ type?.name }}
      </span>
      <div class="flex items-start gap-1.5 font-semibold leading-snug">
        <AppIcon v-if="object.icon" :icon="object.icon" :class="type?.color ? iconTextClasses[type.color] : ''" class="mt-0.5" />
        <span class="line-clamp-3">{{ displayTitle(object, type) }}</span>
        <span v-if="blocked" class="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-md bg-red-100 px-1.5 py-0.5 text-[11px] font-medium text-red-700 dark:bg-red-950 dark:text-red-300" title="Blocked">
          <AppIcon fallback="ph:flag-fill" :size="11" /> Blocked
        </span>
      </div>
      <p
        v-if="object.preview && variant !== 'gallery'"
        class="text-sm text-ink-soft"
        :class="variant === 'wall' ? 'line-clamp-[10] whitespace-pre-line' : 'line-clamp-2'"
      >
        {{ object.preview }}
      </p>
      <div v-for="def in shownProps" :key="def.id" class="flex min-w-0 gap-1 text-xs text-ink-soft">
        <!-- A computed number or text says what it is. -->
        <span v-if="def.kind === 'formula'" class="shrink-0 text-ink-faint">{{ def.name }}</span>
        <PropertyDisplay :def="def" :value="object.props[def.id]" :object="object" />
      </div>
      <div v-if="object.tagIds.length" class="mt-auto flex flex-wrap gap-1 pt-1" @click.prevent>
        <ObjectChip v-for="id in object.tagIds" :key="id" :id="id" tag />
      </div>
    </div>
  </RouterLink>
</template>
