// Sprints: turned on (and renamed) per space, the Task type's Sprint relation and views, the
// current sprint in queries and in typed lines.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SPRINT_PROPERTY_ID,
  addDays,
  builtinTypeId,
  createBuiltinTypes,
  currentSprint,
  followingSprintDays,
  nextSprint,
  type ObjectRecord,
  type ObjectSummary,
  type ObjectType,
  type Space,
} from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { createApp } from '../src/app.ts'
import { ChangeFeed } from '../src/events.ts'
import { asUser } from './helpers.ts'

const at = '2026-10-21T12:00:00.000Z'
const today = new Date().toISOString().slice(0, 10)
const json = (body: unknown, method = 'POST') => ({ method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const TASK = builtinTypeId('s', 'task')
const SPRINT = builtinTypeId('s', 'sprint')

function setup() {
  const store = new NodeStore(':memory:')
  store.putSpace({ id: 's', name: 'Work', sidebar: [], createdAt: at })
  for (const type of createBuiltinTypes('s', at)) store.putType(type)
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-sprints-')))
  const app = createApp({ store, media, feed: new ChangeFeed() })
  const user = asUser(app, store, { spaces: ['s'] })
  const call = async <T>(url: string, init?: RequestInit) => {
    const response = await user.request(url, init)
    expect(response.status, url).toBeLessThan(300)
    return (await response.json()) as T
  }
  return { store, call }
}

const range = (start: string, end: string) => ({ dates: { kind: 'date' as const, value: { start: `${start}T00:00:00.000Z`, end: `${end}T00:00:00.000Z`, resolution: 'day' as const } } })

describe('sprints', () => {
  it('are turned on with their type, a Sprint field on tasks and two views, under the space’s name for them', async () => {
    const { store, call } = setup()
    expect(store.getType(SPRINT)).toBeUndefined()
    const on = await call<{ space: Space; types: ObjectType[] }>('/api/spaces/s/sprints', json({ enabled: true, name: 'Rodada' }))
    expect(on.space.sprints).toEqual({ enabled: true, name: 'Rodada', pluralName: 'Rodadas' })
    expect(store.getType(SPRINT)).toMatchObject({ name: 'Rodada', pluralName: 'Rodadas', system: 'sprint' })
    const task = store.getType(TASK)!
    expect(task.properties.find((p) => p.id === SPRINT_PROPERTY_ID)).toMatchObject({ kind: 'relation', name: 'Rodada', targetTypeIds: [SPRINT], multiple: false })
    expect(task.views.map((v) => v.name)).toEqual(['All', 'Current rodada', 'Backlog'])

    // Renamed: the type, the field and the view follow.
    await call('/api/spaces/s/sprints', json({ name: 'Ciclo', pluralName: 'Ciclos' }))
    expect(store.getType(SPRINT)).toMatchObject({ name: 'Ciclo', pluralName: 'Ciclos' })
    expect(store.getType(TASK)!.properties.find((p) => p.id === SPRINT_PROPERTY_ID)!.name).toBe('Ciclo')
    expect(store.getType(TASK)!.views.map((v) => v.name)).toEqual(['All', 'Current ciclo', 'Backlog'])

    // Off and on again: what the user deleted meanwhile stays deleted.
    await call('/api/spaces/s/sprints', json({ enabled: false }))
    expect(store.getSpace('s')!.sprints).toMatchObject({ enabled: false, name: 'Ciclo' })
    store.putType({ ...store.getType(TASK)!, views: store.getType(TASK)!.views.filter((v) => v.name !== 'Backlog') })
    await call('/api/spaces/s/sprints', json({ enabled: true }))
    expect(store.getType(TASK)!.views.map((v) => v.name)).toEqual(['All', 'Current ciclo'])
    await expect(call('/api/spaces/s/sprints', json({ name: 'x'.repeat(41) }))).rejects.toThrow()
  })

  it('know the current sprint: in queries and in typed lines', async () => {
    const { store, call } = setup()
    await call('/api/spaces/s/sprints', json({ enabled: true }))
    const past = await call<ObjectRecord>('/api/objects', json({ typeId: SPRINT, title: 'Sprint 1', props: range(addDays(today, -20), addDays(today, -7)) }))
    const now = await call<ObjectRecord>('/api/objects', json({ typeId: SPRINT, title: 'Sprint 2', props: range(addDays(today, -6), addDays(today, 7)) }))
    const later = await call<ObjectRecord>('/api/objects', json({ typeId: SPRINT, title: 'Sprint 3', props: range(addDays(today, 8), addDays(today, 21)) }))
    const sprints = store.listObjects(SPRINT)
    expect(currentSprint(sprints, today)?.id).toBe(now.id)
    expect(nextSprint(sprints, past)?.id).toBe(now.id)
    expect(nextSprint(sprints, later)).toBeUndefined()
    expect(followingSprintDays(later, today)).toEqual({ start: addDays(today, 22), end: addDays(today, 35) })

    const inCurrent = await call<ObjectRecord>('/api/objects', json({ typeId: TASK, line: 'Ship it sprint:current' }))
    expect(inCurrent.props[SPRINT_PROPERTY_ID]).toEqual({ kind: 'relation', value: [now.id] })
    await call<ObjectRecord>('/api/objects', json({ typeId: TASK, line: 'Later sprint:"Sprint 3"' }))
    await call<ObjectRecord>('/api/objects', json({ typeId: TASK, title: 'Someday' }))
    const views = store.getType(TASK)!.views
    const run = (name: string) =>
      call<ObjectSummary[]>('/api/spaces/s/query', json({ query: { typeIds: [TASK], filter: views.find((v) => v.name === name)!.filter }, today })).then((rows) => rows.map((o) => o.title).sort())
    expect(await run('Current sprint')).toEqual(['Ship it'])
    expect(await run('Backlog')).toEqual(['Someday'])
  })
})
