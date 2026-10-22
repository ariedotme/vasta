import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { ARTICLE_PROPERTY_ID, applyQuoteHighlights, builtinTypeId, createBuiltinTypes, quoteHighlights, type ObjectRecord } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { createApp } from '../src/app.ts'
import { CaptureService } from '../src/capture.ts'
import { ChangeFeed, type ChangeEvent } from '../src/events.ts'
import { htmlToBlocks } from '../src/html-doc.ts'
import type { FetchPage } from '../src/web-meta.ts'
import { asUser } from './helpers.ts'
import { normalizeWeblinkUrl, readableText, WeblinkService } from '../src/weblinks.ts'

const paragraphs = Array.from({ length: 6 }, (_, i) => `<p>Paragraph ${i + 1} of the story, long enough to count as real article text for the reader. It keeps going for a while so the scoring treats it as content.</p>`).join('\n')

const ARTICLE = `<!doctype html><html><head><title>Story | Site</title></head><body>
  <nav><a href="/">Home</a> <a href="/about">About</a></nav>
  <article>
    <h1>The story</h1>
    <p class="byline">By Ana Lima</p>
    ${paragraphs}
    <p>See <a href="/more">more</a> and <strong>bold <em>both</em></strong>.</p>
    <ul><li>One</li><li>Two <code>x</code></li></ul>
    <pre><code class="language-js">const a = 1
</code></pre>
  </article>
  <footer>Copyright</footer>
</body></html>`

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

function setup(start = '2026-10-18T12:00:00.000Z') {
  const store = new NodeStore(':memory:')
  store.putSpace({ id: 's', name: 'Space', sidebar: [], createdAt: start })
  for (const type of createBuiltinTypes('s', start)) store.putType(type)
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-weblinks-')))
  const clock = { at: start }
  const feed = new ChangeFeed()
  const events: ChangeEvent[] = []
  feed.subscribe((e) => events.push(e))
  const fetched: string[] = []
  const fetchPage: FetchPage = async (url) => (fetched.push(url), { url, html: ARTICLE })
  const weblinks = new WeblinkService({
    store, media, feed, now: () => clock.at, fetchPage,
    fetchMeta: async (url) => ({ meta: { title: `Title of ${new URL(url).pathname}` }, previewImageUrl: `https://img.example${new URL(url).pathname}.png` }),
    fetchImage: async () => ({ data: PNG, mimeType: 'image/png' }),
  })
  const app = asUser(createApp({ store, media, feed, weblinks, now: () => clock.at }), store)
  return { store, media, weblinks, app, clock, events, fetched }
}

const json = (method: string, data: unknown) => ({ method, body: JSON.stringify(data), headers: { 'content-type': 'application/json' } }) as const

describe('weblink urls', () => {
  it('accepts http(s) and bare addresses', () => {
    expect(normalizeWeblinkUrl(' https://Example.com ')).toBe('https://example.com/')
    expect(normalizeWeblinkUrl('example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(() => normalizeWeblinkUrl('ftp://example.com')).toThrow()
    expect(() => normalizeWeblinkUrl('not a url')).toThrow()
  })
})

describe('html to blocks', () => {
  it('keeps structure and marks the editor knows', () => {
    const { document } = parseHTML('<div><h2>Title</h2><p>Hi <b>bold <i>it</i></b> <a href="/x">link</a><br>next</p><blockquote>quote</blockquote><ol start="3"><li><p>a</p><ul><li>b</li></ul></li></ol><img src="x.png"><table><tr><th>h</th></tr><tr><td></td></tr></table>loose text</div>')
    const blocks = htmlToBlocks(document.querySelector('div')!, 'https://site.example/page')
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'blockquote', 'orderedList', 'table', 'paragraph'])
    expect(blocks[1]!.content).toEqual([
      { type: 'text', text: 'Hi ' },
      { type: 'text', text: 'bold ', marks: [{ type: 'bold' }] },
      { type: 'text', text: 'it', marks: [{ type: 'bold' }, { type: 'italic' }] },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://site.example/x' } }] },
      { type: 'hardBreak' },
      { type: 'text', text: 'next' },
    ])
    expect(blocks[2]).toEqual({ type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quote' }] }] })
    expect(blocks[3]).toMatchObject({ attrs: { start: 3 }, content: [{ type: 'listItem', content: [{ type: 'paragraph' }, { type: 'bulletList' }] }] })
    expect(blocks[4]!.content![1]).toEqual({ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph' }] }] })
  })

  it('reads the main text of an article', () => {
    const readable = readableText(ARTICLE, 'https://site.example/story')!
    const types = readable.doc.content.map((b) => b.type)
    expect(types).toContain('bulletList')
    expect(types).toContain('codeBlock')
    expect(JSON.stringify(readable.doc)).not.toContain('Copyright')
    expect(JSON.stringify(readable.doc)).toContain('https://site.example/more')
    expect(readable.byline).toBe('By Ana Lima')
  })
})

describe('weblinks API', () => {
  it('saves a URL once, with its metadata and a local preview image', async () => {
    const { app, weblinks, store } = setup()
    const first = await app.request('/api/spaces/s/weblinks', json('POST', { url: 'example.com/story' }))
    expect(first.status).toBe(201)
    const saved = (await first.json()) as ObjectRecord
    expect(saved).toMatchObject({ typeId: builtinTypeId('s', 'weblink'), title: 'Title of /story', media: { url: 'https://example.com/story', host: 'example.com' } })
    const again = await app.request('/api/spaces/s/weblinks', json('POST', { url: 'https://example.com/story' }))
    expect(again.status).toBe(200)
    expect(((await again.json()) as ObjectRecord).id).toBe(saved.id)
    expect((await app.request('/api/spaces/s/weblinks', json('POST', { url: 'mailto:a@b.c' }))).status).toBe(400)

    await weblinks.idle()
    const stored = store.getObject(saved.id)!
    expect(stored.media?.previewImageFile).toMatchObject({ mimeType: 'image/png', sizeBytes: PNG.byteLength })
    expect(stored.media?.previewImageUrl).toBe('https://img.example/story.png')
    // Saving from the app does not touch the daily note.
    expect(store.listObjects(builtinTypeId('s', 'daily-note'))).toHaveLength(0)
  })

  it('sets the address of an empty weblink and refreshes it', async () => {
    const { app, store, clock, weblinks } = setup()
    const created = (await (await app.request('/api/objects', json('POST', { typeId: builtinTypeId('s', 'weblink') }))).json()) as ObjectRecord
    const set = await app.request(`/api/objects/${created.id}/weblink`, json('PUT', { url: 'https://example.com/a' }))
    expect(set.status).toBe(200)
    expect(await set.json()).toMatchObject({ title: 'Title of /a', media: { url: 'https://example.com/a' } })
    await weblinks.idle()

    // A new address renames a title that came from the page, but not one the user typed.
    store.putObject({ ...store.getObject(created.id)!, title: 'Mine' })
    const moved = (await (await app.request(`/api/objects/${created.id}/weblink`, json('PUT', { url: 'https://example.com/b' }))).json()) as ObjectRecord
    expect(moved.title).toBe('Mine')
    expect(moved.media?.previewImageFile).toBeUndefined()

    clock.at = '2026-10-18T13:00:00.000Z'
    const refreshed = await app.request(`/api/objects/${created.id}/refresh-link`, { method: 'POST' })
    expect(await refreshed.json()).toMatchObject({ updatedAt: clock.at, media: { url: 'https://example.com/b', previewImageFile: { mimeType: 'image/png' } } })
    expect((await app.request(`/api/objects/${created.id}/weblink`, json('PUT', { url: '' }))).status).toBe(400)
  })

  it('saves readable text in its own field, adding the field to older weblink types', async () => {
    const { app, store, events } = setup()
    const typeId = builtinTypeId('s', 'weblink')
    const type = store.getType(typeId)!
    store.putType({ ...type, properties: type.properties.filter((p) => p.id !== ARTICLE_PROPERTY_ID) })
    const link = (await (await app.request('/api/spaces/s/weblinks', json('POST', { url: 'https://site.example/story' }))).json()) as ObjectRecord
    const notes = { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'my note' }] }] }
    store.putObject({ ...store.getObject(link.id)!, content: { body: notes } })

    const response = await app.request(`/api/objects/${link.id}/readable`, { method: 'POST' })
    expect(response.status).toBe(200)
    const saved = (await response.json()) as ObjectRecord
    expect(saved.content.body).toEqual(notes)
    expect(saved.content[ARTICLE_PROPERTY_ID]!.content.length).toBeGreaterThan(3)
    expect(saved.media?.meta?.author).toBe('By Ana Lima')
    expect(store.getType(typeId)!.properties.map((p) => p.id)).toContain(ARTICLE_PROPERTY_ID)
    expect(events).toContainEqual({ kind: 'type', id: typeId, spaceId: 's' })
    // The text is searchable.
    expect(store.search('s', 'scoring treats', 5).map((o) => o.id)).toContain(link.id)
  })

  it('keeps quote highlights when the readable text is saved again, and lists the passages that are gone', async () => {
    const { app, store } = setup()
    const link = (await (await app.request('/api/spaces/s/weblinks', json('POST', { url: 'https://site.example/story' }))).json()) as ObjectRecord
    await app.request(`/api/objects/${link.id}/readable`, { method: 'POST' })
    const article = store.getObject(link.id)!.content[ARTICLE_PROPERTY_ID]!
    const marked = applyQuoteHighlights(article, [
      { quoteId: 'q1', text: 'scoring treats', color: 'yellow' },
      { quoteId: 'q2', text: 'bold both', color: 'green' },
    ])
    expect(marked.missing).toEqual([])
    // A passage the page no longer has, as if it had been highlighted in an older copy.
    const stale = { type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'Gone from the page', marks: [{ type: 'highlight' as const, attrs: { color: 'yellow' as const, quoteId: 'q3' } }] }] }
    store.putObject({ ...store.getObject(link.id)!, content: { [ARTICLE_PROPERTY_ID]: { ...marked.doc, content: [...marked.doc.content, stale] } } })
    const response = await app.request(`/api/objects/${link.id}/readable`, { method: 'POST' })
    const saved = (await response.json()) as ObjectRecord & { lostHighlights?: string[] }
    expect(saved.lostHighlights).toEqual(['Gone from the page'])
    expect(quoteHighlights(saved.content[ARTICLE_PROPERTY_ID]!).map((h) => [h.quoteId, h.text])).toEqual([
      ['q1', 'scoring treats'],
      ['q2', 'bold both'],
    ])
    expect(quoteHighlights(store.getObject(link.id)!.content[ARTICLE_PROPERTY_ID]!)).toHaveLength(2)
  })

  it('keeps server changes when a client saves an older copy', async () => {
    const { app, store, clock, weblinks } = setup()
    const link = (await (await app.request('/api/spaces/s/weblinks', json('POST', { url: 'https://site.example/story' }))).json()) as ObjectRecord
    clock.at = '2026-10-18T12:01:00.000Z'
    await weblinks.idle()
    await weblinks.saveReadable(link.id)
    clock.at = '2026-10-18T12:02:00.000Z'
    // The client still has the copy from before the readable text and the preview image.
    const put = await app.request(`/api/objects/${link.id}`, json('PUT', { ...link, title: 'Renamed', media: { url: 'https://evil.example' } }))
    const saved = (await put.json()) as ObjectRecord
    expect(saved.title).toBe('Renamed')
    expect(saved.media).toMatchObject({ url: 'https://site.example/story', previewImageFile: { mimeType: 'image/png' } })
    expect(saved.content[ARTICLE_PROPERTY_ID]).toEqual(store.getObject(link.id)!.content[ARTICLE_PROPERTY_ID])
    expect(saved.content[ARTICLE_PROPERTY_ID]).toBeDefined()
  })
})

describe('captured links', () => {
  it('get their preview image and, when enabled, readable text in the background', async () => {
    const { store, media, weblinks } = setup()
    const capture = new CaptureService({ store, media, weblinks, saveReadable: true, timeZone: 'UTC', now: () => '2026-10-18T12:00:00.000Z' })
    const { objects } = await capture.note({ text: 'look https://site.example/story' })
    await weblinks.idle()
    const link = store.getObject(objects[0]!.id)!
    expect(link.media?.previewImageFile).toBeDefined()
    expect(link.content[ARTICLE_PROPERTY_ID]?.content.length).toBeGreaterThan(0)
    // Capturing it again reuses the weblink and does no more work.
    const again = await capture.weblink({ url: 'https://site.example/story' })
    expect(again.objects[0]!.id).toBe(link.id)
  })
})
