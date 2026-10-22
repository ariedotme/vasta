// Which media store the server uses, and the helpers behind `vasta media …`.
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { MediaStore } from '@vasta/core/media'
import { NodeMediaStore } from '@vasta/core/media-node'
import { S3MediaStore, s3SettingsFromEnv } from '@vasta/core/media-s3'
import type { NodeStore } from '@vasta/core/node'

/** An S3-compatible bucket when VASTA_S3_BUCKET is set, else files in `<data>/media`. */
export function createMediaStore(env: Record<string, string | undefined>, dataDir: string): NodeMediaStore | S3MediaStore {
  const s3 = s3SettingsFromEnv(env)
  return s3 ? new S3MediaStore(s3) : new NodeMediaStore(path.join(dataDir, 'media'))
}

export function describeMediaStore(media: MediaStore): string {
  return media instanceof S3MediaStore ? `bucket ${media.location}` : media instanceof NodeMediaStore ? media.root : 'custom store'
}

/** Every media key objects point at, trashed objects included (they can come back). */
export function referencedMediaKeys(store: NodeStore): string[] {
  const rows = store.db
    .prepare(
      `SELECT json_extract(media, '$.file.key') AS key FROM objects WHERE json_extract(media, '$.file.key') IS NOT NULL
       UNION SELECT json_extract(media, '$.previewImageFile.key') FROM objects WHERE json_extract(media, '$.previewImageFile.key') IS NOT NULL
       ORDER BY 1`
    )
    .all() as { key: string }[]
  return rows.map((row) => row.key)
}

/** Copy the files of a media folder into another store; files already there are skipped. */
export async function pushMediaFolder(folder: string, to: MediaStore, onFile?: (key: string, copied: boolean) => void) {
  const result = { copied: 0, skipped: 0 }
  for (const key of (await readdir(folder)).filter((name) => /^[a-f0-9]{64}(\.[a-z0-9]+)?$/.test(name)).sort()) {
    if (await to.has(key)) {
      result.skipped++
      onFile?.(key, false)
      continue
    }
    // Same bytes and extension, so the same key.
    const stored = await to.put(new Uint8Array(await readFile(path.join(folder, key))), key)
    if (stored.key !== key) throw new Error(`${key} does not match its content (${stored.key})`)
    result.copied++
    onFile?.(key, true)
  }
  return result
}
