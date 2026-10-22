import type { ColorName, Icon } from '@vasta/core'

const COLORS = new Set<ColorName>([
  'gray', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan',
  'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose',
])

/** Capacities uses Tailwind color names, sometimes prefixed ("bg-sky", "text-red"). */
export function toColor(value: unknown): ColorName | undefined {
  if (typeof value !== 'string') return undefined
  const name = value.replace(/^(bg|text|border)-/, '').split('-')[0]
  if (name === 'slate' || name === 'zinc' || name === 'neutral' || name === 'stone') return 'gray'
  return COLORS.has(name as ColorName) ? (name as ColorName) : undefined
}

/** Capacities icons: { type: "iconify", val: "ph-airplay" | "ph:whatsapp-logo" } or { type: "emoji", val: "🏠" }. */
export function toIcon(value: unknown): Icon | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { type, val } = value as { type?: string; val?: unknown }
  if (typeof val !== 'string' || !val) return undefined
  if (type === 'emoji') return { kind: 'emoji', value: val }
  if (type === 'iconify') return { kind: 'icon', value: val.includes(':') ? val : val.replace(/^([a-z0-9]+)-/, '$1:') }
  return undefined
}

export class Warnings {
  readonly counts = new Map<string, number>()
  add(message: string) {
    this.counts.set(message, (this.counts.get(message) ?? 0) + 1)
  }
  toJSON() {
    return Object.fromEntries([...this.counts].sort((a, b) => b[1] - a[1]))
  }
}
