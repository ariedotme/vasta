import { describe, expect, it } from 'vitest'
import { builtinTypeId, createBuiltinTypes, flowMetrics, mondayOf, statusProperty, type ActivityEntry, type ObjectSummary } from '../src/index.ts'

const task = createBuiltinTypes('s', '2026-10-01T00:00:00.000Z').find((t) => t.system === 'task')!
const status = statusProperty(task)!
const select = (id: string) => ({ kind: 'select' as const, value: [id] })
const object = (id: string, createdAt: string, now: string): ObjectSummary =>
  ({ id, spaceId: 's', typeId: builtinTypeId('s', 'task'), title: id, createdAt, updatedAt: createdAt, props: { status: select(now) }, aliases: [], tagIds: [], collectionIds: [], preview: '' }) as ObjectSummary
let n = 0
const change = (objectId: string, at: string, before: string, after: string): ActivityEntry => ({ id: ++n, spaceId: 's', objectId, at, kind: 'changed', field: 'status', before: select(before), after: select(after) })

describe('flow metrics', () => {
  it('measures lead and cycle time, throughput, cumulative flow and work in progress', () => {
    const objects = [
      object('a', '2026-10-01T10:00:00.000Z', 'done'), // to do → doing on the 3rd → done on the 6th
      object('b', '2026-10-02T10:00:00.000Z', 'done'), // done, reopened, done again on the 13th
      object('c', '2026-10-05T10:00:00.000Z', 'doing'),
      object('d', '2026-10-07T10:00:00.000Z', 'todo'),
    ]
    const activity = [
      change('a', '2026-10-03T10:00:00.000Z', 'todo', 'doing'),
      change('a', '2026-10-06T10:00:00.000Z', 'doing', 'done'),
      change('b', '2026-10-04T10:00:00.000Z', 'todo', 'done'),
      change('b', '2026-10-08T10:00:00.000Z', 'done', 'doing'),
      change('b', '2026-10-13T10:00:00.000Z', 'doing', 'done'),
      change('c', '2026-10-09T10:00:00.000Z', 'todo', 'doing'),
      // Another field, and another object, are left out.
      { ...change('c', '2026-10-09T11:00:00.000Z', 'x', 'y'), field: 'priority' },
    ]
    const m = flowMetrics(objects, activity, status, { from: '2026-10-01', to: '2026-10-14', timeZone: 'UTC' })
    const a = m.items.find((i) => i.id === 'a')!
    expect([a.leadDays, a.cycleDays]).toEqual([5, 3])
    const b = m.items.find((i) => i.id === 'b')!
    expect(b).toMatchObject({ doneAt: '2026-10-13T10:00:00.000Z', startedAt: '2026-10-04T10:00:00.000Z', leadDays: 11, cycleDays: 9 })
    expect(m.items.find((i) => i.id === 'c')).toMatchObject({ category: 'doing', since: '2026-10-09T10:00:00.000Z' })
    expect(m.lead).toMatchObject({ count: 2, median: 5, p85: 11 })
    expect(m.cycle).toMatchObject({ count: 2, median: 3, average: 6 })
    expect(m.wip).toBe(1)
    expect(m.throughput).toEqual([
      { week: '2026-09-28', done: 0 },
      { week: '2026-10-05', done: 1 },
      { week: '2026-10-12', done: 1 },
    ])
    const day = (d: string) => m.flow.find((f) => f.day === d)
    expect(day('2026-10-01')).toEqual({ day: '2026-10-01', todo: 1, doing: 0, done: 0 })
    expect(day('2026-10-06')).toEqual({ day: '2026-10-06', todo: 1, doing: 0, done: 2 })
    expect(day('2026-10-09')).toEqual({ day: '2026-10-09', todo: 1, doing: 2, done: 1 })
    expect(day('2026-10-14')).toEqual({ day: '2026-10-14', todo: 1, doing: 1, done: 2 })
    expect(mondayOf('2026-10-11')).toBe('2026-10-05')
  })

  it('starts an object without status changes where it is now (its past is older than the activity kept)', () => {
    const m = flowMetrics([object('old', '2026-01-01T00:00:00.000Z', 'done')], [], status, { from: '2026-10-01', to: '2026-10-02', timeZone: 'UTC' })
    expect(m.items[0]).toMatchObject({ category: 'done', doneAt: '2026-01-01T00:00:00.000Z' })
    expect(m.lead.count).toBe(0)
    expect(m.flow[0]).toMatchObject({ done: 1 })
  })
})
