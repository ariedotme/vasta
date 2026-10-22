import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createBuiltinTypes, newObject, type DateValue, type ObjectRecord, type ObjectSummary, type ObjectType } from '../src/index.ts'
import { calendarObjects, changeOccurrence, changeOneOccurrence, changeSeries, dayReferences, objectEntries, occurrences, pruneExceptions, spanOf, splitSeries } from '../src/calendar.ts'
import { Store } from '../src/store.ts'
import { calendarEntries, parseCalendar } from '../src/ics.ts'
import { addDays, instantOf, wallTimeIn } from '../src/time.ts'

const SP = 'America/Sao_Paulo'
const NY = 'America/New_York'
const at = '2026-10-01T12:00:00.000Z'

describe('time zones', () => {
  it('turns wall-clock times into instants, across DST', () => {
    expect(new Date(instantOf({ year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0 }, NY)).toISOString()).toBe('2026-07-01T13:00:00.000Z')
    expect(new Date(instantOf({ year: 2026, month: 12, day: 1, hour: 9, minute: 0, second: 0 }, NY)).toISOString()).toBe('2026-12-01T14:00:00.000Z')
    // 02:30 does not exist on 2026-03-08 in New York; it moves past the jump.
    const skipped = instantOf({ year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 }, NY)
    expect(wallTimeIn(skipped, NY).hour).toBe(3)
  })
})

describe('occurrences', () => {
  const range = { from: '2026-10-01', to: '2026-10-31' }

  it('lists a single date when it touches the range', () => {
    expect(occurrences({ start: '2026-10-05T00:00:00.000Z', resolution: 'day' }, range, SP)).toHaveLength(1)
    expect(occurrences({ start: '2026-11-05T00:00:00.000Z', resolution: 'day' }, range, SP)).toHaveLength(0)
    // A range that starts before and ends inside still shows.
    expect(occurrences({ start: '2026-09-28T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z', resolution: 'day' }, range, SP)).toHaveLength(1)
  })

  it('repeats day dates, keeping their length', () => {
    const list = occurrences({ start: '2026-09-30T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z', resolution: 'day', rrule: 'FREQ=WEEKLY' }, range, SP)
    expect(list.map((o) => [o.startDay, o.endDay])).toEqual([
      ['2026-09-30', '2026-10-01'],
      ['2026-10-07', '2026-10-08'],
      ['2026-10-14', '2026-10-15'],
      ['2026-10-21', '2026-10-22'],
      ['2026-10-28', '2026-10-29'],
    ])
  })

  it('repeats times at the same wall-clock time across DST', () => {
    // 09:00 in New York, weekly on Mondays; DST ends on 2026-11-01.
    const value = { start: '2026-10-26T13:00:00.000Z', end: '2026-10-26T14:00:00.000Z', resolution: 'time' as const, rrule: 'FREQ=WEEKLY;COUNT=3', timeZone: NY }
    const list = occurrences(value, { from: '2026-10-01', to: '2026-12-31' }, NY)
    expect(list.map((o) => o.start)).toEqual(['2026-10-26T13:00:00.000Z', '2026-11-02T14:00:00.000Z', '2026-11-09T14:00:00.000Z'])
    expect(list[1]!.end).toBe('2026-11-02T15:00:00.000Z')
  })

  it('honors UNTIL and ignores rules it cannot read', () => {
    const until = occurrences({ start: '2026-10-01T00:00:00.000Z', resolution: 'day', rrule: 'FREQ=DAILY;UNTIL=20261003' }, range, SP)
    expect(until.map((o) => o.startDay)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
    // The web editor writes UNTIL as the end of a day, for day and time values alike.
    const untilEndOfDay = occurrences({ start: '2026-10-01T00:00:00.000Z', resolution: 'day', rrule: 'FREQ=DAILY;UNTIL=20261003T235959' }, range, SP)
    expect(untilEndOfDay.map((o) => o.startDay)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
    const timed = occurrences({ start: '2026-10-01T22:00:00.000Z', resolution: 'time', rrule: 'FREQ=DAILY;UNTIL=20261003T235959', timeZone: SP }, range, SP)
    expect(timed.map((o) => o.startDay)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
    expect(occurrences({ start: '2026-10-01T00:00:00.000Z', resolution: 'day', rrule: 'nonsense' }, range, SP)).toHaveLength(1)
  })

  it('ends a timed range at midnight on the day before', () => {
    expect(spanOf({ start: '2026-10-05T23:00:00.000Z', end: '2026-10-06T03:00:00.000Z', resolution: 'time' }, SP)).toEqual({ startDay: '2026-10-05', endDay: '2026-10-05' })
  })
})

describe('exceptions', () => {
  // Weekly at 09:00 in New York from Monday 2026-10-19, an hour long; DST ends on 2026-11-01.
  const weekly: DateValue = { start: '2026-10-19T13:00:00.000Z', end: '2026-10-19T14:00:00.000Z', resolution: 'time', rrule: 'FREQ=WEEKLY;COUNT=6', timeZone: NY }
  const keys = ['2026-10-19T13:00:00.000Z', '2026-10-26T13:00:00.000Z', '2026-11-02T14:00:00.000Z', '2026-11-09T14:00:00.000Z', '2026-11-16T14:00:00.000Z', '2026-11-23T14:00:00.000Z']
  const range = { from: '2026-10-01', to: '2026-12-31' }
  const starts = (value: DateValue, r = range) => occurrences(value, r, NY).map((o) => o.start)

  it('keys occurrences by the start the rule gives them', () => {
    expect(occurrences(weekly, range, NY).map((o) => o.occurrence)).toEqual(keys)
  })

  it('moves, resizes and cancels single occurrences', () => {
    let value = changeOneOccurrence(weekly, keys[1]!, { start: '2026-10-28T15:00:00.000Z', end: '2026-10-28T17:00:00.000Z' })
    value = changeOneOccurrence(value, keys[3]!, { cancelled: true })
    const list = occurrences(value, range, NY)
    expect(list.map((o) => [o.occurrence, o.start, o.end])).toEqual([
      [keys[0], keys[0], '2026-10-19T14:00:00.000Z'],
      [keys[1], '2026-10-28T15:00:00.000Z', '2026-10-28T17:00:00.000Z'],
      [keys[2], keys[2], '2026-11-02T15:00:00.000Z'],
      [keys[4], keys[4], '2026-11-16T15:00:00.000Z'],
      [keys[5], keys[5], '2026-11-23T15:00:00.000Z'],
    ])
    expect(list[1]!.startDay).toBe('2026-10-28')
    // Moving it back where the rule puts it drops the exception.
    expect(changeOneOccurrence(value, keys[1]!, { start: keys[1]!, end: '2026-10-26T14:00:00.000Z' }).exceptions).toEqual({ [keys[3]!]: { cancelled: true } })
  })

  it('shows a moved occurrence in the range it was moved to, and not in the one it left', () => {
    const value = changeOneOccurrence(weekly, keys[5]!, { start: '2026-10-07T13:00:00.000Z', end: '2026-10-07T14:00:00.000Z' })
    expect(starts(value, { from: '2026-10-05', to: '2026-10-11' })).toEqual(['2026-10-07T13:00:00.000Z'])
    expect(starts(value, { from: '2026-11-23', to: '2026-11-29' })).toEqual([])
    // An exception for an occurrence the rule does not give is ignored.
    const stale = { ...weekly, exceptions: { '2026-10-20T13:00:00.000Z': { start: '2026-10-21T13:00:00.000Z' } } }
    expect(starts(stale)).toEqual(keys)
    expect(pruneExceptions(stale, NY).exceptions).toBeUndefined()
  })

  it('moves all of a series like one occurrence, across DST, with its weekdays and exceptions', () => {
    const value = changeOneOccurrence({ ...weekly, rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=6' }, keys[4]!, { cancelled: true })
    // Monday 2026-11-02 09:00 EST dragged to Tuesday 10:30, 30 minutes long.
    const moved = changeSeries(value, keys[2]!, { start: '2026-11-03T15:30:00.000Z', end: '2026-11-03T16:00:00.000Z' }, NY)
    expect(moved.rrule).toBe('FREQ=WEEKLY;BYDAY=TU;COUNT=6')
    expect(moved.start).toBe('2026-10-20T14:30:00.000Z') // 10:30 EDT
    expect(moved.end).toBe('2026-10-20T15:00:00.000Z')
    expect(Object.keys(moved.exceptions ?? {})).toEqual(['2026-11-17T15:30:00.000Z'])
    expect(starts(moved)).toEqual(['2026-10-20T14:30:00.000Z', '2026-10-27T14:30:00.000Z', '2026-11-03T15:30:00.000Z', '2026-11-10T15:30:00.000Z', '2026-11-24T15:30:00.000Z'])
  })

  it('moves day dates by days, keeping their length', () => {
    const daily: DateValue = { start: '2026-10-05T00:00:00.000Z', end: '2026-10-06T00:00:00.000Z', resolution: 'day', rrule: 'FREQ=MONTHLY;COUNT=3' }
    const moved = changeSeries(daily, '2026-11-05T00:00:00.000Z', { start: '2026-11-07T00:00:00.000Z', end: '2026-11-07T00:00:00.000Z' }, SP)
    expect(moved).toMatchObject({ start: '2026-10-07T00:00:00.000Z', rrule: 'FREQ=MONTHLY;COUNT=3' })
    expect(moved.end).toBeUndefined()
    const once = changeOneOccurrence(daily, '2026-11-05T00:00:00.000Z', { start: '2026-11-09T00:00:00.000Z', end: '2026-11-11T00:00:00.000Z' })
    expect(occurrences(once, { from: '2026-11-01', to: '2026-11-30' }, SP).map((o) => [o.startDay, o.endDay])).toEqual([['2026-11-09', '2026-11-11']])
  })

  it('splits a series for "this and following"', () => {
    const value = changeOneOccurrence(changeOneOccurrence(weekly, keys[1]!, { cancelled: true }), keys[4]!, { cancelled: true })
    const split = splitSeries(value, keys[3]!, { start: '2026-11-09T15:00:00.000Z', end: '2026-11-09T16:00:00.000Z' }, NY)!
    // The old series stops at the last occurrence it keeps, with its own exceptions only.
    expect(split.before.rrule).toBe('FREQ=WEEKLY;UNTIL=20261102T090000')
    expect(split.before.exceptions).toEqual({ [keys[1]!]: { cancelled: true } })
    expect(starts(split.before)).toEqual([keys[0], keys[2]])
    // The rest starts at the moved occurrence, three left of six.
    expect(split.after).toMatchObject({ start: '2026-11-09T15:00:00.000Z', end: '2026-11-09T16:00:00.000Z', rrule: 'FREQ=WEEKLY;COUNT=3' })
    expect(starts(split.after!)).toEqual(['2026-11-09T15:00:00.000Z', '2026-11-23T15:00:00.000Z'])
    // The first occurrence has nothing before it: the change is for all of it.
    expect(splitSeries(value, keys[0]!, { cancelled: true }, NY)).toBeUndefined()
    // Cancelling this and following only ends the series.
    expect(splitSeries(weekly, keys[2]!, { cancelled: true }, NY)).toEqual({ before: { ...weekly, rrule: 'FREQ=WEEKLY;UNTIL=20261026T090000' } })
  })

  it('splits day dates with UNTIL on the last day kept', () => {
    const daily: DateValue = { start: '2026-10-01T00:00:00.000Z', resolution: 'day', rrule: 'FREQ=DAILY;UNTIL=20261010' }
    const split = splitSeries(daily, '2026-10-04T00:00:00.000Z', { start: '2026-10-04T00:00:00.000Z' }, SP)!
    expect(split.before.rrule).toBe('FREQ=DAILY;UNTIL=20261003')
    expect(split.after).toEqual({ ...daily, start: '2026-10-04T00:00:00.000Z' })
  })
})

describe('changing occurrences in the store', () => {
  const setUp = () => {
    const store = new Store(new DatabaseSync(':memory:'))
    store.putSpace({ id: 's', name: 'Space', sidebar: [], createdAt: at })
    for (const type of createBuiltinTypes('s', at)) store.putType(type)
    const date: DateValue = { start: '2026-10-19T13:00:00.000Z', end: '2026-10-19T14:00:00.000Z', resolution: 'time', rrule: 'FREQ=WEEKLY;COUNT=4', timeZone: NY }
    const object: ObjectRecord = {
      id: 'standup', spaceId: 's', typeId: 'task:s', title: 'Standup', icon: { kind: 'emoji', value: '🧍' }, aliases: [], tagIds: ['tag'], collectionIds: [],
      props: { due: { kind: 'date', value: date } },
      content: { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Agenda' }] }] } },
      createdAt: at, updatedAt: at,
    }
    store.putObject(object)
    return store
  }
  const later = '2026-10-20T12:00:00.000Z'
  const edit = (scope: 'this' | 'following' | 'all', change: Parameters<typeof changeOccurrence>[1]['change'], occurrence = '2026-11-02T14:00:00.000Z') =>
    ({ objectId: 'standup', field: 'due', occurrence, scope, change })
  const dueOf = (object: ObjectRecord | undefined) => (object?.props.due?.kind === 'date' ? object.props.due.value : undefined)

  it('writes an exception for "this event"', () => {
    const store = setUp()
    const { object } = changeOccurrence(store, edit('this', { cancelled: true }), later, NY)
    expect(dueOf(object)?.exceptions).toEqual({ '2026-11-02T14:00:00.000Z': { cancelled: true } })
    expect(dueOf(store.getObject('standup'))?.exceptions).toEqual({ '2026-11-02T14:00:00.000Z': { cancelled: true } })
    expect(() => changeOccurrence(store, edit('this', { cancelled: true }, '2026-11-03T14:00:00.000Z'), later, NY)).toThrow('no such occurrence')
  })

  it('copies the object, text included, for "this and following"', () => {
    const store = setUp()
    const { object, created } = changeOccurrence(store, edit('following', { start: '2026-11-02T15:00:00.000Z', end: '2026-11-02T16:00:00.000Z' }), later, NY)
    expect(dueOf(object)?.rrule).toBe('FREQ=WEEKLY;UNTIL=20261026T090000')
    expect(created).toBeDefined()
    const copy = store.getObject(created!.id)!
    expect(copy).toMatchObject({ title: 'Standup', typeId: 'task:s', icon: { kind: 'emoji', value: '🧍' }, tagIds: ['tag'], createdAt: later })
    expect(dueOf(copy)).toMatchObject({ start: '2026-11-02T15:00:00.000Z', rrule: 'FREQ=WEEKLY;COUNT=2' })
    // The text is copied, and ends with a mention of the original, which lists the copy in its backlinks.
    expect(copy.content.body!.content.map((n) => n.content?.map((c) => c.text ?? c.attrs?.label).join(''))).toEqual(['Agenda', 'Continues from Standup'])
    expect(store.backlinks('standup').map((b) => b.object.id)).toContain(copy.id)
    expect(store.loadText(copy.id)!.getXmlFragment('body').length).toBe(2)

    // Splitting the copy again keeps one "Continues from" line.
    const again = changeOccurrence(store, { ...edit('following', { start: '2026-11-09T15:00:00.000Z', end: '2026-11-09T16:00:00.000Z' }, '2026-11-09T15:00:00.000Z'), objectId: copy.id }, later, NY)
    const third = store.getObject(again.created!.id)!
    expect(third.content.body!.content).toHaveLength(2)
    expect(third.content.body!.content[1]!.content![1]!.attrs!.objectId).toBe(copy.id)
  })

  it('changes all of it, or moves it to the trash when all are deleted', () => {
    const store = setUp()
    changeOccurrence(store, edit('all', { start: '2026-11-02T15:00:00.000Z', end: '2026-11-02T15:30:00.000Z' }), later, NY)
    expect(dueOf(store.getObject('standup'))).toMatchObject({ start: '2026-10-19T14:00:00.000Z', end: '2026-10-19T14:30:00.000Z' })
    // "This and following" from the first occurrence is all of it.
    const { created } = changeOccurrence(store, edit('following', { cancelled: true }, '2026-10-19T14:00:00.000Z'), later, NY)
    expect(created).toBeUndefined()
    expect(store.getObject('standup')!.deletedAt).toBe(later)
  })
})

describe('object entries', () => {
  const event: ObjectType = {
    id: 'event', spaceId: 's', name: 'Event', pluralName: 'Events', views: [], createdAt: at, updatedAt: at,
    properties: [{ id: 'when', kind: 'date', name: 'When', withTime: true }],
  }
  const types = new Map([...createBuiltinTypes('s', at), event].map((t) => [t.id, t]))
  const obj = (id: string, typeId: string, data: Partial<ObjectSummary> = {}): ObjectSummary => ({
    id, spaceId: 's', typeId, title: id, aliases: [], tagIds: [], collectionIds: [], props: {}, createdAt: at, updatedAt: at, preview: '', ...data,
  })

  it('collects daily notes, date properties and date objects with notes', () => {
    const objects = [
      obj('note', 'daily-note:s', { date: { start: '2026-10-05T00:00:00.000Z', resolution: 'day' } }),
      obj('bare-date', 'date:s', { date: { start: '2026-10-06T00:00:00.000Z', resolution: 'day' } }),
      obj('noted-date', 'date:s', { date: { start: '2026-10-07T00:00:00.000Z', resolution: 'day' }, preview: 'Something happened' }),
      obj('task', 'task:s', { props: { due: { kind: 'date', value: { start: '2026-10-08T00:00:00.000Z', resolution: 'day' } } } }),
      obj('party', 'event', { props: { when: { kind: 'date', value: { start: '2026-10-09T22:00:00.000Z', resolution: 'time', rrule: 'FREQ=DAILY;COUNT=2' } } } }),
      obj('gone', 'event', { deletedAt: at, props: { when: { kind: 'date', value: { start: '2026-10-09T22:00:00.000Z', resolution: 'time' } } } }),
    ]
    const entries = objectEntries(objects, types, { from: '2026-10-01', to: '2026-10-31' }, SP)
    expect(entries.map((e) => [e.objectId, e.kind, e.field, e.startDay, !!e.recurring])).toEqual([
      ['note', 'daily-note', 'date', '2026-10-05', false],
      ['noted-date', 'object', 'date', '2026-10-07', false],
      ['task', 'property', 'due', '2026-10-08', false],
      ['party', 'property', 'when', '2026-10-09', true],
      ['party', 'property', 'when', '2026-10-10', true],
    ])
  })
})

describe('the objects a calendar reads', () => {
  it('are every object with an entry or a reference in the range, in any time zone', () => {
    const store = new Store(new DatabaseSync(':memory:'))
    store.putSpace({ id: 's', name: 'Space', sidebar: [], createdAt: at })
    for (const type of createBuiltinTypes('s', at)) store.putType(type)
    const types = new Map(store.listTypes('s').map((t) => [t.id, t]))
    const typeOf = (system: string) => [...types.values()].find((t) => t.system === system)!
    const day = (n: number) => addDays('2026-10-01', n)
    const dates: DateValue[] = []
    for (let n = -40; n <= 70; n += 3) {
      dates.push({ start: `${day(n)}T00:00:00.000Z`, resolution: 'day' })
      dates.push({ start: `${day(n)}T02:30:00.000Z`, end: `${day(n)}T04:00:00.000Z`, resolution: 'time', timeZone: SP })
      dates.push({ start: `${day(n)}T23:30:00.000Z`, resolution: 'time' })
      dates.push({ start: `${day(n)}T00:00:00.000Z`, end: `${day(n + 9)}T00:00:00.000Z`, resolution: 'day' })
    }
    dates.push({ start: `${day(-300)}T15:00:00.000Z`, resolution: 'time', rrule: 'FREQ=WEEKLY', timeZone: NY })
    dates.push({ start: `${day(-30)}T00:00:00.000Z`, resolution: 'day', rrule: 'FREQ=MONTHLY;COUNT=2' })
    let i = 0
    for (const date of dates) {
      store.putObject(newObject(typeOf('page'), { title: `own ${i}`, date }, `own${i}`, at))
      store.putObject(newObject(typeOf('task'), { title: `due ${i}`, props: { due: { kind: 'date', value: date } } }, `due${i}`, at))
      if (date.resolution === 'day' && !date.end && !date.rrule) store.putObject(newObject(typeOf('daily-note'), { title: '', date }, `daily${i}`, at))
      i++
    }
    store.putObject(newObject(typeOf('page'), { title: 'Mentions a day', content: { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: 'daily0' } }] }] } } }, 'mentions', at))
    for (const timeZone of ['UTC', SP, 'Asia/Tokyo', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      for (const range of [{ from: day(0), to: day(0) }, { from: day(-3), to: day(31) }, { from: day(60), to: day(66) }, { from: day(-40), to: day(-40) }]) {
        const all = store.listSpaceObjects('s')
        const some = calendarObjects(store, 's', types, range)
        expect(some.length).toBeLessThan(all.length)
        const entries = (objects: ObjectSummary[]) => objectEntries(objects, types, range, timeZone).sort((a, b) => a.key.localeCompare(b.key))
        expect(entries(some)).toEqual(entries(all))
        const links = (ids: string[]) => store.linkCounts(ids)
        expect(dayReferences(some, types, range, timeZone, links)).toEqual(dayReferences(all, types, range, timeZone, links))
      }
    }
  })
})

describe('iCalendar feeds', () => {
  const parsed = parseCalendar(readFileSync(new URL('./fixtures/sample.ics', import.meta.url), 'utf8'))
  const entries = calendarEntries(parsed, 'src', { from: '2026-10-26', to: '2026-11-04' }, SP)
  const byTitle = (title: string) => entries.filter((e) => e.title === title)

  it('reads the calendar name', () => {
    expect(parsed.name).toBe('Work')
  })

  it('expands repeating events with exceptions and moved occurrences', () => {
    expect(byTitle('Standup').map((e) => e.start)).toEqual(['2026-10-26T13:00:00.000Z', '2026-11-04T14:00:00.000Z'])
    expect(byTitle('Standup (moved)').map((e) => [e.start, e.end])).toEqual([['2026-11-02T16:00:00.000Z', '2026-11-02T16:30:00.000Z']])
    expect(byTitle('Standup')[0]).toMatchObject({ recurring: true, location: 'Room 1', allDay: false })
  })

  it('treats DTEND of all-day events as exclusive', () => {
    expect(byTitle('Trip')[0]).toMatchObject({ allDay: true, startDay: '2026-10-30', endDay: '2026-11-01' })
  })

  it('handles durations, URLs, unknown zones, floating times and cancellations', () => {
    expect(byTitle('Call')[0]).toMatchObject({ start: '2026-10-29T15:00:00.000Z', end: '2026-10-29T16:00:00.000Z', url: 'https://example.com/call' })
    expect(byTitle('Call')[0]!.description).toBe('Dial in\nline two')
    expect(byTitle('Unregistered zone')[0]!.start).toBe('2026-10-31T13:00:00.000Z')
    expect(byTitle('Floating')[0]!.start).toBe('2026-10-31T23:00:00.000Z')
    expect(byTitle('Cancelled')).toHaveLength(0)
  })

  it('rejects text that is not iCalendar', () => {
    expect(() => parseCalendar('<html>nope</html>')).toThrow()
  })
})
