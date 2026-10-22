// Best-effort metadata for a saved web page: title, description, preview image and site name,
// read from the page's <title> and Open Graph / Twitter meta tags.
import type { MediaInfo } from '@vasta/core'
import { safeFetch } from './safe-fetch.ts'

/** Metadata reads at most this much of a page. */
const META_MAX_BYTES = 768 * 1024

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/\s+/g, ' ')
    .trim()
}

/** Meta tag values by property/name, lowercased keys. */
function metaTags(html: string): Map<string, string> {
  const tags = new Map<string, string>()
  for (const [tag] of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag)
    const key = attr('property') ?? attr('name')
    const content = attr('content')
    const k = (key?.[1] ?? key?.[2])?.toLowerCase()
    const v = content?.[1] ?? content?.[2]
    if (k && v && !tags.has(k)) tags.set(k, decodeEntities(v))
  }
  return tags
}

export function parsePageMeta(html: string, url: string): Pick<MediaInfo, 'previewImageUrl' | 'meta'> {
  const tags = metaTags(html)
  const pick = (...keys: string[]) => keys.map((k) => tags.get(k)).find(Boolean)
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]
  const meta: Record<string, string> = {}
  const title = pick('og:title', 'twitter:title') ?? (titleTag ? decodeEntities(titleTag) : undefined)
  const description = pick('og:description', 'twitter:description', 'description')
  const publisher = pick('og:site_name', 'application-name')
  if (title) meta.title = title
  if (description) meta.description = description
  if (publisher) meta.publisher = publisher
  const image = pick('og:image', 'og:image:url', 'twitter:image')
  let previewImageUrl: string | undefined
  try {
    if (image) previewImageUrl = new URL(image, url).toString()
  } catch {}
  return { ...(previewImageUrl ? { previewImageUrl } : {}), ...(Object.keys(meta).length ? { meta } : {}) }
}

export type FetchPageMeta = (url: string) => Promise<Pick<MediaInfo, 'previewImageUrl' | 'meta'>>

export interface FetchedPage {
  /** Where the page ended up after redirects. */
  url: string
  html: string
}

export interface FetchPageOptions {
  /** Stop reading once the head is complete (enough for metadata). */
  headOnly?: boolean
  maxBytes?: number
  timeoutMs?: number
}

/** Fetches an HTML page, or nothing for errors and other content. */
export type FetchPage = (url: string, options?: FetchPageOptions) => Promise<FetchedPage | undefined>

export const USER_AGENT = 'Mozilla/5.0 (compatible; Vasta/0.1; +https://github.com/)'

/** The charset a response declares in its header, or in the first bytes of the page. */
function charsetOf(contentType: string, head: Uint8Array): string {
  const declared = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(new TextDecoder('latin1').decode(head.subarray(0, 4096)))?.[1]
  try {
    return declared ? new TextDecoder(declared).encoding : 'utf-8'
  } catch {
    return 'utf-8'
  }
}

export const fetchPage: FetchPage = async (url, { headOnly = false, maxBytes = 5 * 1024 * 1024, timeoutMs = 10_000 } = {}) => {
  try {
    const response = await safeFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
    })
    const contentType = response.headers.get('content-type') ?? ''
    if (!response.ok || !response.body || !contentType.includes('html')) return undefined
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (size < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      size += value.byteLength
      // For metadata the head is enough; stop once it is complete.
      if (headOnly && new TextDecoder('latin1').decode(value).includes('</head>')) break
    }
    await reader.cancel().catch(() => {})
    const bytes = Buffer.concat(chunks)
    return { url: response.url || url, html: new TextDecoder(charsetOf(contentType, bytes)).decode(bytes) }
  } catch {
    return undefined
  }
}

export const fetchPageMeta: FetchPageMeta = async (url) => {
  const page = await fetchPage(url, { headOnly: true, maxBytes: META_MAX_BYTES, timeoutMs: 6000 })
  return page ? parsePageMeta(page.html, page.url) : {}
}
