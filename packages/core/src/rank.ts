// Manual order on boards: each card's place is a key that sorts as text (`props.rank`), and a card
// dropped between two others gets a key between theirs, so moving one card writes only that card
// and moves made on two devices merge (equal keys fall back to the ids). Keys use base-62 digits
// and never end in "0", so there is always room between two of them (after rocicorp's
// fractional-indexing).
import type { Id, ObjectSummary } from './model.ts'

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** The prop that holds a card's place (`{ kind: 'rank', value }`), without a property definition. */
export const RANK_PROPERTY_ID = 'rank'

function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0
    while ((a[n] ?? '0') === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const low = a ? DIGITS.indexOf(a[0]!) : 0
  const high = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length
  if (high - low > 1) return DIGITS[Math.round((low + high) / 2)]!
  if (b && b.length > 1) return b.slice(0, 1)
  return DIGITS[low]! + midpoint(a.slice(1), null)
}

/** A key that sorts after `before` and before `after` (either may be missing: the ends). */
export function rankBetween(before?: string, after?: string): string {
  if (before !== undefined && after !== undefined && before >= after) throw new Error(`ranks out of order: ${before} ≥ ${after}`)
  return midpoint(before ?? '', after ?? null)
}

/** `count` keys in order after `before` (or from the start), for cards that had none. */
export function ranksAfter(before: string | undefined, count: number): string[] {
  const keys: string[] = []
  let last = before
  for (let i = 0; i < count; i++) keys.push((last = rankBetween(last)))
  return keys
}

export const rankOf = (object: Pick<ObjectSummary, 'props'>): string | undefined => {
  const value = object.props[RANK_PROPERTY_ID]
  return value?.kind === 'rank' ? value.value : undefined
}

/** Cards in their manual order: ranked ones by key (then id), the others after them as they came. */
export function byRank<T extends Pick<ObjectSummary, 'props'> & { id: Id }>(objects: T[]): T[] {
  const ranked = objects.filter((o) => rankOf(o) !== undefined)
  ranked.sort((a, b) => (rankOf(a)! < rankOf(b)! ? -1 : rankOf(a)! > rankOf(b)! ? 1 : a.id < b.id ? -1 : 1))
  return [...ranked, ...objects.filter((o) => rankOf(o) === undefined)]
}
