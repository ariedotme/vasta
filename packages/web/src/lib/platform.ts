// Running inside the desktop app (packages/desktop)? The app gives the server's pages six commands
// (set_shortcut, capture_result, capture_suggestions, update_app, set_notify_token, notify); it asks the web app for things by
// dispatching DOM events on window (vasta:capture, vasta:today, vasta:settings; vasta:capture-text
// and vasta:capture-suggest from the floating capture panel), or, when the window was not showing the web app yet, by opening it with a query
// (/?capture, /?today, /?settings). What the page knows about the app comes from an initialization script
// (window.__VASTA_DESKTOP__, set again with a vasta:desktop event when it changes).
import { computed, ref } from 'vue'
import { foodCommand, type ObjectSummary } from '@vasta/core'
import { router } from '../router.ts'
import { captureSpace, captureText, completionSource, dayKey, openToday, typesOf } from './actions.ts'
import { authApi } from './api.ts'
import { foodSourcesOf, previewFoodLine } from './nutrition.ts'
import { meId, people } from './people.ts'
import { ui, workspace } from './state.ts'
import { complete, previewLine, typedLine } from './typed-line.ts'

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const isMac = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')

export interface DesktopInfo {
  version: string
  /** The quick capture shortcut, in Tauri's accelerator syntax (CommandOrControl+Shift+Space). */
  shortcut: string
  /** Where the app checks for updates (<server>/desktop/latest.json). */
  updates: string | null
  /** The app takes set_shortcut from this page (0.1.3 and later). */
  setShortcut?: boolean
  /** The app takes update_app: a newer desktop version, else a reload (0.1.8 and later). */
  updateApp?: boolean
  /** macOS: the window has no title bar, its buttons sit over the page's top-left corner (0.1.9 and later). */
  overlayTitleBar?: boolean
  /** The app takes notify: reminders as system notifications (0.1.10 and later). */
  notify?: boolean
  /** The app hears reminders on its own, with a token from set_notify_token (0.1.11 and later). */
  notifyStream?: boolean
  /** It has that token. */
  notifyToken?: boolean
  /** This install, as its token is named ("Mac 3f2a"). */
  device?: string
}

/** A reminder the server sends to the desktop app (server/src/events.ts). */
export interface DesktopNotification {
  key: string
  title: string
  message: string
  url?: string
}

let providing = false

/**
 * Give the desktop app (0.1.11 and later) a token of its own to hear the user's reminders with,
 * when it has none: its own connection lasts with the window closed, the page's does not.
 */
export async function provideNotifyToken() {
  const info = window.__VASTA_DESKTOP__
  if (!info?.notifyStream || info.notifyToken || !info.device || providing) return
  providing = true
  try {
    const { token } = await authApi.desktopToken(info.device)
    await window.__TAURI_INTERNALS__?.invoke('set_notify_token', { token })
  } catch (failure) {
    console.warn('Could not give the desktop app its notification token:', failure)
  } finally {
    providing = false
  }
}

/** Logging out: the desktop app stops hearing this user's reminders. */
export function forgetNotifyToken() {
  if (window.__VASTA_DESKTOP__?.notifyToken) void window.__TAURI_INTERNALS__?.invoke('set_notify_token', { token: '' }).catch(() => {})
}

/**
 * Show a reminder as a system notification (desktop 0.1.10, which hears them through the page). The app shows each key
 * once, so a second window listening too does not repeat it; clicking it opens `url`'s page.
 */
export async function notifyDesktop(notification: DesktopNotification) {
  const path = notification.url ? new URL(notification.url, location.href).pathname.replace(/^\//, '') : ''
  await window.__TAURI_INTERNALS__?.invoke('notify', { key: notification.key, title: notification.title, body: notification.message, path }).catch(() => {})
}

declare global {
  interface Window {
    __VASTA_DESKTOP__?: DesktopInfo
    __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> }
  }
}

/** The desktop app's version and settings; null in a browser (or an app older than 0.1.2). */
export const desktop = ref<DesktopInfo | null>(typeof window === 'undefined' ? null : (window.__VASTA_DESKTOP__ ?? null))
if (typeof window !== 'undefined') window.addEventListener('vasta:desktop', () => (desktop.value = window.__VASTA_DESKTOP__ ?? null))

// A full-screen window has no traffic lights (they come back with the menu bar, over it).
const fullScreen = ref(false)
if (typeof window !== 'undefined') {
  const measure = () => (fullScreen.value = innerWidth === screen.width && innerHeight === screen.height)
  measure()
  window.addEventListener('resize', measure)
}

/**
 * The macOS window's close, minimize and zoom buttons sit over the top-left corner: the bar there
 * leaves them room, and the top bars move the window (data-tauri-drag-region="deep").
 */
export const trafficLights = computed(() => !!desktop.value?.overlayTitleBar && !fullScreen.value)

const MAC_MODIFIERS: Record<string, string> = { control: '⌃', ctrl: '⌃', alt: '⌥', option: '⌥', shift: '⇧', command: '⌘', cmd: '⌘', super: '⌘', meta: '⌘', commandorcontrol: '⌘', cmdorctrl: '⌘' }
const OTHER_MODIFIERS: Record<string, string> = { control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift', command: 'Super', cmd: 'Super', super: 'Super', meta: 'Super', commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl' }

/** An accelerator as the platform writes it: ⌃⌥⇧⌘Space on macOS, Ctrl+Shift+Space elsewhere. */
export function formatShortcut(accelerator: string, mac = isMac): string {
  const names = mac ? MAC_MODIFIERS : OTHER_MODIFIERS
  const parts = accelerator.split('+')
  const key = (parts.pop() ?? '').replace(/^(Key|Digit)/, '')
  const modifiers = parts.map((part) => names[part.toLowerCase()] ?? part)
  if (!mac) return [...modifiers, key].join('+')
  const order = ['⌃', '⌥', '⇧', '⌘']
  return modifiers.sort((a, b) => order.indexOf(a) - order.indexOf(b)).join('') + key
}

/**
 * A keydown as an accelerator (codes as in KeyboardEvent.code, which Tauri's parser takes), or
 * only the modifiers held so far (`complete` false; formatShortcut shows them alone).
 */
export function recordShortcut(event: KeyboardEvent): { accelerator: string; complete: boolean; modifiers: string[] } {
  const modifiers = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && (isMac ? 'Command' : 'Super')].filter((m) => !!m) as string[]
  const complete = !/^(Shift|Control|Alt|Meta|OS)(Left|Right)?$/.test(event.code)
  return { accelerator: [...modifiers, complete ? event.code : ''].join('+'), complete, modifiers }
}

/**
 * Load a newer build: in the desktop app (0.1.8 and later) it offers a newer version of itself
 * first (its "Install and Restart" dialog) and reloads the window when there is none; elsewhere,
 * a reload.
 */
export function updateApp() {
  if (window.__VASTA_DESKTOP__?.updateApp) void window.__TAURI_INTERNALS__?.invoke('update_app')
  else location.reload()
}

/** Ask the desktop app to use another quick capture shortcut ('' for the default); rejects with its reason. */
export async function setShortcut(accelerator: string): Promise<string> {
  return (await window.__TAURI_INTERNALS__!.invoke('set_shortcut', { shortcut: accelerator })) as string
}

/** Set while Settings records a new shortcut: pressing the current one then only says so. */
export const recording: { onCurrentShortcut: (() => void) | null } = { onCurrentShortcut: null }

const ACTIONS: Record<string, () => unknown> = {
  capture: () => (recording.onCurrentShortcut ? recording.onCurrentShortcut() : (ui.captureOpen = true)),
  today: () => openToday(),
  settings: () => router.push('/settings'),
}

/** What a browser’s toolbar would do: back, forward and reload (the app window has none); and Settings. */
function browserKeys(event: KeyboardEvent) {
  const command = isMac ? event.metaKey : event.ctrlKey
  if (!command || event.shiftKey || event.altKey || event.defaultPrevented) return
  // ⌘, on macOS comes from the app's menu; Windows and Linux windows have none.
  const run = { '[': () => history.back(), ']': () => history.forward(), r: () => location.reload(), ',': ACTIONS.settings! }[event.key.toLowerCase()]
  if (!run) return
  event.preventDefault()
  run()
}

/** The capture space's foods while the panel is open with a line of food (loaded once per line). */
let panelFoods: ObjectSummary[] | undefined

/** The floating capture panel's text: captured here (online or on the replica), answered to the app. */
async function captureFromPanel(text: string) {
  panelFoods = undefined
  const answer = (ok: boolean, message: string | null = null) => window.__TAURI_INTERNALS__?.invoke('capture_result', { ok, message })
  try {
    await captureText(text, 'desktop')
    await answer(true)
  } catch (failure) {
    await answer(false, failure instanceof Error ? failure.message : String(failure))
  }
}

/**
 * What the capture panel should offer at its cursor (desktop 0.1.7): the same list and preview
 * as the Quick capture dialog, answered through the app (capture_suggestions) with the request's
 * `seq`, so the panel can drop answers to older keystrokes. Icons go as emoji only (the panel has
 * no icon set).
 */
async function suggestForPanel(request: { text: string; cursor: number; seq: number }) {
  const space = captureSpace()
  if (!space) return
  const types = await typesOf(space)
  const items = await complete(request.text, request.cursor, completionSource(space.id, types)).catch(() => [])
  const typed = typedLine(types, request.text)
  const eaten = foodCommand(request.text)
  let preview: string | null = null
  let problem: string | null = null
  if (eaten !== undefined) {
    panelFoods ??= await foodSourcesOf(types).catch(() => [])
    const line = previewFoodLine(eaten, space, panelFoods, dayKey())
    preview = line.text
    problem = line.problem ?? null
  } else if (typed) {
    const line = previewLine(typed.type, typed.rest, dayKey(), space.id === workspace.space?.id ? people.list : [], meId())
    preview = `New ${typed.type.name}${line.title ? ` “${line.title}”` : ''}${line.parts.length ? ` · ${line.parts.join(', ')}` : ''}, in today’s note in ${space.name}.`
    if (line.errors.length) problem = `Cannot read ${line.errors.join('; ')}; it stays in the title.`
    else if (!line.parts.length && line.properties.length) preview += ` name:value sets ${line.properties.join(', ')}.`
  }
  const answer = {
    seq: request.seq,
    items: items.map((item) => ({ label: item.label, detail: item.detail ?? null, emoji: item.icon?.kind === 'emoji' ? item.icon.value : null, text: item.text, cursor: item.cursor })),
    preview,
    problem,
  }
  await window.__TAURI_INTERNALS__?.invoke('capture_suggestions', { answer })
}

/** Listen for the desktop app's requests; call once the workspace is loaded. */
export function listenToDesktop() {
  if (!isDesktop) return
  window.addEventListener('keydown', browserKeys)
  for (const [name, run] of Object.entries(ACTIONS)) window.addEventListener(`vasta:${name}`, () => void run())
  // Desktop 0.1.3 sends this instead of vasta:capture whenever the window shows /settings.
  window.addEventListener('vasta:current-shortcut', () => void ACTIONS.capture!())
  window.addEventListener('vasta:capture-text', (event) => void captureFromPanel((event as CustomEvent<string>).detail))
  window.addEventListener('vasta:capture-suggest', (event) => void suggestForPanel((event as CustomEvent<{ text: string; cursor: number; seq: number }>).detail).catch(() => {}))
  const params = new URLSearchParams(location.search)
  const asked = Object.keys(ACTIONS).find((name) => params.has(name))
  if (!asked) return
  params.delete(asked)
  history.replaceState(history.state, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`)
  void ACTIONS[asked]!()
}
