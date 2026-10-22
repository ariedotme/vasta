// The media stores. The S3 store runs against a real bucket only when VASTA_TEST_S3_BUCKET is set,
// with the VASTA_TEST_S3_* variables named like the server's VASTA_S3_* (e.g. a local Garage or
// MinIO in Docker; docs/deploy.md).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { mediaKey, parseRange, RangeNotSatisfiableError, type MediaStore } from '../src/media-store.ts'
import { NodeMediaStore } from '../src/media-store-node.ts'
import { S3MediaStore, s3SettingsFromEnv } from '../src/media-store-s3.ts'

const testS3 = s3SettingsFromEnv(
  Object.fromEntries(Object.entries(process.env).flatMap(([name, value]) => (name.startsWith('VASTA_TEST_S3_') ? [[name.replace('VASTA_TEST_S3_', 'VASTA_S3_'), value]] : [])))
)

const stores: [string, () => MediaStore][] = [['filesystem', () => new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-media-')))]]
if (testS3) stores.push(['S3', () => new S3MediaStore({ ...testS3, prefix: `test-${Date.now()}/` })])

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const read = async (store: MediaStore, key: string, range?: string) => {
  const file = await store.get(key, range)
  return file && { ...file, text: text(new Uint8Array(await new Response(file.body).arrayBuffer())) }
}

describe.each(stores)('media store on the %s', (_, create) => {
  it('stores files by content, reads them whole or in part', async () => {
    const store = create()
    const data = new TextEncoder().encode('0123456789')
    const file = await store.put(data, 'Digits.TXT', 'text/plain')
    expect(file).toEqual({ key: mediaKey(data, 'x.txt'), name: 'Digits.TXT', sizeBytes: 10, mimeType: 'text/plain' })
    expect(file.key).toMatch(/^[a-f0-9]{64}\.txt$/)
    expect((await store.put(data, 'again.txt')).key).toBe(file.key)
    expect(await store.has(file.key)).toBe(true)

    expect(await read(store, file.key)).toMatchObject({ text: '0123456789', length: 10, size: 10 })
    expect(await read(store, file.key, 'bytes=2-4')).toMatchObject({ text: '234', length: 3, size: 10, range: { start: 2, end: 4 } })
    expect(await read(store, file.key, 'bytes=7-')).toMatchObject({ text: '789', range: { start: 7, end: 9 } })
    expect(await read(store, file.key, 'bytes=-2')).toMatchObject({ text: '89', range: { start: 8, end: 9 } })
    await expect(store.get(file.key, 'bytes=20-30')).rejects.toBeInstanceOf(RangeNotSatisfiableError)
  })

  it('knows missing files and refuses invalid keys', async () => {
    const store = create()
    const missing = `${'0'.repeat(64)}.png`
    expect(await store.has(missing)).toBe(false)
    expect(await store.get(missing)).toBeUndefined()
    await expect(store.get('../vasta.db')).rejects.toThrow(/invalid media key/)
  })
})

describe('parseRange', () => {
  it('reads one byte range and ignores what it does not handle', () => {
    expect(parseRange(undefined, 10)).toBeUndefined()
    expect(parseRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=5-100', 10)).toEqual({ start: 5, end: 9 })
    expect(parseRange('bytes=-100', 10)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=0-1,4-5', 10)).toBeUndefined()
    expect(parseRange('items=0-1', 10)).toBeUndefined()
    expect(() => parseRange('bytes=10-', 10)).toThrow(RangeNotSatisfiableError)
    expect(() => parseRange('bytes=5-2', 10)).toThrow(RangeNotSatisfiableError)
  })
})
