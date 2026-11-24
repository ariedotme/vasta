import { describe, expect, it } from 'vitest'
import { scrollToClear } from './keyboard.ts'

describe('scrollToClear', () => {
  it('scrolls a caret behind the keyboard to just above it', () => {
    // The keyboard leaves the top 377px; a caret ending at 478 needs 478 - (377 - 12).
    expect(scrollToClear(478, 377)).toBe(113)
  })

  it('leaves a caret already above the keyboard where it is', () => {
    expect(scrollToClear(300, 377)).toBe(0)
    expect(scrollToClear(365, 377)).toBe(0)
  })

  it('keeps the margin it is given, rounding up to whole pixels', () => {
    expect(scrollToClear(370.2, 377, 0)).toBe(0)
    expect(scrollToClear(377.2, 377, 0)).toBe(1)
  })
})
