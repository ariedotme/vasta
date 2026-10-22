// The media store: content-addressed files, on the filesystem (media-store-node.ts) or in an
// S3-compatible bucket (media-store-s3.ts). Server-side only.
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { StoredFile } from './model.ts'

/** A stored file, or the requested part of it. */
export interface MediaBody {
  body: ReadableStream<Uint8Array>
  /** Bytes in `body`. */
  length: number
  /** Bytes in the whole file. */
  size: number
  /** Set when `body` is a part of the file (an answer to a `Range` request). */
  range?: { start: number; end: number }
}

export interface MediaStore {
  /** Store a file (a no-op when the same bytes are already there). */
  put(data: Uint8Array, name: string, mimeType?: string): Promise<StoredFile>
  /** The file, or the part named by an HTTP `Range` header; undefined when there is no such file. */
  get(key: string, range?: string): Promise<MediaBody | undefined>
  has(key: string): Promise<boolean>
}

/** A `Range` the file cannot satisfy (HTTP 416). */
export class RangeNotSatisfiableError extends Error {
  readonly size: number
  constructor(size: number) {
    super('range not satisfiable')
    this.size = size
  }
}

/** "<sha256>.<extension>", the extension taken from the file name. */
export function mediaKey(data: Uint8Array, name: string): string {
  const hash = createHash('sha256').update(data).digest('hex')
  const extension = path.extname(name).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '')
  return extension ? `${hash}.${extension}` : hash
}

export function checkMediaKey(key: string): string {
  if (!/^[a-f0-9]{64}(\.[a-z0-9]+)?$/.test(key)) throw new Error(`invalid media key: ${key}`)
  return key
}

export function storedFile(key: string, data: Uint8Array, name: string, mimeType?: string): StoredFile {
  return { key, name, sizeBytes: data.byteLength, ...(mimeType ? { mimeType } : {}) }
}

/**
 * The byte range a `Range` header asks of a file of `size` bytes: undefined for the whole file
 * (no header, a unit other than bytes, several ranges), an error when it lies outside the file.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | undefined {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/)
  if (!match || (!match[1] && !match[2])) return undefined
  let start: number
  let end: number
  if (!match[1]) {
    // bytes=-500: the last 500 bytes.
    const suffix = Number(match[2])
    if (suffix === 0) throw new RangeNotSatisfiableError(size)
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
    if (start >= size || end < start) throw new RangeNotSatisfiableError(size)
  }
  return { start, end }
}
