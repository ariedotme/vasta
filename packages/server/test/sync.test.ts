import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HybridClock,
  MAX_CLOCK_DRIFT_MS,
  SYNC_PROTOCOL,
  applyFields,
  builtinTypeId,
  createBuiltinTypes,
  formatHlc,
  mergeFields,
  recordFields,
  type FieldClock,
  type Hlc,
  type ObjectRecord,
  type SyncTable,
} from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore, type SyncTombstone } from '@vasta/core/node'
import { Y, readContent, writeContent, type JsonDoc } from '@vasta/editor-schema/yjs'
import { createApp } from '../src/app.ts'
import { ChangeFeed, type ChangeEvent } from '../src/events.ts'
import type { PulledRow, SyncChange, SyncChangeResult } from '../src/sync.ts'
import { asUser } from './helpers.ts'

type Request = (input: string, init?: RequestInit) => Response | Promise<Response>
type Pulled = { protocol: number; rev: number; more: boolean; rows: PulledRow[]; tombstones: SyncTombstone[]; spaces: string[] }
type Pushed = { protocol: number; rev: number; changes: SyncChangeResult[] }

const json = (body: unknown, method = 'POST') => ({ method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const paragraphs = (...texts: string[]): JsonDoc => ({ type: 'doc', content: texts.map((text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })) })

/**
 * A sync client as step 4 will have one, reduced to what the protocol needs: a replica of rows
 * with their clocks, a Y.Doc per object for rich text, an outbox of changes, and a clock of its
 * own. `time` is its wall clock.
 */
class Client {
  readonly rows = new Map<string, { table: SyncTable; spaceId: string; record: Record<string, unknown>; clock: FieldClock }>()
  readonly texts = new Map<string, Y.Doc>()
  readonly clock: HybridClock
  outbox: SyncChange[] = []
  since = 0
  time = Date.now() - 60_000

  readonly request: Request

  constructor(node: string, request: Request) {
    this.clock = new HybridClock(node)
    this.request = request
  }

  get<T = ObjectRecord>(table: SyncTable, id: string) {
    return this.rows.get(`${table}:${id}`)?.record as T | undefined
  }

  /** Change fields locally and queue them; a new row needs `spaceId`. */
  edit(table: SyncTable, id: string, fields: Record<string, unknown>, spaceId?: string) {
    this.time += 1000
    const hlc = this.clock.tick(this.time)
    const key = `${table}:${id}`
    const row = this.rows.get(key) ?? { table, spaceId: spaceId!, record: { id, spaceId, aliases: [], tagIds: [], collectionIds: [], props: {}, content: {} }, clock: {} }
    row.record = applyFields(table, row.record as never, fields) as unknown as Record<string, unknown>
    for (const name of Object.keys(fields)) row.clock[name] = hlc
    this.rows.set(key, row)
    this.outbox.push({ table, id, ...(spaceId ? { spaceId } : {}), fields: Object.fromEntries(Object.entries(fields).map(([n, value]) => [n, { value, hlc }])) })
  }

  /** Edit an object's rich text as the editor would (a minimal diff into the Y.Doc) and queue the update. */
  editText(id: string, field: string, doc: JsonDoc) {
    const ydoc = this.text(id)
    const before = Y.encodeStateVector(ydoc)
    writeContent(ydoc, { [field]: doc }, undefined, [field])
    this.showText(id)
    this.outbox.push({ table: 'objects', id, text: base64(Y.encodeStateAsUpdate(ydoc, before)) })
  }

  text(id: string) {
    let ydoc = this.texts.get(id)
    if (!ydoc) this.texts.set(id, (ydoc = new Y.Doc()))
    return ydoc
  }

  /** The replica's JSON of an object's text follows its Y.Doc. */
  private showText(id: string) {
    const row = this.rows.get(`objects:${id}`)
    if (row) row.record.content = readContent(this.text(id))
  }

  /** Ask for the text of objects whose pulled state vector differs from the local one. */
  private async pullText(rows: PulledRow[]) {
    const lagging = rows.filter((row) => row.textVector && row.textVector !== base64(Y.encodeStateVector(this.text(row.id))))
    if (!lagging.length) return
    const objects = Object.fromEntries(lagging.map((row) => [row.id, base64(Y.encodeStateVector(this.text(row.id)))]))
    const response = await this.request('/api/sync/text', json({ protocol: SYNC_PROTOCOL, objects }))
    expect(response.status).toBe(200)
    const answer = (await response.json()) as { objects: Record<string, string> }
    for (const [id, update] of Object.entries(answer.objects)) {
      Y.applyUpdate(this.text(id), Buffer.from(update, 'base64'))
      this.showText(id)
    }
  }

  async push(): Promise<Pushed> {
    const response = await this.request('/api/sync/push', json({ protocol: SYNC_PROTOCOL, changes: this.outbox }))
    expect(response.status).toBe(200)
    this.outbox = []
    return (await response.json()) as Pushed
  }

  async pullPage(limit = 500, space?: string): Promise<Pulled> {
    const response = await this.request(`/api/sync/pull?protocol=${SYNC_PROTOCOL}&since=${this.since}&limit=${limit}${space ? `&space=${space}` : ''}`)
    expect(response.status).toBe(200)
    const page = (await response.json()) as Pulled
    for (const row of page.rows) this.merge(row)
    await this.pullText(page.rows)
    for (const tombstone of page.tombstones) this.rows.delete(`${tombstone.table}:${tombstone.id}`)
    for (const [key, row] of this.rows) if (!page.spaces.includes(row.spaceId)) this.rows.delete(key)
    this.since = page.rev
    return page
  }

  async pull(limit = 500) {
    let pages = 0
    while ((await this.pullPage(limit)).more) pages++
    return pages + 1
  }

  /** Merge a pulled row field by field, so unsent local changes survive it. Text comes from the Y.Doc. */
  private merge(row: PulledRow) {
    const key = `${row.table}:${row.id}`
    const local = this.rows.get(key)
    for (const hlc of Object.values(row.clock)) this.clock.observe(hlc)
    if (!local) {
      this.rows.set(key, { table: row.table, spaceId: row.spaceId, record: { ...(row.record as unknown as Record<string, unknown>), content: {} }, clock: { ...row.clock } })
      if (row.table === 'objects') this.showText(row.id)
      return
    }
    const fields = recordFields(row.table, row.record as never)
    const incoming = Object.fromEntries(Object.entries(row.clock).map(([name, hlc]) => [name, { value: fields[name] ?? null, hlc }]))
    const { taken, clock } = mergeFields(local.clock, incoming)
    const { updatedAt } = row.record as { updatedAt?: string }
    local.record = { ...(applyFields(row.table, local.record as never, taken) as unknown as Record<string, unknown>), ...(updatedAt ? { updatedAt } : {}) }
    local.clock = clock
  }
}

function setup() {
  const store = new NodeStore(':memory:')
  const at = '2026-10-01T12:00:00.000Z'
  for (const id of ['s', 'other', 'shared']) {
    store.putSpace({ id, name: id, sidebar: [], createdAt: at })
    for (const type of createBuiltinTypes(id, at)) store.putType(type)
  }
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-sync-')))
  const feed = new ChangeFeed()
  const app = createApp({ store, media, feed })
  const user = asUser(app, store, { spaces: ['s', 'shared'] })
  const a = new Client('phone', user.request)
  const b = new Client('laptop', user.request)
  return { store, app, feed, user, a, b, page: builtinTypeId('s', 'page'), task: builtinTypeId('s', 'task') }
}

async function createPage(request: Request, typeId: string, title: string, extra: Partial<ObjectRecord> = {}) {
  return (await (await request('/api/objects', json({ typeId, title, ...extra }))).json()) as ObjectRecord
}

describe('sync', () => {
  it('keeps edits of different fields of the same object made offline on two devices', async () => {
    const { user, a, b, task } = setup()
    const note = await createPage(user.request, task, 'Write the report')
    await a.pull()
    await b.pull()
    expect(a.get('objects', note.id)?.title).toBe('Write the report')

    a.edit('objects', note.id, { title: 'Write the annual report' })
    b.edit('objects', note.id, { 'props.status': { kind: 'select', value: ['doing'] } })
    expect((await a.push()).changes).toEqual([{ table: 'objects', id: note.id, lost: [] }])
    expect((await b.push()).changes).toEqual([{ table: 'objects', id: note.id, lost: [] }])
    await a.pull()
    await b.pull()

    for (const client of [a, b]) {
      expect(client.get('objects', note.id)).toMatchObject({ title: 'Write the annual report', props: { status: { kind: 'select', value: ['doing'] } } })
    }
    // The app's HTTP API sees the merged object, search included.
    const stored = (await (await user.request(`/api/objects/${note.id}`)).json()) as ObjectRecord
    expect(stored).toMatchObject({ title: 'Write the annual report', props: { status: { value: ['doing'] } } })
    expect(((await (await user.request('/api/spaces/s/search?q=annual')).json()) as ObjectRecord[]).map((o) => o.id)).toEqual([note.id])
  })

  it('lets the later write of the same field win, on the server and on both devices', async () => {
    const { user, a, b, page } = setup()
    const note = await createPage(user.request, page, 'Draft')
    await a.pull()
    await b.pull()
    b.edit('objects', note.id, { title: 'From the laptop' })
    a.time = b.time + 5000
    a.edit('objects', note.id, { title: 'From the phone, later' })

    await a.push()
    const late = await b.push()
    expect(late.changes[0]).toEqual({ table: 'objects', id: note.id, lost: ['title'] })
    await a.pull()
    await b.pull()
    expect(a.get('objects', note.id)?.title).toBe('From the phone, later')
    expect(b.get('objects', note.id)?.title).toBe('From the phone, later')
    expect(((await (await user.request(`/api/objects/${note.id}`)).json()) as ObjectRecord).title).toBe('From the phone, later')

    // Pushing the same change again is harmless.
    a.edit('objects', note.id, { description: 'once' })
    const change = a.outbox[0]!
    await a.push()
    const rev = (await a.pullPage()).rev
    a.outbox = [change]
    expect((await a.push()).changes[0]).toEqual({ table: 'objects', id: note.id, lost: [] })
    expect((await a.pullPage()).rev).toBe(rev)
  })

  it('resolves a delete racing an edit, restores from the trash, and tombstones a purge', async () => {
    const { user, a, b, page } = setup()
    const note = await createPage(user.request, page, 'Old idea')
    await a.pull()
    await b.pull()
    a.edit('objects', note.id, { deletedAt: new Date(a.time).toISOString() })
    b.edit('objects', note.id, { title: 'Old idea, revised' })
    await a.push()
    await b.push()
    await a.pull()
    await b.pull()
    for (const client of [a, b]) expect(client.get('objects', note.id)).toMatchObject({ title: 'Old idea, revised', deletedAt: expect.any(String) })
    const trash = (await (await user.request('/api/spaces/s/trash')).json()) as { objects: ObjectRecord[] }
    expect(trash.objects.map((o) => o.title)).toEqual(['Old idea, revised'])

    expect((await user.request(`/api/objects/${note.id}/restore`, { method: 'POST' })).status).toBe(200)
    await a.pull()
    expect(a.get('objects', note.id)?.deletedAt).toBeUndefined()

    await user.request(`/api/objects/${note.id}`, { method: 'DELETE' })
    expect((await user.request(`/api/objects/${note.id}?forever=1`, { method: 'DELETE' })).status).toBe(204)
    const pulled = await a.pullPage()
    expect(pulled.tombstones).toEqual([expect.objectContaining({ table: 'objects', id: note.id, spaceId: 's' })])
    expect(a.get('objects', note.id)).toBeUndefined()
    await b.pull()
    expect(b.get('objects', note.id)).toBeUndefined()

    // A device that still has it cannot bring it back.
    b.edit('objects', note.id, { title: 'Resurrected' }, 's')
    expect((await b.push()).changes[0]?.error).toBe('deleted for good')
  })

  it('keeps items captured into a daily note while a device edits another field of it', async () => {
    const { user, a } = setup()
    const today = (await (await user.request('/api/capture/today?spaceId=s')).json()) as { dailyNoteId: string }
    await a.pull()
    a.edit('objects', today.dailyNoteId, { 'props.mood': { kind: 'text', value: 'calm' } })

    expect((await user.request('/api/capture/note', json({ text: 'Call the bank', spaceId: 's' }))).status).toBe(201)
    expect((await a.push()).changes[0]?.lost).toEqual([])
    await a.pull()
    const note = a.get('objects', today.dailyNoteId)!
    expect(note.props.mood).toEqual({ kind: 'text', value: 'calm' })
    expect(JSON.stringify(note.content.body)).toContain('Call the bank')
    const stored = (await (await user.request(`/api/objects/${today.dailyNoteId}`)).json()) as ObjectRecord
    expect(JSON.stringify(stored.content.body)).toContain('Call the bank')
    expect(stored.props.mood).toEqual({ kind: 'text', value: 'calm' })
  })

  it('creates objects and types pushed by a device', async () => {
    const { store, user, a } = setup()
    await a.pull()
    a.edit('types', 'type-book', { name: 'Book', properties: [], views: [] }, 's')
    a.edit('objects', 'obj-dune', { typeId: 'type-book', title: 'Dune' }, 's')
    a.editText('obj-dune', 'body', paragraphs('spice'))
    expect((await a.push()).changes.map((c) => c.error)).toEqual([undefined, undefined, undefined])
    expect(store.getType('type-book')).toMatchObject({ name: 'Book', pluralName: 'Book', spaceId: 's' })
    const dune = (await (await user.request('/api/objects/obj-dune')).json()) as ObjectRecord
    expect(dune).toMatchObject({ title: 'Dune', typeId: 'type-book', spaceId: 's', aliases: [] })
    expect(((await (await user.request('/api/spaces/s/search?q=spice')).json()) as ObjectRecord[]).map((o) => o.id)).toEqual(['obj-dune'])

    // An object must name a type of its own space.
    a.edit('objects', 'obj-x', { typeId: builtinTypeId('other', 'page'), title: 'x' }, 's')
    a.edit('objects', 'obj-y', { title: 'no type' }, 's')
    expect((await a.push()).changes.map((c) => c.error)).toEqual(['typeId must be a type of the same space', 'typeId must be a type of the same space'])
    expect(store.getObject('obj-x')).toBeUndefined()
  })

  it('refuses what a client may not change, unknown protocols and clocks far ahead', async () => {
    const { user, a, page } = setup()
    const note = await createPage(user.request, page, 'Note')
    await a.pull()
    const now = Date.now()
    const change = (fields: SyncChange['fields'], extra: Partial<SyncChange> = {}) => ({ table: 'objects' as const, id: note.id, fields, ...extra })
    const hlc = (offset = 0): Hlc => formatHlc(now + offset, 0, 'phone')
    a.outbox = [
      change({ media: { value: { url: 'https://evil.example' }, hlc: hlc() } }),
      change({ title: { value: 42, hlc: hlc() } }),
      change({ title: { value: 'Ok', hlc: 'yesterday' } }),
      change({ title: { value: 'Future', hlc: hlc(MAX_CLOCK_DRIFT_MS + 60_000) } }),
      change({ title: { value: 'Moved', hlc: hlc() } }, { spaceId: 'shared' }),
      { table: 'users' as never, id: 'u', fields: { name: { value: 'x', hlc: hlc() } } },
      { table: 'spaces', id: 'new-space', spaceId: 'new-space', fields: { name: { value: 'Mine', hlc: hlc() } } },
      { table: 'spaces', id: 's', fields: { deletedAt: { value: new Date().toISOString(), hlc: hlc() } } },
      { table: 'types', id: builtinTypeId('s', 'page'), fields: { deletedAt: { value: new Date().toISOString(), hlc: hlc() } } },
    ]
    const errors = (await a.push()).changes.map((c) => c.error)
    expect(errors).toEqual([
      'media cannot be changed by a client',
      'invalid value for title',
      'title needs a value and an hlc',
      expect.stringContaining('clock too far ahead'),
      'a row cannot move to another space',
      'unknown table users',
      'create spaces over HTTP',
      'deletedAt cannot be changed by a client',
      'built-in types cannot be deleted',
    ])
    expect(((await (await user.request(`/api/objects/${note.id}`)).json()) as ObjectRecord).title).toBe('Note')

    expect((await user.request('/api/sync/pull?protocol=0')).status).toBe(409)
    expect((await user.request('/api/sync/pull')).status).toBe(409)
    const wrong = await user.request('/api/sync/push', json({ protocol: 99, changes: [] }))
    expect(wrong.status).toBe(409)
    expect(await wrong.json()).toMatchObject({ protocol: SYNC_PROTOCOL })
    expect((await user.request('/api/sync/push', json({ protocol: SYNC_PROTOCOL }))).status).toBe(400)
  })

  it('only pulls and pushes rows of the spaces the user is a member of', async () => {
    const { store, app, user, a } = setup()
    const elsewhere = await createPage(asUser(app, store, { username: 'partner', spaces: ['other'] }).request, builtinTypeId('other', 'page'), 'Private')
    await a.pull()
    expect([...a.rows.values()].every((r) => r.spaceId === 's' || r.spaceId === 'shared')).toBe(true)
    expect(a.get('objects', elsewhere.id)).toBeUndefined()
    expect((await user.request(`/api/sync/pull?protocol=${SYNC_PROTOCOL}&space=other`)).status).toBe(404)

    a.edit('objects', elsewhere.id, { title: 'Mine now' })
    a.edit('objects', 'new-in-other', { typeId: builtinTypeId('other', 'page'), title: 'x' }, 'other')
    a.edit('spaces', 'other', { name: 'Taken' })
    expect((await a.push()).changes.map((c) => c.error)).toEqual(['not found', 'not found', 'not found'])
    expect(store.getObject(elsewhere.id)?.title).toBe('Private')
    expect(store.getSpace('other')?.name).toBe('other')

    // Leaving a space: it disappears from `spaces`, and the client drops its rows.
    expect([...a.rows.values()].some((r) => r.spaceId === 'shared')).toBe(true)
    store.removeMember('shared', user.user.id)
    const pulled = await a.pullPage()
    expect(pulled.spaces).toEqual(['s'])
    expect([...a.rows.values()].some((r) => r.spaceId === 'shared')).toBe(false)

    // Joining one: pull it from the start with `space`.
    store.putMember({ spaceId: 'other', userId: user.user.id, role: 'editor', createdAt: new Date().toISOString() })
    const since = a.since
    a.since = 0
    await a.pullPage(500, 'other')
    a.since = since
    expect(a.get('objects', elsewhere.id)?.title).toBe('Private')
  })

  it('pages a big pull without missing a change made in the middle', async () => {
    const { user, a, b, page } = setup()
    const notes: ObjectRecord[] = []
    for (let i = 0; i < 25; i++) notes.push(await createPage(user.request, page, `Note ${i}`))
    await b.pull()

    const first = await a.pullPage(10)
    expect(first.more).toBe(true)
    expect(first.rows.length).toBe(10)
    // A row already pulled changes while A is still paging: its new revision comes later.
    const early = first.rows.find((r) => r.table === 'objects')
    b.edit('objects', early?.id ?? notes[0]!.id, { title: 'Changed while paging' })
    await b.push()
    let pages = 1
    while ((await a.pullPage(10)).more) pages++
    expect(pages).toBeGreaterThan(2)
    expect(a.get('objects', early?.id ?? notes[0]!.id)?.title).toBe('Changed while paging')
    for (const note of notes.slice(1)) expect(a.get('objects', note.id)?.title).toBe(note.title)
    expect([...a.rows.keys()].sort()).toEqual([...b.rows.keys()].sort())
  })

  it('announces new revisions to the events stream of members', async () => {
    const { feed, user, page } = setup()
    const events: ChangeEvent[] = []
    feed.subscribe((event) => events.push(event))
    const note = await createPage(user.request, page, 'Note')
    expect(events).toContainEqual({ kind: 'rev', spaceId: 's', rev: expect.any(Number) })
    expect(events).toContainEqual(expect.objectContaining({ kind: 'object', id: note.id }))
  })
})

describe('sync of rich text', () => {
  const textOf = (record: ObjectRecord | undefined, field = 'body') =>
    (record?.content[field]?.content ?? []).map((node) => (node.content ?? []).map((child) => child.text ?? '').join(''))

  it('merges edits of the same paragraph made offline on two devices', async () => {
    const { store, user, a, b, page } = setup()
    const note = await createPage(user.request, page, 'Note', { content: { body: paragraphs('Hello world') as never } })
    await a.pull()
    await b.pull()
    expect(textOf(a.get('objects', note.id))).toEqual(['Hello world'])

    a.editText(note.id, 'body', paragraphs('Hello brave world'))
    b.editText(note.id, 'body', paragraphs('Hello world!'))
    expect((await a.push()).changes).toEqual([{ table: 'objects', id: note.id, lost: [] }])
    await b.push()
    await a.pull()
    await b.pull()
    for (const client of [a, b]) expect(textOf(client.get('objects', note.id))).toEqual(['Hello brave world!'])
    expect(textOf(store.getObject(note.id))).toEqual(['Hello brave world!'])
    // Search and updatedAt follow the merged text.
    expect(((await (await user.request('/api/spaces/s/search?q=brave')).json()) as ObjectRecord[]).map((o) => o.id)).toEqual([note.id])
    expect(store.getObject(note.id)!.updatedAt > note.updatedAt).toBe(true)
  })

  it('keeps a capture made while a device edits the text of the daily note', async () => {
    const { store, user, a } = setup()
    const today = (await (await user.request('/api/capture/today?spaceId=s')).json()) as { dailyNoteId: string }
    await a.pull()
    a.editText(today.dailyNoteId, 'body', paragraphs('Plans for today'))

    expect((await user.request('/api/capture/note', json({ text: 'Call the bank', spaceId: 's' }))).status).toBe(201)
    await a.push()
    await a.pull()
    for (const record of [a.get('objects', today.dailyNoteId), store.getObject(today.dailyNoteId)]) {
      const body = JSON.stringify(record?.content.body)
      expect(body).toContain('Plans for today')
      expect(body).toContain('Call the bank')
    }
    expect(JSON.stringify(a.get('objects', today.dailyNoteId)?.content)).toBe(JSON.stringify(store.getObject(today.dailyNoteId)?.content))
  })

  it("writes the app's whole-document saves as small diffs, so they merge with a device's edits", async () => {
    const { store, user, a, page } = setup()
    const note = await createPage(user.request, page, 'Note', { content: { body: paragraphs('First', 'Second') as never } })
    await a.pull()
    a.editText(note.id, 'body', paragraphs('First, edited on the phone', 'Second'))

    // The app saves its own copy, with the second paragraph changed.
    const saved = await user.request(`/api/objects/${note.id}`, json({ ...note, content: { body: paragraphs('First', 'Second, edited in the browser') } }, 'PUT'))
    expect(saved.status).toBe(200)
    // It gets back the document as its editor would save it, so it does not reload it.
    expect(((await saved.json()) as ObjectRecord).content).toEqual({ body: paragraphs('First', 'Second, edited in the browser') })
    await a.push()
    await a.pull()
    expect(textOf(a.get('objects', note.id))).toEqual(['First, edited on the phone', 'Second, edited in the browser'])
    expect(textOf(store.getObject(note.id))).toEqual(['First, edited on the phone', 'Second, edited in the browser'])
  })

  it('answers only the text a device lacks, and only in its spaces', async () => {
    const { store, user, a, page } = setup()
    const long = paragraphs(...Array.from({ length: 50 }, (_, i) => `Paragraph ${i} with some words in it`))
    const note = await createPage(user.request, page, 'Note', { content: { body: long as never } })
    await a.pull()
    const vector = base64(Y.encodeStateVector(a.text(note.id)))
    const full = base64(Y.encodeStateAsUpdate(a.text(note.id)))
    await user.request(`/api/objects/${note.id}`, json({ ...note, title: 'Renamed', content: { body: { ...long, content: [...long.content, ...paragraphs('One more').content] } } }, 'PUT'))

    const at = '2026-10-01T12:00:00.000Z'
    const hidden = store.putObject({
      id: 'hidden', spaceId: 'other', typeId: builtinTypeId('other', 'page'), title: 'Hidden', aliases: [], tagIds: [], collectionIds: [], props: {},
      content: { body: paragraphs('secret') as never }, createdAt: at, updatedAt: at,
    })
    const response = await user.request('/api/sync/text', json({ protocol: SYNC_PROTOCOL, objects: { [note.id]: vector, [hidden.id]: '', missing: '' } }))
    const { objects } = (await response.json()) as { objects: Record<string, string> }
    expect(Object.keys(objects)).toEqual([note.id])
    expect(objects[note.id]!.length).toBeLessThan(full.length / 4)
    Y.applyUpdate(a.text(note.id), Buffer.from(objects[note.id]!, 'base64'))
    expect(readContent(a.text(note.id)).body?.content.at(-1)).toEqual(paragraphs('One more').content[0])

    expect((await user.request('/api/sync/text', json({ protocol: SYNC_PROTOCOL }))).status).toBe(400)
    expect((await user.request('/api/sync/text', json({ protocol: 1, objects: {} }))).status).toBe(409)
  })

  it('refuses rich text as a field, and text updates that do not decode or build on changes the server lacks', async () => {
    const { user, a, page } = setup()
    const note = await createPage(user.request, page, 'Note', { content: { body: paragraphs('Hello') as never } })
    await a.pull()
    const hlc = formatHlc(Date.now(), 0, 'phone')

    // Two edits on another device; the server only gets the second one.
    const other = new Y.Doc()
    Y.applyUpdate(other, Y.encodeStateAsUpdate(a.text(note.id)))
    writeContent(other, { body: paragraphs('Hello again') })
    const middle = Y.encodeStateVector(other)
    writeContent(other, { body: paragraphs('Hello again and again') })
    const second = base64(Y.encodeStateAsUpdate(other, middle))

    a.outbox = [
      { table: 'objects', id: note.id, fields: { 'content.body': { value: paragraphs('Overwritten'), hlc } } },
      { table: 'objects', id: note.id, text: 'not base64!' },
      { table: 'objects', id: note.id, text: base64(new TextEncoder().encode('garbage, not a Yjs update')) },
      { table: 'objects', id: note.id, text: second },
      { table: 'types', id: page, text: second },
      { table: 'objects', id: note.id },
    ]
    expect((await a.push()).changes.map((c) => c.error)).toEqual([
      'content.body cannot be changed by a client',
      'text must be a base64 Yjs update',
      'text must be a base64 Yjs update',
      'the text update builds on changes the server lacks; pull first',
      'only objects have rich text',
      'fields or text are required',
    ])
    expect(textOf((await (await user.request(`/api/objects/${note.id}`)).json()) as ObjectRecord)).toEqual(['Hello'])
  })
})
