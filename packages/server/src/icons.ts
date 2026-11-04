// Icons agents may give objects: an emoji, or a Phosphor icon by its Iconify name ("ph:star"), the
// set the app's icon picker offers. Names are checked against the full set from @iconify-json/ph,
// read once when first needed; where it cannot be read (the desktop app's one-file server), any
// well-formed name is taken.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Icon } from '@vasta/core'

/** A few common icons, for the tools' descriptions and the CLI's help. */
export const COMMON_ICONS = ['ph:star', 'ph:heart', 'ph:bookmark', 'ph:book-open', 'ph:lightbulb', 'ph:flag', 'ph:tag', 'ph:folder', 'ph:briefcase', 'ph:house', 'ph:code', 'ph:music-notes', 'ph:camera', 'ph:airplane', 'ph:coffee', 'ph:leaf', 'ph:rocket', 'ph:target']

export const ICON_HELP = `an emoji ("📚") or a Phosphor icon as ph:<name>, e.g. ${COMMON_ICONS.join(', ')}; weights as ph:<name>-fill, -bold, -duotone, -light or -thin. Every name: https://phosphoricons.com`

let names: Set<string> | null | undefined

function phosphorNames(): Set<string> | null {
  if (names === undefined) {
    try {
      const set = JSON.parse(readFileSync(createRequire(import.meta.url).resolve('@iconify-json/ph/icons.json'), 'utf8')) as { icons: Record<string, unknown>; aliases?: Record<string, unknown> }
      names = new Set([...Object.keys(set.icons), ...Object.keys(set.aliases ?? {})])
    } catch {
      names = null
    }
  }
  return names
}

/** The Icon a text names, or why it names none. */
export function parseIcon(text: string): Icon | { error: string } {
  const value = text.trim()
  const name = /^(?:ph:)?([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(value)?.[1]
  if (name) {
    const known = phosphorNames()
    if (known && !known.has(name)) return { error: `unknown icon "${value}": use ${ICON_HELP}` }
    return { kind: 'icon', value: `ph:${name}` }
  }
  if (value.length <= 16 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value) && !/[\p{L}\s]/u.test(value)) return { kind: 'emoji', value }
  return { error: `"${value}" is not an icon: use ${ICON_HELP}` }
}
