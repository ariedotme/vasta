// Flow metrics of a type with a status (tasks): how long work takes and how it moves, worked out
// from the activity's status changes (activity.ts) and the objects as they are now.
//   - lead time: created → done; cycle time: first moved past "to do" → done
//   - throughput: what got done per week (Monday to Sunday)
//   - cumulative flow: per day, how many were in each status category at its end
//   - age: how long each open one has been in its current status
// Activity older than the space's retention is gone, so an object's past before it is guessed
// from what is left (its first status change says where it started; without one, where it is now).
import type { ActivityEntry } from './activity.ts'
import type { Id, IsoDateTime, ObjectSummary, ObjectType, SelectPropertyDef } from './model.ts'
import { addDays, dayIn } from './time.ts'

export type StatusCategory = 'todo' | 'doing' | 'done'
export const STATUS_CATEGORIES: StatusCategory[] = ['todo', 'doing', 'done']

/** The select a type's flow is measured on: "status" if it has status meanings, else the first that does. */
export function statusProperty(type: ObjectType | undefined): SelectPropertyDef | undefined {
  const selects = (type?.properties ?? []).filter((p): p is SelectPropertyDef => p.kind === 'select' && p.options.some((o) => o.status))
  return selects.find((p) => p.id === 'status') ?? selects[0]
}

export interface FlowItem {
  id: Id
  title: string
  createdAt: IsoDateTime
  /** When it first left "to do"; absent if it never did (or that is older than the activity kept). */
  startedAt?: IsoDateTime
  /** When it last became done, while it still is. */
  doneAt?: IsoDateTime
  category: StatusCategory
  /** Since when it has had its current status. */
  since: IsoDateTime
  /** Days, for the done ones. */
  leadDays?: number
  cycleDays?: number
}

export interface FlowMetrics {
  from: string
  to: string
  items: FlowItem[]
  /** Per week (its Monday) in the range: how many became done. */
  throughput: { week: string; done: number }[]
  /** Per day in the range: how many were in each category at its end. */
  flow: { day: string; todo: number; doing: number; done: number }[]
  /** Over what was done in the range. */
  lead: Summary
  cycle: Summary
  /** Open ones now. */
  wip: number
}

export interface Summary {
  count: number
  median?: number
  p85?: number
  average?: number
}

const DAY_MS = 86_400_000
const days = (from: IsoDateTime, to: IsoDateTime) => Math.max(0, (Date.parse(to) - Date.parse(from)) / DAY_MS)

function summarize(values: number[]): Summary {
  if (!values.length) return { count: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!
  return { count: values.length, median: at(0.5), p85: at(0.85), average: values.reduce((a, b) => a + b, 0) / values.length }
}

/** The Monday of a day's week. */
export function mondayOf(day: string): string {
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay()
  return addDays(day, -((weekday + 6) % 7))
}

/**
 * Flow metrics for `objects` (of one type, not deleted) over the days `from`..`to` (inclusive, in
 * `timeZone`), from `activity` (any entries; the status ones of these objects are used).
 */
export function flowMetrics(objects: ObjectSummary[], activity: ActivityEntry[], status: SelectPropertyDef, range: { from: string; to: string; timeZone: string }): FlowMetrics {
  const categoryOf = (value: unknown): StatusCategory => {
    const id = (value as { kind?: string; value?: unknown } | undefined)?.kind === 'select' ? ((value as { value: Id[] }).value[0] ?? '') : ''
    return status.options.find((o) => o.id === id)?.status ?? 'todo'
  }
  const changes = new Map<Id, ActivityEntry[]>()
  for (const entry of activity) {
    if (entry.kind !== 'changed' || entry.field !== status.id) continue
    changes.set(entry.objectId, [...(changes.get(entry.objectId) ?? []), entry])
  }

  // Each object's statuses over time: [since, category], oldest first.
  const timelines = new Map<Id, [IsoDateTime, StatusCategory][]>()
  const items: FlowItem[] = []
  for (const object of objects) {
    const steps = (changes.get(object.id) ?? []).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id - b.id))
    const first = steps[0]
    const timeline: [IsoDateTime, StatusCategory][] = [[object.createdAt, first ? categoryOf(first.before) : categoryOf(object.props[status.id])]]
    for (const step of steps) timeline.push([step.at, categoryOf(step.after)])
    timelines.set(object.id, timeline)
    const [since, category] = timeline[timeline.length - 1]!
    const startedAt = timeline.find(([, c]) => c !== 'todo')?.[0]
    let doneAt: IsoDateTime | undefined
    if (category === 'done') {
      // The last time it became done (after any reopening).
      for (let i = timeline.length - 1; i >= 0 && timeline[i]![1] === 'done'; i--) doneAt = timeline[i]![0]
    }
    items.push({
      id: object.id,
      title: object.title,
      createdAt: object.createdAt,
      ...(startedAt ? { startedAt } : {}),
      ...(doneAt ? { doneAt } : {}),
      category,
      since,
      ...(doneAt ? { leadDays: days(object.createdAt, doneAt) } : {}),
      ...(doneAt && startedAt ? { cycleDays: days(startedAt, doneAt) } : {}),
    })
  }

  const dayOf = (instant: IsoDateTime) => dayIn(instant, range.timeZone)
  const doneInRange = items.filter((i) => i.doneAt && dayOf(i.doneAt) >= range.from && dayOf(i.doneAt) <= range.to)

  const throughput: FlowMetrics['throughput'] = []
  for (let week = mondayOf(range.from); week <= range.to; week = addDays(week, 7)) {
    throughput.push({ week, done: doneInRange.filter((i) => mondayOf(dayOf(i.doneAt!)) === week).length })
  }

  const flow: FlowMetrics['flow'] = []
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) {
    const counts = { day, todo: 0, doing: 0, done: 0 }
    for (const timeline of timelines.values()) {
      let category: StatusCategory | undefined
      for (const [since, c] of timeline) if (dayOf(since) <= day) category = c
      if (category) counts[category]++
    }
    flow.push(counts)
  }

  return {
    from: range.from,
    to: range.to,
    items,
    throughput,
    flow,
    lead: summarize(doneInRange.map((i) => i.leadDays!)),
    cycle: summarize(doneInRange.flatMap((i) => (i.cycleDays === undefined ? [] : [i.cycleDays]))),
    wip: items.filter((i) => i.category === 'doing').length,
  }
}
