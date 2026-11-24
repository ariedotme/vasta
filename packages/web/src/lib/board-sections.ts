// Pure helpers for ordering and collapsing board sections (columns and swimlanes).

/** Matches `NO_VALUE` in lib/query.ts so new sections land before an unplaced "No value" group. */
const NO_VALUE = '__none__'

/**
 * Arrange `groups` by a saved order of keys. Unknown keys are ignored; new groups (e.g. a newly
 * created tag) are appended at the end — right before a trailing `NO_VALUE` group, unless the user
 * explicitly placed `NO_VALUE` elsewhere. When `fixed` is true (date buckets), returns `groups`.
 */
export function orderGroups<T extends { key: string }>(groups: T[], savedOrder: string[] | undefined, fixed = false): T[] {
  if (fixed || !savedOrder?.length || groups.length < 2) return groups
  const byKey = new Map(groups.map((g) => [g.key, g]))
  const saved: T[] = []
  const seen = new Set<string>()
  for (const key of savedOrder) {
    const group = byKey.get(key)
    if (!group || seen.has(key)) continue
    seen.add(key)
    saved.push(group)
  }
  const unseen = groups.filter((g) => !seen.has(g.key))
  if (!unseen.length) return saved
  // Keep a trailing NO_VALUE at the very end when new groups appear.
  if (saved.at(-1)?.key === NO_VALUE) return [...saved.slice(0, -1), ...unseen, saved.at(-1)!]
  const noValue = unseen.find((g) => g.key === NO_VALUE)
  if (!noValue) return [...saved, ...unseen]
  return [...saved, ...unseen.filter((g) => g.key !== NO_VALUE), noValue]
}

/**
 * Move `key` to `toIndex` among `keys`. Returns the new order, or `undefined` when unchanged.
 */
export function moveKey(keys: string[], key: string, toIndex: number): string[] | undefined {
  const from = keys.indexOf(key)
  if (from < 0) return undefined
  const clamped = Math.max(0, Math.min(toIndex, keys.length - 1))
  if (clamped === from) return undefined
  const next = [...keys]
  next.splice(clamped, 0, ...next.splice(from, 1))
  return next
}

/** Shift `key` one step backward (-1) or forward (+1) in `keys`. */
export function shiftKey(keys: string[], key: string, delta: -1 | 1): string[] | undefined {
  const from = keys.indexOf(key)
  if (from < 0) return undefined
  return moveKey(keys, key, from + delta)
}

/** Toggle `key` in a saved list of collapsed keys; returns `undefined` when none remain. */
export function toggleKey(current: string[] | undefined, key: string): string[] | undefined {
  const set = new Set(current ?? [])
  if (set.has(key)) set.delete(key)
  else set.add(key)
  return set.size ? [...set] : undefined
}
