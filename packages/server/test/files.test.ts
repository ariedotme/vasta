import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { builtinTypeId, createBuiltinTypes, type ObjectRecord } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { createApp, MAX_UPLOAD_BYTES } from '../src/app.ts'
import { imageSize } from '../src/image-size.ts'
import { asUser } from './helpers.ts'

const at = '2026-01-01T00:00:00.000Z'

function setup() {
  const store = new NodeStore(':memory:')
  for (const id of ['s', 'other']) {
    store.putSpace({ id, name: id, sidebar: [], createdAt: at })
    for (const type of createBuiltinTypes(id, at)) store.putType(type)
  }
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-files-')))
  const app = createApp({ store, media, now: () => at })
  return { store, media, app: asUser(app, store, { spaces: ['s'] }) }
}

/** A PNG header for a 640×480 picture (enough for the size reader and the media store). */
function png(width = 640, height = 480) {
  const data = new Uint8Array(33)
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(data.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return data
}

/** A minimal JPEG: SOI, an EXIF block with the given orientation, and a frame header. */
function jpeg(width: number, height: number, orientation = 1) {
  const exif = [0xff, 0xe1, 0, 34, ...'Exif'.split('').map((ch) => ch.charCodeAt(0)), 0, 0, 0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]
  const frame = [0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
  return new Uint8Array([0xff, 0xd8, ...exif, ...frame, 0xff, 0xd9])
}

const upload = (file: File, extra: Record<string, string> = {}) => {
  const form = new FormData()
  form.set('file', file)
  for (const [key, value] of Object.entries(extra)) form.set(key, value)
  return { method: 'POST', body: form }
}

describe('file uploads', () => {
  it('stores an image as an image object with its size, without touching the daily note', async () => {
    const { app, store } = setup()
    const response = await app.request('/api/spaces/s/files', upload(new File([png()], 'photo.png', { type: 'image/png' }), { caption: 'The view' }))
    expect(response.status).toBe(201)
    const object = (await response.json()) as ObjectRecord
    expect(object.typeId).toBe(builtinTypeId('s', 'image'))
    expect(object.media).toMatchObject({ mimeType: 'image/png', width: 640, height: 480, sizeBytes: 33 })
    expect(object.media?.file?.key).toMatch(/^[a-f0-9]{64}\.png$/)
    expect(store.getObject(object.id)?.spaceId).toBe('s')
    expect(store.listObjects(builtinTypeId('s', 'daily-note'))).toEqual([])
    // Served from the media store.
    expect((await app.request(`/media/${object.media!.file!.key}`)).status).toBe(200)
  })

  it('keeps other kinds of files and HEIC photos as they are', async () => {
    const { app } = setup()
    const pdf = (await (await app.request('/api/spaces/s/files', upload(new File([new Uint8Array([37, 80, 68, 70])], 'doc.pdf', { type: 'application/pdf' })))).json()) as ObjectRecord
    expect(pdf.typeId).toBe(builtinTypeId('s', 'pdf'))
    const heic = (await (await app.request('/api/spaces/s/files', upload(new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], 'IMG_1.HEIC', { type: 'image/heic' })))).json()) as ObjectRecord
    expect(heic.typeId).toBe(builtinTypeId('s', 'image'))
    expect(heic.media).toMatchObject({ mimeType: 'image/heic' })
    expect(heic.media?.width).toBeUndefined()
  })

  it('refuses other spaces, missing files and files over the limit', async () => {
    const { app } = setup()
    const file = new File([png()], 'photo.png', { type: 'image/png' })
    // Spaces the user is not in look like they do not exist.
    expect((await app.request('/api/spaces/other/files', upload(file))).status).toBe(404)
    expect((await app.request('/api/spaces/s/files', { method: 'POST', body: new FormData() })).status).toBe(400)
    expect((await app.request('/api/spaces/s/files', upload(new File([], 'empty.png')))).status).toBe(400)
    const big = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1024 * 1024)], 'big.bin')
    const tooBig = await app.request('/api/spaces/s/files', upload(big))
    expect(tooBig.status).toBe(413)
  })
})

describe('image sizes', () => {
  it('reads PNG and JPEG headers, turning rotated JPEGs', () => {
    expect(imageSize(png(10, 20))).toEqual({ width: 10, height: 20 })
    expect(imageSize(jpeg(4032, 3024))).toEqual({ width: 4032, height: 3024 })
    expect(imageSize(jpeg(4032, 3024, 6))).toEqual({ width: 3024, height: 4032 })
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeUndefined()
  })
})
