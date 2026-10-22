// Sprints: time boxes for tasks, under the name a space chooses ("Sprint", "Rodada"…). Turning them
// on makes the Sprint type (its dates, a range, and a goal), gives the Task type a relation to it
// and, the first time, two views of tasks: the current sprint as a board and the backlog (tasks in
// no sprint that are not done). The current sprint is the one whose dates hold today; queries name
// it with the `current-sprint` variable.
import { SPRINT_DATES_PROPERTY_ID, SPRINT_PROPERTY_ID, builtinTypeId, createBuiltinTypes } from './builtin-types.ts'
import type { Id, IsoDateTime, ObjectSummary, ObjectType, PropertyDef, Space, SprintSettings, ViewDef } from './model.ts'
import type { Store } from './store.ts'
import { addDays, dayIn } from './time.ts'

export class SprintError extends Error {}

export const DEFAULT_SPRINT_SETTINGS: SprintSettings = { enabled: true, name: 'Sprint', pluralName: 'Sprints' }

/** The views of tasks a space gets the first time it turns sprints on. */
export const sprintViewIds = (spaceId: Id) => ({ current: `task:${spaceId}:current-sprint`, backlog: `task:${spaceId}:backlog` })

function taskViews(spaceId: Id, settings: SprintSettings): ViewDef[] {
  const ids = sprintViewIds(spaceId)
  return [
    {
      id: ids.current,
      name: `Current ${settings.name.toLowerCase()}`,
      layout: 'kanban',
      groupBy: [{ field: 'status' }],
      filter: { kind: 'group', operator: 'and', items: [{ kind: 'filter', field: SPRINT_PROPERTY_ID, operator: 'contains', value: { kind: 'variable', name: 'current-sprint' } }] },
    },
    {
      id: ids.backlog,
      name: 'Backlog',
      layout: 'list',
      filter: {
        kind: 'group',
        operator: 'and',
        items: [
          { kind: 'filter', field: SPRINT_PROPERTY_ID, operator: 'is-empty' },
          { kind: 'filter', field: 'status', operator: 'not-contains', value: { kind: 'literal', value: ['done'] } },
        ],
      },
    },
  ]
}

const sprintRelation = (spaceId: Id, settings: SprintSettings): PropertyDef => ({
  id: SPRINT_PROPERTY_ID,
  kind: 'relation',
  name: settings.name,
  targetTypeIds: [builtinTypeId(spaceId, 'sprint')],
  multiple: false,
})

/**
 * Turn sprints on or off, or rename them (`name`, `pluralName`). On: the Sprint type is made (or
 * brought back from the trash) under the space's name for it, and the first time the Task type
 * gets its Sprint relation and views. A rename renames the type and the relation. Off hides them;
 * nothing is deleted. Returns the space and the types changed.
 */
export function setSprints(store: Store, spaceId: Id, input: { enabled?: boolean; name?: string; pluralName?: string }, at: IsoDateTime): { space: Space; types: ObjectType[] } {
  return store.transaction(() => {
    const space = store.getSpace(spaceId)
    if (!space) throw new SprintError('not found')
    const before = space.sprints
    const name = input.name?.trim() || before?.name || DEFAULT_SPRINT_SETTINGS.name
    const pluralName = input.pluralName?.trim() || (input.name?.trim() ? `${name}s` : undefined) || before?.pluralName || `${name}s`
    if (name.length > 40 || pluralName.length > 40) throw new SprintError('the name is too long')
    const settings: SprintSettings = { enabled: input.enabled ?? before?.enabled ?? true, name, pluralName }
    const types: ObjectType[] = []
    const changed = (type: ObjectType) => {
      store.putType({ ...type, updatedAt: at })
      types.push(store.getType(type.id)!)
    }

    const typeId = builtinTypeId(spaceId, 'sprint')
    let sprint = store.getType(typeId)
    if (settings.enabled && !sprint) {
      const [made] = createBuiltinTypes(spaceId, at, ['sprint'])
      store.putType(made!)
      sprint = store.getType(typeId)!
    } else if (settings.enabled && sprint?.deletedAt) {
      store.restoreType(typeId, at)
      sprint = store.getType(typeId)!
    }
    if (sprint && (sprint.name !== name || sprint.pluralName !== pluralName)) changed({ ...sprint, name, pluralName })
    else if (sprint && settings.enabled && !before?.enabled) types.push(sprint)

    const task = store.getType(builtinTypeId(spaceId, 'task'))
    if (task) {
      let next = task
      // The first time only: a relation or view the user deleted stays deleted.
      if (settings.enabled && !before) {
        if (!next.properties.some((p) => p.id === SPRINT_PROPERTY_ID)) {
          const properties = [...next.properties]
          const after = properties.findIndex((p) => p.id === 'assignee' || p.id === 'due')
          properties.splice(after >= 0 ? after + 1 : properties.length, 0, sprintRelation(spaceId, settings))
          next = { ...next, properties }
        }
        const views = taskViews(spaceId, settings).filter((v) => !next.views.some((existing) => existing.id === v.id))
        if (views.length) next = { ...next, views: [...next.views, ...views] }
      }
      // A rename follows into the relation's and the current sprint view's names.
      if (before && before.name !== name) {
        next = {
          ...next,
          properties: next.properties.map((p) => (p.id === SPRINT_PROPERTY_ID && p.name === before.name ? { ...p, name } : p)),
          views: next.views.map((v) => (v.id === sprintViewIds(spaceId).current && v.name === `Current ${before.name.toLowerCase()}` ? { ...v, name: `Current ${name.toLowerCase()}` } : v)),
        }
      }
      if (next !== task) changed(next)
    }

    const saved: Space = { ...space, sprints: settings }
    store.putSpace(saved)
    return { space: saved, types }
  })
}

/** A sprint's first and last day ("YYYY-MM-DD"), when its dates are set. */
export function sprintDays(sprint: Pick<ObjectSummary, 'props'>, timeZone = 'UTC'): { start: string; end: string } | undefined {
  const value = sprint.props[SPRINT_DATES_PROPERTY_ID]
  if (value?.kind !== 'date') return undefined
  const day = (iso: string) => (value.value.resolution === 'day' ? iso.slice(0, 10) : dayIn(iso, timeZone))
  const start = day(value.value.start)
  return { start, end: value.value.end ? day(value.value.end) : start }
}

/** The sprint whose dates hold `today` (the one that started last, when they overlap). */
export function currentSprint<T extends Pick<ObjectSummary, 'id' | 'props' | 'deletedAt'>>(sprints: T[], today: string, timeZone = 'UTC'): T | undefined {
  let found: { sprint: T; start: string } | undefined
  for (const sprint of sprints) {
    const days = !sprint.deletedAt ? sprintDays(sprint, timeZone) : undefined
    if (!days || days.start > today || days.end < today) continue
    if (!found || days.start > found.start) found = { sprint, start: days.start }
  }
  return found?.sprint
}

/** The sprint that starts after `sprint` ends (the earliest), for moving what is left over. */
export function nextSprint<T extends Pick<ObjectSummary, 'id' | 'props' | 'deletedAt'>>(sprints: T[], sprint: Pick<ObjectSummary, 'id' | 'props'>, timeZone = 'UTC'): T | undefined {
  const days = sprintDays(sprint, timeZone)
  if (!days) return undefined
  let found: { sprint: T; start: string } | undefined
  for (const other of sprints) {
    const span = other.id !== sprint.id && !other.deletedAt ? sprintDays(other, timeZone) : undefined
    if (!span || span.start <= days.start) continue
    if (!found || span.start < found.start) found = { sprint: other, start: span.start }
  }
  return found?.sprint
}

/** Dates for the sprint after `last` (the same length, starting the day after it ends), or two weeks from `today`. */
export function followingSprintDays(last: Pick<ObjectSummary, 'props'> | undefined, today: string): { start: string; end: string } {
  const days = last && sprintDays(last)
  if (!days) return { start: today, end: addDays(today, 13) }
  const length = Math.round((Date.parse(`${days.end}T00:00:00Z`) - Date.parse(`${days.start}T00:00:00Z`)) / 86_400_000)
  const start = addDays(days.end, 1)
  return { start, end: addDays(start, length) }
}
