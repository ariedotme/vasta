import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NodeMediaStore } from '@vasta/core/media-node'
import type { ObjectRecord } from '@vasta/core'
import { attachExportMedia, readFrontMatter } from '../src/export-media.ts'

const encode = (text: string) => new TextEncoder().encode(text)
const at = '2026-05-12T11:01:21.134Z'

const image = (id: string, title: string): ObjectRecord => ({
  id,
  spaceId: 's1',
  typeId: 'image:s1',
  title,
  aliases: [],
  tagIds: [],
  collectionIds: [],
  props: {},
  content: {},
  media: { mimeType: 'image/jpeg' },
  createdAt: at,
  updatedAt: at,
})

describe('export media', () => {
  it('reads quoted front matter values', () => {
    expect(readFrontMatter("---\ntype: 'Image'\ntitle: 'It''s here'\ncreatedAt: '2026-05-12T11:01:21.134Z'\n---\nbody")).toEqual({
      type: 'Image',
      title: "It's here",
      createdAt: at,
    })
  })

  it('attaches files to objects matched by kind and creation time, using the title to break ties', async () => {
    const files = {
      'Space/Images/Cat.md': encode(`---\ntype: 'Image'\ntitle: Cat\ncreatedAt: '${at}'\n---\n\nMedia: ![Image](./Media/Cat%20(1).jpeg)\n`),
      'Space/Images/Media/Cat (1).jpeg': new Uint8Array([1, 2, 3]),
      'Space/Images/Missing.md': encode(`---\ntype: 'Image'\ntitle: Missing\ncreatedAt: '${at}'\n---\n\nMedia: Not included\n`),
    }
    const objects = [image('dog', 'Dog'), image('cat', 'Cat')]
    const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-media-')))
    const report = await attachExportMedia(files, [{ id: 's1', name: 'Space', sidebar: [], createdAt: at }], objects, media)

    expect(report).toEqual({ entries: 2, attached: 1, withoutFile: 1, unmatched: [] })
    const file = objects[1]!.media!.file!
    expect(file).toMatchObject({ name: 'Cat (1).jpeg', sizeBytes: 3, mimeType: 'image/jpeg' })
    expect([...readFileSync(media.pathOf(file.key))]).toEqual([1, 2, 3])
    expect(objects[0]!.media!.file).toBeUndefined()
  })
})
