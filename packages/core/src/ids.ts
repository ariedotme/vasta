// Random ids for new objects, types, options and the like. crypto.randomUUID only exists in a
// secure context (HTTPS or localhost), so a browser at a plain-http address such as
// http://192.168.1.10:3000 has no randomUUID; crypto.getRandomValues works everywhere and gives
// the same UUID v4 shape.

const hex = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))

/** A random UUID v4, also outside a secure context. */
export function newId(): string {
  const c = globalThis.crypto
  if (typeof c.randomUUID === 'function') return c.randomUUID()
  const b = c.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = Array.from(b, (x) => hex[x])
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10).join('')}`
}
