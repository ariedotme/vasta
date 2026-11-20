import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, nextTick } from 'vue'

const key = 'vasta.page-width'
function storage(value?: string) {
  const data = new Map(value === undefined ? [] : [[key, value]])
  return {
    getItem: (name: string) => data.get(name) ?? null,
    setItem: (name: string, text: string) => { data.set(name, text) },
    removeItem: (name: string) => { data.delete(name) },
    data,
  }
}
async function load(saved: unknown) {
  vi.resetModules()
  vi.stubGlobal('localStorage', saved)
  return import('./page-width.ts')
}
afterEach(() => vi.unstubAllGlobals())

describe('page width on this device', () => {
  it.each([undefined, '', 'broken', 'Wide'])('defaults to Standard for missing or invalid storage (%s)', async (value) => {
    const { pageWidth } = await load(storage(value))
    expect(pageWidth.value).toBe('standard')
  })

  it.each(['wide', 'full'] as const)('restores %s after a fresh load', async (value) => {
    const { pageWidth } = await load(storage(value))
    expect(pageWidth.value).toBe(value)
  })

  it('remembers changes and clears the override when Standard is selected', async () => {
    const saved = storage()
    const { pageWidth, pageWidthClass } = await load(saved)
    const rendered = computed(() => pageWidthClass(false))
    expect(rendered.value).toBe('max-w-3xl')
    pageWidth.value = 'wide'
    await nextTick()
    expect(saved.data.get(key)).toBe('wide')
    expect(rendered.value).toBe('max-w-6xl')
    pageWidth.value = 'full'
    await nextTick()
    expect(saved.data.get(key)).toBe('full')
    expect(rendered.value).toBe('max-w-none')
    pageWidth.value = 'standard'
    await nextTick()
    expect(saved.data.has(key)).toBe(false)
    expect(rendered.value).toBe('max-w-3xl')
  })

  it('starts at Standard when storage is unavailable and still lets this session change width', async () => {
    const denied = () => { throw new Error('storage denied') }
    const { pageWidth } = await load({ getItem: denied, setItem: denied, removeItem: denied })
    expect(pageWidth.value).toBe('standard')
    pageWidth.value = 'full'
    await nextTick()
    expect(pageWidth.value).toBe('full')
    pageWidth.value = 'standard'
    await nextTick()
  })

  it.each([
    ['standard', 'max-w-3xl', 'max-w-6xl'],
    ['wide', 'max-w-6xl', 'max-w-6xl'],
    ['full', 'max-w-none', 'max-w-none'],
  ] as const)('uses %s for prose and columns', async (value, prose, columns) => {
    const { pageWidth, pageWidthClass } = await load(storage())
    pageWidth.value = value
    expect(pageWidthClass(false)).toBe(prose)
    expect(pageWidthClass(true)).toBe(columns)
    await nextTick()
  })
})
