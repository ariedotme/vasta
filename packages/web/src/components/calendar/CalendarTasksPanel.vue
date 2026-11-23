<script setup lang="ts">
// Scheduling sidebar beside the calendar: lists open tasks (and any opted-in dated custom types)
// grouped into Overdue, Unscheduled (no time / no date) and Scheduled. Dragging an item onto the
// calendar sets its primary date property; dragging a calendar entry back over this panel clears it.
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { statusProperty, type DateValue, type Id, type ObjectSummary, type ObjectType, type PropertyValue } from '@vasta/core'
import { createObject, dayKey } from '../../lib/actions.ts'
import { api } from '../../lib/api.ts'
import {
  formatClock,
  formatDayShort,
  isToday,
  setObjectSchedule,
  setTaskDone,
  viewerTimeZone,
  type CalendarView,
} from '../../lib/calendar.ts'
import { drag, pressScheduleItem, type ScheduleDragItem } from '../../lib/calendar-drag.ts'
import {
  canComplete,
  classifyScheduleItems,
  durationMinutesOf,
  isObjectDone,
  localDayOf,
  primaryDateOf,
  primaryDateProperty,
  schedulableTypes,
  scheduledDateForDrop,
} from '../../lib/calendar-tasks.ts'
import { chip, swatchClasses } from '../../lib/colors.ts'
import { onChange } from '../../lib/events.ts'
import { displayTitle } from '../../lib/format.ts'
import { t, typeName } from '../../lib/i18n.ts'
import { meId, sharedSpace } from '../../lib/people.ts'
import { lastError, primeSummaries, systemType, typesById, workspace } from '../../lib/state.ts'
import AppIcon from '../AppIcon.vue'
import ObjectLink from '../ObjectLink.vue'
import PopoverMenu from '../PopoverMenu.vue'
import TypeIcon from '../TypeIcon.vue'

const props = defineProps<{
  view: CalendarView
  anchor: string
}>()
const emit = defineEmits<{
  changed: []
  count: [count: number]
}>()

const storage = {
  get(key: string) {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value)
    } catch {}
  },
}

const spaceId = computed(() => workspace.space?.id ?? '')
const availableTypes = computed(() => schedulableTypes(workspace.types))
const taskType = computed(() => systemType('task'))

// Opt-in types shown in the sidebar (defaults to Task only, persisted per space).
const typesKey = computed(() => `vasta.calendar.sidebarTypes.${spaceId.value}`)
const scopeKey = computed(() => `vasta.calendar.sidebarScope.${spaceId.value}`)
const SHOW_DONE_KEY = 'vasta.calendar.sidebarShowDone'

const selectedTypeIds = ref<Id[]>([])
const scope = ref<string>('all')
const showDone = ref(storage.get(SHOW_DONE_KEY) === '1')
watch(showDone, (v) => storage.set(SHOW_DONE_KEY, v ? '1' : '0'))

function loadPreferences() {
  const valid = new Set(availableTypes.value.map((item) => item.id))
  const fallback = taskType.value && valid.has(taskType.value.id) ? [taskType.value.id] : availableTypes.value[0] ? [availableTypes.value[0].id] : []
  try {
    const raw = storage.get(typesKey.value)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (Array.isArray(parsed)) {
      const kept = parsed.filter((id): id is Id => typeof id === 'string' && valid.has(id))
      selectedTypeIds.value = kept.length ? kept : fallback
    } else {
      selectedTypeIds.value = fallback
    }
  } catch {
    selectedTypeIds.value = fallback
  }
  scope.value = storage.get(scopeKey.value) || 'all'
}
watch([spaceId, availableTypes], loadPreferences, { immediate: true })

const activeTypes = computed(() => selectedTypeIds.value.map((id) => typesById.value.get(id)).filter((item): item is ObjectType => !!item && !!primaryDateProperty(item)))

function toggleType(id: Id) {
  const has = selectedTypeIds.value.includes(id)
  if (has && selectedTypeIds.value.length <= 1) return
  selectedTypeIds.value = has ? selectedTypeIds.value.filter((x) => x !== id) : [...selectedTypeIds.value, id]
  storage.set(typesKey.value, JSON.stringify(selectedTypeIds.value))
  // If the selected saved view belonged to a type that was just turned off, reset scope.
  if (scope.value.startsWith('view:')) {
    const [, vTypeId] = scope.value.split(':')
    if (!selectedTypeIds.value.includes(vTypeId ?? '')) setScope('all')
  }
}

function setScope(next: string) {
  scope.value = next
  storage.set(scopeKey.value, next)
  scopeOpen.value = false
}

// Saved views offered in the scope picker (for the active types).
const savedViews = computed(() => {
  const list: { key: string; type: ObjectType; viewId: Id; name: string }[] = []
  for (const type of activeTypes.value) {
    for (const view of type.views) {
      list.push({ key: `view:${type.id}:${view.id}`, type, viewId: view.id, name: view.name })
    }
  }
  return list
})

const hasPersonField = computed(() => activeTypes.value.some((type) => type.properties.some((p) => p.kind === 'person')))

const activeSavedView = computed(() => {
  if (!scope.value.startsWith('view:')) return undefined
  return savedViews.value.find((entry) => entry.key === scope.value)
})

const scopeLabel = computed(() => {
  if (scope.value === 'mine' && sharedSpace.value && hasPersonField.value) return t('views.mine')
  if (activeSavedView.value) return activeSavedView.value.name
  return showDone.value ? t('calendar.tasks.all') : t('calendar.tasks.allOpen')
})

/** Show the small colored type chip on rows when multiple types are mixed together. */
const showTypeChip = computed(() => activeTypes.value.length > 1 && !activeSavedView.value)

// Data loading ----------------------------------------------------------------
const items = ref<ObjectSummary[]>([])
const loading = ref(false)
let requestId = 0

async function load() {
  if (!workspace.space || !activeTypes.value.length) {
    items.value = []
    return
  }
  const id = ++requestId
  loading.value = true
  try {
    const viewEntry = activeSavedView.value
    const viewDef = viewEntry?.type.views.find((v) => v.id === viewEntry.viewId)
    const typeIds = viewEntry ? [viewEntry.type.id] : activeTypes.value.map((item) => item.id)
    const list = await api.query(workspace.space.id, {
      query: { typeIds, ...(viewDef?.filter ? { filter: viewDef.filter } : {}) },
      today: dayKey(),
      timeZone: viewerTimeZone(),
    })
    if (id !== requestId) return
    primeSummaries(list)
    if (scope.value === 'mine' && sharedSpace.value && hasPersonField.value) {
      const me = meId()
      items.value = me
        ? list.filter((obj) => {
            const type = typesById.value.get(obj.typeId)
            return type?.properties.some((p) => {
              if (p.kind !== 'person') return false
              const value = obj.props[p.id]
              return value?.kind === 'person' && value.value.includes(me)
            })
          })
        : list
    } else {
      items.value = list
    }
  } catch (error) {
    lastError.value = (error as Error).message
  } finally {
    if (id === requestId) loading.value = false
  }
}

watch([spaceId, () => selectedTypeIds.value.join(','), scope], () => void load(), { immediate: true })

let reloadTimer: ReturnType<typeof setTimeout> | undefined
const stopListening = onChange(() => {
  clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => void load(), 300)
})
onBeforeUnmount(() => {
  stopListening()
  clearTimeout(reloadTimer)
})

const buckets = computed(() =>
  classifyScheduleItems(items.value, typesById.value, {
    today: dayKey(),
    view: props.view,
    showDone: showDone.value,
  })
)

watch(
  () => buckets.value.overdue.length + buckets.value.unscheduled.length,
  (count) => emit('count', count),
  { immediate: true }
)

// Section folding -------------------------------------------------------------
const openSections = reactive({ overdue: true, unscheduled: true, scheduled: false })

// Quick-add -------------------------------------------------------------------
const newTitle = ref('')
const creating = ref(false)
const createTypeId = ref<Id>('')
const createTypeAnchor = ref<HTMLElement | null>(null)
const createTypeOpen = ref(false)

const createType = computed<ObjectType | undefined>(() => {
  if (activeSavedView.value) return activeSavedView.value.type
  const picked = activeTypes.value.find((item) => item.id === createTypeId.value)
  return picked ?? activeTypes.value.find((item) => item.system === 'task') ?? activeTypes.value[0]
})

async function quickCreate() {
  const title = newTitle.value.trim()
  const target = createType.value
  if (!title || !target || creating.value) return
  creating.value = true
  try {
    const propsMap: Record<Id, PropertyValue> = {}
    const statusDef = statusProperty(target)
    const todo = statusDef?.options.find((o) => o.status === 'todo')
    if (statusDef && todo) propsMap[statusDef.id] = { kind: 'select', value: [todo.id] }
    await createObject(target.id, { title, props: propsMap }, false)
    newTitle.value = ''
    await load()
    emit('changed')
  } catch (error) {
    lastError.value = (error as Error).message
  } finally {
    creating.value = false
  }
}

// Actions on rows -------------------------------------------------------------
async function toggleItemDone(item: ObjectSummary) {
  const type = typesById.value.get(item.typeId)
  if (!canComplete(type)) return
  try {
    await setTaskDone(item.id, type, !isObjectDone(item, type))
    await load()
    emit('changed')
  } catch (error) {
    lastError.value = (error as Error).message
  }
}

async function clearItemDate(item: ObjectSummary) {
  const type = typesById.value.get(item.typeId)
  const field = primaryDateProperty(type)
  if (!field) return
  try {
    await setObjectSchedule(item.id, field.id, undefined)
    await load()
    emit('changed')
  } catch (error) {
    lastError.value = (error as Error).message
  }
}

async function scheduleForAnchorDay(item: ObjectSummary) {
  const type = typesById.value.get(item.typeId)
  const field = primaryDateProperty(type)
  if (!field) return
  try {
    const next = scheduledDateForDrop(primaryDateOf(item, type), { day: props.anchor })
    await setObjectSchedule(item.id, field.id, next)
    await load()
    emit('changed')
  } catch (error) {
    lastError.value = (error as Error).message
  }
}

function startDrag(event: PointerEvent, item: ObjectSummary) {
  if ((event.target as HTMLElement).closest('button')) return
  const type = typesById.value.get(item.typeId)
  const field = primaryDateProperty(type)
  if (!type || !field) return
  const currentDate = primaryDateOf(item, type)
  const dragItem: ScheduleDragItem = {
    objectId: item.id,
    field: field.id,
    title: displayTitle(item, type),
    color: type.color,
    icon: item.icon ?? type.icon,
    fallbackIcon: type.system === 'task' ? 'ph:check-circle' : 'ph:cube',
    currentDate,
    durationMinutes: durationMinutesOf(currentDate),
  }
  pressScheduleItem(event, dragItem, async (dropped, target) => {
    try {
      const next = scheduledDateForDrop(dropped.currentDate, target)
      await setObjectSchedule(dropped.objectId, dropped.field, next)
      await load()
      emit('changed')
    } catch (error) {
      lastError.value = (error as Error).message
    }
  })
}

// Formatting helpers ----------------------------------------------------------
function formatDateMeta(date: DateValue | undefined): string {
  if (!date) return ''
  const day = localDayOf(date)
  const dayText = isToday(day) ? t('common.today') : formatDayShort(day)
  if (date.resolution === 'time') {
    const time = date.end ? `${formatClock(date.start)} – ${formatClock(date.end)}` : formatClock(date.start)
    return `${dayText}, ${time}`
  }
  return dayText
}

function priorityColor(item: ObjectSummary): string | undefined {
  const type = typesById.value.get(item.typeId)
  const prop = type?.properties.find((p) => p.id === 'priority' && p.kind === 'select')
  const val = item.props.priority
  if (!prop || prop.kind !== 'select' || val?.kind !== 'select' || !val.value.length) return undefined
  const option = prop.options.find((o) => o.id === val.value[0])
  return option?.color ? swatchClasses[option.color] : undefined
}

const canUnscheduleDrop = computed(() => drag.active && drag.mode === 'move' && drag.entry?.kind === 'property' && !drag.entry.recurring)
const hoveringUnschedule = computed(() => canUnscheduleDrop.value && !!drag.target?.unschedule)

const scopeAnchor = ref<HTMLElement | null>(null)
const scopeOpen = ref(false)
const optionsAnchor = ref<HTMLElement | null>(null)
const optionsOpen = ref(false)

onMounted(() => void load())
</script>

<template>
  <div class="relative flex h-full min-h-0 flex-col" data-unschedule-drop>
    <!-- Header: scope picker + options -->
    <div class="flex items-center gap-1 px-3 pb-2 pt-3">
      <button
        ref="scopeAnchor"
        class="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-sm font-medium text-ink hover:bg-hover"
        @click="scopeOpen = !scopeOpen"
      >
        <span class="truncate">{{ scopeLabel }}</span>
        <AppIcon fallback="ph:caret-down" :size="12" class="shrink-0 text-ink-faint" />
      </button>

      <AppIcon v-if="loading" fallback="ph:circle-notch" :size="13" class="animate-spin text-ink-faint" />

      <button
        ref="optionsAnchor"
        class="ml-auto grid h-7 w-7 shrink-0 place-items-center rounded-md text-ink-soft hover:bg-hover hover:text-ink"
        :class="optionsOpen ? 'bg-hover text-ink' : ''"
        :title="t('calendar.tasks.options')"
        @click="optionsOpen = !optionsOpen"
      >
        <AppIcon fallback="ph:sliders-horizontal" :size="15" />
      </button>
    </div>

    <!-- Quick-add input -->
    <form v-if="createType" class="flex items-center gap-1.5 border-b border-line px-3 pb-2.5" @submit.prevent="quickCreate">
      <button
        v-if="activeTypes.length > 1 && !activeSavedView"
        ref="createTypeAnchor"
        type="button"
        class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-line hover:bg-hover"
        :title="typeName(createType)"
        @click="createTypeOpen = !createTypeOpen"
      >
        <TypeIcon :icon="createType.icon" :color="createType.color" :size="14" />
      </button>
      <input
        v-model="newTitle"
        type="text"
        :disabled="creating"
        :placeholder="createType.system === 'task' ? t('calendar.tasks.addPlaceholder') : t('calendar.tasks.addTypePlaceholder', { type: typeName(createType) })"
        class="min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 py-1 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent"
      />
    </form>

    <!-- Sections -->
    <div v-if="!availableTypes.length" class="p-4 text-xs text-ink-faint">
      {{ t('calendar.quick.noDateTypes') }}
    </div>
    <div v-else class="flex-1 space-y-3 overflow-y-auto px-2.5 py-2.5">
      <!-- Overdue -->
      <section v-if="buckets.overdue.length" class="space-y-1">
        <button
          class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-xs font-medium text-red-600 hover:bg-hover dark:text-red-400"
          @click="openSections.overdue = !openSections.overdue"
        >
          <AppIcon :fallback="openSections.overdue ? 'ph:caret-down' : 'ph:caret-right'" :size="11" />
          <span>{{ t('calendar.tasks.overdue') }}</span>
          <span class="ml-auto tabular-nums opacity-80">{{ buckets.overdue.length }}</span>
        </button>
        <div v-if="openSections.overdue" class="space-y-1">
          <div
            v-for="item in buckets.overdue"
            :key="item.id"
            class="group flex cursor-grab items-start gap-2 rounded-lg border border-line bg-surface px-2 py-1.5 hover:border-line-strong active:cursor-grabbing"
            :class="drag.active && drag.scheduleItem?.objectId === item.id ? 'opacity-40' : ''"
            @pointerdown="startDrag($event, item)"
          >
            <button
              v-if="canComplete(typesById.get(item.typeId))"
              class="mt-0.5 shrink-0 text-ink-soft hover:text-accent"
              :title="isObjectDone(item, typesById.get(item.typeId)) ? t('calendar.markAsTodo') : t('calendar.markAsDone')"
              @click.stop="toggleItemDone(item)"
            >
              <AppIcon :fallback="isObjectDone(item, typesById.get(item.typeId)) ? 'ph:check-circle-fill' : 'ph:circle'" :size="15" />
            </button>
            <TypeIcon v-else class="mt-0.5 shrink-0" :icon="item.icon ?? typesById.get(item.typeId)?.icon" :color="typesById.get(item.typeId)?.color" :size="14" />

            <div class="min-w-0 flex-1">
              <ObjectLink
                :id="item.id"
                draggable="false"
                class="block truncate text-sm leading-snug text-ink hover:underline"
                :class="isObjectDone(item, typesById.get(item.typeId)) ? 'line-through opacity-60' : ''"
              >
                {{ displayTitle(item, typesById.get(item.typeId)) }}
              </ObjectLink>
              <div class="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                <span
                  v-if="showTypeChip && typesById.get(item.typeId)"
                  class="inline-flex max-w-full items-center gap-1 rounded px-1 py-[1px] text-[11px] font-medium"
                  :class="chip(typesById.get(item.typeId)?.color)"
                >
                  <AppIcon :icon="typesById.get(item.typeId)?.icon" fallback="ph:cube" :size="10" />
                  <span class="truncate">{{ typeName(typesById.get(item.typeId)!) }}</span>
                </span>
                <span v-if="priorityColor(item)" class="h-1.5 w-1.5 shrink-0 rounded-full" :class="priorityColor(item)" />
                <span class="tabular-nums text-red-600 dark:text-red-400">{{ formatDateMeta(primaryDateOf(item, typesById.get(item.typeId))) }}</span>
              </div>
            </div>

            <div class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
              <button
                v-if="view === 'day'"
                class="rounded p-0.5 text-ink-faint hover:bg-hover hover:text-ink"
                :title="t('calendar.tasks.scheduleForDay')"
                @click.stop="scheduleForAnchorDay(item)"
              >
                <AppIcon fallback="ph:calendar-plus" :size="13" />
              </button>
              <button
                class="rounded p-0.5 text-ink-faint hover:bg-hover hover:text-ink"
                :title="t('calendar.tasks.unschedule')"
                @click.stop="clearItemDate(item)"
              >
                <AppIcon fallback="ph:x" :size="12" />
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- Unscheduled (No time / No date) -->
      <section class="space-y-1">
        <button
          class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-xs font-medium text-ink-soft hover:bg-hover"
          @click="openSections.unscheduled = !openSections.unscheduled"
        >
          <AppIcon :fallback="openSections.unscheduled ? 'ph:caret-down' : 'ph:caret-right'" :size="11" />
          <span>{{ view === 'month' ? t('calendar.tasks.noDate') : t('calendar.tasks.noTime') }}</span>
          <span class="ml-auto tabular-nums text-ink-faint">{{ buckets.unscheduled.length }}</span>
        </button>
        <div v-if="openSections.unscheduled" class="space-y-1">
          <p v-if="!buckets.unscheduled.length" class="rounded-lg border border-dashed border-line px-2.5 py-2 text-center text-xs text-ink-faint">
            {{ t('calendar.tasks.emptyUnscheduled') }}
          </p>
          <div
            v-for="item in buckets.unscheduled"
            :key="item.id"
            class="group flex cursor-grab items-start gap-2 rounded-lg border border-line bg-surface px-2 py-1.5 hover:border-line-strong active:cursor-grabbing"
            :class="[
              drag.active && drag.scheduleItem?.objectId === item.id ? 'opacity-40' : '',
              isObjectDone(item, typesById.get(item.typeId)) ? 'opacity-60' : '',
            ]"
            @pointerdown="startDrag($event, item)"
          >
            <button
              v-if="canComplete(typesById.get(item.typeId))"
              class="mt-0.5 shrink-0 text-ink-soft hover:text-accent"
              :title="isObjectDone(item, typesById.get(item.typeId)) ? t('calendar.markAsTodo') : t('calendar.markAsDone')"
              @click.stop="toggleItemDone(item)"
            >
              <AppIcon :fallback="isObjectDone(item, typesById.get(item.typeId)) ? 'ph:check-circle-fill' : 'ph:circle'" :size="15" />
            </button>
            <TypeIcon v-else class="mt-0.5 shrink-0" :icon="item.icon ?? typesById.get(item.typeId)?.icon" :color="typesById.get(item.typeId)?.color" :size="14" />

            <div class="min-w-0 flex-1">
              <ObjectLink
                :id="item.id"
                draggable="false"
                class="block truncate text-sm leading-snug text-ink hover:underline"
                :class="isObjectDone(item, typesById.get(item.typeId)) ? 'line-through' : ''"
              >
                {{ displayTitle(item, typesById.get(item.typeId)) }}
              </ObjectLink>
              <div
                v-if="showTypeChip || priorityColor(item) || primaryDateOf(item, typesById.get(item.typeId))"
                class="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs"
              >
                <span
                  v-if="showTypeChip && typesById.get(item.typeId)"
                  class="inline-flex max-w-full items-center gap-1 rounded px-1 py-[1px] text-[11px] font-medium"
                  :class="chip(typesById.get(item.typeId)?.color)"
                >
                  <AppIcon :icon="typesById.get(item.typeId)?.icon" fallback="ph:cube" :size="10" />
                  <span class="truncate">{{ typeName(typesById.get(item.typeId)!) }}</span>
                </span>
                <span v-if="priorityColor(item)" class="h-1.5 w-1.5 shrink-0 rounded-full" :class="priorityColor(item)" />
                <span v-if="primaryDateOf(item, typesById.get(item.typeId))" class="tabular-nums text-ink-faint">
                  {{ formatDateMeta(primaryDateOf(item, typesById.get(item.typeId))) }}
                </span>
              </div>
            </div>

            <div class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
              <button
                v-if="view === 'day' && (!primaryDateOf(item, typesById.get(item.typeId)) || localDayOf(primaryDateOf(item, typesById.get(item.typeId))!) !== anchor)"
                class="rounded p-0.5 text-ink-faint hover:bg-hover hover:text-ink"
                :title="t('calendar.tasks.scheduleForDay')"
                @click.stop="scheduleForAnchorDay(item)"
              >
                <AppIcon fallback="ph:calendar-plus" :size="13" />
              </button>
              <button
                v-if="primaryDateOf(item, typesById.get(item.typeId))"
                class="rounded p-0.5 text-ink-faint hover:bg-hover hover:text-ink"
                :title="t('calendar.tasks.unschedule')"
                @click.stop="clearItemDate(item)"
              >
                <AppIcon fallback="ph:x" :size="12" />
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- Scheduled -->
      <section v-if="buckets.scheduled.length" class="space-y-1 border-t border-line pt-2">
        <button
          class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-xs font-medium text-ink-soft hover:bg-hover"
          @click="openSections.scheduled = !openSections.scheduled"
        >
          <AppIcon :fallback="openSections.scheduled ? 'ph:caret-down' : 'ph:caret-right'" :size="11" />
          <span>{{ t('calendar.tasks.scheduled') }}</span>
          <span class="ml-auto tabular-nums text-ink-faint">{{ buckets.scheduled.length }}</span>
        </button>
        <div v-if="openSections.scheduled" class="space-y-1">
          <div
            v-for="item in buckets.scheduled"
            :key="item.id"
            class="group flex cursor-grab items-start gap-2 rounded-lg border border-line bg-surface px-2 py-1.5 hover:border-line-strong active:cursor-grabbing"
            :class="[
              drag.active && drag.scheduleItem?.objectId === item.id ? 'opacity-40' : '',
              isObjectDone(item, typesById.get(item.typeId)) ? 'opacity-60' : '',
            ]"
            @pointerdown="startDrag($event, item)"
          >
            <button
              v-if="canComplete(typesById.get(item.typeId))"
              class="mt-0.5 shrink-0 text-ink-soft hover:text-accent"
              :title="isObjectDone(item, typesById.get(item.typeId)) ? t('calendar.markAsTodo') : t('calendar.markAsDone')"
              @click.stop="toggleItemDone(item)"
            >
              <AppIcon :fallback="isObjectDone(item, typesById.get(item.typeId)) ? 'ph:check-circle-fill' : 'ph:circle'" :size="15" />
            </button>
            <TypeIcon v-else class="mt-0.5 shrink-0" :icon="item.icon ?? typesById.get(item.typeId)?.icon" :color="typesById.get(item.typeId)?.color" :size="14" />

            <div class="min-w-0 flex-1">
              <ObjectLink
                :id="item.id"
                draggable="false"
                class="block truncate text-sm leading-snug text-ink hover:underline"
                :class="isObjectDone(item, typesById.get(item.typeId)) ? 'line-through' : ''"
              >
                {{ displayTitle(item, typesById.get(item.typeId)) }}
              </ObjectLink>
              <div class="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                <span
                  v-if="showTypeChip && typesById.get(item.typeId)"
                  class="inline-flex max-w-full items-center gap-1 rounded px-1 py-[1px] text-[11px] font-medium"
                  :class="chip(typesById.get(item.typeId)?.color)"
                >
                  <AppIcon :icon="typesById.get(item.typeId)?.icon" fallback="ph:cube" :size="10" />
                  <span class="truncate">{{ typeName(typesById.get(item.typeId)!) }}</span>
                </span>
                <span class="tabular-nums text-accent">{{ formatDateMeta(primaryDateOf(item, typesById.get(item.typeId))) }}</span>
              </div>
            </div>

            <button
              class="shrink-0 rounded p-0.5 text-ink-faint opacity-0 transition-opacity hover:bg-hover hover:text-ink group-hover:opacity-100 [@media(hover:none)]:opacity-100"
              :title="t('calendar.tasks.unschedule')"
              @click.stop="clearItemDate(item)"
            >
              <AppIcon fallback="ph:x" :size="12" />
            </button>
          </div>
        </div>
      </section>
    </div>

    <!-- Drop overlay when dragging a calendar entry back onto the sidebar to unschedule -->
    <div
      v-if="canUnscheduleDrop"
      class="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center rounded-xl border-2 border-dashed p-4 text-center backdrop-blur-[1px] transition-colors"
      :class="hoveringUnschedule ? 'border-accent bg-accent/10 text-accent' : 'border-line-strong bg-surface/90 text-ink-soft'"
    >
      <AppIcon fallback="ph:calendar-x" :size="22" class="mb-1.5" />
      <span class="text-sm font-medium">{{ t('calendar.tasks.dropToUnschedule') }}</span>
    </div>

    <!-- Scope popover -->
    <PopoverMenu v-model:open="scopeOpen" :anchor="scopeAnchor" placement="bottom-start" width="14rem">
      <button
        class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover"
        :class="scope === 'all' ? 'font-medium text-ink' : 'text-ink-soft'"
        @click="setScope('all')"
      >
        <AppIcon fallback="ph:list-checks" :size="14" class="text-ink-soft" />
        <span class="truncate">{{ showDone ? t('calendar.tasks.all') : t('calendar.tasks.allOpen') }}</span>
        <AppIcon v-if="scope === 'all'" fallback="ph:check" :size="13" class="ml-auto text-accent" />
      </button>
      <button
        v-if="sharedSpace && hasPersonField"
        class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover"
        :class="scope === 'mine' ? 'font-medium text-ink' : 'text-ink-soft'"
        @click="setScope('mine')"
      >
        <AppIcon fallback="ph:user" :size="14" class="text-ink-soft" />
        <span class="truncate">{{ t('views.mine') }}</span>
        <AppIcon v-if="scope === 'mine'" fallback="ph:check" :size="13" class="ml-auto text-accent" />
      </button>
      <template v-if="savedViews.length">
        <div class="mx-2.5 my-1 border-t border-line" />
        <button
          v-for="entry in savedViews"
          :key="entry.key"
          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover"
          :class="scope === entry.key ? 'font-medium text-ink' : 'text-ink-soft'"
          @click="setScope(entry.key)"
        >
          <TypeIcon v-if="activeTypes.length > 1" :icon="entry.type.icon" :color="entry.type.color" :size="13" />
          <AppIcon v-else fallback="ph:funnel" :size="13" class="text-ink-faint" />
          <span class="truncate">{{ entry.name }}</span>
          <AppIcon v-if="scope === entry.key" fallback="ph:check" :size="13" class="ml-auto text-accent" />
        </button>
      </template>
    </PopoverMenu>

    <!-- Options popover: opt-in types + show completed -->
    <PopoverMenu v-model:open="optionsOpen" :anchor="optionsAnchor" placement="bottom-end" width="15rem">
      <div class="px-2.5 py-1 text-xs font-medium text-ink-faint">{{ t('calendar.tasks.typesHeading') }}</div>
      <label
        v-for="item in availableTypes"
        :key="item.id"
        class="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm hover:bg-hover"
      >
        <input
          type="checkbox"
          class="h-4 w-4 accent-[var(--color-accent)]"
          :checked="selectedTypeIds.includes(item.id)"
          :disabled="selectedTypeIds.includes(item.id) && selectedTypeIds.length <= 1"
          @change="toggleType(item.id)"
        />
        <TypeIcon :icon="item.icon" :color="item.color" :size="14" />
        <span class="truncate">{{ typeName(item) }}</span>
      </label>
      <div class="mx-2.5 my-1 border-t border-line" />
      <label class="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm hover:bg-hover">
        <input v-model="showDone" type="checkbox" class="h-4 w-4 accent-[var(--color-accent)]" />
        <AppIcon fallback="ph:check-circle" :size="14" class="text-ink-soft" />
        <span>{{ t('calendar.tasks.showDone') }}</span>
      </label>
    </PopoverMenu>

    <!-- Quick-add type picker (only when multiple types are enabled) -->
    <PopoverMenu v-model:open="createTypeOpen" :anchor="createTypeAnchor" placement="bottom-start" width="12rem">
      <button
        v-for="item in activeTypes"
        :key="item.id"
        class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover"
        @click="(createTypeId = item.id), (createTypeOpen = false)"
      >
        <TypeIcon :icon="item.icon" :color="item.color" :size="14" />
        <span class="truncate">{{ typeName(item) }}</span>
        <AppIcon v-if="createType?.id === item.id" fallback="ph:check" :size="13" class="ml-auto text-accent" />
      </button>
    </PopoverMenu>
  </div>
</template>
