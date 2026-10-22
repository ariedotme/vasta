// Seeded randomness, so a randomized test replays exactly from its seed: Yjs client ids, HLC node
// ids, UUIDs and block ids all come from here while a seed is set. Import it before anything
// else: lib0 (Yjs) keeps a reference to getRandomValues when it loads.
import { webcrypto } from 'node:crypto'
import { createRequire, syncBuiltinESMExports } from 'node:module'

const originals = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto), randomUUID: webcrypto.randomUUID.bind(webcrypto), random: Math.random }
let next: (() => number) | undefined

/** mulberry32: numbers in [0, 1) from a seed. */
export function seeded(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function getRandomValues<T extends ArrayBufferView | null>(array: T): T {
  if (!next || !array) return originals.getRandomValues(array as never) as T
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(next() * 256)
  return array
}

function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
  if (!next) return originals.randomUUID()
  const hex = Array.from(getRandomValues(new Uint8Array(16)), (b, i) => (i === 6 ? (b & 0x0f) | 0x40 : i === 8 ? (b & 0x3f) | 0x80 : b).toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

for (const target of new Set([webcrypto, globalThis.crypto])) {
  Object.defineProperty(target, 'getRandomValues', { configurable: true, writable: true, value: getRandomValues })
  Object.defineProperty(target, 'randomUUID', { configurable: true, writable: true, value: randomUUID })
}
// The server imports randomUUID from node:crypto itself.
createRequire(import.meta.url)('node:crypto').randomUUID = randomUUID
syncBuiltinESMExports()
Math.random = () => (next ? next() : originals.random())

/** Draw from `seed` from now on; without one, randomness is random again. */
export function seedRandom(seed?: number) {
  next = seed === undefined ? undefined : seeded(seed)
}
