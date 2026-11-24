import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import type { NavigationFailure, NavigationGuardWithThis, NavigationHookAfter, RouteLocationNormalized, Router } from 'vue-router'
import { keepsScroll } from './scroll-memory.ts'

type Listener = (...args: unknown[]) => void

/** Minimal EventTarget with listener tracking so tests can verify cleanup. */
class FakeTarget {
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

/** Fake `<main>` whose `scrollTop` clamps to `[0, maxScroll]` like a real scroller. */
class FakeMain extends FakeTarget {
  private _scrollTop = 0
  maxScroll = 3000
  get scrollTop() {
    return this._scrollTop
  }
  set scrollTop(value: number) {
    this._scrollTop = Math.max(0, Math.min(value, this.maxScroll))
  }
}

const routeOf = (fullPath: string): RouteLocationNormalized =>
  ({ path: fullPath.split(/[?#]/)[0]!, fullPath }) as RouteLocationNormalized

/** Fake router that mirrors vue-router's history state timing for push vs popstate. */
function makeRouter(initial = '/t/tasks') {
  const before: NavigationGuardWithThis<undefined>[] = []
  const after: NavigationHookAfter[] = []
  const entries = [initial]
  let position = 0
  const state = { position, current: initial }
  const currentRoute = ref(routeOf(initial))

  const router = {
    options: { history: { state } },
    currentRoute,
    beforeEach(guard: NavigationGuardWithThis<undefined>) {
      before.push(guard)
      return () => {
        const at = before.indexOf(guard)
        if (at >= 0) before.splice(at, 1)
      }
    },
    afterEach(hook: NavigationHookAfter) {
      after.push(hook)
      return () => {
        const at = after.indexOf(hook)
        if (at >= 0) after.splice(at, 1)
      }
    },
  } as unknown as Router

  function runHooks(to: RouteLocationNormalized, from: RouteLocationNormalized, failure?: NavigationFailure) {
    if (!failure) {
      for (const guard of before) guard.call(undefined, to, from, () => {})
      currentRoute.value = to
    }
    for (const hook of after) hook(to, from, failure)
  }

  return {
    router,
    push(fullPath: string) {
      const from = currentRoute.value
      const to = routeOf(fullPath)
      // On push, history.state still points at the old entry during beforeEach.
      for (const guard of before) guard.call(undefined, to, from, () => {})
      entries.splice(position + 1)
      entries.push(fullPath)
      position = entries.length - 1
      state.position = position
      state.current = fullPath
      currentRoute.value = to
      for (const hook of after) hook(to, from)
    },
    pop(delta: number, cancelled = false) {
      const from = currentRoute.value
      const targetPosition = position + delta
      const fullPath = entries[targetPosition]!
      const to = routeOf(fullPath)
      if (cancelled) {
        // An earlier guard aborted the navigation before keepsScroll's beforeEach ran.
        runHooks(to, from, {} as NavigationFailure)
        return
      }
      // On popstate, history.state already holds the destination entry during beforeEach.
      position = targetPosition
      state.position = position
      state.current = fullPath
      runHooks(to, from)
    },
  }
}

let fakeWindow: FakeTarget
let frames: Map<number, FrameRequestCallback>
let nextFrameId: number
let now: number
let stops: (() => void)[]

function stepFrame(ms = 16) {
  now += ms
  const batch = [...frames.entries()]
  frames.clear()
  for (const [, cb] of batch) cb(now)
}

beforeEach(() => {
  fakeWindow = new FakeTarget()
  frames = new Map()
  nextFrameId = 1
  now = 0
  stops = []
  vi.stubGlobal('window', fakeWindow)
  vi.stubGlobal('performance', { now: () => now })
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextFrameId++
    frames.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    frames.delete(id)
  })
})

afterEach(() => {
  while (stops.length) stops.pop()!()
  vi.unstubAllGlobals()
})

describe('keepsScroll', () => {
  it('starts a new page at the top and restores the old scroll on Back and Forward', async () => {
    const { router, push, pop } = makeRouter('/t/tasks')
    const main = new FakeMain()
    stops.push(keepsScroll(router, () => main as unknown as HTMLElement))

    main.scrollTop = 1200
    push('/o/task-1')
    await nextTick()
    expect(main.scrollTop).toBe(0)

    main.scrollTop = 450
    pop(-1)
    await nextTick()
    expect(main.scrollTop).toBe(1200)
    expect(frames.size).toBe(0)
    expect(main.count()).toBe(0)
    expect(fakeWindow.count()).toBe(0)

    pop(1)
    await nextTick()
    expect(main.scrollTop).toBe(450)
  })

  it('retries until an async list grows tall enough, then cleans up listeners', async () => {
    const { router, push, pop } = makeRouter('/t/tasks')
    const main = new FakeMain()
    stops.push(keepsScroll(router, () => main as unknown as HTMLElement))

    main.scrollTop = 1200
    push('/o/task-1')
    await nextTick()

    // Returning while the list has not loaded its items yet.
    main.maxScroll = 0
    pop(-1)
    await nextTick()
    expect(main.scrollTop).toBe(0)
    expect(frames.size).toBe(1)

    stepFrame()
    expect(main.scrollTop).toBe(0)
    expect(frames.size).toBe(1)

    // Items arrive and the page becomes tall enough.
    main.maxScroll = 2000
    stepFrame()
    expect(main.scrollTop).toBe(1200)
    expect(frames.size).toBe(0)
    expect(main.count()).toBe(0)
    expect(fakeWindow.count()).toBe(0)
  })

  it('keeps scroll when only the query changes on the same page', async () => {
    const { router, push } = makeRouter('/t/tasks')
    const main = new FakeMain()
    stops.push(keepsScroll(router, () => main as unknown as HTMLElement))

    main.scrollTop = 900
    push('/t/tasks?pane=abc')
    await nextTick()
    expect(main.scrollTop).toBe(900)
  })

  it('ignores cancelled navigations (such as phone Back closing an overlay)', async () => {
    const { router, push, pop } = makeRouter('/t/tasks')
    const main = new FakeMain()
    stops.push(keepsScroll(router, () => main as unknown as HTMLElement))

    main.scrollTop = 800
    push('/o/task-1')
    await nextTick()
    main.scrollTop = 300

    pop(-1, true)
    await nextTick()
    expect(main.scrollTop).toBe(300)
  })

  it('stops restoring as soon as the user touches, scrolls, clicks or presses a key', async () => {
    for (const [target, event] of [
      ['main', 'touchstart'],
      ['main', 'wheel'],
      ['main', 'pointerdown'],
      ['window', 'keydown'],
    ] as const) {
      const { router, push, pop } = makeRouter('/t/tasks')
      const main = new FakeMain()
      const stop = keepsScroll(router, () => main as unknown as HTMLElement)
      stops.push(stop)

      main.scrollTop = 1200
      push('/o/task-1')
      await nextTick()

      main.maxScroll = 0
      pop(-1)
      await nextTick()
      expect(frames.size).toBe(1)

      if (target === 'main') main.dispatch(event)
      else fakeWindow.dispatch(event)

      expect(frames.size).toBe(0)
      expect(main.count()).toBe(0)
      expect(fakeWindow.count()).toBe(0)

      main.maxScroll = 2000
      stepFrame()
      expect(main.scrollTop).toBe(0)
      stop()
    }
  })

  it('gives up after the wait window if the list is shorter than before', async () => {
    const { router, push, pop } = makeRouter('/t/tasks')
    const main = new FakeMain()
    stops.push(keepsScroll(router, () => main as unknown as HTMLElement))

    main.scrollTop = 1200
    push('/o/task-1')
    await nextTick()

    main.maxScroll = 900
    pop(-1)
    await nextTick()
    expect(main.scrollTop).toBe(900)
    expect(frames.size).toBe(1)

    stepFrame(2100)
    expect(frames.size).toBe(0)
    expect(main.count()).toBe(0)
    expect(fakeWindow.count()).toBe(0)
  })

  it('cancels an in-flight restore and removes listeners on teardown', async () => {
    const { router, push, pop } = makeRouter('/t/tasks')
    const main = new FakeMain()
    const stop = keepsScroll(router, () => main as unknown as HTMLElement)

    main.scrollTop = 1200
    push('/o/task-1')
    await nextTick()

    main.maxScroll = 0
    pop(-1)
    await nextTick()
    expect(frames.size).toBe(1)

    stop()
    expect(frames.size).toBe(0)
    expect(main.count()).toBe(0)
    expect(fakeWindow.count()).toBe(0)
  })
})
