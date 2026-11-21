<script setup lang="ts">
// What members did to an object (core activity.ts), newest first, folded under a header. The server
// keeps it, so it is read from there (the service worker's last answer while offline).
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { ActivityEntry, Id, ObjectType, PropertyDef } from '@vasta/core'
import { api } from '../lib/api.ts'
import { formatDate, formatRelative } from '../lib/format.ts'
import { locale, propName, t, typeName } from '../lib/i18n.ts'
import { onChange } from '../lib/events.ts'
import { personName } from '../lib/people.ts'
import { typesById } from '../lib/state.ts'
import AppIcon from './AppIcon.vue'
import PersonAvatar from './PersonAvatar.vue'
import PropertyDisplay from './PropertyDisplay.vue'

const props = defineProps<{ objectId: Id; type: ObjectType | undefined }>()

const entries = ref<ActivityEntry[]>([])
const failed = ref(false)
const open = ref(false)
const shown = ref(20)

async function load() {
  try {
    entries.value = await api.objectActivity(props.objectId)
    failed.value = false
  } catch {
    failed.value = true
  }
}
watch(() => props.objectId, () => ((shown.value = 20), load()), { immediate: true })
// Another member's change (or this page's save) comes back as a change event.
let timer: ReturnType<typeof setTimeout> | undefined
const stop = onChange((event) => {
  if (event.kind !== 'object' || event.id !== props.objectId) return
  clearTimeout(timer)
  timer = setTimeout(load, 800)
})
onBeforeUnmount(() => {
  stop()
  clearTimeout(timer)
})

const defOf = (field: string | undefined): PropertyDef | undefined => props.type?.properties.find((p) => p.id === field)

const FIELD_KEYS: Record<string, 'object.titleLabel' | 'common.type' | 'dateEditor.date'> = {
  title: 'object.titleLabel',
  typeId: 'common.type',
  date: 'dateEditor.date',
}
const builtin = (entry: ActivityEntry) => !!FIELD_KEYS[entry.field ?? '']
// Without the type (an object of another space) a property's name and values cannot be shown.
const fieldName = (entry: ActivityEntry) => {
  const key = FIELD_KEYS[entry.field ?? '']
  if (key) return t(key)
  const def = defOf(entry.field)
  if (def) return propName(def)
  return props.type ? t('activity.deletedProp') : t('activity.prop')
}

const VERB_KEYS: Record<ActivityEntry['kind'], 'activity.created' | 'activity.changed' | 'activity.trashed' | 'activity.restored'> = {
  created: 'activity.created',
  changed: 'activity.changed',
  trashed: 'activity.trashed',
  restored: 'activity.restored',
}

/** A value of a built-in field as text: a title, a type's name, a date. */
function plain(entry: ActivityEntry, value: unknown): string {
  if (value === undefined) return t('activity.empty')
  if (entry.field === 'typeId') {
    const found = typesById.value.get(String(value))
    return found ? typeName(found) : t('activity.deletedType')
  }
  if (entry.field === 'date') return formatDate(value as never)
  return String(value)
}

const visible = computed(() => entries.value.slice(0, shown.value))
</script>

<template>
  <section v-if="entries.length || failed" class="mt-10">
    <button class="flex items-center gap-1.5 text-sm font-semibold text-ink-soft hover:text-ink" @click="open = !open">
      <AppIcon :fallback="open ? 'ph:caret-down' : 'ph:caret-right'" :size="12" />
      {{ t('activity.title') }}
      <span v-if="entries.length" class="font-normal text-ink-faint">{{ entries.length }}</span>
    </button>
    <template v-if="open">
      <p v-if="failed && !entries.length" class="mt-2 text-sm text-ink-faint">{{ t('activity.offline') }}</p>
      <ol class="mt-2 space-y-1.5">
        <li v-for="entry in visible" :key="entry.id" class="flex items-start gap-2 text-sm">
          <PersonAvatar v-if="entry.actor" :id="entry.actor" :size="18" class="mt-0.5" />
          <div class="min-w-0 flex-1 text-ink-soft">
            <span class="font-medium text-ink">{{ entry.actor ? personName(entry.actor) : t('common.someone') }}</span><span v-if="entry.via" class="text-ink-faint">{{ t('object.via', { agent: entry.via }) }}</span>
            {{ t(VERB_KEYS[entry.kind]) }}
            <template v-if="entry.kind === 'changed'">
              <span class="text-ink">{{ fieldName(entry) }}</span>
              <span v-if="builtin(entry) || defOf(entry.field)" class="ml-1 inline-flex flex-wrap items-center gap-1 align-middle">
                <template v-if="!builtin(entry)">
                  <span v-if="entry.before === undefined" class="text-ink-faint">{{ t('activity.empty') }}</span>
                  <PropertyDisplay v-else :def="defOf(entry.field)!" :value="entry.before as never" :wrap="false" class="line-through decoration-ink-faint/60" />
                  <AppIcon fallback="ph:arrow-right" :size="12" class="text-ink-faint" />
                  <span v-if="entry.after === undefined" class="text-ink-faint">{{ t('activity.empty') }}</span>
                  <PropertyDisplay v-else :def="defOf(entry.field)!" :value="entry.after as never" :wrap="false" />
                </template>
                <template v-else>
                  <span class="line-through decoration-ink-faint/60">{{ plain(entry, entry.before) }}</span>
                  <AppIcon fallback="ph:arrow-right" :size="12" class="text-ink-faint" />
                  <span class="text-ink">{{ plain(entry, entry.after) }}</span>
                </template>
              </span>
            </template>
            <span class="ml-1 whitespace-nowrap text-xs text-ink-faint" :title="new Date(entry.at).toLocaleString(locale)">{{ formatRelative(entry.at) }}</span>
          </div>
        </li>
      </ol>
      <button v-if="entries.length > shown" class="mt-2 text-sm text-ink-faint hover:text-ink" @click="shown += 50">{{ t('inbox.showOlder') }}</button>
    </template>
  </section>
</template>
