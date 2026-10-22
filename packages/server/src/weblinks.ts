// Weblinks: saving a URL as an object, its page metadata, a readable copy of the page and a local
// copy of its preview image. Used by the app's own endpoints and by the capture service.
import { randomUUID } from 'node:crypto'
import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import {
  ARTICLE_PROPERTY_ID,
  applyQuoteHighlights,
  articleProperty,
  quoteHighlights,
  BODY_PROPERTY_ID,
  builtinTypeId,
  type Doc,
  type Id,
  type IsoDateTime,
  type MediaInfo,
  type ObjectRecord,
  type StoredFile,
} from '@vasta/core'
import type { MediaStore } from '@vasta/core/media'
import type { NodeStore } from '@vasta/core/node'
import type { ChangeFeed } from './events.ts'
import { htmlToBlocks } from './html-doc.ts'
import { textToBlocks } from '@vasta/core'
import { safeFetch } from './safe-fetch.ts'
import { USER_AGENT, type FetchPage, type FetchPageMeta } from './web-meta.ts'

const IMAGE_MAX_BYTES = 8 * 1024 * 1024
const IMAGE_TIMEOUT_MS = 10_000
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg',
}

export class WeblinkError extends Error {}

/**
 * The http(s) URL a user typed or pasted. Accepts a bare address such as "example.com/page"
 * (https is assumed); throws a WeblinkError for anything else.
 */
export function normalizeWeblinkUrl(raw: string): string {
  const text = (raw ?? '').trim()
  const withScheme = /^[a-z][\w+.-]*:/i.test(text) ? text : /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(text) ? `https://${text}` : text
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new WeblinkError('enter a valid web address')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WeblinkError('the address must start with http:// or https://')
  return url.toString()
}

export interface WeblinkInput {
  url: string
  title?: string
  /** A note saved in the weblink's body. */
  note?: string
}

/** Downloads an image; nothing for errors, non-images and files over the size cap. */
export type FetchImage = (url: string) => Promise<{ data: Uint8Array; mimeType: string } | undefined>

export const fetchImage: FetchImage = async (url) => {
  try {
    const response = await safeFetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS), headers: { 'user-agent': USER_AGENT, accept: 'image/*' } })
    const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (!response.ok || !mimeType.startsWith('image/')) return undefined
    if (Number(response.headers.get('content-length') ?? 0) > IMAGE_MAX_BYTES) return undefined
    const data = new Uint8Array(await response.arrayBuffer())
    return data.byteLength && data.byteLength <= IMAGE_MAX_BYTES ? { data, mimeType } : undefined
  } catch {
    return undefined
  }
}

export interface WeblinkOptions {
  store: NodeStore
  media: MediaStore
  feed?: ChangeFeed
  now?: () => IsoDateTime
  /** Without these, links are saved with their URL only (tests, VASTA_FETCH_LINK_META=0). */
  fetchMeta?: FetchPageMeta
  fetchPage?: FetchPage
  fetchImage?: FetchImage
}

export interface ReadableText {
  doc: Doc
  title?: string
  byline?: string
  length?: number
}

/** Extract the main text of a page with Readability, as rich-text blocks. */
export function readableText(html: string, url: string): ReadableText | undefined {
  const { document } = parseHTML(html)
  const article = new Readability<Node>(document as unknown as Document, { serializer: (node) => node, charThreshold: 200 }).parse()
  if (!article?.content) return undefined
  const content = htmlToBlocks(article.content, url)
  if (!content.length) return undefined
  return {
    doc: { type: 'doc', content },
    ...(article.title ? { title: article.title } : {}),
    ...(article.byline ? { byline: article.byline.trim() } : {}),
    ...(article.length ? { length: article.length } : {}),
  }
}

export class WeblinkService {
  private readonly store: NodeStore
  private readonly media: MediaStore
  private readonly feed: ChangeFeed | undefined
  private readonly now: () => IsoDateTime
  private readonly fetchMeta: FetchPageMeta | undefined
  private readonly fetchPage: FetchPage | undefined
  private readonly fetchImage: FetchImage | undefined
  /** Background work (preview images, readable text) still running; see `idle`. */
  private readonly pending = new Set<Promise<unknown>>()

  constructor(options: WeblinkOptions) {
    this.store = options.store
    this.media = options.media
    this.feed = options.feed
    this.now = options.now ?? (() => new Date().toISOString())
    this.fetchMeta = options.fetchMeta
    this.fetchPage = options.fetchPage
    this.fetchImage = options.fetchImage
  }

  /** The weblink saved before for this URL, or a new (unsaved) one with the page's metadata. */
  async prepare(spaceId: Id, input: WeblinkInput): Promise<{ object: ObjectRecord; created: boolean }> {
    const url = normalizeWeblinkUrl(input.url)
    const typeId = builtinTypeId(spaceId, 'weblink')
    // Links saved before URLs were normalized may be stored exactly as they were typed.
    const existing = this.store.findObjectByMediaUrl(typeId, url) ?? this.store.findObjectByMediaUrl(typeId, input.url.trim())
    if (existing) return { object: existing, created: false }
    const media = await this.pageMedia(url)
    const at = this.now()
    const object: ObjectRecord = {
      id: randomUUID(),
      spaceId,
      typeId,
      title: input.title?.trim() || String(media.meta?.title ?? '') || media.host!,
      aliases: [],
      tagIds: [],
      collectionIds: [],
      props: {},
      content: input.note?.trim() ? { [BODY_PROPERTY_ID]: { type: 'doc', content: textToBlocks(input.note) } } : {},
      media,
      createdAt: at,
      updatedAt: at,
    }
    return { object, created: true }
  }

  /** Find or create the weblink for a URL. New ones get their preview image in the background. */
  async save(spaceId: Id, input: WeblinkInput): Promise<{ object: ObjectRecord; created: boolean }> {
    const result = await this.prepare(spaceId, input)
    if (!result.created) return result
    this.store.putObject(result.object)
    this.changed(result.object)
    this.enrich(result.object.id)
    return result
  }

  /** Point a weblink at a URL (e.g. one created empty from "New → Weblink") and load its metadata. */
  async setUrl(id: Id, rawUrl: string): Promise<ObjectRecord> {
    const url = normalizeWeblinkUrl(rawUrl)
    this.weblink(id)
    const media = await this.pageMedia(url)
    const updated = this.update(id, (object) => ({
      ...object,
      // A title the user typed stays; one taken from the previous page follows the new one.
      title: !object.title.trim() || object.title === String(object.media?.meta?.title ?? object.media?.host ?? '') ? String(media.meta?.title ?? '') || media.host! : object.title,
      media,
    }))
    this.enrich(id)
    return updated
  }

  /** Fetch the page's metadata again. A new preview image replaces the stored copy. */
  async refresh(id: Id): Promise<ObjectRecord> {
    const url = this.weblink(id).media?.url
    if (!url) throw new WeblinkError('this weblink has no address yet')
    const fresh = await this.pageMedia(url)
    const updated = this.update(id, (object) => {
      const { previewImageFile, ...old } = object.media ?? {}
      const keepFile = previewImageFile && fresh.previewImageUrl === old.previewImageUrl
      const meta = { ...old.meta, ...fresh.meta }
      const media: MediaInfo = { ...old, ...fresh, ...(Object.keys(meta).length ? { meta } : {}), ...(keepFile ? { previewImageFile } : {}) }
      if (!fresh.previewImageUrl && !keepFile) delete media.previewImageUrl
      return { ...object, media }
    })
    await this.storePreviewImage(id)
    return this.store.getObject(id) ?? updated
  }

  /**
   * Save a readable copy of the page (Readability) in the weblink's "Readable text" field,
   * replacing an earlier copy. The user's notes in the body are left alone. Highlights of quotes
   * are found again in the new copy by their text; `lostHighlights` lists the passages that are
   * not there any more (their quotes stay).
   */
  async saveReadable(id: Id): Promise<ObjectRecord & { lostHighlights?: string[] }> {
    const url = this.weblink(id).media?.url
    if (!url) throw new WeblinkError('this weblink has no address yet')
    if (!this.fetchPage) throw new WeblinkError('fetching pages is turned off on this server')
    const page = await this.fetchPage(url)
    if (!page) throw new WeblinkError('could not load the page')
    const readable = readableText(page.html, page.url)
    if (!readable) throw new WeblinkError('no readable text found on this page')
    this.ensureArticleField(this.weblink(id).typeId)
    let lost: string[] = []
    const object = this.update(id, (object) => {
      const media = object.media ?? {}
      const meta = { ...media.meta }
      if (readable.byline && !meta.author) meta.author = readable.byline
      const before = object.content[ARTICLE_PROPERTY_ID]
      const { doc, missing } = applyQuoteHighlights(readable.doc, before ? quoteHighlights(before) : [])
      lost = missing.map((m) => m.text)
      return { ...object, content: { ...object.content, [ARTICLE_PROPERTY_ID]: doc }, media: { ...media, meta } }
    })
    return lost.length ? { ...object, lostHighlights: lost } : object
  }

  /** Store the preview image locally and, when asked, the readable text; runs in the background. */
  enrich(id: Id, { readable = false } = {}) {
    const run = (async () => {
      await this.storePreviewImage(id)
      if (readable && this.fetchPage) await this.saveReadable(id).catch(() => {})
    })()
      .catch((error) => console.warn(`weblink ${id}: ${(error as Error).message}`))
      .finally(() => this.pending.delete(run))
    this.pending.add(run)
  }

  /** Resolves when the background work started so far has finished. */
  async idle() {
    while (this.pending.size) await Promise.all([...this.pending])
  }

  // -------------------------------------------------------------------------

  private weblink(id: Id): ObjectRecord {
    const object = this.store.getObject(id)
    if (!object || object.deletedAt) throw new WeblinkError('weblink not found')
    if (this.store.getType(object.typeId)?.system !== 'weblink') throw new WeblinkError('this object is not a weblink')
    return object
  }

  private async pageMedia(url: string): Promise<MediaInfo> {
    const page = (await this.fetchMeta?.(url)) ?? {}
    return { url, host: new URL(url).host, ...page }
  }

  private async storePreviewImage(id: Id) {
    const source = this.store.getObject(id)?.media?.previewImageUrl
    if (!source || !this.fetchImage || this.store.getObject(id)?.media?.previewImageFile) return
    const image = await this.fetchImage(source)
    if (!image) return
    const extension = IMAGE_EXTENSIONS[image.mimeType] ?? image.mimeType.split('/')[1]?.replace(/\W/g, '') ?? 'img'
    const file: StoredFile = await this.media.put(image.data, `preview.${extension}`, image.mimeType)
    // The page may have changed its image while this one downloaded.
    if (this.store.getObject(id)?.media?.previewImageUrl !== source) return
    this.update(id, (object) => ({ ...object, media: { ...object.media, previewImageFile: file } }))
  }

  /** Weblink types made before the readable-text field existed get it the first time it is needed. */
  private ensureArticleField(typeId: Id) {
    const type = this.store.getType(typeId)
    if (!type || type.properties.some((p) => p.id === ARTICLE_PROPERTY_ID)) return
    const updated = { ...type, properties: [...type.properties, structuredClone(articleProperty)], updatedAt: this.now() }
    this.store.putType(updated)
    this.feed?.emit({ kind: 'type', id: type.id, spaceId: type.spaceId })
  }

  /** Apply a change to the stored copy (read and written without awaiting in between). */
  private update(id: Id, change: (object: ObjectRecord) => ObjectRecord): ObjectRecord {
    const current = this.store.getObject(id)
    if (!current || current.deletedAt) throw new WeblinkError('weblink not found')
    const updated = { ...change(current), updatedAt: this.now() }
    this.store.putObject(updated)
    this.changed(updated)
    return updated
  }

  private changed(object: ObjectRecord) {
    this.feed?.emit({ kind: 'object', id: object.id, spaceId: object.spaceId, typeId: object.typeId, updatedAt: object.updatedAt })
  }
}
