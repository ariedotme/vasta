<script setup lang="ts">
// The board layout: a column per group of `groupField`, optionally in rows (swimlanes) by a second
// field. Cards keep a manual order (core rank.ts) while `manual`, move by dragging (lib/board.ts:
// a mouse at once, a finger after a long press), and are made with "+" at the bottom of a column.
// Columns fold, lanes collapse, both reorder by dragging their handle or via their menu, and
// columns can have a WIP limit; all are saved on the view's settings (`board`).
import { computed, nextTick, ref } from 'vue'
import type { BoardSettings, Id, ObjectRecord, ObjectSummary } from '@vasta/core'
import { RANK_PROPERTY_ID, byRank, rankOf, rankBetween } from '@vasta/core'
import { createObject } from '../lib/actions.ts'
import { boardDrag, moveCard, pressCard, pressSection, sectionDrag, type BoardAxis, type CardTarget } from '../lib/board.ts'
import { moveKey, orderGroups, shiftKey, toggleKey } from '../lib/board-sections.ts'
import { resolveCard } from '../lib/cards.ts'
import { chip } from '../lib/colors.ts'
import { displayTitle } from '../lib/format.ts'
import { t } from '../lib/i18n.ts'
import { openMenuAt, promptDialog, type MenuItem } from '../lib/overlays.ts'
import { groupObjects, isDateField, movableField, NO_VALUE, placeInGroup, typesOf, type Group } from '../lib/query.ts'
import { lastError, summaryOf, typesById } from '../lib/state.ts'
import AppIcon from './AppIcon.vue'
import ObjectCard from './ObjectCard.vue'
import ObjectChip from './ObjectChip.vue'
import PersonChip from './PersonChip.vue'

const props = defineProps<{
  objects: ObjectSummary[]
  groupField: string
  typeIds: Id[]
  board?: BoardSettings
  /** Cards in their manual order (the view has no sort of its own). */
  manual: boolean
}>()
const emit = defineEmits<{
  menu: [event: MouseEvent, object: ObjectSummary]
  moved: [object: ObjectRecord]
  created: [object: ObjectRecord]
  board: [board: BoardSettings]
  /** A card was dropped among others while the view sorts by a field: it should go back to the manual order. */
  manual: []
}>()

const types = computed(() => typesOf(props.typeIds))
const typeOf = (object: ObjectSummary) => typesById.value.get(object.typeId)
const laneField = computed(() => (props.board?.swimlanes && props.board.swimlanes !== props.groupField ? props.board.swimlanes : ''))

const columnsFixed = computed(() => isDateField(props.groupField, types.value))
const lanesFixed = computed(() => !laneField.value || isDateField(laneField.value, types.value))

const columns = computed<Group[]>(() => orderGroups(groupObjects(props.objects, props.groupField, types.value, true), props.board?.columnOrder, columnsFixed.value))
const lanes = computed<Group[]>(() =>
  laneField.value ? orderGroups(groupObjects(props.objects, laneField.value, types.value, false), props.board?.laneOrder, lanesFixed.value) : [{ key: '', label: '', items: props.objects }]
)

const canReorderColumns = computed(() => !columnsFixed.value && columns.value.length > 1)
const canReorderLanes = computed(() => !lanesFixed.value && lanes.value.length > 1)

/** Readable name for a group, including tag/relation groups whose `label` is empty in query.ts. */
function groupTitle(group: Group): string {
  if (group.label) return group.label
  if (group.objectId) {
    const summary = summaryOf(group.objectId)
    return displayTitle(summary, typesById.value.get(summary?.typeId ?? ''))
  }
  return ''
}

/** The cards of a column in a lane, in the board's order. */
function cell(column: Group, lane: Group): ObjectSummary[] {
  const inLane = new Set(lane.items.map((o) => o.id))
  const items = laneField.value ? column.items.filter((o) => inLane.has(o.id)) : column.items
  return props.manual ? byRank(items) : items
}

// Columns & lanes: folding, collapsing, ordering and WIP limits ----------------
const collapsed = computed(() => new Set(props.board?.collapsed ?? []))
const collapsedLanes = computed(() => new Set(props.board?.collapsedLanes ?? []))
const allLanesCollapsed = computed(() => lanes.value.length > 0 && lanes.value.every((l) => collapsedLanes.value.has(l.key)))
const anyLaneCollapsed = computed(() => lanes.value.some((l) => collapsedLanes.value.has(l.key)))
const wip = (column: Group) => props.board?.wip?.[column.key]
const over = (column: Group) => (wip(column) ?? Infinity) < column.items.length

function setBoard(patch: Partial<BoardSettings>) {
  const next: BoardSettings = { ...(props.board ?? {}), ...patch }
  for (const key of Object.keys(next) as (keyof BoardSettings)[]) if (next[key] === undefined) delete next[key]
  emit('board', next)
}
function toggleFold(column: Group) {
  setBoard({ collapsed: toggleKey(props.board?.collapsed, column.key) })
}
function toggleLane(lane: Group) {
  setBoard({ collapsedLanes: toggleKey(props.board?.collapsedLanes, lane.key) })
}
function expandLane(laneKey: string) {
  if (collapsedLanes.value.has(laneKey)) setBoard({ collapsedLanes: toggleKey(props.board?.collapsedLanes, laneKey) })
}
function setAllLanesCollapsed(fold: boolean) {
  setBoard({ collapsedLanes: fold ? lanes.value.map((l) => l.key) : undefined })
}
function reorderColumn(key: string, toIndex: number) {
  const next = moveKey(columns.value.map((c) => c.key), key, toIndex)
  if (next) setBoard({ columnOrder: next })
}
function shiftColumn(column: Group, delta: -1 | 1) {
  const next = shiftKey(columns.value.map((c) => c.key), column.key, delta)
  if (next) setBoard({ columnOrder: next })
}
function reorderLane(key: string, toIndex: number) {
  const next = moveKey(lanes.value.map((l) => l.key), key, toIndex)
  if (next) setBoard({ laneOrder: next })
}
function shiftLane(lane: Group, delta: -1 | 1) {
  const next = shiftKey(lanes.value.map((l) => l.key), lane.key, delta)
  if (next) setBoard({ laneOrder: next })
}

async function setWip(column: Group) {
  const answer = await promptDialog({
    title: t('board.wipTitle', { column: groupTitle(column) || t('board.thisColumn') }),
    message: t('board.wipMessage'),
    value: wip(column) ? String(wip(column)) : '',
    placeholder: t('board.noLimit'),
    confirmLabel: t('board.setLimit'),
    optional: true,
  })
  if (answer === null) return
  const limit = Math.floor(Number(answer))
  const limits = { ...(props.board?.wip ?? {}) }
  if (answer.trim() && limit > 0) limits[column.key] = limit
  else delete limits[column.key]
  setBoard({ wip: Object.keys(limits).length ? limits : undefined })
}

function columnMenu(event: MouseEvent, column: Group) {
  const index = columns.value.findIndex((c) => c.key === column.key)
  const items: MenuItem[] = [
    {
      label: collapsed.value.has(column.key) ? t('board.unfoldColumn') : t('board.foldColumn'),
      icon: collapsed.value.has(column.key) ? 'ph:arrows-out-line-horizontal' : 'ph:arrows-in-line-horizontal',
      run: () => toggleFold(column),
    },
    { label: wip(column) ? t('board.wipLimitValue', { limit: wip(column)! }) : t('board.setWipLimit'), icon: 'ph:gauge', run: () => setWip(column) },
  ]
  if (canReorderColumns.value) {
    items.push({ kind: 'separator' })
    if (index > 0) items.push({ label: t('board.moveLeft'), icon: 'ph:arrow-left', run: () => shiftColumn(column, -1) })
    if (index < columns.value.length - 1) items.push({ label: t('board.moveRight'), icon: 'ph:arrow-right', run: () => shiftColumn(column, 1) })
    if (props.board?.columnOrder?.length) items.push({ label: t('board.resetOrder'), icon: 'ph:arrow-counter-clockwise', run: () => setBoard({ columnOrder: undefined }) })
  }
  openMenuAt(event.clientX, event.clientY, items)
}

function laneMenu(event: MouseEvent, lane: Group) {
  const index = lanes.value.findIndex((l) => l.key === lane.key)
  const isCollapsed = collapsedLanes.value.has(lane.key)
  const items: MenuItem[] = [
    {
      label: isCollapsed ? t('board.expandSection') : t('board.collapseSection'),
      icon: isCollapsed ? 'ph:arrows-out-line-vertical' : 'ph:arrows-in-line-vertical',
      run: () => toggleLane(lane),
    },
  ]
  if (canReorderLanes.value) {
    if (index > 0) items.push({ label: t('board.moveUp'), icon: 'ph:arrow-up', run: () => shiftLane(lane, -1) })
    if (index < lanes.value.length - 1) items.push({ label: t('board.moveDown'), icon: 'ph:arrow-down', run: () => shiftLane(lane, 1) })
    if (props.board?.laneOrder?.length) items.push({ label: t('board.resetOrder'), icon: 'ph:arrow-counter-clockwise', run: () => setBoard({ laneOrder: undefined }) })
  }
  items.push({ kind: 'separator' })
  if (!allLanesCollapsed.value) items.push({ label: t('board.collapseAllSections'), icon: 'ph:arrows-in-line-vertical', run: () => setAllLanesCollapsed(true) })
  if (anyLaneCollapsed.value) items.push({ label: t('board.expandAllSections'), icon: 'ph:arrows-out-line-vertical', run: () => setAllLanesCollapsed(false) })
  openMenuAt(event.clientX, event.clientY, items)
}

// Section drop indicators ------------------------------------------------------
const draggedLaneIndex = computed(() => (sectionDrag.active && sectionDrag.axis === 'lane' ? lanes.value.findIndex((l) => l.key === sectionDrag.key) : -1))
const laneDropBefore = (index: number) =>
  draggedLaneIndex.value >= 0 && sectionDrag.index === index && draggedLaneIndex.value !== index && draggedLaneIndex.value !== index - 1
const laneDropAfterLast = computed(
  () => draggedLaneIndex.value >= 0 && sectionDrag.index === lanes.value.length && draggedLaneIndex.value !== lanes.value.length - 1
)

const draggedColumnIndex = computed(() => (sectionDrag.active && sectionDrag.axis === 'column' ? columns.value.findIndex((c) => c.key === sectionDrag.key) : -1))
const colDropBefore = (index: number) =>
  draggedColumnIndex.value >= 0 && sectionDrag.index === index && draggedColumnIndex.value !== index && draggedColumnIndex.value !== index - 1
const colDropAfter = (index: number) =>
  draggedColumnIndex.value >= 0 && index === columns.value.length - 1 && sectionDrag.index === columns.value.length && draggedColumnIndex.value !== columns.value.length - 1

// Card sizing & fields hidden in automatic mode (the columns and lanes already say them, except dates).
const cardSize = computed(() => resolveCard('kanban', props.board).size)
const columnWidthClass = computed(() => (cardSize.value === 'sm' ? 'w-56' : cardSize.value === 'lg' ? 'w-[22rem] max-w-[85vw]' : 'w-72'))
const hiddenFields = computed(() => [props.groupField, laneField.value].filter((field): field is string => !!field && !isDateField(field, types.value)))

// Dragging cards ---------------------------------------------------------------
const columnAxis = computed<BoardAxis>(() => ({ field: props.groupField, groups: columns.value }))
const laneAxis = computed<BoardAxis | undefined>(() => (laneField.value ? { field: laneField.value, groups: lanes.value } : undefined))
const draggable = computed(() => movableField(props.groupField, types.value) && (!laneField.value || movableField(laneField.value, types.value)))

async function drop(cardId: Id, target: CardTarget) {
  const card = props.objects.find((o) => o.id === cardId)
  const column = columns.value.find((g) => g.key === target.column)
  const lane = lanes.value.find((g) => g.key === target.lane)
  if (!card || !column || !lane) return
  const cells = cell(column, lane)
  const sameCell = cells.some((o) => o.id === cardId)
  // Dropped back where it was: nothing to do.
  if (sameCell && cells.indexOf(card) === target.index) return
  // Reordering a column only makes sense in the manual order.
  if (sameCell && !props.manual) emit('manual')
  try {
    const saved = await moveCard(card, target, columnAxis.value, laneAxis.value, cells)
    for (const object of saved) emit('moved', object)
  } catch (error) {
    lastError.value = (error as Error).message
  }
}

// A finger's long press drags (on a phone that is also when the browser opens a menu: not here).
let lastPointer = ''
function onPress(event: PointerEvent, object: ObjectSummary) {
  lastPointer = event.pointerType
  if (draggable.value) pressCard(event, object.id, drop, expandLane)
}
function onContextMenu(event: MouseEvent, object: ObjectSummary) {
  if (lastPointer === 'touch' && draggable.value) event.preventDefault()
  else emit('menu', event, object)
}

/** A cell's cards with their place among the cards other than the one dragged (-1 for it). */
function placed(column: Group, lane: Group) {
  let place = 0
  return cell(column, lane).map((object) => ({ object, place: boardDrag.active && object.id === boardDrag.cardId ? -1 : place++ }))
}

/** Where the dragged card would land, to draw a bar there. */
const landing = (column: Group, lane: Group) => (boardDrag.active && boardDrag.target?.column === column.key && boardDrag.target.lane === lane.key ? boardDrag.target.index : -1)
const cellKey = (column: Group, lane: Group) => `${column.key}|${lane.key}`

// "+": a new card in a column (and lane), at its end -------------------------------
const addingIn = ref('')
const newTitle = ref('')
const newInput = ref<HTMLInputElement[]>([])
const canAdd = computed(() => props.typeIds.length === 1 && draggable.value)
async function startAdding(column: Group, lane: Group) {
  addingIn.value = cellKey(column, lane)
  newTitle.value = ''
  await nextTick()
  newInput.value[0]?.focus()
}
async function addCard(column: Group, lane: Group) {
  const title = newTitle.value.trim()
  const typeId = props.typeIds[0]
  if (!title || !typeId) {
    addingIn.value = ''
    return
  }
  const draft: Pick<ObjectRecord, 'typeId' | 'props' | 'tagIds'> = { typeId, props: {}, tagIds: [] }
  placeInGroup(draft, props.groupField, column, columns.value)
  if (laneField.value) placeInGroup(draft, laneField.value, lane, lanes.value)
  const last = cell(column, lane).at(-1)
  const lastRank = last && rankOf(last)
  if (props.manual && (lastRank || !last)) draft.props[RANK_PROPERTY_ID] = { kind: 'rank', value: rankBetween(lastRank) }
  newTitle.value = ''
  try {
    const created = await createObject(typeId, { title, props: draft.props, tagIds: draft.tagIds }, false)
    emit('created', created)
  } catch (error) {
    lastError.value = (error as Error).message
  }
  await nextTick()
  newInput.value[0]?.focus()
}
</script>

<template>
  <div class="overflow-x-auto pb-4" data-drag-scroll data-board-root>
    <div class="inline-flex min-w-full flex-col gap-3">
      <!-- With swimlanes, column headers sit in their own top row so collapsing any lane (even the first) keeps them visible. -->
      <div v-if="laneField" class="flex gap-3">
        <div
          v-for="(column, colIndex) in columns"
          :key="column.key"
          :data-board-col-header="column.key"
          class="group/col relative flex shrink-0 items-center gap-1.5 rounded-xl bg-raised text-sm ring-1 ring-line"
          :class="[
            collapsed.has(column.key) ? 'w-11 cursor-pointer flex-col px-1.5 py-2' : `${columnWidthClass} px-2.5 py-2`,
            sectionDrag.active && sectionDrag.axis === 'column' && sectionDrag.key === column.key ? 'opacity-50' : '',
          ]"
          @click="collapsed.has(column.key) && toggleFold(column)"
          @contextmenu.prevent="columnMenu($event, column)"
        >
          <div v-if="colDropBefore(colIndex)" class="pointer-events-none absolute -left-2 inset-y-0 w-1 rounded-full bg-accent" />
          <div v-if="colDropAfter(colIndex)" class="pointer-events-none absolute -right-2 inset-y-0 w-1 rounded-full bg-accent" />
          <span
            v-if="canReorderColumns && !collapsed.has(column.key)"
            class="-ml-1 cursor-grab touch-none rounded p-0.5 text-ink-faint opacity-0 hover:text-ink group-hover/col:opacity-100 active:cursor-grabbing [@media(hover:none)]:opacity-100"
            :title="t('views.dragToReorder')"
            @pointerdown.stop="pressSection($event, 'column', column.key, reorderColumn)"
          >
            <AppIcon fallback="ph:dots-six-vertical" :size="14" />
          </span>
          <template v-if="!collapsed.has(column.key)">
            <span v-if="column.objectId" class="min-w-0 truncate"><ObjectChip :id="column.objectId" :tag="groupField === 'tags'" /></span>
            <PersonChip v-else-if="column.personId" :id="column.personId" />
            <span v-else class="truncate rounded-md px-2 py-0.5 font-medium" :class="column.key === NO_VALUE ? 'text-ink-faint' : chip(column.color as never)">{{ column.label }}</span>
          </template>
          <span
            class="text-xs tabular-nums"
            :class="over(column) ? 'rounded-md bg-red-100 px-1.5 font-semibold text-red-700 dark:bg-red-950 dark:text-red-300' : 'text-ink-faint'"
            :title="wip(column) ? t('board.wipTooltip', { limit: wip(column)! }) : undefined"
            >{{ column.items.length }}<template v-if="wip(column)">/{{ wip(column) }}</template></span
          >
          <span v-if="collapsed.has(column.key)" class="max-h-28 truncate text-xs font-medium text-ink-soft [writing-mode:vertical-rl]">{{ groupTitle(column) || '…' }}</span>
          <button
            v-else
            class="ml-auto rounded-md p-0.5 text-ink-faint opacity-0 hover:bg-hover hover:text-ink group-hover/col:opacity-100 [@media(hover:none)]:opacity-100"
            :title="t('board.columnOptions')"
            @click.stop="columnMenu($event, column)"
          >
            <AppIcon fallback="ph:dots-three" :size="16" />
          </button>
        </div>
      </div>

      <template v-for="(lane, laneIndex) in lanes" :key="lane.key">
        <div v-if="laneField && laneDropBefore(laneIndex)" class="h-1 rounded-full bg-accent" />
        <div
          :data-board-lane="laneField ? lane.key : undefined"
          :class="sectionDrag.active && sectionDrag.axis === 'lane' && sectionDrag.key === lane.key ? 'opacity-50' : ''"
        >
          <!-- A lane's header: collapse toggle, drag handle, label, count and menu. -->
          <header
            v-if="laneField"
            :data-board-collapsed-lane="collapsedLanes.has(lane.key) ? lane.key : undefined"
            class="group/lane sticky left-0 flex w-fit items-center gap-1 rounded-lg px-1 py-0.5 text-sm transition-colors"
            :class="[
              collapsedLanes.has(lane.key) ? '' : 'mb-2',
              boardDrag.active && boardDrag.hoverLane === lane.key ? 'bg-hover ring-1 ring-accent' : '',
            ]"
            @contextmenu.prevent="laneMenu($event, lane)"
          >
            <span
              v-if="canReorderLanes"
              class="cursor-grab touch-none rounded p-0.5 text-ink-faint opacity-0 hover:text-ink group-hover/lane:opacity-100 active:cursor-grabbing [@media(hover:none)]:opacity-100"
              :title="t('views.dragToReorder')"
              @pointerdown.stop="pressSection($event, 'lane', lane.key, reorderLane)"
            >
              <AppIcon fallback="ph:dots-six-vertical" :size="14" />
            </span>
            <button
              type="button"
              class="grid h-6 w-6 place-items-center rounded-md text-ink-faint hover:bg-hover hover:text-ink"
              :aria-expanded="!collapsedLanes.has(lane.key)"
              :title="collapsedLanes.has(lane.key) ? t('board.expandSection') : t('board.collapseSection')"
              @click="toggleLane(lane)"
            >
              <AppIcon :fallback="collapsedLanes.has(lane.key) ? 'ph:caret-right' : 'ph:caret-down'" :size="13" />
            </button>
            <ObjectChip v-if="lane.objectId" :id="lane.objectId" :tag="laneField === 'tags'" />
            <PersonChip v-else-if="lane.personId" :id="lane.personId" />
            <button
              v-else
              type="button"
              class="rounded-md px-2 py-0.5 font-medium hover:opacity-85"
              :class="lane.key === NO_VALUE ? 'text-ink-faint' : chip(lane.color as never)"
              @click="toggleLane(lane)"
            >
              {{ lane.label }}
            </button>
            <button type="button" class="px-1 text-xs tabular-nums text-ink-faint hover:text-ink" @click="toggleLane(lane)">{{ lane.items.length }}</button>
            <button
              type="button"
              class="rounded-md p-0.5 text-ink-faint opacity-0 hover:bg-hover hover:text-ink group-hover/lane:opacity-100 [@media(hover:none)]:opacity-100"
              :title="t('board.sectionOptions')"
              @click.stop="laneMenu($event, lane)"
            >
              <AppIcon fallback="ph:dots-three" :size="16" />
            </button>
          </header>

          <div v-if="!laneField || !collapsedLanes.has(lane.key)" class="flex gap-3">
            <section
              v-for="(column, colIndex) in columns"
              :key="column.key"
              :data-board-col-header="!laneField ? column.key : undefined"
              class="relative flex shrink-0 flex-col rounded-xl bg-raised ring-1 ring-line"
              :class="[
                collapsed.has(column.key) ? 'w-11 p-1.5' : `${columnWidthClass} p-2`,
                !laneField && sectionDrag.active && sectionDrag.axis === 'column' && sectionDrag.key === column.key ? 'opacity-50' : '',
              ]"
            >
              <div v-if="!laneField && colDropBefore(colIndex)" class="pointer-events-none absolute -left-2 inset-y-0 w-1 rounded-full bg-accent" />
              <div v-if="!laneField && colDropAfter(colIndex)" class="pointer-events-none absolute -right-2 inset-y-0 w-1 rounded-full bg-accent" />

              <!-- Column header when there are no swimlanes. -->
              <header
                v-if="!laneField"
                class="group/col flex items-center gap-1.5 text-sm"
                :class="collapsed.has(column.key) ? 'cursor-pointer flex-col py-1' : 'px-1 py-1'"
                @click="collapsed.has(column.key) && toggleFold(column)"
                @contextmenu.prevent="columnMenu($event, column)"
              >
                <span
                  v-if="canReorderColumns && !collapsed.has(column.key)"
                  class="-ml-1 cursor-grab touch-none rounded p-0.5 text-ink-faint opacity-0 hover:text-ink group-hover/col:opacity-100 active:cursor-grabbing [@media(hover:none)]:opacity-100"
                  :title="t('views.dragToReorder')"
                  @pointerdown.stop="pressSection($event, 'column', column.key, reorderColumn)"
                >
                  <AppIcon fallback="ph:dots-six-vertical" :size="14" />
                </span>
                <template v-if="!collapsed.has(column.key)">
                  <span v-if="column.objectId" class="min-w-0 truncate"><ObjectChip :id="column.objectId" :tag="groupField === 'tags'" /></span>
                  <PersonChip v-else-if="column.personId" :id="column.personId" />
                  <span v-else class="truncate rounded-md px-2 py-0.5 font-medium" :class="column.key === NO_VALUE ? 'text-ink-faint' : chip(column.color as never)">{{ column.label }}</span>
                </template>
                <span
                  class="text-xs tabular-nums"
                  :class="over(column) ? 'rounded-md bg-red-100 px-1.5 font-semibold text-red-700 dark:bg-red-950 dark:text-red-300' : 'text-ink-faint'"
                  :title="wip(column) ? t('board.wipTooltip', { limit: wip(column)! }) : undefined"
                  >{{ column.items.length }}<template v-if="wip(column)">/{{ wip(column) }}</template></span
                >
                <span v-if="collapsed.has(column.key)" class="text-xs font-medium text-ink-soft [writing-mode:vertical-rl]">{{ groupTitle(column) || '…' }}</span>
                <button
                  v-else
                  class="ml-auto rounded-md p-0.5 text-ink-faint opacity-0 hover:bg-hover hover:text-ink group-hover/col:opacity-100 [@media(hover:none)]:opacity-100"
                  :title="t('board.columnOptions')"
                  @click.stop="columnMenu($event, column)"
                >
                  <AppIcon fallback="ph:dots-three" :size="16" />
                </button>
              </header>

              <!-- Folded column inside a swimlane: slim clickable strip with that cell's count. -->
              <button
                v-if="laneField && collapsed.has(column.key)"
                type="button"
                class="flex flex-1 flex-col items-center py-1 text-xs tabular-nums text-ink-faint hover:text-ink"
                :title="t('board.unfoldColumn')"
                @click="toggleFold(column)"
                @contextmenu.prevent="columnMenu($event, column)"
              >
                {{ cell(column, lane).length }}
              </button>

              <div
                v-if="!collapsed.has(column.key)"
                class="flex min-h-12 flex-1 flex-col gap-2"
                :class="!laneField ? 'mt-2' : ''"
                :data-board-cell="cellKey(column, lane)"
              >
                <!-- The card being dragged stays where it was, faded; a bar shows where it would land. -->
                <template v-for="{ object, place } in placed(column, lane)" :key="object.id">
                  <div v-if="place >= 0 && landing(column, lane) === place" class="h-1 rounded-full bg-accent" />
                  <div
                    :data-board-card="object.id"
                    class="touch-manipulation select-none"
                    :class="place < 0 ? 'opacity-40' : ''"
                    @pointerdown="onPress($event, object)"
                    @contextmenu="onContextMenu($event, object)"
                    @dragstart.prevent
                  >
                    <ObjectCard :object="object" :type="typeOf(object)" variant="kanban" :card="board" :hide="hiddenFields" />
                  </div>
                </template>
                <div v-if="landing(column, lane) >= 0 && landing(column, lane) >= placed(column, lane).filter((p) => p.place >= 0).length" class="h-1 rounded-full bg-accent" />
                <template v-if="canAdd">
                  <input
                    v-if="addingIn === cellKey(column, lane)"
                    ref="newInput"
                    v-model="newTitle"
                    class="w-full rounded-lg border border-line-strong bg-surface px-2.5 py-2 text-sm outline-none"
                    :placeholder="t('board.newCardPlaceholder')"
                    @keydown.enter.prevent="addCard(column, lane)"
                    @keydown.esc="addingIn = ''"
                    @blur="addingIn = ''"
                  />
                  <button v-else class="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm text-ink-faint hover:bg-hover hover:text-ink" @click="startAdding(column, lane)">
                    <AppIcon fallback="ph:plus" :size="14" /> {{ t('common.new') }}
                  </button>
                </template>
              </div>
            </section>
          </div>
        </div>
      </template>
      <div v-if="laneField && laneDropAfterLast" class="h-1 rounded-full bg-accent" />
    </div>
  </div>
</template>
