// Card presentation helpers for board, gallery, grid and wall views. Each layout keeps its own
// independent CardSettings on the view (board vs cards.gallery / cards.grid / cards.wall).
import type { CardSettings, CardSize, PropertyDef } from '@vasta/core'

export type CardVariant = 'grid' | 'wall' | 'gallery' | 'kanban'

export interface ResolvedCard {
  cover: boolean
  fit: boolean
  preview: boolean
  labels: boolean
  size: CardSize
}

export interface CardFieldOption {
  id: string
  label: string
  icon: string
  def?: PropertyDef
}

export interface CardFieldRow extends CardFieldOption {
  on: boolean
}

/** Effective card appearance for a layout variant, falling back to that variant's defaults. */
export function resolveCard(variant: CardVariant, settings?: CardSettings): ResolvedCard {
  return {
    cover: settings?.cardCover ?? variant !== 'kanban',
    fit: settings?.cardFit ?? false,
    preview: settings?.cardPreview ?? variant !== 'gallery',
    labels: settings?.cardLabels ?? false,
    size: settings?.cardSize ?? 'md',
  }
}

/**
 * Arrange selectable card fields for the menu: in manual mode (`savedIds` defined), ticked fields
 * appear first in their saved order, followed by unticked fields; in automatic mode (`undefined`),
 * all choices appear unchecked in their natural order.
 */
export function cardFieldRows(choices: CardFieldOption[], savedIds: string[] | undefined): CardFieldRow[] {
  if (!savedIds) return choices.map((c) => ({ ...c, on: false }))
  const byId = new Map(choices.map((c) => [c.id, c]))
  const on: CardFieldRow[] = []
  const ticked = new Set<string>()
  for (const id of savedIds) {
    const choice = byId.get(id)
    if (!choice || ticked.has(id)) continue
    ticked.add(id)
    on.push({ ...choice, on: true })
  }
  return [...on, ...choices.filter((c) => !ticked.has(c.id)).map((c) => ({ ...c, on: false }))]
}

/** Toggle a field in `cardFields`, returning the new ordered list of ticked ids. */
export function toggleCardFieldId(choices: CardFieldOption[], savedIds: string[] | undefined, id: string): string[] {
  const valid = new Set(choices.map((c) => c.id))
  const current = (savedIds ?? []).filter((item) => valid.has(item))
  if (current.includes(id)) return current.filter((item) => item !== id)
  return valid.has(id) ? [...current, id] : current
}

/**
 * Merge a `CardSettings` patch into `current`, stripping keys that match the variant's defaults
 * (and `undefined`) so saved settings stay minimal and clean.
 */
export function patchCardSettings<T extends CardSettings>(current: T | undefined, patch: Partial<CardSettings>, variant: CardVariant): T | undefined {
  const defaults = resolveCard(variant)
  const next: Record<string, unknown> = { ...(current ?? {}), ...patch }
  if (next.cardCover === defaults.cover) delete next.cardCover
  if (next.cardFit === defaults.fit) delete next.cardFit
  if (next.cardPreview === defaults.preview) delete next.cardPreview
  if (next.cardLabels === defaults.labels) delete next.cardLabels
  if (next.cardSize === defaults.size) delete next.cardSize
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
  return Object.keys(next).length ? (next as T) : undefined
}
