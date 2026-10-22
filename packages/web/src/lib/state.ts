// App-wide state: the open space, its types, and a cache of object summaries shared by
// mentions, embeds, relations and tags so a renamed object updates everywhere.
import { computed, reactive, ref, watch, type Ref } from 'vue'
import type { Id, ObjectRecord, ObjectSummary, ObjectType, Space, SystemTypeKey } from '@vasta/core'
import { docToPlainText } from '@vasta/core'
import { api } from './api.ts'

export const workspace = reactive({
  space: null as Space | null,
  /** Every space the user is a member of. */
  spaces: [] as Space[],
  types: [] as ObjectType[],
  counts: {} as Record<Id, number>,
  /** Entries in the space's trash (deleted types, and objects deleted on their own). */
  trash: 0,
  ready: false,
  error: '' as string,
})

export const typesById = computed(() => new Map(workspace.types.map((t) => [t.id, t])))

export const systemType = (key: SystemTypeKey) => workspace.types.find((t) => t.system === key)

const SPACE_KEY = 'vasta.space'

function rememberSpace(id: Id) {
  try {
    localStorage.setItem(SPACE_KEY, id)
  } catch {}
}

export async function loadWorkspace(spaceId?: Id) {
  try {
    const spaces = await api.spaces()
    let stored: string | null = null
    try {
      stored = localStorage.getItem(SPACE_KEY)
    } catch {}
    const id = spaceId ?? (spaces.some((s) => s.id === stored) ? stored : spaces[0]?.id)
    if (!id) {
      workspace.error = 'No space found. Import one with `pnpm import:capacities`.'
      return
    }
    const bundle = await api.space(id)
    workspace.spaces = spaces
    workspace.space = bundle.space
    workspace.types = bundle.types
    workspace.counts = bundle.counts
    workspace.trash = bundle.trash
    workspace.ready = true
    rememberSpace(id)
  } catch (error) {
    workspace.error = `Could not reach the Vasta server (${(error as Error).message}).`
  }
}

/** Forget everything loaded for the previous user (after logging out). */
export function resetWorkspace() {
  Object.assign(workspace, { space: null, spaces: [], types: [], counts: {}, trash: 0, ready: false, error: '' })
  summaries.clear()
  pending.clear()
}

export async function refreshCounts() {
  if (!workspace.space) return
  const bundle = await api.space(workspace.space.id)
  workspace.counts = bundle.counts
  workspace.trash = bundle.trash
}

/** Reload the list of spaces and the open one (renamed, its sidebar changed, joined or left elsewhere). */
export async function refreshSpaces() {
  try {
    const spaces = await api.spaces()
    workspace.spaces = spaces
    const current = spaces.find((s) => s.id === workspace.space?.id)
    if (current) workspace.space = current
    else if (workspace.space) await loadWorkspace()
  } catch {}
}

/**
 * Types edited here and not saved yet (a view's settings wait a moment before they are saved): a
 * reload of the stored copy meanwhile must not undo the edit. The editor clears its entry when the
 * save answers.
 */
export const unsavedTypes = new Map<Id, ObjectType>()

/** Put a changed type in the open space's list; one moved to the trash leaves it, one of another space (a live change) is not its. */
export function replaceType(type: ObjectType) {
  if (type.spaceId !== workspace.space?.id) return
  const unsaved = unsavedTypes.get(type.id)
  if (unsaved && unsaved !== type) return
  const index = workspace.types.findIndex((t) => t.id === type.id)
  if (type.deletedAt) {
    if (index >= 0) workspace.types.splice(index, 1)
  } else if (index >= 0) workspace.types[index] = type
  else workspace.types.push(type)
}

// ---------------------------------------------------------------------------
// Object summaries

const summaries = reactive(new Map<Id, ObjectSummary>())
const pending = new Set<Id>()
let flushTimer: ReturnType<typeof setTimeout> | undefined

export function primeSummaries(list: ObjectSummary[]) {
  for (const summary of list) summaries.set(summary.id, summary)
}

/** Keep the cache in step after an object is saved from its page. */
export function primeFromObject(object: ObjectRecord) {
  const { content, ...rest } = object
  const preview = Object.values(content).map(docToPlainText).join('\n').slice(0, 280)
  summaries.set(object.id, { ...rest, preview })
}

export function forgetSummary(id: Id) {
  summaries.delete(id)
}

/** Request summaries for ids not in the cache; batched into one request per tick. */
export function requestSummaries(ids: Id[]) {
  for (const id of ids) if (!summaries.has(id)) pending.add(id)
  if (!pending.size || flushTimer) return
  flushTimer = setTimeout(async () => {
    flushTimer = undefined
    const batch = [...pending]
    pending.clear()
    try {
      primeSummaries(await api.summaries(batch))
    } catch {}
  }, 10)
}

/** The cached summary, without fetching a missing one. */
export const cachedSummary = (id: Id): ObjectSummary | undefined => summaries.get(id)

export function summaryOf(id: Id): ObjectSummary | undefined {
  requestSummaries([id])
  return summaries.get(id)
}

export function useSummaries(ids: Ref<Id[]>) {
  watch(ids, (value) => requestSummaries(value), { immediate: true })
  return computed(() => ids.value.map((id) => summaries.get(id)).filter((s): s is ObjectSummary => !!s))
}

// ---------------------------------------------------------------------------
// UI flags shared across components

const SIDEBAR_KEY = 'vasta.sidebar-collapsed'

function readFlag(key: string) {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export const ui = reactive({
  paletteOpen: false,
  passwordOpen: false,
  /** The quick capture dialog (the desktop app's global shortcut). */
  captureOpen: false,
  /** The sidebar drawer on phones. */
  sidebarOpen: false,
  /** The sidebar put away on wider screens (⌘\), remembered on this device. */
  sidebarCollapsed: readFlag(SIDEBAR_KEY),
  /** The keyboard shortcuts dialog (⌘/). */
  shortcutsOpen: false,
})

watch(
  () => ui.sidebarCollapsed,
  (collapsed) => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0')
    } catch {}
  }
)

export const lastError = ref('')

/** A short message with an optional action, such as Undo after a delete (shown by AppToast). */
export interface Notice {
  message: string
  action?: { label: string; run: () => unknown }
}

export const notice = ref<Notice | null>(null)
