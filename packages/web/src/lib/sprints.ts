// Sprints in the open space (core sprints.ts): whether they are on, what the space calls them, its
// sprints (kept loaded, so filters on the current sprint work on any page) and turning them on,
// off or renaming them.
import { computed, ref, watch } from 'vue'
import type { ObjectSummary, SprintSettings } from '@vasta/core'
import { builtinTypeId, currentSprint } from '@vasta/core'
import { dayKey } from './actions.ts'
import { api } from './api.ts'
import { onChange } from './events.ts'
import { primeSummaries, replaceType, workspace } from './state.ts'

export const sprintSettings = computed<SprintSettings | undefined>(() => workspace.space?.sprints)
export const sprintsOn = computed(() => !!sprintSettings.value?.enabled)
export const sprintTypeId = computed(() => (workspace.space ? builtinTypeId(workspace.space.id, 'sprint') : ''))

/** The open space's sprints. */
export const sprints = ref<ObjectSummary[]>([])

async function load() {
  const typeId = sprintTypeId.value
  if (!typeId || !workspace.types.some((t) => t.id === typeId && !t.deletedAt)) {
    sprints.value = []
    return
  }
  try {
    const list = await api.objectsOfType(typeId)
    if (sprintTypeId.value !== typeId) return
    sprints.value = list
    primeSummaries(list)
  } catch {}
}

watch(() => [sprintTypeId.value, workspace.types.some((t) => t.id === sprintTypeId.value && !t.deletedAt)], load, { immediate: true })
let timer: ReturnType<typeof setTimeout> | undefined
onChange((event) => {
  if (event.kind !== 'object' || event.typeId !== sprintTypeId.value) return
  clearTimeout(timer)
  timer = setTimeout(load, 300)
})

/** The sprint whose dates hold today. */
export const current = computed(() => currentSprint(sprints.value, dayKey()))

/** Turn sprints on or off, or rename them, in the open space; the workspace follows. */
export async function setSprints(input: { enabled?: boolean; name?: string; pluralName?: string }) {
  const space = workspace.space
  if (!space) return
  const { space: saved, types } = await api.setSprints(space.id, input)
  workspace.space = { ...space, sprints: saved.sprints! }
  const index = workspace.spaces.findIndex((s) => s.id === saved.id)
  if (index >= 0) workspace.spaces[index] = { ...workspace.spaces[index]!, sprints: saved.sprints! }
  for (const type of types) {
    if (workspace.types.some((t) => t.id === type.id)) replaceType(type)
    else workspace.types.push(type)
  }
}
