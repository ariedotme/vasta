import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope, type Ref } from 'vue'
import { closeTopLayer, closesOnBack } from './back.ts'

const scopes: EffectScope[] = []
/** A component's setup: `closesOnBack` inside a scope that ends with it. */
function layer(open: Ref<boolean>, close: () => void) {
  const scope = effectScope()
  scopes.push(scope)
  scope.run(() => closesOnBack(open, close))
  return scope
}
afterEach(() => {
  while (scopes.length) scopes.pop()!.stop()
})

describe('closesOnBack and closeTopLayer', () => {
  it('has nothing to close when no layer is open, so Back changes the page', () => {
    expect(closeTopLayer()).toBe(false)
  })

  it('closes the layer that is open, once, and not the page', () => {
    const close = vi.fn()
    layer(ref(true), close)
    expect(closeTopLayer()).toBe(true)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the last opened first', async () => {
    const closed: string[] = []
    const sheet = ref(true)
    const dialog = ref(false)
    layer(sheet, () => ((sheet.value = false), closed.push('sheet')))
    layer(dialog, () => ((dialog.value = false), closed.push('dialog')))
    dialog.value = true
    await nextTick()
    closeTopLayer()
    await nextTick()
    closeTopLayer()
    await nextTick()
    expect(closed).toEqual(['dialog', 'sheet'])
    expect(closeTopLayer()).toBe(false)
  })

  it('a layer that stays open stays on top and keeps the page too (a save in flight)', () => {
    const stays = vi.fn()
    layer(ref(true), stays)
    expect(closeTopLayer()).toBe(true)
    expect(closeTopLayer()).toBe(true)
    expect(stays).toHaveBeenCalledTimes(2)
  })

  it('forgets a layer once it is closed', async () => {
    const open = ref(true)
    const close = vi.fn()
    layer(open, close)
    open.value = false
    await nextTick()
    expect(closeTopLayer()).toBe(false)
    expect(close).not.toHaveBeenCalled()
    // ... and takes it again when it reopens, on top of the others.
    open.value = true
    await nextTick()
    expect(closeTopLayer()).toBe(true)
  })

  it('forgets a layer whose component is gone', () => {
    const close = vi.fn()
    layer(ref(true), close).stop()
    expect(closeTopLayer()).toBe(false)
    expect(close).not.toHaveBeenCalled()
  })

  it('closes when `later` says, not before: the navigation is cancelled at once', () => {
    const close = vi.fn()
    layer(ref(true), close)
    let run: (() => void) | undefined
    expect(closeTopLayer((go) => (run = go))).toBe(true)
    expect(close).not.toHaveBeenCalled()
    run!()
    expect(close).toHaveBeenCalledOnce()
  })

  it('a layer registered while closed is not there until it opens', async () => {
    const open = ref(false)
    layer(open, vi.fn())
    expect(closeTopLayer()).toBe(false)
    open.value = true
    await nextTick()
    expect(closeTopLayer()).toBe(true)
  })
})
