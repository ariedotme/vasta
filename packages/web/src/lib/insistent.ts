// Reminders in the app (server/src/insistent.ts): the editor dialog (an object's "Remind me…",
// Settings › Reminders' "New reminder…"), the styles it offers (how a reminder reaches you: a
// pop-up, the whole screen, notifications, escalating), and how a rule reads in a line.
import { reactive } from 'vue'
import { addDays, type Id } from '@vasta/core'
import type { InsistentRule, LadderStep, NagChannel, RuleInput } from './api.ts'
import { formatWeekday } from './calendar.ts'
import { t } from './i18n.ts'

/** The editor: a new rule (about an object, or about nothing) or one to change. */
export const reminderEditor = reactive<{ open: boolean; objectId?: Id; rule?: InsistentRule; saved?: (rule: InsistentRule | null) => void }>({ open: false })

export function openReminderEditor(options: { objectId?: Id; rule?: InsistentRule; saved?: (rule: InsistentRule | null) => void } = {}) {
  Object.assign(reminderEditor, { open: true, objectId: options.objectId, rule: options.rule, saved: options.saved })
}

export function closeReminderEditor() {
  Object.assign(reminderEditor, { open: false, objectId: undefined, rule: undefined, saved: undefined })
}

export const CHANNELS: { id: NagChannel; readonly label: string; icon: string; readonly hint: string }[] = [
  { id: 'push', get label() { return t('reminders.channel.push') }, icon: 'ph:device-mobile', get hint() { return t('reminders.channel.pushHint') } },
  { id: 'desktop', get label() { return t('reminders.channel.desktop') }, icon: 'ph:desktop', get hint() { return t('reminders.channel.desktopHint') } },
  { id: 'ntfy', get label() { return t('reminders.channel.ntfy') }, icon: 'ph:bell-ringing', get hint() { return t('reminders.channel.ntfyHint') } },
  { id: 'telegram', get label() { return t('reminders.channel.telegram') }, icon: 'ph:telegram-logo', get hint() { return t('reminders.channel.telegramHint') } },
  { id: 'popup', get label() { return t('reminders.channel.popup') }, icon: 'ph:app-window', get hint() { return t('reminders.channel.popupHint') } },
  { id: 'takeover', get label() { return t('reminders.channel.takeover') }, icon: 'ph:frame-corners', get hint() { return t('reminders.channel.takeoverHint') } },
]

/** A reminder's style: how it reaches you (the same as REMINDER_STYLES in server/src/insistent.ts). */
export interface ReminderStyle {
  id: string
  readonly label: string
  icon: string
  readonly description: string
  repeat: number | null
  steps: LadderStep[]
  /** It needs the desktop app open. */
  desktop?: boolean
}

export const STYLES: ReminderStyle[] = [
  {
    id: 'popup',
    get label() { return t('reminders.channel.popup') },
    icon: 'ph:app-window',
    get description() { return t('reminders.style.popupDesc') },
    repeat: null,
    steps: [{ after: 0, channels: ['popup'] }],
    desktop: true,
  },
  {
    id: 'fullscreen',
    get label() { return t('reminders.channel.takeover') },
    icon: 'ph:frame-corners',
    get description() { return t('reminders.style.fullscreenDesc') },
    repeat: null,
    steps: [{ after: 0, channels: ['takeover'] }],
    desktop: true,
  },
  {
    id: 'notification',
    get label() { return t('reminders.style.notification') },
    icon: 'ph:bell',
    get description() { return t('reminders.style.notificationDesc') },
    repeat: 30,
    steps: [{ after: 0, channels: ['push', 'desktop', 'ntfy'] }],
  },
  {
    id: 'escalating',
    get label() { return t('reminders.style.escalating') },
    icon: 'ph:trend-up',
    get description() { return t('reminders.style.escalatingDesc') },
    repeat: 15,
    steps: [
      { after: 0, channels: ['push', 'desktop', 'ntfy'] },
      { after: 15, channels: ['push', 'desktop', 'ntfy'], urgent: true },
      { after: 30, channels: ['push', 'ntfy', 'telegram'], urgent: true },
      { after: 45, channels: ['push', 'ntfy', 'telegram', 'takeover'], urgent: true },
    ],
  },
  {
    id: 'relentless',
    get label() { return t('reminders.style.relentless') },
    icon: 'ph:siren',
    get description() { return t('reminders.style.relentlessDesc') },
    repeat: 5,
    steps: [
      { after: 0, channels: ['push', 'desktop', 'ntfy'], urgent: true },
      { after: 10, channels: ['push', 'ntfy', 'telegram'], urgent: true },
      { after: 15, channels: ['push', 'ntfy', 'telegram', 'takeover'], urgent: true },
    ],
  },
]

/** The style a rule's ladder is, if any (else its steps are its own: "custom"). */
export function styleOf(rule: Pick<RuleInput, 'repeat' | 'steps'>): ReminderStyle | undefined {
  return STYLES.find((p) => p.repeat === rule.repeat && JSON.stringify(p.steps) === JSON.stringify(rule.steps))
}

const weekdayShort = (d: number) => formatWeekday(addDays('2026-10-18', d))

export function daysText(days: number[] | undefined): string {
  if (!days?.length || days.length === 7) return t('reminders.days.everyDay')
  if (days.join() === '1,2,3,4,5') return t('reminders.days.weekdays')
  if (days.join() === '0,6') return t('reminders.days.weekends')
  return t('reminders.days.on', { days: days.map(weekdayShort).join(', ') })
}

/** "Every day at 09:00", "When I'm first at the computer after 08:00 (by 11:00)". */
export function whenText(rule: Pick<InsistentRule, 'when'>, objectTime?: string): string {
  const when = rule.when
  if (when.kind === 'object') {
    if (objectTime) return t('reminders.when.atObjectTime', { time: objectTime })
    return when.before ? t('reminders.when.minBefore', { min: when.before }) : t('reminders.when.whenItStarts')
  }
  if (when.kind === 'daily') {
    const days = daysText(when.days).replace(/^./, (c) => c.toUpperCase())
    return t('reminders.when.daily', { days, at: when.at })
  }
  return when.latest
    ? t('reminders.when.wakeLatest', { after: when.after, latest: when.latest, days: daysText(when.days) })
    : t('reminders.when.wake', { after: when.after, days: daysText(when.days) })
}

export function ladderText(rule: Pick<InsistentRule, 'repeat' | 'steps'>): string {
  const style = styleOf(rule)
  if (style) return style.label
  const base = rule.repeat ? t('reminders.ladder.everyMin', { min: rule.repeat }) : t('reminders.ladder.oncePerStep')
  if (rule.steps.length <= 1) return base
  const top = rule.steps.at(-1)!
  const channels = top.channels.map((c) => CHANNELS.find((x) => x.id === c)?.label ?? c).join(' + ')
  return t('reminders.ladder.upTo', { base, channels, min: top.after })
}
