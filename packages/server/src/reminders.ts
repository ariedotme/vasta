// Reminders: a habit at its "Remind at" time while it is not done that day, timed events and tasks
// a few minutes before they start, and, in spaces that track food, what is left of the day late in
// it, the week's summary and meals with nothing logged. Sent to each user through ntfy (their
// server and topic, a token if the topic is protected), the Telegram bot and/or the desktop apps
// they have open (system notifications). Settings are per user, in the database's meta
// (`reminders.<userId>`), changed in Settings › Reminders. The service looks every 30 seconds at
// what fell due since it last looked; reminders missed while the server was down are not sent late.
import {
  DEFAULT_MEALS,
  addDays,
  builtinTypeId,
  dayIn,
  foodDayNudge,
  foodMealNudge,
  foodWeekNudge,
  goalForDay,
  habitAmountText,
  habitsWithFood,
  habitRemindAt,
  habitStats,
  isHabitDone,
  isHabitPaused,
  isHabitScheduled,
  instantOf,
  isNutritionOn,
  nutritionDays,
  readGoals,
  weekStart,
  type CalendarEntry,
  type FoodNudge,
  type Id,
  type ObjectSummary,
  type ObjectType,
  type Space,
  type User,
} from '@vasta/core'
import { objectEntries } from '@vasta/core/calendar'
import type { NodeStore } from '@vasta/core/node'
import type { AccountService } from './accounts.ts'
import type { CalendarService } from './calendars.ts'
import type { DesktopListeners } from './events.ts'
import { safeFetch } from './safe-fetch.ts'

/** Food reminders, in spaces that track food. Times are "HH:MM" in the user's zone. */
export interface FoodReminders {
  /** What is left of the day (kcal, protein, how the week goes); null: off. */
  dayLeft: string | null
  /** The week's summary on a weekday (0 Sunday … 6 Saturday), about the Monday-to-Sunday week ending then; null: off. */
  week: { day: number; at: string } | null
  /** Minutes after a meal's usual time with nothing logged in it; null: off. */
  mealsAfter: number | null
}

/** Which notifications about others' work go through the channels (the app's bell lists them all). */
export interface WorkNotifications {
  assigned: boolean
  mentioned: boolean
  comments: boolean
}

export interface ReminderSettings {
  ntfy?: { server: string; topic: string; token?: string }
  /** Also to the user's Telegram chat with the bot. */
  telegram?: boolean
  /** Also as system notifications in the desktop apps open (0.1.10 and later). */
  desktop?: boolean
  /** Habits at their "Remind at" time. */
  habits: boolean
  /** Minutes before timed events and tasks; null: no event reminders. */
  eventsBefore: number | null
  food: FoodReminders
  work: WorkNotifications
}

/** What the app sees: the token stays on the server. */
export interface ReminderView {
  ntfy?: { server: string; topic: string; hasToken: boolean }
  telegram: boolean
  desktop: boolean
  habits: boolean
  eventsBefore: number | null
  food: FoodReminders
  work: WorkNotifications
  /** The bot runs and this user linked their Telegram account. */
  telegramReady: boolean
  /** Desktop apps of this user listening right now. */
  desktopApps: number
}

export const EVENT_LEADS = [0, 5, 10, 15, 30, 60]
export const MEAL_LEADS = [30, 60, 90, 120]
const DEFAULT_FOOD: FoodReminders = { dayLeft: '18:00', week: { day: 0, at: '20:00' }, mealsAfter: null }
const DEFAULT_WORK: WorkNotifications = { assigned: true, mentioned: true, comments: true }
const DEFAULTS: ReminderSettings = { habits: true, eventsBefore: 10, desktop: true, food: DEFAULT_FOOD, work: DEFAULT_WORK }
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

export class ReminderError extends Error {}

export interface Reminder {
  key: string
  title: string
  message: string
  /** An emoji shortcode ntfy shows by the title. */
  tag: string
  /** The emoji Telegram's message starts with (⏰ when unset). */
  icon?: string
  url?: string
}

export interface ReminderOptions {
  store: NodeStore
  accounts: AccountService
  calendars?: CalendarService
  webUrl?: string
  /** The Telegram bot's sender, when it runs. */
  telegram?: (chatId: number, text: string) => Promise<void>
  /** Desktop apps listening on /api/events?desktop=1. */
  desktop?: DesktopListeners
  /** Defaults to safeFetch: an ntfy server on the local network needs VASTA_ALLOW_PRIVATE_FETCH. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  now?: () => number
}

const keyOf = (userId: Id) => `reminders.${userId}`

export class ReminderService {
  private readonly options: ReminderOptions
  private last = 0
  private timer: ReturnType<typeof setInterval> | undefined
  /** Reminders sent lately, so one never goes twice (kept two days). */
  private sent = new Map<string, number>()

  constructor(options: ReminderOptions) {
    this.options = options
  }

  private get store() {
    return this.options.store
  }

  private now() {
    return this.options.now?.() ?? Date.now()
  }

  settings(userId: Id): ReminderSettings {
    try {
      const saved = JSON.parse(this.store.getMeta(keyOf(userId)) ?? '{}') as Partial<ReminderSettings>
      return { ...DEFAULTS, ...saved, food: { ...DEFAULT_FOOD, ...saved.food }, work: { ...DEFAULT_WORK, ...saved.work } }
    } catch {
      return { ...DEFAULTS }
    }
  }

  view(userId: Id): ReminderView {
    const settings = this.settings(userId)
    return {
      ...(settings.ntfy ? { ntfy: { server: settings.ntfy.server, topic: settings.ntfy.topic, hasToken: !!settings.ntfy.token } } : {}),
      telegram: !!settings.telegram,
      desktop: !!settings.desktop,
      habits: settings.habits,
      eventsBefore: settings.eventsBefore,
      food: settings.food,
      work: settings.work,
      telegramReady: !!this.options.telegram && this.store.getUser(userId)?.telegramUserId !== undefined,
      desktopApps: this.options.desktop?.count(userId) ?? 0,
    }
  }

  /** Change the settings; ntfy.token: a string sets it, '' clears it, absent keeps it. ntfy null turns ntfy off. */
  save(
    userId: Id,
    input: {
      ntfy?: { server?: string; topic?: string; token?: string } | null
      telegram?: boolean
      desktop?: boolean
      habits?: boolean
      eventsBefore?: number | null
      food?: Partial<FoodReminders>
      work?: Partial<WorkNotifications>
    }
  ): ReminderView {
    const next = this.settings(userId)
    if (input.ntfy === null) delete next.ntfy
    else if (input.ntfy) {
      const server = (input.ntfy.server ?? next.ntfy?.server ?? 'https://ntfy.sh').trim().replace(/\/+$/, '')
      const topic = (input.ntfy.topic ?? next.ntfy?.topic ?? '').trim()
      if (!/^https?:\/\/[^\s/]+/i.test(server)) throw new ReminderError('the ntfy server must be an http:// or https:// address')
      if (!/^[\w-]{1,64}$/.test(topic)) throw new ReminderError('the ntfy topic takes letters, digits, - and _ (up to 64)')
      const token = input.ntfy.token === undefined ? next.ntfy?.token : input.ntfy.token.trim() || undefined
      next.ntfy = { server, topic, ...(token ? { token } : {}) }
    }
    if (input.telegram !== undefined) next.telegram = input.telegram
    if (input.desktop !== undefined) next.desktop = !!input.desktop
    if (input.habits !== undefined) next.habits = input.habits
    if (input.eventsBefore !== undefined) {
      if (input.eventsBefore !== null && !EVENT_LEADS.includes(input.eventsBefore)) throw new ReminderError(`minutes before events: ${EVENT_LEADS.join(', ')} or none`)
      next.eventsBefore = input.eventsBefore
    }
    if (input.food) {
      const { dayLeft, week, mealsAfter } = input.food
      if (dayLeft !== undefined) {
        if (dayLeft !== null && !CLOCK.test(dayLeft)) throw new ReminderError('the time for what is left of the day is HH:MM')
        next.food.dayLeft = dayLeft
      }
      if (week !== undefined) {
        if (week !== null && (!Number.isInteger(week.day) || week.day < 0 || week.day > 6 || !CLOCK.test(week.at))) throw new ReminderError("the week's summary takes a weekday (0 Sunday … 6 Saturday) and HH:MM")
        next.food.week = week && { day: week.day, at: week.at }
      }
      if (mealsAfter !== undefined) {
        if (mealsAfter !== null && !MEAL_LEADS.includes(mealsAfter)) throw new ReminderError(`minutes after a meal: ${MEAL_LEADS.join(', ')} or none`)
        next.food.mealsAfter = mealsAfter
      }
    }
    if (input.work) for (const key of ['assigned', 'mentioned', 'comments'] as const) if (typeof input.work[key] === 'boolean') next.work[key] = input.work[key]
    this.store.setMeta(keyOf(userId), JSON.stringify(next))
    return this.view(userId)
  }

  /** Send a test through every channel the user set; what each answered. */
  async test(userId: Id): Promise<{ channel: string; ok: boolean; error?: string }[]> {
    const user = this.store.getUser(userId)
    if (!user) throw new ReminderError('unknown user')
    const results = await this.deliver(user, this.settings(userId), { key: `test:${this.now()}`, title: 'Vasta reminders work', message: 'Habits, events and food will remind you here.', tag: 'white_check_mark' })
    if (!results.length) throw new ReminderError('set up ntfy, Telegram or the desktop app first')
    return results
  }

  /** A notification about others' work (notifications.ts), through the user's channels if they want that kind. */
  async notify(userId: Id, kind: 'assigned' | 'mentioned' | 'comment', reminder: Reminder & { objectId?: Id }) {
    const user = this.store.getUser(userId)
    if (!user) return
    const settings = this.settings(userId)
    if (!settings.work[kind === 'comment' ? 'comments' : kind]) return
    const { objectId, ...rest } = reminder
    await this.deliver(user, settings, { ...rest, ...(objectId ? this.link(objectId) : {}) })
  }

  start() {
    this.last = this.now()
    this.timer = setInterval(() => void this.tick().catch((error) => console.error('Reminders:', error)), 30_000)
  }

  stop() {
    clearInterval(this.timer)
  }

  /** Send what fell due since the last look. */
  async tick(now = this.now()) {
    const from = this.last || now
    this.last = now
    for (const [key, at] of this.sent) if (at < now - 2 * 86_400_000) this.sent.delete(key)
    for (const user of this.store.listUsers()) {
      const settings = this.settings(user.id)
      if (!settings.ntfy && !settings.telegram && !settings.desktop) continue
      for (const reminder of this.due(user, settings, from, now)) {
        const key = `${user.id}:${reminder.key}`
        if (this.sent.has(key)) continue
        this.sent.set(key, now)
        await this.deliver(user, settings, reminder)
      }
    }
  }

  /** The reminders of a user whose time falls in (from, to]. */
  due(user: User, settings: ReminderSettings, from: number, to: number): Reminder[] {
    const timeZone = this.options.accounts.captureFor(user).timeZone
    const reminders: Reminder[] = []
    const days = [...new Set([dayIn(from, timeZone), dayIn(to, timeZone)])]
    const inWindow = (at: number) => at > from && at <= to
    for (const space of this.options.accounts.spacesOf(user)) {
      if (settings.habits) {
        const type = this.store.getType(builtinTypeId(space.id, 'habit'))
        // Habits done from food have their days worked out from what was logged.
        const habits = type ? habitsWithFood(this.store, space.id, this.store.listObjects(type.id), days.at(-1)!) : []
        for (const habit of habits) {
          const time = habitRemindAt(habit)
          if (!time || isHabitPaused(habit)) continue
          const [hour, minute] = time.split(':').map(Number) as [number, number]
          for (const day of days) {
            const [year, month, date] = day.split('-').map(Number) as [number, number, number]
            const at = instantOf({ year, month, day: date, hour, minute, second: 0 }, timeZone)
            if (!inWindow(at) || !isHabitScheduled(habit, day) || isHabitDone(habit, day)) continue
            const streak = habitStats(habit, day).current
            const amount = habitAmountText(habit, day)
            reminders.push({
              key: `habit:${habit.id}:${day}`,
              title: habit.title || 'A habit',
              message: [amount ? `${amount} so far today` : 'Not done yet today', streak ? `${streak} in a row` : ''].filter(Boolean).join(' · '),
              tag: 'alarm_clock',
              ...this.link(habit.id),
            })
          }
        }
      }
      if (settings.eventsBefore !== null) {
        const lead = settings.eventsBefore * 60_000
        const range = { from: days[0]!, to: addDays(days.at(-1)!, 1) }
        const types = new Map(this.store.listTypes(space.id).map((t) => [t.id, t]))
        const objects = this.store.listSpaceObjects(space.id)
        const byId = new Map(objects.map((o) => [o.id, o]))
        const entries = [...objectEntries(objects, types, range, timeZone), ...(this.options.calendars?.entries(space.id, range, timeZone) ?? [])]
        for (const entry of entries) {
          if (entry.allDay || entry.kind === 'daily-note' || !inWindow(Date.parse(entry.start) - lead)) continue
          const object = entry.objectId ? byId.get(entry.objectId) : undefined
          if (object && isFinishedTask(object, types.get(object.typeId))) continue
          reminders.push(this.eventReminder(entry, object, settings.eventsBefore, timeZone))
        }
      }
      if (isNutritionOn(space)) reminders.push(...this.foodReminders(space, settings.food, days, inWindow, timeZone))
    }
    return reminders
  }

  /** What is left of the day, the week's summary and meals with nothing logged, whose time falls in the window. */
  private foodReminders(space: Space, food: FoodReminders, days: string[], inWindow: (at: number) => boolean, timeZone: string): Reminder[] {
    const at = (day: string, time: string) => {
      const [year, month, date] = day.split('-').map(Number) as [number, number, number]
      const [hour, minute] = time.split(':').map(Number) as [number, number]
      return instantOf({ year, month, day: date, hour, minute, second: 0 }, timeZone)
    }
    const dailyType = builtinTypeId(space.id, 'daily-note')
    let goals: ReturnType<typeof readGoals> | undefined
    const goalsNow = () => (goals ??= readGoals(this.store.listObjects(builtinTypeId(space.id, 'nutrition-goal'))))
    const history = (from: string, to: string) => {
      const notes = this.store.listObjects(dailyType).filter((n) => (n.date?.start.slice(0, 10) ?? '') >= from)
      return nutritionDays(notes, goalsNow(), from, to)
    }
    const reminder = (key: string, nudge: FoodNudge | undefined): Reminder[] =>
      nudge ? [{ key: `food:${space.id}:${key}`, title: nudge.title, message: nudge.message, tag: 'fork_and_knife', ...this.page('nutrition') }] : []
    const reminders: Reminder[] = []
    for (const day of days) {
      if (food.dayLeft && inWindow(at(day, food.dayLeft))) reminders.push(...reminder(`day:${day}`, foodDayNudge(history(weekStart(day), day), goalsNow(), day)))
      const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay()
      if (food.week && weekday === food.week.day && inWindow(at(day, food.week.at))) {
        // The Monday-to-Sunday week ending on or before the day.
        const end = addDays(day, -((weekday + 7) % 7))
        reminders.push(...reminder(`week:${end}`, foodWeekNudge(history(addDays(end, -90), end), goalsNow(), end)))
      }
      if (food.mealsAfter !== null) {
        const meals = space.nutrition?.meals ?? DEFAULT_MEALS
        for (const meal of meals) {
          if (!meal.time || !inWindow(at(day, meal.time) + food.mealsAfter * 60_000)) continue
          const note = this.store.findObjectOnDay(dailyType, day)
          reminders.push(...reminder(`meal:${meal.id}:${day}`, foodMealNudge(note, meal, meals, timeZone, goalForDay(goalsNow(), day))))
        }
      }
    }
    return reminders
  }

  private link(id: Id) {
    return this.page(`o/${id}`)
  }

  private page(path: string) {
    return this.options.webUrl ? { url: `${this.options.webUrl.replace(/\/$/, '')}/${path}` } : {}
  }

  private eventReminder(entry: CalendarEntry, object: ObjectSummary | undefined, minutes: number, timeZone: string): Reminder {
    const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(entry.start))
    const title = entry.kind === 'external' ? (entry.title ?? 'An event') : object?.title || 'Something'
    return {
      key: `event:${entry.key}`,
      title,
      message: [minutes ? `At ${clock}, in ${minutes} min` : `Now, ${clock}`, entry.location].filter(Boolean).join(' · '),
      tag: 'calendar',
      ...(object ? this.link(object.id) : entry.url ? { url: entry.url } : {}),
    }
  }

  private async deliver(user: User, settings: ReminderSettings, reminder: Reminder) {
    const results: { channel: string; ok: boolean; error?: string }[] = []
    if (settings.ntfy) {
      try {
        const { server, topic, token } = settings.ntfy
        // JSON publishing (to the server's root) carries any text in the title, unlike headers.
        const response = await (this.options.fetch ?? safeFetch)(server, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ topic, title: reminder.title, message: reminder.message, tags: [reminder.tag], ...(reminder.url ? { click: reminder.url } : {}) }),
          signal: AbortSignal.timeout(10_000),
        })
        if (!response.ok) throw new Error(`${server} answered ${response.status}${response.status === 403 || response.status === 401 ? ': check the token, and that it is one of this server' : ''}`)
        results.push({ channel: 'ntfy', ok: true })
      } catch (error) {
        results.push({ channel: 'ntfy', ok: false, error: (error as Error).message })
      }
    }
    const chat = this.store.getUser(user.id)?.telegramUserId
    if (settings.telegram && this.options.telegram && chat !== undefined) {
      try {
        await this.options.telegram(chat, `${reminder.icon ?? '⏰'} ${reminder.title}\n${reminder.message}${reminder.url ? `\n${reminder.url}` : ''}`)
        results.push({ channel: 'telegram', ok: true })
      } catch (error) {
        results.push({ channel: 'telegram', ok: false, error: (error as Error).message })
      }
    }
    if (settings.desktop && this.options.desktop) {
      const apps = this.options.desktop.send(user.id, { key: reminder.key, title: reminder.title, message: reminder.message, ...(reminder.url ? { url: reminder.url } : {}) })
      // Not an error when no app is open: the other channels still got it.
      results.push(apps ? { channel: 'desktop', ok: true } : { channel: 'desktop', ok: false, error: 'no desktop app open (Vasta for desktop 0.1.10 or later)' })
    }
    for (const failed of results.filter((r) => !r.ok && r.channel !== 'desktop')) console.warn(`Reminder to ${user.username} through ${failed.channel} failed: ${failed.error}`)
    return results
  }
}

/** A task whose status is a "done" option. */
function isFinishedTask(object: ObjectSummary, type: ObjectType | undefined): boolean {
  if (type?.system !== 'task') return false
  const status = type.properties.find((p) => p.id === 'status')
  const value = object.props.status
  return status?.kind === 'select' && value?.kind === 'select' && status.options.some((o) => value.value.includes(o.id) && o.status === 'done')
}
