import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DONE_VALUE, builtinTypeId, createBuiltinTypes, foodEntryKey, habitDoneKey, newObject, setNutritionEnabled, type ObjectType } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { AccountService } from '../src/accounts.ts'
import { CaptureService } from '../src/capture.ts'
import { ChangeFeed, DesktopListeners, type DesktopNotification } from '../src/events.ts'
import { ReminderService } from '../src/reminders.ts'

const AT = '2026-10-20T09:00:00.000Z'
// 08:00 in São Paulo (UTC-3) on 20 October 2026.
const EIGHT = Date.parse('2026-10-20T11:00:00.000Z')

function setup() {
  const store = new NodeStore(':memory:')
  store.putSpace({ id: 's', name: 'Notes', sidebar: [], createdAt: AT })
  for (const type of createBuiltinTypes('s', AT)) store.putType(type)
  const meeting: ObjectType = { ...store.getType(builtinTypeId('s', 'page'))!, id: 'meeting', system: undefined, name: 'Meeting', pluralName: 'Meetings', properties: [{ id: 'when', kind: 'date', name: 'When', withTime: true }] }
  store.putType(meeting)
  store.putUser({ id: 'u', username: 'arie', name: 'Arie', timeZone: 'America/Sao_Paulo', createdAt: AT }, 'x')
  store.putMember({ spaceId: 's', userId: 'u', role: 'owner', createdAt: AT })
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-reminders-')))
  const capture = new CaptureService({ store, media, feed: new ChangeFeed(), timeZone: 'UTC' })
  const accounts = new AccountService({ store, capture })
  const habit = store.getType(builtinTypeId('s', 'habit'))!
  store.putObject(newObject(habit, { title: 'Meditate', props: { remind: { kind: 'text', value: '8h' } } }, 'meditate', AT))
  store.putObject(newObject(habit, { title: 'Read', props: { remind: { kind: 'text', value: '08:00' }, [habitDoneKey('2026-10-20')]: DONE_VALUE } }, 'read', AT))
  store.putObject(newObject(meeting, { title: 'Standup', props: { when: { kind: 'date', value: { start: '2026-10-20T13:00:00.000Z', resolution: 'time' } } } }, 'standup', AT))
  const posts: { url: string; auth?: string; body: Record<string, unknown> }[] = []
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    posts.push({ url, auth: (init?.headers as Record<string, string>).authorization, body: JSON.parse(String(init?.body)) })
    return new Response('{}')
  }) as typeof fetch
  const desktop = new DesktopListeners()
  const reminders = new ReminderService({ store, accounts, desktop, webUrl: 'https://notes.example', fetch: fakeFetch })
  return { store, reminders, posts, desktop }
}

describe('reminders', () => {
  it('sends a habit at its time unless done, and events minutes before, once each', async () => {
    const { reminders, posts } = setup()
    reminders.save('u', { ntfy: { server: 'https://ntfy.home/', topic: 'arie-vasta', token: 'tk_secret' }, eventsBefore: 10 })
    expect(reminders.view('u')).toMatchObject({ ntfy: { server: 'https://ntfy.home', topic: 'arie-vasta', hasToken: true }, habits: true, eventsBefore: 10 })

    await reminders.tick(EIGHT - 60_000)
    await reminders.tick(EIGHT + 15_000)
    expect(posts).toEqual([
      { url: 'https://ntfy.home', auth: 'Bearer tk_secret', body: { topic: 'arie-vasta', title: 'Meditate', message: 'Not done yet today', tags: ['alarm_clock'], click: 'https://notes.example/o/meditate' } },
    ])
    // The standup is at 10:00 local (13:00 UTC): 09:50.
    await reminders.tick(Date.parse('2026-10-20T12:49:50.000Z'))
    await reminders.tick(Date.parse('2026-10-20T12:50:20.000Z'))
    await reminders.tick(Date.parse('2026-10-20T12:50:50.000Z'))
    expect(posts.slice(1).map((p) => [p.body.title, p.body.message])).toEqual([['Standup', 'At 10:00, in 10 min']])
  })

  it('checks its settings and needs a channel for a test', async () => {
    const { reminders } = setup()
    expect(() => reminders.save('u', { ntfy: { server: 'ftp://x', topic: 't' } })).toThrow('http')
    expect(() => reminders.save('u', { ntfy: { topic: 'no spaces here' } })).toThrow('topic')
    expect(() => reminders.save('u', { eventsBefore: 7 })).toThrow('minutes')
    expect(() => reminders.save('u', { food: { dayLeft: '25:00' } })).toThrow('HH:MM')
    expect(() => reminders.save('u', { food: { week: { day: 7, at: '20:00' } } })).toThrow('weekday')
    reminders.save('u', { desktop: false })
    await expect(reminders.test('u')).rejects.toThrow('set up ntfy, Telegram or the desktop app')
    reminders.save('u', { ntfy: { topic: 'vasta' } })
    expect(await reminders.test('u')).toEqual([{ channel: 'ntfy', ok: true }])
  })

  it('tells desktop apps that listen, and says when none is open', async () => {
    const { reminders, desktop } = setup()
    expect(reminders.view('u')).toMatchObject({ desktop: true, desktopApps: 0 })
    expect(await reminders.test('u')).toEqual([{ channel: 'desktop', ok: false, error: expect.stringContaining('no desktop app') }])
    const shown: DesktopNotification[] = []
    const stop = desktop.listen('u', (n) => shown.push(n))
    expect(reminders.view('u').desktopApps).toBe(1)
    expect(await reminders.test('u')).toEqual([{ channel: 'desktop', ok: true }])
    await reminders.tick(EIGHT - 60_000)
    await reminders.tick(EIGHT + 15_000)
    expect(shown.map((n) => n.title)).toEqual(['Vasta reminders work', 'Meditate'])
    stop()
    expect(reminders.view('u').desktopApps).toBe(0)
  })

  it('says what is left of the day, sums up the week on Sunday, and points at meals not logged', async () => {
    const { store, reminders, desktop } = setup()
    setNutritionEnabled(store, 's', true, AT)
    const goalType = store.getType(builtinTypeId('s', 'nutrition-goal'))!
    store.putObject({ ...newObject(goalType, { title: 'Goal', props: { kcal: { kind: 'number', value: 2000 }, 'protein-pct': { kind: 'number', value: 30 }, 'carbs-pct': { kind: 'number', value: 40 }, 'fat-pct': { kind: 'number', value: 30 } } }, 'goal', AT), date: { start: '2026-10-01T00:00:00.000Z', resolution: 'day' } })
    const daily = store.getType(builtinTypeId('s', 'daily-note'))!
    const eaten = (day: string, kcal: number, protein: number) =>
      store.putObject({
        ...newObject(daily, { title: '', props: { [foodEntryKey(day)]: { kind: 'food-entry', value: { name: 'x', amount: '', grams: 0, meal: 'lunch', at: `${day}T15:00:00.000Z`, nutrients: { kcal, protein, carbs: 0, fat: 0 }, quick: true } } } }, `note-${day}`, AT),
        date: { start: `${day}T00:00:00.000Z`, resolution: 'day' },
      })
    eaten('2026-10-20', 1400, 110)
    reminders.save('u', { habits: false, eventsBefore: null, food: { mealsAfter: 60 } })
    const shown: DesktopNotification[] = []
    desktop.listen('u', (n) => shown.push(n))
    const local = (iso: string) => Date.parse(`${iso}-03:00`)
    const between = async (from: string, to: string) => {
      await reminders.tick(local(from))
      await reminders.tick(local(to))
    }

    // Breakfast at 08:00, an hour later: nothing logged.
    await between('2026-10-20T08:59:50', '2026-10-20T09:00:10')
    expect(shown.pop()).toMatchObject({ title: 'Breakfast not logged', message: '1 400 kcal today so far (goal 2 000)', url: 'https://notes.example/nutrition' })
    // Lunch had something.
    await between('2026-10-20T13:29:50', '2026-10-20T13:30:10')
    expect(shown).toEqual([])
    await between('2026-10-20T17:59:50', '2026-10-20T18:00:10')
    expect(shown.pop()).toMatchObject({ title: '600 kcal left today', message: '40 g protein to go' })

    eaten('2026-10-25', 2000, 150)
    await between('2026-10-25T19:59:50', '2026-10-25T20:00:10')
    expect(shown.map((n) => n.title)).toContain('Your week of food')
    expect(shown.find((n) => n.title === 'Your week of food')!.message).toBe('1 700 kcal a day (goal 2 000) · protein 130 g a day (goal 150 g) · on target 1 of 2 days · 1 day on target in a row')
  })
})
