<script setup lang="ts">
// ⌘K: search everything, jump to an object or type, or create a new object from the query. A
// pasted URL offers to save it as a weblink. "/" and a type's name create an object of that type
// with the properties the rest names ("/Book Dune author:x"); "/" lists the types, and a
// relation's or a select's `name:` its objects or options. "/food …" logs what was eaten on
// today's note.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { foodCommand, type ObjectSummary, type ObjectType } from '@vasta/core'
import { completionSource, createObject, dayKey } from '../lib/actions.ts'
import { api } from '../lib/api.ts'
import { bareUrl } from '../lib/embeds.ts'
import { displayTitle } from '../lib/format.ts'
import { foodSourcesOf, nutritionOn, previewFoodLine } from '../lib/nutrition.ts'
import { meId, people } from '../lib/people.ts'
import { lastError, notice, primeFromObject, primeSummaries, refreshCounts, systemType, typesById, ui, workspace } from '../lib/state.ts'
import { objectColor } from '../lib/tags.ts'
import { previewLine, typedLine, type Completion, type LinePreview } from '../lib/typed-line.ts'
import { templates } from '../lib/templates.ts'
import { useCompletions } from '../lib/use-completions.ts'
import { GO, keysOf, toggleSidebar } from '../lib/shortcuts.ts'
import { cycleTheme } from '../lib/theme.ts'
import AppIcon from './AppIcon.vue'
import TypeIcon from './TypeIcon.vue'
import { openObject } from '../lib/open.ts'

type Result =
  | { kind: 'object'; object: ObjectSummary }
  | { kind: 'type'; type: ObjectType }
  | { kind: 'create'; title: string; type: ObjectType }
  | { kind: 'complete'; item: Completion }
  | { kind: 'typed'; type: ObjectType; line: string; preview: LinePreview }
  | { kind: 'food'; line: string; preview: { text: string; problem?: string } }
  | { kind: 'weblink'; url: string }
  | { kind: 'command'; command: Command }

interface Command {
  label: string
  icon: string
  /** A shortcut's id in lib/shortcuts.ts, for its keys. */
  shortcut?: string
  run: () => unknown
  /** Offered only while this holds (Nutrition: a space that tracks food). */
  when?: () => boolean
}

/** Places and actions, offered when the query matches their name. */
const COMMANDS: Command[] = [
  { label: 'Today', icon: 'ph:calendar-check', shortcut: 'today', run: GO.today.run },
  { label: 'Inbox', icon: 'ph:tray', shortcut: 'inbox', run: GO.inbox.run },
  { label: 'Calendar', icon: 'ph:calendar-dots', shortcut: 'calendar', run: GO.calendar.run },
  { label: 'Tasks', icon: 'ph:check-circle', shortcut: 'tasks', run: GO.tasks.run },
  { label: 'Settings', icon: 'ph:gear-six', shortcut: 'settings', run: () => router.push('/settings') },
  { label: 'Trash', icon: 'ph:trash', run: () => router.push('/trash') },
  { label: 'Keyboard shortcuts', icon: 'ph:keyboard', shortcut: 'shortcuts', run: () => (ui.shortcutsOpen = true) },
  { label: 'Show or hide the sidebar', icon: 'ph:sidebar-simple', shortcut: 'sidebar', run: toggleSidebar },
  { label: 'Change theme', icon: 'ph:circle-half', run: cycleTheme },
  { label: 'Nutrition', icon: 'ph:chart-bar', run: () => router.push('/nutrition'), when: () => nutritionOn.value },
]

const router = useRouter()
const query = ref('')
const objects = ref<ObjectSummary[]>([])
const active = ref(0)
const input = ref<HTMLInputElement | null>(null)
let seq = 0
let timer: ReturnType<typeof setTimeout> | undefined
/** The search in flight, so Enter acts on results for what was typed, not on stale ones. */
let inFlight: Promise<void> = Promise.resolve()

const cursor = ref(0)
const source = computed(() => (workspace.space ? completionSource(workspace.space.id, workspace.types) : undefined))
const completions = useCompletions(query, cursor, () => source.value)
const readCursor = () => (cursor.value = input.value?.selectionStart ?? query.value.length)
watch(query, () => nextTick(readCursor))

/** The space's foods, loaded once a line of food is typed, to show what it will log. */
const foods = ref<ObjectSummary[] | null>(null)
watch(query, async (value) => {
  if (foodCommand(value) === undefined || foods.value) return
  foods.value = []
  foods.value = await foodSourcesOf(workspace.types).catch(() => [])
})

const results = computed<Result[]>(() => {
  if (query.value.startsWith('/')) {
    const items = completions.shown.value
    if (items.length) return items.map((item) => ({ kind: 'complete', item }))
    const eaten = foodCommand(query.value)
    if (eaten !== undefined && workspace.space) return [{ kind: 'food', line: eaten, preview: previewFoodLine(eaten, workspace.space, foods.value ?? [], dayKey()) }]
    const typed = typedLine(workspace.types, query.value)
    return typed ? [{ kind: 'typed', type: typed.type, line: typed.rest, preview: previewLine(typed.type, typed.rest, dayKey(), people.list, meId(), templates.list) }] : []
  }
  const q = query.value.trim().toLowerCase()
  const types: Result[] = q
    ? workspace.types.filter((t) => t.pluralName.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)).slice(0, 4).map((type) => ({ kind: 'type', type }))
    : []
  const page = systemType('page')
  const url = bareUrl(query.value)
  if (url) return [{ kind: 'weblink', url }, ...objects.value.map((object): Result => ({ kind: 'object', object }))]
  const create: Result[] = q && page ? [{ kind: 'create', title: query.value.trim(), type: page }] : []
  const commands: Result[] = q.length > 1 ? COMMANDS.filter((c) => c.label.toLowerCase().includes(q) && (!c.when || c.when())).map((command) => ({ kind: 'command', command })) : []
  return [...commands, ...objects.value.map((object): Result => ({ kind: 'object', object })), ...types, ...create]
})

async function search() {
  if (!workspace.space) return
  const mine = ++seq
  const found = await api.search(workspace.space.id, query.value, 20)
  if (mine !== seq) return
  primeSummaries(found)
  objects.value = found
  active.value = 0
}

let searchPending = false
watch(query, () => {
  clearTimeout(timer)
  searchPending = true
  inFlight = new Promise((resolve) => {
    timer = setTimeout(
      () =>
        void search().finally(() => {
          searchPending = false
          resolve()
        }),
      120
    )
  })
})

watch(
  () => ui.paletteOpen,
  async (open) => {
    if (!open) return
    // Focus first so keystrokes typed right after ⌘K land in the input.
    query.value = ''
    await nextTick()
    input.value?.focus()
    inFlight = search()
  }
)

async function choose(result: Result | undefined) {
  if (!result) return
  if (result.kind === 'complete') {
    query.value = result.item.text
    await nextTick()
    input.value?.focus()
    input.value?.setSelectionRange(result.item.cursor, result.item.cursor)
    cursor.value = result.item.cursor
    return
  }
  ui.paletteOpen = false
  if (result.kind === 'typed') return createObject(result.type.id, {}, true, result.line)
  if (result.kind === 'food') return logLine(result.line)
  if (result.kind === 'command') return result.command.run()
  if (result.kind === 'object') await openObject(result.object.id)
  else if (result.kind === 'type') await router.push(`/t/${result.type.id}`)
  else if (result.kind === 'weblink') await saveWeblink(result.url)
  else await createObject(result.type.id, { title: result.title })
}

async function logLine(line: string) {
  if (!workspace.space) return
  try {
    const answer = await api.logFoodLine(workspace.space.id, line, dayKey())
    notice.value = { message: answer.summary.replace(/\n/g, ' ') }
  } catch (error) {
    lastError.value = (error as Error).message
  } finally {
    foods.value = null
  }
}

/** Save the URL (or find the weblink saved before for it) and open it. */
async function saveWeblink(url: string) {
  if (!workspace.space) return
  try {
    const object = await api.saveWeblink(workspace.space.id, url)
    primeFromObject(object)
    void refreshCounts()
    await openObject(object.id)
  } catch (error) {
    lastError.value = (error as Error).message
  }
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'ArrowDown') active.value = Math.min(active.value + 1, results.value.length - 1)
  else if (event.key === 'ArrowUp') active.value = Math.max(active.value - 1, 0)
  else if (event.key === 'Enter') {
    // While a search is pending the list on screen is stale: wait and take the top fresh result.
    const index = searchPending && !query.value.startsWith('/') ? 0 : active.value
    void inFlight.then(() => choose(results.value[index]))
  }
  else if (event.key === 'Tab' && results.value[active.value]?.kind === 'complete') void choose(results.value[active.value])
  // Esc puts a list of suggestions away first.
  else if (event.key === 'Escape' && results.value[0]?.kind === 'complete') completions.dismiss()
  else if (event.key === 'Escape') ui.paletteOpen = false
  else return
  event.preventDefault()
}

function onGlobalKey(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    ui.paletteOpen = !ui.paletteOpen
  }
}

onMounted(() => window.addEventListener('keydown', onGlobalKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey))

const typeOf = (object: ObjectSummary) => typesById.value.get(object.typeId)
</script>

<template>
  <Teleport to="body">
    <div v-if="ui.paletteOpen" class="fixed inset-0 z-50 flex items-start justify-center bg-black/25 px-3 pt-[calc(0.75rem+env(safe-area-inset-top))] md:px-4 md:pt-[12vh]" @mousedown.self="ui.paletteOpen = false">
      <div class="w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
        <div class="flex items-center gap-2 border-b border-line px-4">
          <AppIcon fallback="ph:magnifying-glass" class="text-ink-faint" />
          <input
            ref="input"
            v-model="query"
            class="w-full bg-transparent py-3.5 text-[15px] outline-none placeholder:text-ink-faint"
            placeholder="Search or create…"
            @keydown="onKey"
            @keyup="readCursor"
            @click="readCursor"
          />
          <kbd class="rounded border border-line px-1.5 text-[11px] text-ink-faint max-md:hidden">esc</kbd>
          <button class="-mr-2 rounded-md p-2 text-ink-faint md:hidden" title="Close" @click="ui.paletteOpen = false"><AppIcon fallback="ph:x" /></button>
        </div>
        <div class="max-h-[45dvh] overflow-y-auto p-1.5 md:max-h-[55vh]">
          <button
            v-for="(result, i) in results"
            :key="i"
            class="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left"
            :class="i === active ? 'bg-hover' : ''"
            @mouseenter="active = i"
            @click="choose(result)"
          >
            <template v-if="result.kind === 'object'">
              <TypeIcon :icon="result.object.icon ?? typeOf(result.object)?.icon" fallback="ph:file-text" :size="18" :color="objectColor(result.object, typeOf(result.object))" />
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium">{{ displayTitle(result.object, typeOf(result.object)) }}</div>
                <div v-if="result.object.preview" class="truncate text-xs text-ink-faint">{{ result.object.preview }}</div>
              </div>
              <span class="shrink-0 text-xs text-ink-faint">{{ typeOf(result.object)?.name }}</span>
            </template>
            <template v-else-if="result.kind === 'command'">
              <AppIcon :fallback="result.command.icon" :size="18" class="text-ink-soft" />
              <span class="flex-1 text-sm">{{ result.command.label }}</span>
              <kbd v-if="result.command.shortcut" class="rounded border border-line px-1.5 font-sans text-[11px] text-ink-faint max-md:hidden">{{ keysOf(result.command.shortcut) }}</kbd>
            </template>
            <template v-else-if="result.kind === 'type'">
              <TypeIcon :icon="result.type.icon" fallback="ph:cube" :size="18" :color="result.type.color" />
              <span class="flex-1 text-sm">{{ result.type.pluralName }}</span>
              <span class="text-xs text-ink-faint">Type</span>
            </template>
            <template v-else-if="result.kind === 'weblink'">
              <AppIcon fallback="ph:link" :size="18" class="text-accent" />
              <div class="min-w-0 flex-1">
                <div class="text-sm">Save as weblink</div>
                <div class="truncate text-xs text-ink-faint">{{ result.url }}</div>
              </div>
              <span class="text-xs text-ink-faint">{{ systemType('weblink')?.name }}</span>
            </template>
            <template v-else-if="result.kind === 'complete'">
              <AppIcon :icon="result.item.icon" fallback="ph:cube" :size="18" class="text-ink-soft" />
              <span class="min-w-0 flex-1 truncate text-sm">{{ result.item.label }}</span>
              <span class="shrink-0 text-xs text-ink-faint">{{ result.item.detail }}</span>
            </template>
            <template v-else-if="result.kind === 'typed'">
              <AppIcon :icon="result.type.icon" fallback="ph:plus-circle" :size="18" class="text-accent" />
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm">Create {{ result.preview.title ? `“${result.preview.title}”` : `a ${result.type.name}` }}</div>
                <div v-if="result.preview.unknownTemplate" class="truncate text-xs text-amber-700 dark:text-amber-400">{{ result.type.name }} has no template “{{ result.preview.unknownTemplate }}”</div>
                <div v-else-if="result.preview.errors.length" class="truncate text-xs text-amber-700 dark:text-amber-400">Cannot read {{ result.preview.errors.join('; ') }}</div>
                <div v-else-if="result.preview.parts.length || result.preview.template" class="truncate text-xs text-ink-faint">{{ [...(result.preview.template ? [`from ${result.preview.template}`] : []), ...result.preview.parts].join(', ') }}</div>
                <div v-else-if="result.preview.properties.length" class="truncate text-xs text-ink-faint">name:value sets {{ result.preview.properties.join(', ') }}</div>
              </div>
              <span class="shrink-0 text-xs text-ink-faint">{{ result.type.name }}</span>
            </template>
            <template v-else-if="result.kind === 'food'">
              <AppIcon fallback="ph:bowl-food" :size="18" class="text-accent" />
              <div class="min-w-0 flex-1">
                <div class="text-sm">{{ result.preview.text }}</div>
                <div v-if="result.preview.problem" class="text-xs text-amber-700 dark:text-amber-400">{{ result.preview.problem }}</div>
              </div>
              <span class="shrink-0 text-xs text-ink-faint">Food</span>
            </template>
            <template v-else>
              <AppIcon fallback="ph:plus-circle" :size="18" class="text-accent" />
              <span class="flex-1 text-sm">Create “{{ result.title }}”</span>
              <span class="text-xs text-ink-faint">{{ result.type.name }}</span>
            </template>
          </button>
          <p v-if="!results.length" class="px-3 py-6 text-center text-sm text-ink-faint">Nothing found</p>
        </div>
      </div>
    </div>
  </Teleport>
</template>
