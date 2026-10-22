import { describe, expect, it } from 'vitest'
import { NodeStore } from '../src/store-node.ts'
import { builtinTypeId, createBuiltinTypes, ensureBuiltinTypes } from '../src/index.ts'
import { DONE_VALUE, habitDoneKey, habitProgress, habitRemindAt, habitStats, habitValue, isHabitDone, isHabitScheduled, type PropertyValue } from '../src/index.ts'

const habit = (days: string[], props: Record<string, PropertyValue> = {}) => ({
  createdAt: '2026-10-01T12:00:00.000Z',
  props: { ...props, ...Object.fromEntries(days.map((d) => [habitDoneKey(d), DONE_VALUE])) },
})

describe('habit stats', () => {
  it('counts the current and best streaks; today not done yet does not break one', () => {
    const h = habit(['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-08', '2026-10-09'])
    expect(habitStats(h, '2026-10-10')).toMatchObject({ current: 2, best: 3, total: 5 })
    expect(habitStats(h, '2026-10-11').current).toBe(0)
  })

  it('skips the days it does not repeat on', () => {
    // Mondays, Wednesdays and Fridays: Mon 5, Wed 7, Fri 9 in a row.
    const days: PropertyValue = { kind: 'select', value: ['mon', 'wed', 'fri'] }
    const h = habit(['2026-10-05', '2026-10-07', '2026-10-09'], { days })
    expect(isHabitScheduled(h, '2026-10-06')).toBe(false)
    expect(habitStats(h, '2026-10-11')).toMatchObject({ current: 3, best: 3, weekDone: 3, weekScheduled: 3 })
  })

  it('rates the last 30 days from when the habit began', () => {
    const h = habit(['2026-10-01', '2026-10-02', '2026-10-04'])
    // 1–4 October scheduled, today (the 5th) not done yet: 3 of 4.
    expect(habitStats(h, '2026-10-05').rate30).toBe(0.75)
  })
})

describe('habits with a daily goal', () => {
  const target: PropertyValue = { kind: 'number', value: 8 }
  const amount = (value: number): PropertyValue => ({ kind: 'number', value })
  const h = {
    createdAt: '2026-10-01T12:00:00.000Z',
    props: { target, [habitDoneKey('2026-10-01')]: amount(8), [habitDoneKey('2026-10-02')]: amount(5), [habitDoneKey('2026-10-03')]: amount(9), [habitDoneKey('2026-10-04')]: DONE_VALUE },
  }

  it('is done on a day once the amount reaches the goal', () => {
    expect(isHabitDone(h, '2026-10-01')).toBe(true)
    expect(isHabitDone(h, '2026-10-02')).toBe(false)
    expect(habitProgress(h, '2026-10-02')).toBe(5 / 8)
    // A plain check from before the goal was set counts as reaching it.
    expect(habitValue(h, '2026-10-04')).toBe(8)
    expect(habitStats(h, '2026-10-04')).toMatchObject({ current: 2, best: 2, total: 3 })
    expect(habitStats(h, '2026-10-04').average30).toBe(30 / 4)
  })

  it('reads reminder times loosely', () => {
    const at = (value: string) => habitRemindAt({ createdAt: '', props: { remind: { kind: 'text', value } } })
    expect([at('8'), at('8h'), at('08:30'), at('7h05'), at('25:00'), at('soon')]).toEqual(['08:00', '08:00', '08:30', '07:05', undefined, undefined])
  })
})

describe('habit type migration', () => {
  it('gives an older Habit type the goal, unit and reminder once', () => {
    const at = '2026-10-20T12:00:00.000Z'
    const store = new NodeStore(':memory:')
    store.putSpace({ id: 's', name: 'Space', sidebar: [], createdAt: at })
    for (const type of createBuiltinTypes('s', at)) {
      // The Habit type as it shipped first.
      if (type.system === 'habit') type.properties = type.properties.filter((p) => ['days', 'paused', 'body'].includes(p.id))
      store.putType(type)
    }
    ensureBuiltinTypes(store, at)
    const names = () => store.getType(builtinTypeId('s', 'habit'))!.properties.map((p) => p.name)
    expect(names()).toEqual(['Repeat on', 'Paused', 'Daily goal', 'Unit', 'Remind at', 'Notes'])
    // Deleted by the user: it stays deleted.
    const type = store.getType(builtinTypeId('s', 'habit'))!
    store.putType({ ...type, properties: type.properties.filter((p) => p.id !== 'unit') })
    ensureBuiltinTypes(store, at)
    expect(names()).not.toContain('Unit')
  })
})
