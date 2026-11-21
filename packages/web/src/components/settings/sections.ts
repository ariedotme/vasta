// The settings page's sections, in order: the side navigation and each section's heading.
import { t } from '../../lib/i18n.ts'
import { isDesktop, isLocalServer } from '../../lib/platform.ts'

export const SECTIONS = [
  { id: 'device', get label() { return t('settings.section.device') }, icon: 'ph:device-mobile' },
  ...(isDesktop ? [{ id: 'desktop', get label() { return t('settings.section.desktop') }, icon: 'ph:desktop' }] : []),
  { id: 'appearance', get label() { return t('settings.section.appearance') }, icon: 'ph:palette' },
  { id: 'account', get label() { return t('settings.section.account') }, icon: 'ph:user-circle' },
  { id: 'space', get label() { return t('settings.section.space') }, icon: 'ph:planet' },
  // On the desktop app's own server: no other accounts, and the way to a real server.
  isLocalServer()
    ? { id: 'server', get label() { return t('settings.section.server') }, icon: 'ph:hard-drives' }
    : { id: 'server', get label() { return t('settings.section.serverAccounts') }, icon: 'ph:users-three' },
  { id: 'import', get label() { return t('settings.section.import') }, icon: 'ph:download-simple' },
  { id: 'snippets', get label() { return t('settings.section.snippets') }, icon: 'ph:brackets-curly' },
  { id: 'sprints', get label() { return t('settings.section.sprints') }, icon: 'ph:flag-banner' },
  { id: 'inbox', get label() { return t('settings.section.inbox') }, icon: 'ph:tray' },
  { id: 'nutrition', get label() { return t('settings.section.nutrition') }, icon: 'ph:bowl-food' },
  { id: 'reminders', get label() { return t('settings.section.reminders') }, icon: 'ph:bell-ringing' },
  { id: 'reminder-channels', get label() { return t('settings.section.reminderChannels') }, icon: 'ph:bell' },
  { id: 'channels', get label() { return t('settings.section.channels') }, icon: 'ph:broadcast' },
  { id: 'tokens', get label() { return t('settings.section.tokens') }, icon: 'ph:key' },
  { id: 'agents', get label() { return t('settings.section.agents') }, icon: 'ph:robot' },
  { id: 'telegram', get label() { return t('settings.section.telegram') }, icon: 'ph:telegram-logo' },
  { id: 'sessions', get label() { return t('settings.section.sessions') }, icon: 'ph:devices' },
]

export const sectionIcon = (id: string) => SECTIONS.find((s) => s.id === id)?.icon
