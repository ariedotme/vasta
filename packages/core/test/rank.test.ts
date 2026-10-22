import { describe, expect, it } from 'vitest'
import { byRank, rankBetween, ranksAfter, type ObjectSummary } from '../src/index.ts'

describe('board ranks', () => {
  it('makes keys between any two, at either end, forever', () => {
    const first = rankBetween()
    const after = rankBetween(first)
    const before = rankBetween(undefined, first)
    expect(before < first && first < after).toBe(true)
    // Dropping again and again into the same gap keeps finding room.
    let low = first
    let high = after
    for (let i = 0; i < 200; i++) {
      const mid = rankBetween(low, high)
      expect(low < mid && mid < high).toBe(true)
      expect(mid.endsWith('0')).toBe(false)
      if (i % 2) low = mid
      else high = mid
    }
    // And at the top.
    let top = first
    for (let i = 0; i < 100; i++) {
      const next = rankBetween(undefined, top)
      expect(next < top).toBe(true)
      top = next
    }
    expect(() => rankBetween(after, first)).toThrow('out of order')
  })

  it('orders ranked cards by key, then the others as they came', () => {
    const [a, b] = ranksAfter(undefined, 2)
    const card = (id: string, rank?: string) => ({ id, props: rank ? { rank: { kind: 'rank' as const, value: rank } } : {} }) as unknown as ObjectSummary
    expect(byRank([card('x'), card('second', b), card('y'), card('first', a), card('tie', a)]).map((o) => o.id)).toEqual(['first', 'tie', 'second', 'x', 'y'])
  })
})
