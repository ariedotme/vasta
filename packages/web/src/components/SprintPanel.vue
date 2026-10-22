<script setup lang="ts">
// On a sprint's page: how far it got (its tasks by status), the days left, finishing it (what is
// not done moves to the next sprint, or back to the backlog) and planning the next one.
import { computed, ref, watch } from 'vue'
import type { ObjectRecord, ObjectSummary, SelectPropertyDef } from '@vasta/core'
import { SPRINT_DATES_PROPERTY_ID, SPRINT_PROPERTY_ID, builtinTypeId, daysBetween, followingSprintDays, nextSprint, sprintDays } from '@vasta/core'
import { createObject, dayKey } from '../lib/actions.ts'
import { api } from '../lib/api.ts'
import { onChange } from '../lib/events.ts'
import { confirmDialog } from '../lib/overlays.ts'
import { runServerQuery } from '../lib/query.ts'
import { sprintSettings, sprints } from '../lib/sprints.ts'
import { lastError, notice, primeFromObject, typesById } from '../lib/state.ts'
import AppIcon from './AppIcon.vue'

const props = defineProps<{ sprint: ObjectRecord }>()

const taskType = computed(() => typesById.value.get(builtinTypeId(props.sprint.spaceId, 'task')))
const statusDef = computed(() => taskType.value?.properties.find((p): p is SelectPropertyDef => p.id === 'status' && p.kind === 'select'))
const word = computed(() => sprintSettings.value?.name ?? 'Sprint')

const tasks = ref<ObjectSummary[]>([])
async function load() {
  if (!taskType.value) return
  tasks.value = await runServerQuery({
    typeIds: [taskType.value.id],
    filter: { kind: 'group', operator: 'and', items: [{ kind: 'filter', field: SPRINT_PROPERTY_ID, operator: 'contains', value: { kind: 'literal', value: [props.sprint.id] } }] },
  }).catch(() => [])
}
watch(() => props.sprint.id, load, { immediate: true })
let timer: ReturnType<typeof setTimeout> | undefined
onChange((event) => {
  if (event.kind !== 'object' || event.typeId !== taskType.value?.id) return
  clearTimeout(timer)
  timer = setTimeout(load, 400)
})

const categoryOf = (task: ObjectSummary) => {
  const value = task.props.status
  const id = value?.kind === 'select' ? value.value[0] : undefined
  return statusDef.value?.options.find((o) => o.id === id)?.status ?? 'todo'
}
const counts = computed(() => {
  const by = { todo: 0, doing: 0, done: 0 }
  for (const task of tasks.value) by[categoryOf(task)]++
  return by
})
const unfinished = computed(() => tasks.value.filter((t) => categoryOf(t) !== 'done'))
const share = (n: number) => (tasks.value.length ? `${(n / tasks.value.length) * 100}%` : '0%')

const days = computed(() => sprintDays(props.sprint))
const when = computed(() => {
  const span = days.value
  if (!span) return `Give this ${word.value.toLowerCase()} its dates to see the days left.`
  const today = dayKey()
  if (today < span.start) return `Starts in ${daysBetween(today, span.start)} days`
  if (today > span.end) return `Ended ${daysBetween(span.end, today)} days ago`
  const left = daysBetween(today, span.end)
  return left === 0 ? 'Last day' : `${left + 1} days left, today included`
})
const next = computed(() => nextSprint(sprints.value, props.sprint))

async function finish() {
  const target = next.value
  const count = unfinished.value.length
  const where = target ? `to “${target.title || word.value}”` : 'back to the backlog'
  const ok = await confirmDialog({
    title: `Finish “${props.sprint.title || word.value}”?`,
    message: count ? `${count} unfinished ${count === 1 ? 'task moves' : 'tasks move'} ${where}. Done tasks stay in it.` : 'Every task in it is done.',
    confirmLabel: count ? `Move ${count} ${count === 1 ? 'task' : 'tasks'}` : 'OK',
  })
  if (!ok || !count) return
  try {
    for (const task of unfinished.value) {
      const object = await api.object(task.id)
      if (target) object.props[SPRINT_PROPERTY_ID] = { kind: 'relation', value: [target.id] }
      else delete object.props[SPRINT_PROPERTY_ID]
      primeFromObject(await api.saveObject(object))
    }
    notice.value = { message: `Moved ${count} ${count === 1 ? 'task' : 'tasks'} ${where}.` }
    await load()
  } catch (error) {
    lastError.value = (error as Error).message
  }
}

/** The next sprint, right after this one and as long, numbered after the last. */
async function planNext() {
  const span = followingSprintDays(props.sprint, dayKey())
  const number = Math.max(0, ...sprints.value.map((s) => Number(/(\d+)\s*$/.exec(s.title)?.[1] ?? 0))) + 1
  await createObject(props.sprint.typeId, {
    title: `${word.value} ${number}`,
    props: { [SPRINT_DATES_PROPERTY_ID]: { kind: 'date', value: { start: `${span.start}T00:00:00.000Z`, end: `${span.end}T00:00:00.000Z`, resolution: 'day' } } },
  })
}
</script>

<template>
  <section class="mt-6 rounded-xl border border-line p-4">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <span class="font-medium">{{ tasks.length }} {{ tasks.length === 1 ? 'task' : 'tasks' }}</span>
      <span class="text-ink-soft">{{ counts.done }} done · {{ counts.doing }} in progress · {{ counts.todo }} to do</span>
      <span class="ml-auto text-ink-faint">{{ when }}</span>
    </div>
    <div class="mt-3 flex h-2 overflow-hidden rounded-full bg-hover" role="img" :aria-label="`${counts.done} of ${tasks.length} done`">
      <div class="bg-green-500" :style="{ width: share(counts.done) }" />
      <div class="bg-blue-500" :style="{ width: share(counts.doing) }" />
    </div>
    <div class="mt-3 flex flex-wrap gap-2">
      <button class="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-hover" @click="finish">
        <AppIcon fallback="ph:flag-checkered" :size="14" /> Finish {{ word.toLowerCase() }}…
      </button>
      <button v-if="!next" class="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-hover" @click="planNext">
        <AppIcon fallback="ph:plus" :size="14" /> Next {{ word.toLowerCase() }}
      </button>
      <RouterLink v-if="taskType" :to="`/t/${taskType.id}`" class="ml-auto self-center text-sm text-accent hover:underline">Tasks</RouterLink>
    </div>
  </section>
</template>
