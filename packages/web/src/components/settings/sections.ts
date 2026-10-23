// The settings page's sections, in order: the side navigation and each section's heading.
import { isDesktop, isLocalServer } from '../../lib/platform.ts'

export const SECTIONS = [
  { id: 'device', label: 'This device', icon: 'ph:device-mobile' },
  ...(isDesktop ? [{ id: 'desktop', label: 'Desktop app', icon: 'ph:desktop' }] : []),
  { id: 'appearance', label: 'Appearance', icon: 'ph:palette' },
  { id: 'account', label: 'Account', icon: 'ph:user-circle' },
  { id: 'space', label: 'Space', icon: 'ph:planet' },
  // On the desktop app's own server: no other accounts, and the way to a real server.
  isLocalServer() ? { id: 'server', label: 'Server', icon: 'ph:hard-drives' } : { id: 'server', label: 'Server accounts', icon: 'ph:users-three' },
  { id: 'snippets', label: 'Snippets', icon: 'ph:brackets-curly' },
  { id: 'sprints', label: 'Sprints', icon: 'ph:flag-banner' },
  { id: 'inbox', label: 'Inbox', icon: 'ph:tray' },
  { id: 'nutrition', label: 'Food tracking', icon: 'ph:bowl-food' },
  { id: 'reminders', label: 'Reminders', icon: 'ph:bell' },
  { id: 'channels', label: 'Capture channels', icon: 'ph:broadcast' },
  { id: 'tokens', label: 'Capture tokens', icon: 'ph:key' },
  { id: 'telegram', label: 'Telegram', icon: 'ph:telegram-logo' },
  { id: 'sessions', label: 'Sessions', icon: 'ph:devices' },
]

export const sectionIcon = (id: string) => SECTIONS.find((s) => s.id === id)?.icon
