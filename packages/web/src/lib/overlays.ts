// App-owned dialogs and context menus. The UI never relies on the browser's prompt(), confirm()
// or right-click menu, so it behaves the same in a browser tab and in the desktop app.
import type { ColorName, Icon } from '@vasta/core'
import { reactive, shallowRef } from 'vue'

// ---------------------------------------------------------------------------
// Dialogs

interface PromptRequest {
  kind: 'prompt'
  title: string
  message?: string
  value: string
  placeholder?: string
  confirmLabel: string
  /** The text may be left empty (an optional note). */
  optional?: boolean
  resolve: (value: string | null) => void
}

interface ConfirmRequest {
  kind: 'confirm'
  title: string
  message?: string
  confirmLabel: string
  danger: boolean
  /** Text the user must type before the button works (e.g. the name of what gets deleted). */
  requireText?: string
  resolve: (ok: boolean) => void
}

interface ChoiceRequest {
  kind: 'choice'
  title: string
  message?: string
  choices: { value: string; label: string; danger?: boolean }[]
  resolve: (value: string | null) => void
}

/** A template's questions (core's TemplateAsk), all in one dialog; each may be left empty. */
interface AsksRequest {
  kind: 'asks'
  title: string
  message?: string
  fields: { label: string; options?: string[] }[]
  confirmLabel: string
  resolve: (answers: Record<string, string> | null) => void
}

export type DialogRequest = PromptRequest | ConfirmRequest | ChoiceRequest | AsksRequest

export const activeDialog = shallowRef<DialogRequest | null>(null)

/** A new dialog replaces the open one, which counts as cancelled. */
function cancelActiveDialog() {
  const current = activeDialog.value
  if (current?.kind === 'prompt' || current?.kind === 'choice' || current?.kind === 'asks') current.resolve(null)
  else if (current?.kind === 'confirm') current.resolve(false)
}

/** Ask for a line of text. Resolves to the trimmed text, or null when cancelled or empty ('' when `optional`). */
export function promptDialog(options: { title: string; message?: string; value?: string; placeholder?: string; confirmLabel?: string; optional?: boolean }) {
  return new Promise<string | null>((resolve) => {
    cancelActiveDialog()
    activeDialog.value = {
      kind: 'prompt',
      title: options.title,
      message: options.message,
      value: options.value ?? '',
      placeholder: options.placeholder,
      confirmLabel: options.confirmLabel ?? 'OK',
      ...(options.optional ? { optional: true } : {}),
      resolve: (value) => {
        activeDialog.value = null
        resolve(value?.trim() ? value.trim() : value !== null && options.optional ? '' : null)
      },
    }
  })
}

export function confirmDialog(options: { title: string; message?: string; confirmLabel?: string; danger?: boolean; requireText?: string }) {
  return new Promise<boolean>((resolve) => {
    cancelActiveDialog()
    activeDialog.value = {
      kind: 'confirm',
      title: options.title,
      message: options.message,
      confirmLabel: options.confirmLabel ?? 'OK',
      danger: options.danger ?? false,
      ...(options.requireText ? { requireText: options.requireText } : {}),
      resolve: (ok) => {
        activeDialog.value = null
        resolve(ok)
      },
    }
  })
}

/** Ask to pick one of a few answers, shown as buttons in this order. Resolves to its value, or null when cancelled. */
export function choiceDialog<T extends string>(options: { title: string; message?: string; choices: { value: T; label: string; danger?: boolean }[] }) {
  return new Promise<T | null>((resolve) => {
    cancelActiveDialog()
    activeDialog.value = {
      kind: 'choice',
      title: options.title,
      message: options.message,
      choices: options.choices,
      resolve: (value) => {
        activeDialog.value = null
        resolve(value as T | null)
      },
    }
  })
}

/** Ask a template's questions, in order. Resolves to the answers by label (trimmed), or null when cancelled. */
export function asksDialog(options: { title: string; message?: string; fields: { label: string; options?: string[] }[]; confirmLabel?: string }) {
  return new Promise<Record<string, string> | null>((resolve) => {
    cancelActiveDialog()
    activeDialog.value = {
      kind: 'asks',
      title: options.title,
      message: options.message,
      fields: options.fields,
      confirmLabel: options.confirmLabel ?? 'Create',
      resolve: (answers) => {
        activeDialog.value = null
        resolve(answers && Object.fromEntries(Object.entries(answers).map(([label, value]) => [label, value.trim()])))
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Context menus

export type MenuItem =
  | {
      kind?: 'action'
      label: string
      /** An Iconify name, or an icon of the user's (a section's emoji). */
      icon?: string | Icon
      danger?: boolean
      disabled?: boolean
      hint?: string
      /** Shown as a checkbox at the end of the row. */
      checked?: boolean
      /** The menu stays open after running, and a checkbox flips (several boxes in a row). */
      keepOpen?: boolean
      run: () => unknown
    }
  | { kind: 'separator' }
  /** A row that opens its items beside the menu (on hover, a click, or the right arrow key). */
  | { kind: 'submenu'; label: string; icon?: string | Icon; items: MenuItem[] }
  | { kind: 'heading'; label: string }
  /** A row of palette swatches (null = none), shown as text in that color or as a tinted square. */
  | { kind: 'colors'; label: string; sample: 'text' | 'background'; current?: ColorName | null; pick: (color: ColorName | null) => unknown }

export const contextMenu = reactive({
  open: false,
  x: 0,
  y: 0,
  items: [] as MenuItem[],
})

/** Show our menu at the pointer instead of the native one. */
export function openContextMenu(event: MouseEvent, items: MenuItem[]) {
  event.preventDefault()
  event.stopPropagation()
  openMenuAt(event.clientX, event.clientY, items)
}

/** Show the menu at a point on screen (e.g. below the cursor in the editor). */
export function openMenuAt(x: number, y: number, items: MenuItem[]) {
  contextMenu.items = items
  contextMenu.x = x
  contextMenu.y = y
  contextMenu.open = true
}

export function closeContextMenu() {
  contextMenu.open = false
}
