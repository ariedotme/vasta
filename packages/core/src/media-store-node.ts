// Content-addressed media store on the local filesystem.
import { createReadStream, existsSync, mkdirSync } from 'node:fs'
import { stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { checkMediaKey, mediaKey, parseRange, storedFile, type MediaBody, type MediaStore } from './media-store.ts'
import type { StoredFile } from './model.ts'

export class NodeMediaStore implements MediaStore {
  readonly root: string

  constructor(root: string) {
    this.root = root
    mkdirSync(root, { recursive: true })
  }

  async put(data: Uint8Array, name: string, mimeType?: string): Promise<StoredFile> {
    const key = mediaKey(data, name)
    const file = this.pathOf(key)
    if (!existsSync(file)) await writeFile(file, data)
    return storedFile(key, data, name, mimeType)
  }

  async get(key: string, rangeHeader?: string): Promise<MediaBody | undefined> {
    const file = this.pathOf(key)
    const size = await stat(file).then((s) => s.size, () => undefined)
    if (size === undefined) return undefined
    const range = size ? parseRange(rangeHeader, size) : undefined
    const stream = createReadStream(file, range ?? {})
    return {
      body: Readable.toWeb(stream) as ReadableStream<Uint8Array>,
      length: range ? range.end - range.start + 1 : size,
      size,
      ...(range ? { range } : {}),
    }
  }

  async has(key: string): Promise<boolean> {
    return existsSync(this.pathOf(key))
  }

  pathOf(key: string): string {
    return path.join(this.root, checkMediaKey(key))
  }
}
