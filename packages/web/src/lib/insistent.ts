// Insistent reminders in the app (server/src/insistent.ts): the editor dialog (an object's
// "Remind me…", Settings › Reminders' "New reminder…"), the ladder presets it offers, and how a
// rule reads in a line.
import { reactive } from 'vue'
import type { Id } from '@vasta/core'
import type { InsistentRule, LadderStep, NagChannel, RuleInput } from './api.ts'

/** The editor: a new rule (about an object, or about nothing) or one to change. */
export const reminderEditor = reactive<{ open: boolean; objectId?: Id; rule?: InsistentRule; saved?: (rule: InsistentRule | null) => void }>({ open: false })

export function openReminderEditor(options: { objectId?: Id; rule?: InsistentRule; saved?: (rule: InsistentRule | null) => void } = {}) {
  Object.assign(reminderEditor, { open: true, objectId: options.objectId, rule: options.rule, saved: options.saved })
}

export function closeReminderEditor() {
  Object.assign(reminderEditor, { open: false, objectId: undefined, rule: undefined, saved: undefined })
}

export const CHANNELS: { id: NagChannel; label: string; icon: string; hint: string }[] = [
  { id: 'push', label: 'Phone', icon: 'ph:device-mobile', hint: 'Notifications on the phones and browsers that turned them on' },
  { id: 'desktop', label: 'Desktop', icon: 'ph:desktop', hint: 'A notification of the desktop app' },
  { id: 'ntfy', label: 'ntfy', icon: 'ph:bell-ringing', hint: 'Your ntfy topic' },
  { id: 'telegram', label: 'Telegram', icon: 'ph:telegram-logo', hint: 'A message from the bot, with buttons' },
  { id: 'takeover', label: 'Takeover', icon: 'ph:frame-corners', hint: 'The desktop app takes the whole screen until you answer' },
]

export const PRESETS: { id: string; label: string; description: string; repeat: number | null; steps: LadderStep[] }[] = [
  {
    id: 'gentle',
    label: 'Gentle',
    description: 'A notification every 30 minutes, nothing louder.',
    repeat: 30,
    steps: [{ after: 0, channels: ['push', 'desktop', 'ntfy'] }],
  },
  {
    id: 'insistent',
    label: 'Insistent',
    description: 'Every 15 minutes, louder at each step, the screen at 45.',
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
    label: 'Relentless',
    description: 'Every 5 minutes; Telegram at 10, the screen at 15.',
    repeat: 5,
    steps: [
      { after: 0, channels: ['push', 'desktop', 'ntfy'], urgent: true },
      { after: 10, channels: ['push', 'ntfy', 'telegram'], urgent: true },
      { after: 15, channels: ['push', 'ntfy', 'telegram', 'takeover'], urgent: true },
    ],
  },
]

/** The preset a rule's ladder is, if any. */
export function presetOf(rule: Pick<RuleInput, 'repeat' | 'steps'>): string | undefined {
  return PRESETS.find((p) => p.repeat === rule.repeat && JSON.stringify(p.steps) === JSON.stringify(rule.steps))?.id
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function daysText(days: number[] | undefined): string {
  if (!days?.length || days.length === 7) return 'every day'
  if (days.join() === '1,2,3,4,5') return 'on weekdays'
  if (days.join() === '0,6') return 'on weekends'
  return `on ${days.map((d) => WEEKDAYS[d]).join(', ')}`
}

/** "Every day at 09:00", "When I'm first at the computer after 08:00 (by 11:00)". */
export function whenText(rule: Pick<InsistentRule, 'when'>, objectTime?: string): string {
  const when = rule.when
  if (when.kind === 'object') return objectTime ? `At its time, ${objectTime}` : when.before ? `${when.before} min before it starts` : 'When it starts'
  if (when.kind === 'daily') return `${daysText(when.days).replace(/^./, (c) => c.toUpperCase())} at ${when.at}`
  return `At the computer after ${when.after}${when.latest ? ` (by ${when.latest} anyway)` : ''}, ${daysText(when.days)}`
}

export function ladderText(rule: Pick<InsistentRule, 'repeat' | 'steps'>): string {
  const top = rule.steps.at(-1)!
  const last = rule.steps.length > 1 ? `, up to ${top.channels.map((c) => CHANNELS.find((x) => x.id === c)?.label ?? c).join(' + ')} at ${top.after} min` : ''
  return `${rule.repeat ? `Every ${rule.repeat} min` : 'Once per step'}${last}`
}
