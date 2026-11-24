import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { keepsCaretAboveKeyboard, scrollToClear } from './keyboard.ts'

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

type Listener = (...args: unknown[]) => void

class FakeEmitter {
  listeners = new Map<string, Set<Listener>>()
  addEventListener(type: string, fn: Listener) {
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, (set = new Set()))
    set.add(fn)
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn)
  }
  dispatch(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn()
  }
  count() {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }
}

class FakeElement {
  parentElement: FakeElement | null = null
  childNodes: FakeElement[] = []
  isContentEditable = false
  scrollTop = 0
  style: Record<string, string> = { paddingBottom: '' }
  overflowY = 'visible'
  rect = { top: 0, bottom: 0, height: 0 }
  removed = false
  setAttribute(name: string, value: string) {
    if (name === 'style') {
      const match = /top:([\d.-]+)px/.exec(value)
      if (match) this.rect = { top: Number(match[1]), bottom: Number(match[1]), height: 0 }
    }
  }
  getBoundingClientRect() {
    return this.rect
  }
  remove() {
    this.removed = true
  }
}

function setupEnv() {
  const viewport = Object.assign(new FakeEmitter(), {
    width: 390,
    height: 844,
    offsetTop: 0,
    scale: 1,
  })
  const doc = new FakeEmitter()
  const main = new FakeElement()
  main.overflowY = 'auto'
  const editor = new FakeElement()
  editor.isContentEditable = true
  editor.parentElement = main
  editor.rect = { top: 100, bottom: 2000, height: 1900 }

  let range: {
    getBoundingClientRect: () => { top: number; bottom: number; height: number }
    startContainer: FakeElement
    startOffset: number
  } = {
    getBoundingClientRect: () => ({ top: 460, bottom: 480, height: 20 }),
    startContainer: editor,
    startOffset: 0,
  }
  const appended: FakeElement[] = []
  const fakeWindow = {
    visualViewport: viewport,
    innerHeight: 844,
  }
  const fakeDocument = Object.assign(doc, {
    activeElement: editor,
    body: {
      appendChild(el: FakeElement) {
        appended.push(el)
        return el
      },
    },
    createElement: () => new FakeElement(),
    getSelection: () => ({
      rangeCount: 1,
      isCollapsed: true,
      getRangeAt: () => range,
    }),
  })

  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 1
  vi.stubGlobal('Element', FakeElement)
  vi.stubGlobal('HTMLElement', FakeElement)
  vi.stubGlobal('window', fakeWindow)
  vi.stubGlobal('document', fakeDocument)
  vi.stubGlobal('getComputedStyle', (el: FakeElement) => ({ overflowY: el.overflowY }))
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })

  const flushFrame = () => {
    const batch = [...frames.entries()]
    frames.clear()
    for (const [, cb] of batch) cb(0)
  }

  return {
    viewport,
    fakeWindow,
    fakeDocument,
    main,
    editor,
    appended,
    frames,
    flushFrame,
    setRange(next: typeof range) {
      range = next
    },
  }
}

describe('keepsCaretAboveKeyboard', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('does nothing on desktop even when the window shrinks vertically', () => {
    const env = setupEnv()
    const stop = keepsCaretAboveKeyboard(() => false)

    env.viewport.height = 500
    env.viewport.dispatch('resize')
    env.fakeDocument.dispatch('input')
    env.flushFrame()

    expect(env.main.style.paddingBottom).toBe('')
    expect(env.main.scrollTop).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    stop()
  })

  it('pads and scrolls to clear the keyboard, updates padding when keyboard grows, and unpads on close', () => {
    const env = setupEnv()
    const stop = keepsCaretAboveKeyboard(() => true)

    // Keyboard opens (height 344px, visible bottom at 500px); caret at 560px needs 72px scroll.
    env.viewport.height = 500
    env.setRange({
      getBoundingClientRect: () => ({ top: 540, bottom: 560, height: 20 }),
      startContainer: env.editor,
      startOffset: 0,
    })
    env.viewport.dispatch('resize')
    env.flushFrame()

    expect(env.main.style.paddingBottom).toBe('344px')
    expect(env.main.scrollTop).toBe(72)

    // Keyboard grows taller (e.g. emoji/toolbar -> 404px): padding updates instead of staying stale.
    env.viewport.height = 440
    env.viewport.dispatch('resize')
    env.flushFrame()
    expect(env.main.style.paddingBottom).toBe('404px')

    // Keyboard closes: room made for it is removed.
    env.viewport.height = 844
    env.viewport.dispatch('resize')
    env.flushFrame()
    expect(env.main.style.paddingBottom).toBe('')

    stop()
  })

  it('reacts to visualViewport scroll events', () => {
    const env = setupEnv()
    const stop = keepsCaretAboveKeyboard(() => true)

    env.viewport.height = 420
    env.setRange({
      getBoundingClientRect: () => ({ top: 440, bottom: 460, height: 20 }),
      startContainer: env.editor,
      startOffset: 0,
    })
    env.viewport.dispatch('scroll')
    env.flushFrame()

    expect(env.main.scrollTop).toBe(52)
    stop()
  })

  it('uses the child block on an empty line and never falls back to the editor root bottom', () => {
    const env = setupEnv()
    const stop = keepsCaretAboveKeyboard(() => true)
    env.viewport.height = 420

    // Caret on editor root with no child at offset: must NOT jump to editor.rect.bottom (2000).
    env.setRange({
      getBoundingClientRect: () => ({ top: 0, bottom: 0, height: 0 }),
      startContainer: env.editor,
      startOffset: 0,
    })
    env.viewport.dispatch('resize')
    env.flushFrame()
    expect(env.main.scrollTop).toBe(0)

    // Caret on editor root pointing at a child paragraph whose bottom is 460: scrolls to clear it.
    const line = new FakeElement()
    line.rect = { top: 440, bottom: 460, height: 20 }
    env.editor.childNodes = [line]
    env.viewport.dispatch('resize')
    env.flushFrame()
    expect(env.main.scrollTop).toBe(52)

    stop()
  })

  it('keeps detecting the keyboard after rotating to landscape with the keyboard still up', () => {
    const env = setupEnv()
    const stop = keepsCaretAboveKeyboard(() => true)

    // Rotate to landscape (844x390 layout, visual viewport shrunk to 180 by the keyboard).
    env.fakeWindow.innerHeight = 390
    env.viewport.width = 844
    env.viewport.height = 180
    env.setRange({
      getBoundingClientRect: () => ({ top: 200, bottom: 220, height: 20 }),
      startContainer: env.editor,
      startOffset: 0,
    })
    env.viewport.dispatch('resize')
    env.flushFrame()

    expect(env.main.style.paddingBottom).toBe('210px')
    expect(env.main.scrollTop).toBe(52)
    stop()
  })

  it('cleans up listeners, marker, padding, and timers on stop', () => {
    const env = setupEnv()
    const stop = keepsCaretAboveKeyboard(() => true)

    env.viewport.height = 420
    env.fakeDocument.dispatch('input')
    env.flushFrame()
    expect(env.main.style.paddingBottom).toBe('424px')
    expect(env.appended).toHaveLength(1)

    stop()
    expect(env.fakeDocument.count()).toBe(0)
    expect(env.viewport.count()).toBe(0)
    expect(env.main.style.paddingBottom).toBe('')
    expect(env.appended[0]!.removed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
