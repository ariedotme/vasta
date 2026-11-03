import { afterEach, describe, expect, it, vi } from 'vitest'
import { newId } from '../src/ids.ts'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('newId', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('makes a UUID v4', () => {
    expect(newId()).toMatch(UUID_V4)
  })

  it('works without crypto.randomUUID (plain-http pages)', () => {
    const { getRandomValues } = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: getRandomValues.bind(globalThis.crypto) })
    const ids = new Set(Array.from({ length: 200 }, () => newId()))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(UUID_V4)
  })
})
