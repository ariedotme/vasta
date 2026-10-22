<script setup lang="ts">
// The board layout: a column per group of `groupField`, optionally in rows (swimlanes) by a second
// field. Cards keep a manual order (core rank.ts) while `manual`, move by dragging (lib/board.ts:
// a mouse at once, a finger after a long press), and are made with "+" at the bottom of a column.
// Columns fold and can have a WIP limit; both are the view's settings (`board`).
import { computed, nextTick, ref } from 'vue'
import type { BoardSettings, Id, ObjectRecord, ObjectSummary, PropertyDef } from '@vasta/core'
import { RANK_PROPERTY_ID, byRank, rankOf, rankBetween } from '@vasta/core'
import { createObject } from '../lib/actions.ts'
import { boardDrag, moveCard, pressCard, type BoardAxis, type CardTarget } from '../lib/board.ts'
import { chip } from '../lib/colors.ts'
import { openMenuAt, promptDialog } from '../lib/overlays.ts'
import { groupObjects, movableField, NO_VALUE, placeInGroup, typesOf, type Group } from '../lib/query.ts'
import { lastError, typesById } from '../lib/state.ts'
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

const columns = computed<Group[]>(() => groupObjects(props.objects, props.groupField, types.value, true))
const lanes = computed<Group[]>(() => (laneField.value ? groupObjects(props.objects, laneField.value, types.value, false) : [{ key: '', label: '', items: props.objects }]))

/** The cards of a column in a lane, in the board's order. */
function cell(column: Group, lane: Group): ObjectSummary[] {
  const inLane = new Set(lane.items.map((o) => o.id))
  const items = laneField.value ? column.items.filter((o) => inLane.has(o.id)) : column.items
  return props.manual ? byRank(items) : items
}

// Columns: folded ones and WIP limits ------------------------------------------
const collapsed = computed(() => new Set(props.board?.collapsed ?? []))
const wip = (column: Group) => props.board?.wip?.[column.key]
const over = (column: Group) => (wip(column) ?? Infinity) < column.items.length

function setBoard(patch: Partial<BoardSettings>) {
  const next: BoardSettings = { ...(props.board ?? {}), ...patch }
  for (const key of Object.keys(next) as (keyof BoardSettings)[]) if (next[key] === undefined) delete next[key]
  emit('board', next)
}
function toggleFold(column: Group) {
  const keys = new Set(collapsed.value)
  if (keys.has(column.key)) keys.delete(column.key)
  else keys.add(column.key)
  setBoard({ collapsed: keys.size ? [...keys] : undefined })
}
async function setWip(column: Group) {
  const answer = await promptDialog({
    title: `Most cards in “${column.label || 'this column'}”`,
    message: 'The count turns red when the column holds more. Empty: no limit.',
    value: wip(column) ? String(wip(column)) : '',
    placeholder: 'No limit',
    confirmLabel: 'Set limit',
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
  openMenuAt(event.clientX, event.clientY, [
    { label: collapsed.value.has(column.key) ? 'Unfold column' : 'Fold column', icon: collapsed.value.has(column.key) ? 'ph:arrows-out-line-horizontal' : 'ph:arrows-in-line-horizontal', run: () => toggleFold(column) },
    { label: wip(column) ? `WIP limit: ${wip(column)}…` : 'Set a WIP limit…', icon: 'ph:gauge', run: () => setWip(column) },
  ])
}

// Card fields: the view's, or the first two with a value that are not the columns or lanes.
const cardFields = computed<PropertyDef[] | undefined>(() => {
  const ids = props.board?.cardFields
  if (!ids) return undefined
  const defs = types.value.flatMap((t) => t.properties)
  return ids.flatMap((id) => defs.find((d) => d.id === id) ?? [])
})
const hiddenFields = computed(() => [props.groupField, laneField.value].filter(Boolean))

// Dragging -------------------------------------------------------------------
const columnAxis = computed<BoardAxis>(() => ({ field: props.groupField, groups: columns.value }))
const laneAxis = computed<BoardAxis | undefined>(() => (laneField.value ? { field: laneField.value, groups: lanes.value } : undefined))
const draggable = computed(() => movableField(props.groupField) && (!laneField.value || movableField(laneField.value)))

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
  if (draggable.value) pressCard(event, object.id, drop)
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
  <div class="overflow-x-auto pb-4" data-drag-scroll>
    <div class="inline-flex min-w-full flex-col gap-4">
      <div v-for="(lane, laneIndex) in lanes" :key="lane.key">
        <!-- A lane's header: what its cards share. -->
        <header v-if="laneField" class="sticky left-0 mb-2 flex w-fit items-center gap-2 text-sm">
          <ObjectChip v-if="lane.objectId" :id="lane.objectId" :tag="laneField === 'tags'" />
          <PersonChip v-else-if="lane.personId" :id="lane.personId" />
          <span v-else class="rounded-md px-2 py-0.5 font-medium" :class="lane.key === NO_VALUE ? 'text-ink-faint' : chip(lane.color as never)">{{ lane.label }}</span>
          <span class="text-xs text-ink-faint">{{ lane.items.length }}</span>
        </header>
        <div class="flex gap-3">
          <section
            v-for="column in columns"
            :key="column.key"
            class="flex shrink-0 flex-col rounded-xl bg-raised ring-1 ring-line"
            :class="collapsed.has(column.key) ? 'w-11 p-1.5' : 'w-72 p-2'"
          >
            <!-- Column headers on the first lane only; a folded column shows its name upright. -->
            <header
              v-if="laneIndex === 0 || collapsed.has(column.key)"
              class="group/col flex items-center gap-2 text-sm"
              :class="collapsed.has(column.key) ? 'cursor-pointer flex-col py-1' : 'px-1 py-1'"
              @click="collapsed.has(column.key) && toggleFold(column)"
              @contextmenu.prevent="columnMenu($event, column)"
            >
              <template v-if="!collapsed.has(column.key)">
                <span v-if="column.objectId"><ObjectChip :id="column.objectId" :tag="groupField === 'tags'" /></span>
                <PersonChip v-else-if="column.personId" :id="column.personId" />
                <span v-else class="truncate rounded-md px-2 py-0.5 font-medium" :class="column.key === NO_VALUE ? 'text-ink-faint' : chip(column.color as never)">{{ column.label }}</span>
              </template>
              <span
                class="text-xs tabular-nums"
                :class="over(column) ? 'rounded-md bg-red-100 px-1.5 font-semibold text-red-700 dark:bg-red-950 dark:text-red-300' : 'text-ink-faint'"
                :title="wip(column) ? `WIP limit ${wip(column)}` : undefined"
                >{{ column.items.length }}<template v-if="wip(column)">/{{ wip(column) }}</template></span
              >
              <span v-if="collapsed.has(column.key)" class="text-xs font-medium text-ink-soft [writing-mode:vertical-rl]">{{ column.label || '…' }}</span>
              <button
                v-else
                class="ml-auto rounded-md p-0.5 text-ink-faint opacity-0 hover:bg-hover hover:text-ink group-hover/col:opacity-100 [@media(hover:none)]:opacity-100"
                title="Column options"
                @click.stop="columnMenu($event, column)"
              >
                <AppIcon fallback="ph:dots-three" :size="16" />
              </button>
            </header>
            <div
              v-if="!collapsed.has(column.key)"
              class="flex min-h-12 flex-1 flex-col gap-2"
              :class="laneIndex === 0 ? 'mt-2' : ''"
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
                  <ObjectCard :object="object" :type="typeOf(object)" variant="kanban" :fields="cardFields" :hide="hiddenFields" />
                </div>
              </template>
              <div v-if="landing(column, lane) >= 0 && landing(column, lane) >= placed(column, lane).filter((p) => p.place >= 0).length" class="h-1 rounded-full bg-accent" />
              <template v-if="canAdd">
                <input
                  v-if="addingIn === cellKey(column, lane)"
                  ref="newInput"
                  v-model="newTitle"
                  class="w-full rounded-lg border border-line-strong bg-surface px-2.5 py-2 text-sm outline-none"
                  placeholder="Title, then Enter"
                  @keydown.enter.prevent="addCard(column, lane)"
                  @keydown.esc="addingIn = ''"
                  @blur="addingIn = ''"
                />
                <button v-else class="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm text-ink-faint hover:bg-hover hover:text-ink" @click="startAdding(column, lane)">
                  <AppIcon fallback="ph:plus" :size="14" /> New
                </button>
              </template>
            </div>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>
