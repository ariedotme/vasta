// The app's keyboard shortcuts, in one place: the handler installed by App.vue, the list the
// shortcuts dialog (⌘/) shows, and the hints in the sidebar and ⌘K. ⌘1–3 (the sidebar's top rows,
// in order) and ⌘D (today, "day") work while typing too; "G then a letter" (as in Linear or GitHub)
// only outside text fields, and also in a browser tab, where ⌘1–3 switch tabs; so does Esc for the
// side pane. ⌘K lives in CommandPalette, the desktop app's ⌘[ ⌘] ⌘, in platform.ts.
import { router } from '../router.ts'
import { openToday } from './actions.ts'
import { closePane, paneObjectId } from './open.ts'
import { systemType, ui, workspace } from './state.ts'

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
/** ⌘ on macOS, Ctrl elsewhere. */
export const mod = isMac ? '⌘' : 'Ctrl+'

export interface Shortcut {
  id: string
  label: string
  /** As shown: [`${mod}1`], or ['G', 'T'] for a sequence. */
  keys: string[]
  /** Another way to press it, shown after "or". */
  alt?: string[]
}

export const GO: Record<'today' | 'inbox' | 'calendar' | 'tasks', { path?: string; run: () => unknown }> = {
  today: { run: () => openToday() },
  inbox: { path: '/inbox', run: () => router.push('/inbox') },
  calendar: { path: '/calendar', run: () => router.push('/calendar') },
  tasks: { run: () => systemType('task') && router.push(`/t/${systemType('task')!.id}`) },
}

export const SHORTCUTS: { group: string; items: Shortcut[] }[] = [
  {
    group: 'Go to',
    items: [
      { id: 'calendar', label: 'Calendar', keys: [`${mod}1`], alt: ['G', 'C'] },
      { id: 'inbox', label: 'Inbox', keys: [`${mod}2`], alt: ['G', 'I'] },
      { id: 'tasks', label: 'Tasks', keys: [`${mod}3`], alt: ['G', 'K'] },
      { id: 'today', label: 'Today and its daily note', keys: [`${mod}D`], alt: ['G', 'T'] },
      { id: 'settings', label: 'Settings', keys: [`${mod},`], alt: ['G', 'S'] },
      { id: 'back', label: 'Back', keys: [`${mod}[`] },
      { id: 'forward', label: 'Forward', keys: [`${mod}]`] },
    ],
  },
  {
    group: 'App',
    items: [
      { id: 'search', label: 'Search or create', keys: [`${mod}K`] },
      { id: 'sidebar', label: 'Show or hide the sidebar', keys: [`${mod}\\`] },
      { id: 'pane', label: 'Close the side pane', keys: ['Esc'] },
      { id: 'shortcuts', label: 'Keyboard shortcuts', keys: [`${mod}/`] },
    ],
  },
  {
    group: 'In a note',
    items: [
      { id: 'blocks', label: 'Insert a block', keys: ['/'] },
      { id: 'mention', label: 'Link an object', keys: ['@'] },
      { id: 'select', label: 'Select blocks', keys: ['Esc'] },
      { id: 'indent', label: 'Nest under the line above (in a toggle)', keys: ['Tab'] },
      { id: 'outdent', label: 'Take out of the toggle', keys: ['⇧Tab'] },
      { id: 'bold', label: 'Bold, italic, underline', keys: [`${mod}B`, `${mod}I`, `${mod}U`] },
    ],
  },
]

/** The keys of a shortcut by id, for hints next to what it opens. */
export const keysOf = (id: string) => SHORTCUTS.flatMap((g) => g.items).find((s) => s.id === id)?.keys.join(' ') ?? ''

const typing = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"]')

/** A dialog, menu or the palette is open: plain-letter sequences stay out of its way. */
const overlayOpen = () => ui.paletteOpen || ui.captureOpen || ui.passwordOpen || !!document.querySelector('[role=dialog], [role=menu], [data-overlay]')

let pendingG = 0

function onKey(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || !workspace.ready) return
  const command = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (command && !event.altKey && !event.shiftKey) {
    const run = ({ Digit1: GO.calendar.run, Digit2: GO.inbox.run, Digit3: GO.tasks.run, KeyD: GO.today.run, Backslash: toggleSidebar, Slash: () => (ui.shortcutsOpen = !ui.shortcutsOpen) } as Record<string, () => unknown>)[event.code]
    if (!run) return
    event.preventDefault()
    void run()
    return
  }
  if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target) || overlayOpen()) return
  // Esc while typing stays with the editor (it selects blocks there).
  if (event.key === 'Escape' && paneObjectId.value) {
    event.preventDefault()
    void closePane()
    return
  }
  const key = event.key.toLowerCase()
  if (key === 'g' && !event.shiftKey) {
    pendingG = Date.now()
    return
  }
  if (Date.now() - pendingG > 1200) return
  pendingG = 0
  const run = ({ t: GO.today.run, i: GO.inbox.run, c: GO.calendar.run, k: GO.tasks.run, s: () => router.push('/settings') } as Record<string, () => unknown>)[key]
  if (!run) return
  event.preventDefault()
  void run()
}

export function toggleSidebar() {
  ui.sidebarCollapsed = !ui.sidebarCollapsed
}

export function installShortcuts() {
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}
