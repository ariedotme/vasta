import { describe, expect, it } from 'vitest'
import { moveKey, orderGroups, shiftKey, toggleKey } from './board-sections.ts'

const groups = (...keys: string[]) => keys.map((key) => ({ key }))

describe('orderGroups', () => {
  it('applies a saved order and ignores removed keys', () => {
    const result = orderGroups(groups('a', 'b', 'c'), ['deleted', 'c', 'a', 'b'])
    expect(result.map((g) => g.key)).toEqual(['c', 'a', 'b'])
  })

  it('places newly created groups before a trailing NO_VALUE group', () => {
    const result = orderGroups(groups('a', 'b', 'new', '__none__'), ['b', 'a', '__none__'])
    expect(result.map((g) => g.key)).toEqual(['b', 'a', 'new', '__none__'])
  })

  it('respects an explicit NO_VALUE position when the user moved it out of the end', () => {
    const result = orderGroups(groups('a', 'b', 'new', '__none__'), ['__none__', 'b', 'a'])
    expect(result.map((g) => g.key)).toEqual(['__none__', 'b', 'a', 'new'])
  })

  it('puts an unseen NO_VALUE at the very end after other new groups', () => {
    const result = orderGroups(groups('a', '__none__', 'new', 'b'), ['b', 'a'])
    expect(result.map((g) => g.key)).toEqual(['b', 'a', 'new', '__none__'])
  })

  it('deduplicates keys in savedOrder', () => {
    const result = orderGroups(groups('a', 'b', 'c'), ['b', 'b', 'a'])
    expect(result.map((g) => g.key)).toEqual(['b', 'a', 'c'])
  })

  it('keeps natural order when fixed (date fields) or when no saved order exists', () => {
    expect(orderGroups(groups('overdue', 'today', 'later'), ['later', 'today', 'overdue'], true).map((g) => g.key)).toEqual(['overdue', 'today', 'later'])
    expect(orderGroups(groups('a', 'b'), undefined).map((g) => g.key)).toEqual(['a', 'b'])
  })
})

describe('moveKey and shiftKey', () => {
  it('moves a key to another position and returns undefined on no-op or missing key', () => {
    expect(moveKey(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(moveKey(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a'])
    expect(moveKey(['a', 'b', 'c'], 'b', 1)).toBeUndefined()
    expect(moveKey(['a', 'b', 'c'], 'z', 0)).toBeUndefined()
  })

  it('shifts a key one step backward or forward and stops at the ends', () => {
    expect(shiftKey(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(shiftKey(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(shiftKey(['a', 'b', 'c'], 'a', -1)).toBeUndefined()
    expect(shiftKey(['a', 'b', 'c'], 'c', 1)).toBeUndefined()
  })
})

describe('toggleKey', () => {
  it('adds and removes keys, returning undefined when the last key is removed', () => {
    expect(toggleKey(undefined, 'a')).toEqual(['a'])
    expect(toggleKey(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleKey(['a', 'b'], 'a')).toEqual(['b'])
    expect(toggleKey(['b'], 'b')).toBeUndefined()
  })
})
