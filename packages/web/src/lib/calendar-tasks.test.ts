import { describe, expect, it } from 'vitest'
import type { DateValue, Id, ObjectSummary, ObjectType } from '@vasta/core'
import {
  DEFAULT_SCHEDULE_MINUTES,
  canComplete,
  classifyScheduleItems,
  isObjectDone,
  movedEntryTimes,
  primaryDateProperty,
  schedulableTypes,
  scheduledDateForDrop,
} from './calendar-tasks.ts'

function instantAt(day: string, minutes: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  return new Date(year, month - 1, date, Math.floor(minutes / 60), minutes % 60).toISOString()
}

const ts = '2026-01-01T00:00:00.000Z'

const taskType: ObjectType = {
  id: 'type-task',
  spaceId: 'space-1',
  name: 'Task',
  pluralName: 'Tasks',
  system: 'task',
  color: 'emerald',
  properties: [
    {
      id: 'status',
      kind: 'select',
      name: 'Status',
      multiple: false,
      options: [
        { id: 'todo', label: 'To do', status: 'todo' },
        { id: 'done', label: 'Done', status: 'done' },
      ],
    },
    { id: 'due', kind: 'date', name: 'Due', withTime: true },
    {
      id: 'priority',
      kind: 'select',
      name: 'Priority',
      multiple: false,
      options: [
        { id: 'high', label: 'High', color: 'red' },
        { id: 'medium', label: 'Medium', color: 'amber' },
        { id: 'low', label: 'Low', color: 'sky' },
      ],
    },
  ],
  views: [],
  createdAt: ts,
  updatedAt: ts,
}

const bugType: ObjectType = {
  id: 'type-bug',
  spaceId: 'space-1',
  name: 'Bug',
  pluralName: 'Bugs',
  color: 'red',
  properties: [
    {
      id: 'state',
      kind: 'select',
      name: 'State',
      multiple: false,
      options: [
        { id: 'open', label: 'Open', status: 'todo' },
        { id: 'fixed', label: 'Fixed', status: 'done' },
      ],
    },
    { id: 'target-date', kind: 'date', name: 'Target date', withTime: true },
  ],
  views: [],
  createdAt: ts,
  updatedAt: ts,
}

const videoType: ObjectType = {
  id: 'type-video',
  spaceId: 'space-1',
  name: 'Video',
  pluralName: 'Videos',
  color: 'violet',
  properties: [{ id: 'publish', kind: 'date', name: 'Publish date', withTime: true }],
  views: [],
  createdAt: ts,
  updatedAt: ts,
}

const noteType: ObjectType = {
  id: 'type-note',
  spaceId: 'space-1',
  name: 'Page',
  pluralName: 'Pages',
  system: 'page',
  properties: [],
  views: [],
  createdAt: ts,
  updatedAt: ts,
}

const dailyNoteType: ObjectType = {
  id: 'type-daily',
  spaceId: 'space-1',
  name: 'Daily note',
  pluralName: 'Daily notes',
  system: 'daily-note',
  properties: [{ id: 'd', kind: 'date', name: 'Date' }],
  views: [],
  createdAt: ts,
  updatedAt: ts,
}

const typesById = new Map<Id, ObjectType>([
  [taskType.id, taskType],
  [bugType.id, bugType],
  [videoType.id, videoType],
  [noteType.id, noteType],
])

function makeObj(
  id: string,
  typeId: string,
  opts: { title?: string; date?: DateValue; dateField?: string; status?: string; statusField?: string; priority?: string; updatedAt?: string } = {}
): ObjectSummary {
  const props: ObjectSummary['props'] = {}
  if (opts.date) props[opts.dateField ?? 'due'] = { kind: 'date', value: opts.date }
  if (opts.status) props[opts.statusField ?? 'status'] = { kind: 'select', value: [opts.status] }
  if (opts.priority) props.priority = { kind: 'select', value: [opts.priority] }
  return {
    id,
    spaceId: 'space-1',
    typeId,
    title: opts.title ?? id,
    aliases: [],
    tagIds: [],
    collectionIds: [],
    props,
    preview: '',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: opts.updatedAt ?? '2026-11-20T00:00:00.000Z',
  }
}

describe('calendar-tasks helpers', () => {
  it('lists schedulable types with Task first and excludes pages and daily notes', () => {
    const result = schedulableTypes([videoType, noteType, dailyNoteType, bugType, taskType])
    expect(result.map((t) => t.id)).toEqual(['type-task', 'type-bug', 'type-video'])
  })

  it('detects completable types including custom types with non-default status ids', () => {
    expect(canComplete(taskType)).toBe(true)
    expect(canComplete(bugType)).toBe(true)
    expect(canComplete(videoType)).toBe(false)
    expect(primaryDateProperty(bugType)?.id).toBe('target-date')
    expect(isObjectDone(makeObj('b1', bugType.id, { status: 'fixed', statusField: 'state' }), bugType)).toBe(true)
    expect(isObjectDone(makeObj('b2', bugType.id, { status: 'open', statusField: 'state' }), bugType)).toBe(false)
  })

  it('classifies overdue, day-only, undated and timed items differently for week vs month views', () => {
    const today = '2026-11-23'
    const items = [
      makeObj('overdue', taskType.id, { date: { start: '2026-11-20T00:00:00.000Z', resolution: 'day' }, status: 'todo' }),
      makeObj('done-old', taskType.id, { date: { start: '2026-11-19T00:00:00.000Z', resolution: 'day' }, status: 'done' }),
      makeObj('day-today', taskType.id, { date: { start: '2026-11-23T00:00:00.000Z', resolution: 'day' }, status: 'todo' }),
      makeObj('undated-low', taskType.id, { priority: 'low', status: 'todo', updatedAt: '2026-11-22T00:00:00.000Z' }),
      makeObj('undated-high', taskType.id, { priority: 'high', status: 'todo', updatedAt: '2026-11-21T00:00:00.000Z' }),
      makeObj('timed', taskType.id, { date: { start: instantAt('2026-11-24', 600), end: instantAt('2026-11-24', 660), resolution: 'time' }, status: 'todo' }),
      makeObj('video-undated', videoType.id, { updatedAt: '2026-11-23T00:00:00.000Z' }),
    ]

    const week = classifyScheduleItems(items, typesById, { today, view: 'week', showDone: false })
    expect(week.overdue.map((o) => o.id)).toEqual(['overdue'])
    // Day-only items come first in Unscheduled on week view, followed by undated sorted by priority.
    expect(week.unscheduled.map((o) => o.id)).toEqual(['day-today', 'undated-high', 'undated-low', 'video-undated'])
    expect(week.scheduled.map((o) => o.id)).toEqual(['timed'])

    const month = classifyScheduleItems(items, typesById, { today, view: 'month', showDone: false })
    expect(month.overdue.map((o) => o.id)).toEqual(['overdue'])
    expect(month.unscheduled.map((o) => o.id)).toEqual(['undated-high', 'undated-low', 'video-undated'])
    expect(month.scheduled.map((o) => o.id)).toEqual(['day-today', 'timed'])

    const withDone = classifyScheduleItems(items, typesById, { today, view: 'week', showDone: true })
    // Completed past items are not flagged overdue.
    expect(withDone.overdue.map((o) => o.id)).toEqual(['overdue'])
    expect(withDone.unscheduled.map((o) => o.id)).toContain('done-old')
  })

  it('builds 1-hour timed blocks on hour drop, preserves existing duration, and writes day resolution on all-day/month drop', () => {
    const timed = scheduledDateForDrop(undefined, { day: '2026-11-24', minutes: 600 })
    expect(timed.resolution).toBe('time')
    expect(timed.start).toBe(instantAt('2026-11-24', 600))
    expect(Date.parse(timed.end!) - Date.parse(timed.start)).toBe(DEFAULT_SCHEDULE_MINUTES * 60_000)

    const existing90: DateValue = {
      start: instantAt('2026-11-24', 600),
      end: instantAt('2026-11-24', 690),
      resolution: 'time',
    }
    const movedTimed = scheduledDateForDrop(existing90, { day: '2026-11-25', minutes: 660 })
    expect(movedTimed.start).toBe(instantAt('2026-11-25', 660))
    expect(Date.parse(movedTimed.end!) - Date.parse(movedTimed.start)).toBe(90 * 60_000)

    const allDay = scheduledDateForDrop(existing90, { day: '2026-11-25', allDay: true })
    expect(allDay).toEqual({ start: '2026-11-25T00:00:00.000Z', resolution: 'day' })

    const monthMovedTimed = scheduledDateForDrop(existing90, { day: '2026-11-26' })
    expect(monthMovedTimed.resolution).toBe('time')
    expect(monthMovedTimed.start).toBe(instantAt('2026-11-26', 600))
  })

  it('promotes all-day entries to timed blocks and converts timed entries to all-day via movedEntryTimes', () => {
    const allDayEntry = {
      key: 'k1',
      kind: 'property' as const,
      objectId: 't1',
      field: 'due',
      start: '2026-11-23T00:00:00.000Z',
      startDay: '2026-11-23',
      endDay: '2026-11-23',
      allDay: true,
    }
    const promoted = movedEntryTimes(allDayEntry, { day: '2026-11-24', minutes: 540 })
    expect(promoted.resolution).toBe('time')
    expect(promoted.start).toBe(instantAt('2026-11-24', 540))
    expect(Date.parse(promoted.end!) - Date.parse(promoted.start)).toBe(60 * 60_000)

    const timedEntry = {
      key: 'k2',
      kind: 'property' as const,
      objectId: 't2',
      field: 'due',
      start: instantAt('2026-11-24', 540),
      end: instantAt('2026-11-24', 600),
      startDay: '2026-11-24',
      endDay: '2026-11-24',
      allDay: false,
    }
    const demoted = movedEntryTimes(timedEntry, { day: '2026-11-25', allDay: true })
    expect(demoted).toEqual({ start: '2026-11-25T00:00:00.000Z', resolution: 'day' })
  })
})
