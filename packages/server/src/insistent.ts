// Insistent reminders (docs/reminders.md): a reminder that keeps asking until it gets a real
// answer. Each one is a *rule* of a user: what it is about (any object, or nothing), when it starts
// (the object's own time, a time of day, or the first time the user is at the computer after an
// hour), what it shows (the object, random objects with a tag or from a query, today's tasks), how
// it is answered (OK, doing it, typing the text, saying it out loud) and its *ladder*: the channels
// each step goes through, minutes apart, repeated every few minutes until answered.
//
// Each occurrence of a rule is a *nag*, kept in `reminder_nags`: open until it is answered, the
// habit or task is done (wherever that happens), or its day ends (then it was ignored). Snoozing
// shifts the ladder's clock, so it does not climb while snoozed, but every few snoozes climb a step;
// "Not today" asks for a reason. Swiping a notification away answers nothing. What happened to
// each nag (answered how, after how long, how far up the ladder, how often snoozed, why skipped)
// is what the honest stats are made of.
//
// Nags are answered in the web app (/remind/<id>, also the page of the desktop app's takeover), from
// buttons on ntfy and Web Push notifications (signed links, `actionUrl`) and in Telegram (buttons,
// a reply with the text, a reply with the reason).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  addDays,
  builtinTypeId,
  dayIn,
  habitDayValue,
  habitDoneKey,
  habitAmountText,
  habitFoodRule,
  habitStats,
  habitRemindAt,
  habitTarget,
  habitsWithFood,
  instantOf,
  isHabitDone,
  isHabitPaused,
  isHabitScheduled,
  querySpace,
  SAID_MATCH,
  TYPED_MATCH,
  normalizeText,
  textMatch,
  type Id,
  type ObjectRecord,
  type ObjectSummary,
  type ObjectType,
  type User,
} from '@vasta/core'
import { completeRepeat, objectEntries } from '@vasta/core/calendar'
import type { NodeStore } from '@vasta/core/node'
import { runAs } from './actor.ts'
import type { AccountService } from './accounts.ts'
import type { ChangeFeed } from './events.ts'

// Rules ------------------------------------------------------------------------

/** Where a step of the ladder reaches the user. `takeover`: the desktop app's full-screen window. */
export const NAG_CHANNELS = ['push', 'desktop', 'ntfy', 'telegram', 'takeover'] as const
export type NagChannel = (typeof NAG_CHANNELS)[number]

export interface LadderStep {
  /** Minutes after the reminder starts (not counting snoozes). The first step is at 0. */
  after: number
  channels: NagChannel[]
  /** ntfy at its highest priority (5), Web Push that stays until answered, Telegram with sound. */
  urgent?: boolean
}

export type RuleWhen =
  /** The object's own time: a habit's "Remind at" on its days, a task's or event's start (`before` minutes earlier). */
  | { kind: 'object'; before?: number }
  /** A time of day, on some weekdays (0 Sunday … 6 Saturday; none: every day). */
  | { kind: 'daily'; at: string; days?: number[] }
  /**
   * The first time the user is at the computer (the desktop app sees them come back, or the
   * computer wake) from `after` on; `latest`: start then anyway, wherever they are.
   */
  | { kind: 'wake'; after: string; latest?: string; days?: number[] }

export type RuleContent =
  /** The object the reminder is about. */
  | { kind: 'target' }
  /** `count` random objects with the tag (or one of its sub-tags). */
  | { kind: 'tag'; tagId: Id; count?: number }
  /** `count` random objects a saved query (an object of the Query type) finds. */
  | { kind: 'query'; queryId: Id; count?: number }
  /** The tasks due today or overdue, not done. */
  | { kind: 'tasks' }

/** How a reminder is answered. `done`: the habit or task done. `type` and `say`: its content's text, typed or said out loud. */
export type AckMode = 'ok' | 'done' | 'type' | 'say'

export interface InsistentRule {
  id: string
  /** What it is about; a free-standing reminder has none and a title of its own. */
  objectId?: Id
  /** The space its content comes from (the object's, or the tag's or query's). */
  spaceId: Id
  /** Its own title; the object's when absent. */
  title?: string
  when: RuleWhen
  content: RuleContent
  ack: AckMode
  /** Minutes between repeats; null: only at the ladder's steps. */
  repeat: number | null
  steps: LadderStep[]
  /** Minutes a snooze lasts. */
  snooze: number
  /** Snoozes that climb one step of the ladder; null: snoozing never does. */
  climbAfter: number | null
  /** Seconds before the desktop takeover offers its way out. */
  escapeAfter: number
  paused?: boolean
  createdAt: string
}

export type RuleInput = Partial<Omit<InsistentRule, 'id' | 'createdAt'>>

export class InsistentError extends Error {}

const CLOCK = /^([01]?\d|2[0-3]):[0-5]\d$/
export const REPEATS = [2, 5, 10, 15, 20, 30, 45, 60, 90, 120]
export const SNOOZES = [5, 10, 15, 30, 60]

/** A reminder that repeats every 15 minutes, climbing to ntfy's highest priority, Telegram and the takeover. */
export const DEFAULT_STEPS: LadderStep[] = [
  { after: 0, channels: ['push', 'desktop', 'ntfy'] },
  { after: 15, channels: ['push', 'desktop', 'ntfy'], urgent: true },
  { after: 30, channels: ['push', 'ntfy', 'telegram'], urgent: true },
  { after: 45, channels: ['push', 'ntfy', 'telegram', 'takeover'], urgent: true },
]

const pad = (clock: string) => clock.replace(/^(\d):/, '0$1:')

// Nags -------------------------------------------------------------------------

/** How a nag ended. `escaped`: the takeover's way out. */
export type NagOutcome = 'ok' | 'done' | 'typed' | 'said' | 'skipped' | 'escaped' | 'ignored'
/** What the user can answer with. */
export type NagAnswer = 'ok' | 'done' | 'typed' | 'said' | 'snooze' | 'skip' | 'escape'

export interface Nag {
  id: string
  userId: Id
  ruleId: string
  /** Which occurrence of the rule: a day, or a calendar entry's key. */
  occurrence: string
  /** The day it is about (for a habit, the day to mark done). */
  day: string
  startedAt: number
  /** It stops (ignored) then. */
  expiresAt: number
  /** When it is sent next; null: no more until answered. */
  nextAt: number | null
  /** Time spent snoozed, which the ladder's clock leaves out. */
  shift: number
  /** Steps climbed by snoozing. */
  bump: number
  /** The highest step it reached. */
  step: number
  snoozes: number
  /** How many times it was sent. */
  sent: number
  /** The objects it shows, picked when it started. */
  contentIds: Id[]
  /** Telegram messages sent for it, whose buttons go once it is answered. */
  telegram?: { chat: number; message: number }[]
  /** The takeover was sent. */
  tookOver?: boolean
  /** Telegram's "why not today?" message, which a reply answers. */
  asking?: number
  outcome?: NagOutcome
  reason?: string
  answeredAt?: number
}

type Row = Record<string, unknown>

export interface RuleStats {
  /** Occurrences in the period (open ones included). */
  total: number
  open: number
  done: number
  ok: number
  typed: number
  said: number
  skipped: number
  escaped: number
  ignored: number
  /** Snoozes in all. */
  snoozes: number
  /** Answered in the end (done, ok, typed, said). */
  answered: number
  /** Median minutes from start to the answer, for the answered ones. */
  medianMinutes: number | null
  /** How many needed the takeover. */
  tookOver: number
  /** How many climbed past the first step. */
  escalated: number
  /** The latest "Not today" reasons. */
  reasons: { day: string; reason: string }[]
  /** The last 14 days, oldest first: what each one came to. */
  days: { day: string; outcome: NagOutcome | 'open' | null }[]
}


// The service --------------------------------------------------------------------

/** One reminder to send, as the channels take it (ReminderService.deliver). */
export interface NagDelivery {
  key: string
  title: string
  message: string
  url?: string
  urgent: boolean
  channels: NagChannel[]
  /** Buttons: signed links (ntfy, Web Push) and Telegram's callback data. */
  actions: { action: NagAnswer | 'open'; label: string; url: string; callback?: string }[]
  nag: Nag
  rule: InsistentRule
  /** The text the user types or says, for Telegram's "reply with it". */
  expected?: string[]
}

export interface InsistentOptions {
  store: NodeStore
  accounts: AccountService
  feed?: ChangeFeed
  webUrl?: string
  /** Send through the user's channels (ReminderService). */
  deliver: (user: User, delivery: NagDelivery) => Promise<void>
  /** The nag was answered or ended: the takeover closes, Telegram's buttons go. */
  resolved?: (nag: Nag) => void
  /** Quiet hours of the user, from their reminder settings. */
  quiet?: (userId: Id) => { from: string; to: string } | null
  now?: () => number
  random?: () => number
}

const SECRET_KEY = 'reminders.secret'
/** A user seen at the computer this recently is there. */
const PRESENT_MS = 3 * 60_000

export class InsistentReminders {
  private readonly options: InsistentOptions
  /** When each user was last seen at a computer (the desktop app's presence). */
  private present = new Map<Id, number>()
  private secret: Buffer | undefined

  constructor(options: InsistentOptions) {
    this.options = options
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS reminder_rules (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        rule       TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reminder_rules_user ON reminder_rules(user_id);
      CREATE TABLE IF NOT EXISTS reminder_nags (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        rule_id    TEXT NOT NULL,
        occurrence TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        closed_at  INTEGER,
        outcome    TEXT,
        state      TEXT NOT NULL,
        UNIQUE (rule_id, occurrence)
      );
      CREATE INDEX IF NOT EXISTS reminder_nags_open ON reminder_nags(user_id) WHERE closed_at IS NULL;
      CREATE INDEX IF NOT EXISTS reminder_nags_rule ON reminder_nags(rule_id, started_at);
    `)
  }

  private get store() {
    return this.options.store
  }

  private now() {
    return this.options.now?.() ?? Date.now()
  }

  private random() {
    return this.options.random?.() ?? Math.random()
  }

  private timeZone(user: User) {
    return this.options.accounts.captureFor(user).timeZone
  }

  // Rules ------------------------------------------------------------------------

  rules(userId: Id): InsistentRule[] {
    const rows = this.store.db.prepare('SELECT rule FROM reminder_rules WHERE user_id = ? ORDER BY created_at').all(userId) as Row[]
    return rows.map((row) => JSON.parse(row.rule as string) as InsistentRule)
  }

  rule(userId: Id, id: string): InsistentRule | undefined {
    const row = this.store.db.prepare('SELECT rule FROM reminder_rules WHERE id = ? AND user_id = ?').get(id, userId) as Row | undefined
    return row ? (JSON.parse(row.rule as string) as InsistentRule) : undefined
  }

  /** The rules about an object. */
  rulesFor(userId: Id, objectId: Id): InsistentRule[] {
    return this.rules(userId).filter((r) => r.objectId === objectId)
  }

  /** A new rule, filled in from what fits its object. */
  create(user: User, input: RuleInput): InsistentRule {
    const object = input.objectId ? this.readable(user, input.objectId) : undefined
    const type = object && this.store.getType(object.typeId)
    const habit = type?.system === 'habit'
    const timed = !!object && !habit && this.timeOf(object, type) !== undefined
    const rule = this.check(user, {
      id: randomBytes(8).toString('hex'),
      spaceId: object?.spaceId ?? input.spaceId ?? '',
      when: habit && object && habitRemindAt(object) ? { kind: 'object' } : timed ? { kind: 'object', before: 0 } : { kind: 'daily', at: '09:00' },
      content: { kind: 'target' },
      ack: habit || type?.system === 'task' ? 'done' : 'ok',
      repeat: 15,
      steps: DEFAULT_STEPS,
      snooze: 15,
      climbAfter: 2,
      escapeAfter: 10,
      createdAt: new Date(this.now()).toISOString(),
      ...input,
      ...(object ? { objectId: object.id } : {}),
    } as InsistentRule)
    this.store.db.prepare('INSERT INTO reminder_rules (id, user_id, rule, created_at) VALUES (?, ?, ?, ?)').run(rule.id, user.id, JSON.stringify(rule), rule.createdAt)
    return rule
  }

  update(user: User, id: string, input: RuleInput): InsistentRule {
    const current = this.rule(user.id, id)
    if (!current) throw new InsistentError('no such reminder')
    const { objectId: _objectId, ...changes } = input
    const rule = this.check(user, { ...current, ...changes, id: current.id, createdAt: current.createdAt })
    this.store.db.prepare('UPDATE reminder_rules SET rule = ? WHERE id = ?').run(JSON.stringify(rule), id)
    // A paused reminder stops asking now.
    if (rule.paused) for (const nag of this.openNags(user.id).filter((n) => n.ruleId === id)) this.close(nag, 'ignored')
    return rule
  }

  remove(userId: Id, id: string) {
    for (const nag of this.openNags(userId).filter((n) => n.ruleId === id)) this.close(nag, 'ignored')
    this.store.db.prepare('DELETE FROM reminder_rules WHERE id = ? AND user_id = ?').run(id, userId)
    this.store.db.prepare('DELETE FROM reminder_nags WHERE rule_id = ? AND user_id = ?').run(id, userId)
  }

  /** An object the user may read (a member of its space), not in the trash. */
  private readable(user: User, id: Id): ObjectRecord {
    const object = this.store.getObject(id)
    if (!object || object.deletedAt || !this.options.accounts.spacesOf(user).some((s) => s.id === object.spaceId)) throw new InsistentError('no such object')
    return object
  }

  private check(user: User, rule: InsistentRule): InsistentRule {
    const spaces = new Set(this.options.accounts.spacesOf(user).map((s) => s.id))
    const object = rule.objectId ? this.store.getObject(rule.objectId) : undefined
    if (rule.objectId && !object) throw new InsistentError('no such object')
    const type = object && this.store.getType(object.typeId)
    if (!spaces.has(rule.spaceId)) {
      if (rule.spaceId) throw new InsistentError('no such space')
      rule.spaceId = this.options.accounts.captureFor(user).spaceId()
    }
    const title = typeof rule.title === 'string' ? rule.title.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
    if (title) rule.title = title
    else delete rule.title
    if (!object && !rule.title) throw new InsistentError('a reminder about nothing needs a title')

    const when = rule.when
    const days = (list: unknown) => {
      if (list === undefined) return undefined
      if (!Array.isArray(list) || list.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new InsistentError('weekdays are 0 (Sunday) to 6 (Saturday)')
      const set = [...new Set(list as number[])].sort()
      return set.length && set.length < 7 ? set : undefined
    }
    if (when?.kind === 'object') {
      if (!object) throw new InsistentError("“at its own time” needs an object")
      const habit = type?.system === 'habit'
      if (!habit && this.timeOf(object, type) === undefined) throw new InsistentError(`“${object.title || 'This'}” has no time of its own: pick a time of day`)
      const before = when.before ?? 0
      if (!Number.isInteger(before) || before < 0 || before > 24 * 60) throw new InsistentError('minutes before: 0 to 1440')
      rule.when = habit ? { kind: 'object' } : { kind: 'object', before }
    } else if (when?.kind === 'daily') {
      if (!CLOCK.test(when.at ?? '')) throw new InsistentError('the time is HH:MM')
      const d = days(when.days)
      rule.when = { kind: 'daily', at: pad(when.at), ...(d ? { days: d } : {}) }
    } else if (when?.kind === 'wake') {
      if (!CLOCK.test(when.after ?? '')) throw new InsistentError('the time to wait for is HH:MM')
      if (when.latest !== undefined && when.latest !== null && (!CLOCK.test(when.latest) || pad(when.latest) <= pad(when.after))) throw new InsistentError('“at the latest” is a time after the first one')
      const d = days(when.days)
      rule.when = { kind: 'wake', after: pad(when.after), ...(when.latest ? { latest: pad(when.latest) } : {}), ...(d ? { days: d } : {}) }
    } else throw new InsistentError('when: object, daily or wake')

    const content = rule.content
    const count = (n: unknown) => {
      const value = n === undefined ? 1 : Number(n)
      if (!Number.isInteger(value) || value < 1 || value > 5) throw new InsistentError('show 1 to 5 objects')
      return value
    }
    if (content?.kind === 'target') {
      if (!object) throw new InsistentError('a reminder about nothing shows a tag, a query or your tasks')
    } else if (content?.kind === 'tag') {
      const tag = this.store.getObject(content.tagId)
      if (!tag || tag.deletedAt || tag.typeId !== builtinTypeId(tag.spaceId, 'tag') || !spaces.has(tag.spaceId)) throw new InsistentError('no such tag')
      rule.content = { kind: 'tag', tagId: tag.id, count: count(content.count) }
      if (!object) rule.spaceId = tag.spaceId
    } else if (content?.kind === 'query') {
      const query = this.store.getObject(content.queryId)
      if (!query?.query || query.deletedAt || !spaces.has(query.spaceId)) throw new InsistentError('no such query')
      rule.content = { kind: 'query', queryId: query.id, count: count(content.count) }
      if (!object) rule.spaceId = query.spaceId
    } else if (content?.kind === 'tasks') {
      rule.content = { kind: 'tasks' }
    } else throw new InsistentError('content: target, tag, query or tasks')

    if (!['ok', 'done', 'type', 'say'].includes(rule.ack)) throw new InsistentError('answered by: ok, done, type or say')
    if (rule.ack === 'done' && !(type?.system === 'habit' || type?.system === 'task')) throw new InsistentError('only a habit or a task is answered by doing it')
    if (rule.ack === 'done' && type?.system === 'habit' && object && habitFoodRule(object)) throw new InsistentError('this habit is done from what is logged in Food: answer it with OK')
    if ((rule.ack === 'type' || rule.ack === 'say') && rule.content.kind === 'tasks') throw new InsistentError('your tasks are not something to type or say: show a tag or a query')

    if (rule.repeat !== null && !REPEATS.includes(rule.repeat)) throw new InsistentError(`repeat every ${REPEATS.join(', ')} minutes, or never`)
    if (!SNOOZES.includes(rule.snooze)) throw new InsistentError(`snooze for ${SNOOZES.join(', ')} minutes`)
    if (rule.climbAfter !== null && (!Number.isInteger(rule.climbAfter) || rule.climbAfter < 1 || rule.climbAfter > 10)) throw new InsistentError('climb a step after 1 to 10 snoozes, or never')
    if (!Number.isInteger(rule.escapeAfter) || rule.escapeAfter < 3 || rule.escapeAfter > 120) throw new InsistentError('the way out of the takeover shows after 3 to 120 seconds')
    if (!Array.isArray(rule.steps) || !rule.steps.length || rule.steps.length > 6) throw new InsistentError('a ladder has 1 to 6 steps')
    const steps = rule.steps.map((step, i) => {
      const channels = [...new Set(step.channels ?? [])]
      if (!channels.length || channels.some((c) => !NAG_CHANNELS.includes(c))) throw new InsistentError(`each step goes through some of: ${NAG_CHANNELS.join(', ')}`)
      const after = i === 0 ? 0 : Number(step.after)
      if (!Number.isInteger(after) || after < 0 || after > 12 * 60) throw new InsistentError("a step's minutes are 0 to 720")
      return { after, channels: NAG_CHANNELS.filter((c) => channels.includes(c)), ...(step.urgent ? { urgent: true } : {}) }
    })
    for (let i = 1; i < steps.length; i++) if (steps[i]!.after <= steps[i - 1]!.after) throw new InsistentError('each step comes later than the one before')
    rule.steps = steps
    rule.paused = !!rule.paused || undefined
    if (!rule.paused) delete rule.paused
    return {
      id: rule.id,
      ...(rule.objectId ? { objectId: rule.objectId } : {}),
      spaceId: rule.spaceId,
      ...(rule.title ? { title: rule.title } : {}),
      when: rule.when,
      content: rule.content,
      ack: rule.ack,
      repeat: rule.repeat,
      steps: rule.steps,
      snooze: rule.snooze,
      climbAfter: rule.climbAfter,
      escapeAfter: rule.escapeAfter,
      ...(rule.paused ? { paused: true } : {}),
      createdAt: rule.createdAt,
    }
  }

  // Occurrences ------------------------------------------------------------------

  /** A task's due date or an event's start: the first date property with a time, or the object's own date. */
  private timeOf(object: Pick<ObjectSummary, 'props' | 'date'>, type: ObjectType | undefined): string | undefined {
    if (!type) return undefined
    for (const def of type.properties) {
      const value = object.props[def.id]
      if (def.kind === 'date' && value?.kind === 'date' && value.value.resolution === 'time') return def.id
    }
    return object.date?.resolution === 'time' && type.system !== 'daily-note' ? 'date' : undefined
  }

  /** The occurrences of a rule that start in (from, to]: their key, day and start. */
  private occurrences(user: User, rule: InsistentRule, from: number, to: number): { occurrence: string; day: string; at: number; until?: number }[] {
    const timeZone = this.timeZone(user)
    const days = [...new Set([dayIn(from, timeZone), dayIn(to, timeZone)])]
    const inWindow = (at: number) => at > from && at <= to
    const at = (day: string, clock: string) => {
      const [year, month, date] = day.split('-').map(Number) as [number, number, number]
      const [hour, minute] = clock.split(':').map(Number) as [number, number]
      return instantOf({ year, month, day: date, hour, minute, second: 0 }, timeZone)
    }
    const weekday = (day: string) => new Date(`${day}T00:00:00.000Z`).getUTCDay()
    const object = rule.objectId ? this.store.getObject(rule.objectId) : undefined
    if (rule.objectId && (!object || object.deletedAt)) return []
    const type = object && this.store.getType(object.typeId)
    const found: { occurrence: string; day: string; at: number; until?: number }[] = []
    if (rule.when.kind === 'object' && object && type?.system !== 'habit') {
      const field = this.timeOf(object, type)
      if (!field || !type) return []
      const lead = (rule.when.before ?? 0) * 60_000
      const types = new Map([[type.id, type]])
      const range = { from: addDays(days[0]!, -1), to: addDays(days.at(-1)!, 2) }
      for (const entry of objectEntries([{ ...object, preview: '' }], types, range, timeZone)) {
        if (entry.field !== field || entry.allDay) continue
        // A repeating task reminds of the occurrence it is at.
        if (entry.recurring && type.system === 'task' && !entry.current) continue
        const start = Date.parse(entry.start) - lead
        if (inWindow(start)) found.push({ occurrence: entry.key, day: dayIn(Date.parse(entry.start), timeZone), at: start })
      }
      return found
    }
    for (const day of days) {
      if (rule.when.kind === 'object') {
        const time = object && habitRemindAt(object)
        if (time) found.push({ occurrence: day, day, at: at(day, time) })
      } else if (rule.when.kind === 'daily') {
        if (!rule.when.days || rule.when.days.includes(weekday(day))) found.push({ occurrence: day, day, at: at(day, rule.when.at) })
      } else if (!rule.when.days || rule.when.days.includes(weekday(day))) {
        // At the computer from `after` on: started by presence(); here only `latest`, or a user
        // already there when `after` comes.
        const after = at(day, rule.when.after)
        const latest = rule.when.latest ? at(day, rule.when.latest) : undefined
        if (inWindow(after) && this.isPresent(user.id, after)) found.push({ occurrence: day, day, at: after })
        else if (latest !== undefined && inWindow(latest)) found.push({ occurrence: day, day, at: latest })
      }
    }
    return found.filter((o) => inWindow(o.at))
  }

  /** The habit or task is done for the nag's day (wherever that happened). */
  private isDone(rule: InsistentRule, nag: Pick<Nag, 'day' | 'occurrence'>): boolean {
    const object = rule.objectId ? this.store.getObject(rule.objectId) : undefined
    if (!object) return false
    const type = this.store.getType(object.typeId)
    if (type?.system === 'habit') {
      const [withFood] = habitFoodRule(object) ? habitsWithFood(this.store, object.spaceId, [{ ...object, preview: '' }], nag.day) : [object]
      return isHabitDone(withFood ?? object, nag.day)
    }
    if (type?.system === 'task') {
      if (isFinished(object, type)) return true
      // A repeating task done on this occurrence has moved on to the next one.
      const due = object.props.due
      if (due?.kind === 'date' && due.value.rrule && nag.occurrence.includes(':due:')) {
        const start = nag.occurrence.split(':due:')[1]!
        return Date.parse(due.value.start) > Date.parse(start)
      }
    }
    return false
  }

  /** The habit is not due that day: not on its days, paused, or done already. */
  private skipsDay(rule: InsistentRule, day: string): boolean {
    const object = rule.objectId ? this.store.getObject(rule.objectId) : undefined
    const type = object && this.store.getType(object.typeId)
    if (!object || type?.system !== 'habit') return false
    return isHabitPaused(object) || !isHabitScheduled(object, day)
  }

  // Presence ---------------------------------------------------------------------

  /** The user is at a computer (the desktop app saw them come back, or the computer wake): reminders waiting for that start. */
  async presence(user: User, at = this.now()) {
    this.present.set(user.id, at)
    const timeZone = this.timeZone(user)
    const day = dayIn(at, timeZone)
    for (const rule of this.rules(user.id)) {
      if (rule.paused || rule.when.kind !== 'wake') continue
      if (rule.when.days && !rule.when.days.includes(new Date(`${day}T00:00:00.000Z`).getUTCDay())) continue
      const [year, month, date] = day.split('-').map(Number) as [number, number, number]
      const [hour, minute] = rule.when.after.split(':').map(Number) as [number, number]
      if (at < instantOf({ year, month, day: date, hour, minute, second: 0 }, timeZone)) continue
      const nag = this.start(user, rule, { occurrence: day, day, at })
      if (nag) await this.advance(user, rule, nag, at)
    }
  }

  private isPresent(userId: Id, at: number) {
    const seen = this.present.get(userId)
    return seen !== undefined && at - seen < PRESENT_MS && seen - at < PRESENT_MS
  }

  /** The user's desktop app went away or idle. */
  absent(userId: Id) {
    this.present.delete(userId)
  }

  // Running ----------------------------------------------------------------------

  /** The objects whose plain reminders an insistent one replaces (ReminderService skips them). */
  covered(userId: Id): Set<Id> {
    return new Set(this.rules(userId).flatMap((r) => (!r.paused && r.objectId && r.when.kind === 'object' ? [r.objectId] : [])))
  }

  /** Start what fell due in (from, now] and move every open nag on. */
  async tick(user: User, from: number, now: number) {
    for (const rule of this.rules(user.id)) {
      if (rule.paused) continue
      for (const occurrence of this.occurrences(user, rule, from, now)) this.start(user, rule, occurrence)
    }
    const rules = new Map(this.rules(user.id).map((r) => [r.id, r]))
    for (const nag of this.openNags(user.id)) {
      const rule = rules.get(nag.ruleId)
      if (!rule) this.close(nag, 'ignored', now)
      else await this.advance(user, rule, nag, now)
    }
  }

  /** A new nag for an occurrence, unless it already had one, the habit is not due, or it is done. */
  private start(user: User, rule: InsistentRule, occurrence: { occurrence: string; day: string; at: number }): Nag | undefined {
    if (this.store.db.prepare('SELECT 1 FROM reminder_nags WHERE rule_id = ? AND occurrence = ?').get(rule.id, occurrence.occurrence)) return undefined
    if (this.skipsDay(rule, occurrence.day) || this.isDone(rule, occurrence)) return undefined
    const now = Math.max(occurrence.at, this.now())
    // The one before ends (it was ignored) when the next one starts.
    for (const open of this.openNags(user.id).filter((n) => n.ruleId === rule.id)) this.close(open, open.outcome ?? 'ignored', now)
    const timeZone = this.timeZone(user)
    const midnight = instantOf({ ...partsOf(addDays(occurrence.day, 1)), hour: 0, minute: 0, second: 0 }, timeZone)
    const nag: Nag = {
      id: randomBytes(9).toString('base64url'),
      userId: user.id,
      ruleId: rule.id,
      occurrence: occurrence.occurrence,
      day: occurrence.day,
      startedAt: occurrence.at,
      // The end of its day, or two hours for one that starts late.
      expiresAt: Math.max(midnight, occurrence.at + 2 * 3_600_000),
      nextAt: occurrence.at,
      shift: 0,
      bump: 0,
      step: 0,
      snoozes: 0,
      sent: 0,
      contentIds: this.pickContent(user, rule),
    }
    this.store.db
      .prepare('INSERT INTO reminder_nags (id, user_id, rule_id, occurrence, started_at, state) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nag.id, user.id, rule.id, nag.occurrence, nag.startedAt, JSON.stringify(nag))
    return nag
  }

  /** Random objects for the nag to show, picked once so every repeat shows the same ones. */
  private pickContent(user: User, rule: InsistentRule): Id[] {
    const content = rule.content
    if (content.kind === 'target') return rule.objectId ? [rule.objectId] : []
    if (content.kind === 'tasks') return []
    let pool: ObjectSummary[] = []
    if (content.kind === 'tag') {
      const tagType = builtinTypeId(rule.spaceId, 'tag')
      const tags = this.store.listObjects(tagType)
      const parentOf = new Map(tags.map((t) => [t.id, t.parentId]))
      const under = (id: Id | undefined): boolean => {
        for (let at = id, depth = 0; at && depth < 20; at = parentOf.get(at) ?? undefined, depth++) if (at === content.tagId) return true
        return false
      }
      pool = this.store.listSpaceObjects(rule.spaceId).filter((o) => !o.deletedAt && o.typeId !== tagType && o.tagIds.some(under))
    } else {
      const query = this.store.getObject(content.queryId)
      if (query?.query && !query.deletedAt) {
        try {
          pool = querySpace(this.store, query.spaceId, { query: query.query, parentId: query.id, timeZone: this.timeZone(user), me: user.id, today: dayIn(this.now(), this.timeZone(user)) }, new Date(this.now()).toISOString())
        } catch (error) {
          console.warn(`Reminder ${rule.id}: its query failed: ${(error as Error).message}`)
        }
      }
    }
    pool = pool.filter((o) => o.id !== rule.objectId)
    // The ones not shown last time first, so the same ones do not come back day after day.
    const last = new Set(this.lastNag(rule.id)?.contentIds ?? [])
    const picked: Id[] = []
    for (const bag of [pool.filter((o) => !last.has(o.id)), pool.filter((o) => last.has(o.id))]) {
      while (picked.length < (content.count ?? 1) && bag.length) picked.push(bag.splice(Math.floor(this.random() * bag.length), 1)[0]!.id)
    }
    return picked
  }

  /** Close it, send it, or wait: what an open nag does now. */
  private async advance(user: User, rule: InsistentRule, nag: Nag, now: number) {
    if (this.isDone(rule, nag)) return this.close(nag, 'done', now)
    if (now >= nag.expiresAt) return this.close(nag, 'ignored', now)
    if (nag.nextAt === null || now < nag.nextAt) return
    const quiet = this.quietUntil(user, now)
    if (quiet !== undefined) {
      nag.nextAt = Math.min(quiet, nag.expiresAt)
      return this.save(nag)
    }
    const active = now - nag.startedAt - nag.shift
    const byTime = lastIndex(rule.steps, (s) => s.after * 60_000 <= active)
    const step = Math.min(rule.steps.length - 1, Math.max(byTime, nag.bump))
    nag.step = Math.max(nag.step, step)
    nag.sent++
    const nextStep = rule.steps.slice(step + 1).find((s) => s.after * 60_000 > active)
    const nextByStep = nextStep ? nag.startedAt + nag.shift + nextStep.after * 60_000 : null
    const nextByRepeat = rule.repeat !== null ? now + rule.repeat * 60_000 : null
    nag.nextAt = [nextByStep, nextByRepeat].filter((t): t is number => t !== null).reduce<number | null>((a, b) => (a === null ? b : Math.min(a, b)), null)
    if (rule.steps[step]!.channels.includes('takeover')) nag.tookOver = true
    this.save(nag)
    await this.options.deliver(user, this.delivery(user, rule, nag, step))
  }

  /** The end of the user's quiet hours, when `at` falls in them. */
  private quietUntil(user: User, at: number): number | undefined {
    const quiet = this.options.quiet?.(user.id)
    if (!quiet) return undefined
    const timeZone = this.timeZone(user)
    const day = dayIn(at, timeZone)
    const clock = (d: string, c: string) => instantOf({ ...partsOf(d), hour: Number(c.slice(0, 2)), minute: Number(c.slice(3, 5)), second: 0 }, timeZone)
    for (const start of [addDays(day, -1), day]) {
      const from = clock(start, quiet.from)
      const to = quiet.to > quiet.from ? clock(start, quiet.to) : clock(addDays(start, 1), quiet.to)
      if (at >= from && at < to) return to
    }
    return undefined
  }

  // Answers ----------------------------------------------------------------------

  /** Answer a nag. `texts`: what was typed or heard, one per item shown; `reason`: why not today. */
  async answer(user: User, nagId: string, input: { answer: NagAnswer; texts?: string[]; reason?: string }): Promise<Nag> {
    const nag = this.nag(nagId)
    if (!nag || nag.userId !== user.id) throw new InsistentError('no such reminder')
    if (nag.outcome) return nag
    const rule = this.rule(user.id, nag.ruleId)
    if (!rule) throw new InsistentError('no such reminder')
    const now = this.now()
    switch (input.answer) {
      case 'snooze': {
        nag.snoozes++
        nag.shift += rule.snooze * 60_000
        nag.nextAt = now + rule.snooze * 60_000
        if (rule.climbAfter !== null && nag.snoozes % rule.climbAfter === 0) nag.bump = Math.min(rule.steps.length - 1, Math.max(nag.bump, nag.step) + 1)
        this.save(nag)
        this.options.resolved?.(nag)
        return nag
      }
      case 'skip': {
        const reason = (input.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
        if (!reason) throw new InsistentError('say why not today, in a line')
        nag.reason = reason
        return this.close(nag, 'skipped', now)
      }
      case 'escape':
        return this.close(nag, 'escaped', now)
      case 'ok':
        if (rule.ack !== 'ok') throw new InsistentError(rule.ack === 'done' ? 'this one is answered by doing it' : `this one is answered by ${rule.ack === 'say' ? 'saying' : 'typing'} its text`)
        return this.close(nag, 'ok', now)
      case 'done':
        if (rule.ack !== 'done') throw new InsistentError('this one is not answered by doing it')
        this.complete(user, rule, nag)
        return this.close(nag, 'done', now)
      case 'typed':
      case 'said': {
        if (rule.ack !== 'type' && rule.ack !== 'say') throw new InsistentError('this one is not answered with its text')
        // Saying it may fall back to typing (no microphone, no speech recognition); typing is stricter.
        if (input.answer === 'said' && rule.ack !== 'say') throw new InsistentError('this one is answered by typing its text')
        const expected = this.expected(rule, nag)
        const texts = input.texts ?? []
        const need = input.answer === 'typed' ? TYPED_MATCH : SAID_MATCH
        const missing = expected.findIndex((text, i) => textMatch(text, texts[i] ?? '') < need)
        if (missing >= 0) throw new InsistentError(expected.length > 1 ? `not quite: phrase ${missing + 1} again` : 'not quite: once more')
        this.complete(user, rule, nag)
        return this.close(nag, input.answer, now)
      }
      default:
        throw new InsistentError('answer: ok, done, typed, said, snooze, skip or escape')
    }
  }

  /** A typed reply in Telegram: the text, or the reason asked for. Undefined when it is not about a nag. */
  async telegramReply(user: User, replyTo: number, text: string): Promise<string | undefined> {
    for (const nag of this.openNags(user.id)) {
      const rule = this.rule(user.id, nag.ruleId)
      const message = nag.telegram?.find((m) => m.message === replyTo)
      if (!rule || !message) continue
      if (nag.asking === replyTo) {
        await this.answer(user, nag.id, { answer: 'skip', reason: text })
        return 'Skipped for today. Noted why.'
      }
      if (rule.ack !== 'type' && rule.ack !== 'say') return undefined
      const expected = this.expected(rule, nag)
      // In Telegram everything comes as one message: the phrases, in order, on lines or not.
      const joined = expected.join(' ')
      if (textMatch(joined, text) < TYPED_MATCH) return expected.length > 1 ? 'Not quite. Type all of them, in order.' : 'Not quite. Type it again.'
      this.complete(user, rule, nag)
      this.close(nag, 'typed', this.now())
      return 'Done ✓'
    }
    return undefined
  }

  /** "Not today" in Telegram: the message asking why, which the reply answers. */
  askedWhy(nagId: string, message: number, chat: number) {
    const nag = this.nag(nagId)
    if (!nag || nag.outcome) return
    nag.asking = message
    nag.telegram = [...(nag.telegram ?? []), { chat, message }]
    this.save(nag)
  }

  /** A Telegram message sent for a nag: its buttons go once it is answered, and a reply to it answers. */
  sentTelegram(nagId: string, chat: number, message: number) {
    const nag = this.nag(nagId)
    if (!nag) return
    nag.telegram = [...(nag.telegram ?? []), { chat, message }].slice(-20)
    this.save(nag)
  }

  /** The texts a nag is answered with: its items' titles. */
  expected(_rule: InsistentRule, nag: Nag): string[] {
    return nag.contentIds.map((id) => this.store.getObjectSummaries([id])[0]?.title ?? '').filter((t) => normalizeText(t))
  }

  /** Mark the habit done for the day, or the task done (the occurrence it is at, for a repeating one). */
  private complete(user: User, rule: InsistentRule, nag: Nag) {
    const object = rule.objectId ? this.store.getObject(rule.objectId) : undefined
    const type = object && this.store.getType(object.typeId)
    if (!object || object.deletedAt || !type) return
    if (type.system !== 'habit' && type.system !== 'task') return
    if (this.isDone(rule, nag)) return
    const at = new Date(this.now()).toISOString()
    runAs(user.id, () => {
      let next: ObjectRecord
      if (type.system === 'habit') {
        if (habitFoodRule(object)) return
        const value = habitDayValue(object, habitTarget(object) ?? 1)
        if (!value) return
        next = { ...object, props: { ...object.props, [habitDoneKey(nag.day)]: value }, updatedAt: at }
      } else {
        const status = type.properties.find((p) => p.id === 'status')
        const done = status?.kind === 'select' ? status.options.find((o) => o.status === 'done') : undefined
        if (!done) return
        next = completeRepeat({ ...object, props: { ...object.props, status: { kind: 'select', value: [done.id] } }, updatedAt: at }, object, type, this.timeZone(user))
      }
      const stored = this.store.putObject(next)
      this.options.feed?.emit({ kind: 'object', id: stored.id, spaceId: stored.spaceId, typeId: stored.typeId, updatedAt: stored.updatedAt })
    })
  }

  private close(nag: Nag, outcome: NagOutcome, at = this.now()): Nag {
    nag.outcome = outcome
    nag.answeredAt = at
    nag.nextAt = null
    this.store.db.prepare('UPDATE reminder_nags SET closed_at = ?, outcome = ?, state = ? WHERE id = ?').run(at, outcome, JSON.stringify(nag), nag.id)
    this.options.resolved?.(nag)
    return nag
  }

  // Reading ----------------------------------------------------------------------

  nag(id: string): Nag | undefined {
    const row = this.store.db.prepare('SELECT state FROM reminder_nags WHERE id = ?').get(id) as Row | undefined
    return row ? (JSON.parse(row.state as string) as Nag) : undefined
  }

  openNags(userId: Id): Nag[] {
    const rows = this.store.db.prepare('SELECT state FROM reminder_nags WHERE user_id = ? AND closed_at IS NULL ORDER BY started_at').all(userId) as Row[]
    return rows.map((row) => JSON.parse(row.state as string) as Nag)
  }

  private lastNag(ruleId: string): Nag | undefined {
    const row = this.store.db.prepare('SELECT state FROM reminder_nags WHERE rule_id = ? ORDER BY started_at DESC LIMIT 1').get(ruleId) as Row | undefined
    return row ? (JSON.parse(row.state as string) as Nag) : undefined
  }

  private save(nag: Nag) {
    this.store.db.prepare('UPDATE reminder_nags SET state = ? WHERE id = ?').run(JSON.stringify(nag), nag.id)
  }

  /** What a nag shows: its title, a line of status, its items (title and a short text) or today's tasks. */
  view(user: User, nagId: string) {
    const nag = this.nag(nagId)
    if (!nag || nag.userId !== user.id) throw new InsistentError('no such reminder')
    const rule = this.rule(user.id, nag.ruleId)
    if (!rule) throw new InsistentError('no such reminder')
    const object = rule.objectId ? this.store.getObject(rule.objectId) : undefined
    const type = object && this.store.getType(object.typeId)
    const items = this.store.getObjectSummaries(nag.contentIds).map((o) => ({ id: o.id, title: o.title, text: o.preview.slice(0, 600), typeId: o.typeId }))
    return {
      id: nag.id,
      title: this.titleOf(rule),
      ...(object ? { object: { id: object.id, title: object.title, typeId: object.typeId, system: type?.system ?? null } } : {}),
      day: nag.day,
      startedAt: new Date(nag.startedAt).toISOString(),
      ack: rule.ack,
      items: rule.content.kind === 'target' && rule.ack !== 'type' && rule.ack !== 'say' ? items.map((i) => ({ ...i, title: '' })).filter((i) => i.text) : items,
      ...(rule.content.kind === 'tasks' ? { tasks: this.tasks(user, rule.spaceId) } : {}),
      expected: rule.ack === 'type' || rule.ack === 'say' ? this.expected(rule, nag) : [],
      snooze: rule.snooze,
      snoozes: nag.snoozes,
      climbAfter: rule.climbAfter,
      step: nag.step,
      steps: rule.steps.length,
      sent: nag.sent,
      escapeAfter: rule.escapeAfter,
      ...(nag.outcome ? { outcome: nag.outcome } : {}),
      ...(nag.reason ? { reason: nag.reason } : {}),
      ruleId: rule.id,
    }
  }

  titleOf(rule: InsistentRule): string {
    if (rule.title) return rule.title
    const object = rule.objectId ? this.store.getObject(rule.objectId) : undefined
    return object?.title || 'A reminder'
  }

  /** Tasks due today or overdue, not done (up to 8, earliest first). */
  tasks(user: User, spaceId: Id): { id: Id; title: string; due: string }[] {
    const type = this.store.getType(builtinTypeId(spaceId, 'task'))
    if (!type) return []
    const timeZone = this.timeZone(user)
    const today = dayIn(this.now(), timeZone)
    return this.store
      .listObjects(type.id)
      .filter((t) => !t.deletedAt && !isFinished(t, type))
      .flatMap((t) => {
        const due = t.props.due
        if (due?.kind !== 'date') return []
        const day = due.value.resolution === 'day' ? due.value.start.slice(0, 10) : dayIn(due.value.start, timeZone)
        return day <= today ? [{ id: t.id, title: t.title || 'Untitled', due: due.value.start }] : []
      })
      .sort((a, b) => a.due.localeCompare(b.due))
      .slice(0, 8)
  }

  /** Each rule's stats over the last `days` days. */
  stats(user: User, ruleId: string, days = 30): RuleStats {
    const timeZone = this.timeZone(user)
    const since = this.now() - days * 86_400_000
    const rows = this.store.db.prepare('SELECT state FROM reminder_nags WHERE user_id = ? AND rule_id = ? AND started_at >= ? ORDER BY started_at').all(user.id, ruleId, since) as Row[]
    const nags = rows.map((row) => JSON.parse(row.state as string) as Nag)
    const count = (outcome: NagOutcome) => nags.filter((n) => n.outcome === outcome).length
    const answered = nags.filter((n) => n.outcome && ['ok', 'done', 'typed', 'said'].includes(n.outcome))
    const minutes = answered.map((n) => ((n.answeredAt ?? n.startedAt) - n.startedAt) / 60_000).sort((a, b) => a - b)
    const median = minutes.length ? (minutes.length % 2 ? minutes[(minutes.length - 1) / 2]! : (minutes[minutes.length / 2 - 1]! + minutes[minutes.length / 2]!) / 2) : null
    const today = dayIn(this.now(), timeZone)
    const byDay = new Map<string, Nag>()
    for (const nag of nags) byDay.set(nag.day, nag)
    return {
      total: nags.length,
      open: nags.filter((n) => !n.outcome).length,
      done: count('done'),
      ok: count('ok'),
      typed: count('typed'),
      said: count('said'),
      skipped: count('skipped'),
      escaped: count('escaped'),
      ignored: count('ignored'),
      snoozes: nags.reduce((sum, n) => sum + n.snoozes, 0),
      answered: answered.length,
      medianMinutes: median === null ? null : Math.round(median),
      tookOver: nags.filter((n) => n.tookOver).length,
      escalated: nags.filter((n) => n.step > 0).length,
      reasons: nags
        .filter((n) => n.reason)
        .slice(-5)
        .reverse()
        .map((n) => ({ day: n.day, reason: n.reason! })),
      days: Array.from({ length: 14 }, (_, i) => {
        const day = addDays(today, i - 13)
        const nag = byDay.get(day)
        return { day, outcome: nag ? (nag.outcome ?? 'open') : null }
      }),
    }
  }


  // Delivery ---------------------------------------------------------------------

  private delivery(user: User, rule: InsistentRule, nag: Nag, step: number): NagDelivery {
    const title = this.titleOf(rule)
    const items = this.store.getObjectSummaries(nag.contentIds)
    const lines: string[] = []
    const object = rule.objectId ? this.store.getObject(rule.objectId) : undefined
    const type = object && this.store.getType(object.typeId)
    if (rule.content.kind === 'tasks') {
      const tasks = this.tasks(user, rule.spaceId)
      lines.push(tasks.length ? tasks.map((t) => `• ${t.title}`).join('\n') : 'No tasks due today.')
    } else if (rule.content.kind === 'target') {
      if (object?.description) lines.push(object.description)
    } else {
      for (const item of items) lines.push(items.length > 1 ? `• ${item.title}` : `“${item.title}”`)
    }
    if (object && type?.system === 'habit') {
      const amount = habitAmountText(object, nag.day)
      const streak = habitStats(object, nag.day).current
      const habitLine = [amount ? `${amount} so far today` : '', streak ? `${streak} in a row` : ''].filter(Boolean).join(' · ')
      if (habitLine) lines.push(habitLine)
    }
    const ask = { ok: '', done: 'Mark it done to stop this.', type: 'Type it to stop this.', say: 'Say it out loud to stop this.' }[rule.ack]
    const status = [nag.sent > 1 ? `Reminder ${nag.sent}` : '', nag.snoozes ? `snoozed ${nag.snoozes === 1 ? 'once' : `${nag.snoozes} times`}` : '', ask].filter(Boolean).join(' · ')
    if (status) lines.push(status)
    const page = `remind/${nag.id}`
    const actions: NagDelivery['actions'] = []
    if (rule.ack === 'done') actions.push({ action: 'done', label: 'Done ✓', url: this.actionUrl(nag.id, 'done'), callback: `nag:${nag.id}:done` })
    else if (rule.ack === 'ok') actions.push({ action: 'ok', label: 'OK ✓', url: this.actionUrl(nag.id, 'ok'), callback: `nag:${nag.id}:ok` })
    else actions.push({ action: 'open', label: rule.ack === 'say' ? 'Say it' : 'Type it', url: this.link(page) })
    actions.push({ action: 'snooze', label: `Snooze ${rule.snooze} min`, url: this.actionUrl(nag.id, 'snooze'), callback: `nag:${nag.id}:snooze` })
    actions.push({ action: 'skip', label: 'Not today', url: this.link(page, 'skip'), callback: `nag:${nag.id}:skip` })
    const ladder = rule.steps[step]!
    return {
      key: `nag:${nag.id}:${nag.sent}`,
      title,
      message: lines.join('\n'),
      url: this.link(page),
      urgent: !!ladder.urgent,
      channels: ladder.channels,
      actions,
      nag,
      rule,
      ...(rule.ack === 'type' || rule.ack === 'say' ? { expected: this.expected(rule, nag) } : {}),
    }
  }

  private link(path: string, query?: string) {
    const base = (this.options.webUrl ?? '').replace(/\/$/, '')
    return `${base}/${path}${query ? `?${query}` : ''}`
  }

  // Signed links -----------------------------------------------------------------
  // ntfy's buttons are requests the phone makes on its own, and a Web Push button is answered by
  // the service worker: neither carries the user's session. A link signed with the server's secret
  // answers one nag one way, and nothing else.

  private key(): Buffer {
    if (this.secret) return this.secret
    let saved = this.store.getMeta(SECRET_KEY)
    if (!saved) this.store.setMeta(SECRET_KEY, (saved = randomBytes(32).toString('base64url')))
    return (this.secret = Buffer.from(saved, 'base64url'))
  }

  sign(nagId: string, answer: string): string {
    return createHmac('sha256', this.key()).update(`${nagId}:${answer}`).digest('base64url').slice(0, 32)
  }

  actionUrl(nagId: string, answer: 'ok' | 'done' | 'snooze'): string {
    return this.link(`api/remind/${nagId}/${answer}`, `s=${this.sign(nagId, answer)}`)
  }

  /** Answer from a signed link. */
  async signed(nagId: string, answer: string, signature: string): Promise<Nag> {
    const expected = Buffer.from(this.sign(nagId, answer))
    const given = Buffer.from(signature)
    if (!['ok', 'done', 'snooze'].includes(answer) || expected.length !== given.length || !timingSafeEqual(expected, given)) throw new InsistentError('this link is not valid')
    const nag = this.nag(nagId)
    const user = nag && this.store.getUser(nag.userId)
    if (!nag || !user) throw new InsistentError('no such reminder')
    return this.answer(user, nagId, { answer: answer as NagAnswer })
  }

  /** Telegram's buttons: `nag:<id>:<answer>`. What to show the user, and whether to ask why. */
  async callback(user: User, data: string): Promise<{ text: string; askWhy?: string }> {
    const match = /^nag:([\w-]+):(ok|done|snooze|skip)$/.exec(data)
    if (!match) return { text: '' }
    const [, nagId, answer] = match as unknown as [string, string, NagAnswer]
    const nag = this.nag(nagId)
    if (!nag || nag.userId !== user.id) return { text: 'That reminder is gone.' }
    if (nag.outcome) return { text: 'Already answered.' }
    if (answer === 'skip') return { text: '', askWhy: nagId }
    try {
      const after = await this.answer(user, nagId, { answer })
      const rule = this.rule(user.id, after.ruleId)
      return { text: answer === 'snooze' ? `Snoozed for ${rule?.snooze ?? 15} minutes.` : 'Done ✓' }
    } catch (error) {
      return { text: (error as Error).message }
    }
  }
}

function lastIndex<T>(list: T[], test: (item: T) => boolean): number {
  let found = 0
  list.forEach((item, i) => {
    if (test(item)) found = i
  })
  return found
}

function partsOf(day: string) {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number]
  return { year, month, day: date }
}

/** A task whose status is a "done" (or dropped) option. */
export function isFinished(object: Pick<ObjectSummary, 'props'>, type: ObjectType | undefined): boolean {
  if (type?.system !== 'task') return false
  const status = type.properties.find((p) => p.id === 'status')
  const value = object.props.status
  return status?.kind === 'select' && value?.kind === 'select' && status.options.some((o) => value.value.includes(o.id) && o.status === 'done')
}
