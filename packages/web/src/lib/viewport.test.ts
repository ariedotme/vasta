import { describe, expect, it } from 'vitest'
import { startsDrawerSwipe } from './viewport.ts'

describe('startsDrawerSwipe', () => {
  it('opens the drawer from the left edge in the installed app', () => {
    expect(startsDrawerSwipe(4, true)).toBe(true)
    expect(startsDrawerSwipe(23, true)).toBe(true)
  })

  it('not away from the edge', () => {
    expect(startsDrawerSwipe(24, true)).toBe(false)
    expect(startsDrawerSwipe(200, true)).toBe(false)
  })

  it("not in a browser tab, where the edge swipe is the browser's Back", () => {
    expect(startsDrawerSwipe(4, false)).toBe(false)
  })
})
