// Devices with a local replica (ClientStore on sqlite-wasm, as in the web app's worker) syncing
// with the real server through its sync endpoints, offline and back.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BODY_PROPERTY_ID, builtinTypeId, createBuiltinTypes, dailyNoteId, dayEntries, dayTotals, newObject, type Doc, type DocNode, type ObjectRecord, type ObjectType } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { Y, readContent, writeContent, type JsonDoc } from '@vasta/editor-schema/yjs'
import { createApp } from '../src/app.ts'
import { CalendarService } from '../src/calendars.ts'
import { ChangeFeed } from '../src/events.ts'
import { Device, asUser, now, paragraphs, texts, type Request } from './helpers.ts'

const at = '2026-10-19T12:00:00.000Z'
const ics = readFileSync(new URL('../../core/test/fixtures/sample.ics', import.meta.url), 'utf8')
const json = (body: unknown, method = 'POST') => ({ method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

/** A type of books with a relation, a number and a select without options. */
const book = (spaceId: string): ObjectType => ({
  id: spaceId === 's' ? 'book' : `book-${spaceId}`, spaceId, name: 'Livro', pluralName: 'Livros', createdAt: at, updatedAt: at, views: [],
  properties: [
    { id: 'body', kind: 'rich-text', name: 'Notes' },
    { id: 'author', kind: 'relation', name: 'Autor', targetTypeIds: [], multiple: false },
    { id: 'rating', kind: 'number', name: 'Nota' },
    { id: 'genre', kind: 'select', name: 'Gênero', multiple: false, options: [] },
  ],
})

function setup() {
  const store = new NodeStore(':memory:')
  for (const id of ['s', 'other']) {
    store.putSpace({ id, name: id, sidebar: [], createdAt: at })
    for (const type of createBuiltinTypes(id, at)) store.putType(type)
  }
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-replica-')))
  const feed = new ChangeFeed()
  const calendars = new CalendarService({ store, feed, now, fetch: (async () => new Response(ics, { status: 200 })) as typeof fetch })
  const app = createApp({ store, media, feed, calendars })
  const user = asUser(app, store, { spaces: ['s'] })
  return { store, app, user, phone: new Device('phone', user.request), laptop: new Device('laptop', user.request), page: builtinTypeId('s', 'page') }
}

async function serverObject(request: Request, id: string) {
  return (await (await request(`/api/objects/${id}`)).json()) as ObjectRecord
}

describe('local replica', () => {
  it('pulls the user’s spaces with their text, and pushes what the device created offline', async () => {
    const { user, phone, page } = setup()
    const made = (await (await user.request('/api/objects', json({ typeId: page, title: 'From the server', content: { body: paragraphs('Hello') } }))).json()) as ObjectRecord
    await phone.sync.sync()
    expect(phone.store.listSpaces().map((s) => s.id)).toEqual(['s'])
    expect(texts(phone.store.getObject(made.id)!.content.body)).toEqual(['Hello'])
    expect(phone.store.search('s', 'hello').map((o) => o.id)).toEqual([made.id])

    phone.online = false
    const type = phone.store.createType({ spaceId: 's', name: 'Recipe' }, now())
    const bread = phone.store.createObject({ typeId: type.id, title: 'Bread', content: { body: paragraphs('Flour, water') as Doc } }, now())
    phone.store.saveObject({ ...phone.store.getObject(made.id)!, title: 'Renamed offline' }, now())
    await expect(phone.sync.sync()).rejects.toThrow()
    expect(phone.store.outboxSize()).toBe(3)

    phone.online = true
    const result = await phone.sync.sync()
    expect(result.refused).toEqual([])
    expect(phone.store.outboxSize()).toBe(0)
    expect((await serverObject(user.request, made.id)).title).toBe('Renamed offline')
    const stored = await serverObject(user.request, bread.id)
    expect([stored.title, stored.typeId, texts(stored.content.body)]).toEqual(['Bread', type.id, ['Flour, water']])
  })

  it('knows who made what: the device’s user offline, the server’s say after a sync', async () => {
    const { store, app, user, phone, page } = setup()
    const ana = asUser(app, store, { username: 'ana', spaces: ['s'] })
    phone.store.user = user.user.id
    const fromAna = (await (await ana.request('/api/objects', json({ typeId: page, title: 'By Ana' }))).json()) as ObjectRecord
    await phone.sync.sync()
    expect(phone.store.getObject(fromAna.id)).toMatchObject({ createdBy: ana.user.id, updatedBy: ana.user.id })

    phone.online = false
    const mine = phone.store.createObject({ typeId: page, title: 'Mine' }, now())
    expect(mine).toMatchObject({ createdBy: user.user.id, updatedBy: user.user.id })
    const edited = phone.store.saveObject({ ...phone.store.getObject(fromAna.id)!, title: 'By Ana, edited' }, now())
    expect(edited).toMatchObject({ createdBy: ana.user.id, updatedBy: user.user.id })
    phone.online = true
    await phone.sync.sync()
    expect(store.getObject(mine.id)).toMatchObject({ createdBy: user.user.id })
    expect(store.getObject(fromAna.id)).toMatchObject({ createdBy: ana.user.id, updatedBy: user.user.id })

    // Ana edits it again: the phone hears it was her.
    await ana.request(`/api/objects/${fromAna.id}`, json({ ...store.getObject(fromAna.id)!, title: 'Ana again' }, 'PUT'))
    await phone.sync.sync()
    expect(phone.store.getObject(fromAna.id)).toMatchObject({ title: 'Ana again', updatedBy: ana.user.id })
  })

  it('turns sprints on offline, and the server takes the type, the field and the setting', async () => {
    const { store, phone } = setup()
    await phone.sync.sync()
    phone.online = false
    phone.store.setSprints('s', { enabled: true, name: 'Rodada' }, now())
    phone.online = true
    await phone.sync.sync()
    expect(store.getSpace('s')!.sprints).toEqual({ enabled: true, name: 'Rodada', pluralName: 'Rodadas' })
    expect(store.getType(builtinTypeId('s', 'sprint'))).toMatchObject({ system: 'sprint', name: 'Rodada' })
    expect(store.getType(builtinTypeId('s', 'task'))!.properties.some((p) => p.id === 'sprint')).toBe(true)
  })

  it('merges offline edits of two devices: other fields both kept, the same field the later one, text both', async () => {
    const { user, phone, laptop, page } = setup()
    const note = (await (await user.request('/api/objects', json({ typeId: page, title: 'Plan', content: { body: paragraphs('One') } }))).json()) as ObjectRecord
    await phone.sync.sync()
    await laptop.sync.sync()
    phone.online = laptop.online = false

    phone.store.saveObject({ ...phone.store.getObject(note.id)!, title: 'Plan (phone)', icon: { kind: 'emoji', value: '📱' } }, now())
    const editor = phone.edit(note.id)
    editor.type('One', 'Two from the phone')
    await new Promise((resolve) => setTimeout(resolve, 5))
    laptop.store.saveObject({ ...laptop.store.getObject(note.id)!, title: 'Plan (laptop)', aliases: ['Planning'] }, now())
    const other = laptop.edit(note.id)
    other.type('One', 'Three from the laptop')

    phone.online = laptop.online = true
    await phone.sync.sync()
    await laptop.sync.sync()
    await phone.sync.sync()
    for (const device of [phone, laptop]) {
      const object = device.store.getObject(note.id)!
      expect([object.title, object.icon, object.aliases]).toEqual(['Plan (laptop)', { kind: 'emoji', value: '📱' }, ['Planning']])
      expect(texts(object.content.body).sort()).toEqual(['One', 'Three from the laptop', 'Two from the phone'])
    }
    // The open editors got the other device's text as it arrived.
    expect(editor.text().sort()).toEqual(['One', 'Three from the laptop', 'Two from the phone'])
    expect(other.text()).toEqual(editor.text())
    expect(texts((await serverObject(user.request, note.id)).content.body)).toEqual(editor.text())
    editor.close()
    other.close()
  })

  it('keeps a capture that arrives while the device types in the daily note offline', async () => {
    const { user, phone } = setup()
    const today = (await (await user.request('/api/capture/today?spaceId=s')).json()) as { day: string; dailyNoteId: string }
    await phone.sync.sync()
    const editor = phone.edit(today.dailyNoteId)
    phone.online = false
    editor.type('Typed offline')
    expect((await user.request('/api/capture/note', json({ text: 'Call the bank', spaceId: 's' }))).status).toBe(201)
    phone.online = true
    await phone.sync.sync()
    const lines = editor.text()
    expect(lines).toContain('Typed offline')
    expect(lines.some((line) => line.includes('Call the bank'))).toBe(true)
    // The inbox works on the replica, and marking the capture done reaches the server.
    const { items } = phone.store.inbox('s', today.day, 2)
    expect(items.map((i) => texts({ type: 'doc', content: i.content }))).toEqual([['Call the bank']])
    phone.store.markCaptureDone(today.dailyNoteId, items[0]!.id, true, now())
    await phone.sync.sync()
    const inbox = (await (await user.request(`/api/spaces/s/inbox?today=${items[0]!.day}`)).json()) as { items: { done: boolean }[] }
    expect(inbox.items.map((i) => i.done)).toEqual([true])
    expect(texts(readContent(editor.doc)[BODY_PROPERTY_ID])).toContain('Typed offline')
    editor.close()
  })

  it('captures offline into the day’s note, and the capture reaches the server and its inbox', async () => {
    const { user, phone } = setup()
    const today = (await (await user.request('/api/capture/today?spaceId=s')).json()) as { day: string; dailyNoteId: string }
    await phone.sync.sync()
    phone.online = false
    const result = phone.store.capture('s', 'Buy stamps https://example.org', 'desktop', today.day, now())
    expect(result.dailyNoteId).toBe(today.dailyNoteId)
    phone.online = true
    await phone.sync.sync()
    const inbox = (await (await user.request(`/api/spaces/s/inbox?today=${today.day}`)).json()) as { items: { id: string; channel: string; content: DocNode[] }[] }
    expect(inbox.items.map((i) => [i.id, i.channel])).toEqual([[result.blockId, 'desktop']])
    expect(inbox.items[0]!.content[0]!.content!.map((n) => n.marks?.[0]?.type ?? 'text')).toEqual(['text', 'link'])
  })

  it('captures offline into another of the user’s spaces (the capture space), not the open one', async () => {
    const { store, user, phone } = setup()
    store.putMember({ spaceId: 'other', userId: user.user.id, role: 'editor', createdAt: at })
    const today = (await (await user.request('/api/capture/today?spaceId=other')).json()) as { day: string; dailyNoteId: string }
    await phone.sync.sync()
    expect(phone.store.listSpaces().map((s) => s.id).sort()).toEqual(['other', 's'])
    phone.online = false
    const result = phone.store.capture('other', 'Pick up the parcel', 'desktop', today.day, now())
    expect(result.dailyNoteId).toBe(today.dailyNoteId)
    phone.online = true
    await phone.sync.sync()
    const inbox = (await (await user.request(`/api/spaces/other/inbox?today=${today.day}`)).json()) as { items: { id: string }[] }
    expect(inbox.items.map((i) => i.id)).toEqual([result.blockId])
    const open = (await (await user.request(`/api/spaces/s/inbox?today=${today.day}`)).json()) as { items: unknown[] }
    expect(open.items).toEqual([])
  })

  it('captures online through the server, links becoming weblinks', async () => {
    const { user } = setup()
    const response = await user.request('/api/spaces/s/captures', json({ text: 'Read later https://example.org/post', channel: 'desktop' }))
    expect(response.status).toBe(201)
    const { dailyNoteId } = (await response.json()) as { dailyNoteId: string }
    const note = await serverObject(user.request, dailyNoteId)
    const callout = note.content.body!.content.find((n) => n.type === 'callout')!
    expect((callout.attrs!.capture as { channel: string }).channel).toBe('desktop')
    expect(callout.content!.map((n) => n.type)).toEqual(['paragraph', 'objectEmbed'])
    expect((await user.request('/api/spaces/other/captures', json({ text: 'x' }))).status).toBe(404)
  })

  it('captures an object of a type offline, with the properties its first line names, embedded in the day’s note', async () => {
    const { store, user, phone } = setup()
    store.putType(book('s'))
    const today = (await (await user.request('/api/capture/today?spaceId=s')).json()) as { day: string; dailyNoteId: string }
    await phone.sync.sync()
    phone.online = false
    const result = phone.store.captureObject('s', 'book', 'Duna autor:"Frank Herbert" nota:4,5 gênero:clássico\nA classic', 'desktop', today.day, now(), 'America/Sao_Paulo')
    expect(result).toMatchObject({ dailyNoteId: today.dailyNoteId, summary: 'Livro “Duna”, autor Frank Herbert, nota 4.5, gênero clássico' })
    phone.online = true
    await phone.sync.sync()
    const note = await serverObject(user.request, today.dailyNoteId)
    const embed = note.content.body!.content.find((n) => n.type === 'callout')!.content![0]!
    expect(embed.attrs).toMatchObject({ display: 'inline' })
    const dune = await serverObject(user.request, embed.attrs!.objectId as string)
    expect(dune).toMatchObject({ typeId: 'book', title: 'Duna', props: { rating: { kind: 'number', value: 4.5 } } })
    expect(texts(dune.content.body!)).toEqual(['A classic'])
    const author = (dune.props.author as { value: string[] }).value[0]!
    expect(store.getObject(author)).toMatchObject({ title: 'Frank Herbert', typeId: builtinTypeId('s', 'page') })
    const genre = store.getType('book')!.properties.find((p) => p.id === 'genre')!
    expect(genre.kind === 'select' && genre.options.map((o) => o.label)).toEqual(['clássico'])
  })

  it('captures an object of a type online through the server, and creates one from a line in either', async () => {
    const { store, user, phone } = setup()
    store.putType(book('s'))
    store.putType(book('other'))
    const response = await user.request('/api/spaces/s/captures', json({ text: 'Duna nota:5', channel: 'desktop', typeId: 'book' }))
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ summary: 'Livro “Duna”, nota 5' })
    expect((await user.request('/api/spaces/s/captures', json({ text: 'Duna', typeId: 'book-other' }))).status).toBe(400)

    const created = (await (await user.request('/api/objects', json({ typeId: 'book', line: 'Hyperion nota:4' }))).json()) as ObjectRecord
    expect(created).toMatchObject({ title: 'Hyperion', props: { rating: { kind: 'number', value: 4 } } })
    await phone.sync.sync()
    const offline = phone.store.createObject({ typeId: 'book' }, now(), { text: 'Ilium autor:"Dan Simmons"', context: { today: '2026-10-19', timeZone: 'UTC' } })
    expect(offline.title).toBe('Ilium')
    expect(phone.store.getObject((offline.props.author as { value: string[] }).value[0]!)?.title).toBe('Dan Simmons')
  })

  it('gives a block an id to mention or embed it, on the server and on the replica', async () => {
    const { user, phone } = setup()
    const page = builtinTypeId('s', 'page')
    const content = { body: paragraphs('Chapter 1', 'The spice must flow.') as Doc }
    const created = (await (await user.request('/api/objects', json({ typeId: page, title: 'Dune', content }))).json()) as ObjectRecord
    const ask = (path: number[]) => user.request(`/api/objects/${created.id}/block-ids`, json({ field: 'body', path }))
    const { id } = (await (await ask([1])).json()) as { id: string }
    expect(id).toMatch(/^[a-z0-9]{8}$/)
    expect(((await (await ask([1])).json()) as { id: string }).id).toBe(id)
    expect((await serverObject(user.request, created.id)).content.body!.content[1]!.attrs).toMatchObject({ id })
    expect((await ask([7])).status).toBe(404)
    expect((await user.request(`/api/objects/${created.id}/block-ids`, json({ field: 'body', path: 'x' }))).status).toBe(400)

    await phone.sync.sync()
    phone.online = false
    const offline = phone.store.ensureBlockId(created.id, 'body', [0], now())!
    expect(offline).not.toBe(id)
    phone.online = true
    await phone.sync.sync()
    const ids = (await serverObject(user.request, created.id)).content.body!.content.map((n) => n.attrs?.id)
    expect(ids).toEqual([offline, id])
  })

  it('gives a day one daily note when two devices open it offline', async () => {
    const { user, phone, laptop } = setup()
    await phone.sync.sync()
    await laptop.sync.sync()
    phone.online = laptop.online = false
    const a = phone.store.dailyNote('s', '2026-11-02', now())
    const b = laptop.store.dailyNote('s', '2026-11-02', now())
    expect(a.id).toBe(dailyNoteId('s', '2026-11-02'))
    expect(b.id).toBe(a.id)
    const first = phone.edit(a.id)
    first.type('Phone')
    const second = laptop.edit(b.id)
    second.type('Laptop')
    phone.online = laptop.online = true
    await phone.sync.sync()
    await laptop.sync.sync()
    await phone.sync.sync()
    expect(first.text().sort()).toEqual(['Laptop', 'Phone'])
    const notes = (await (await user.request(`/api/types/${builtinTypeId('s', 'daily-note')}/objects`)).json()) as ObjectRecord[]
    expect(notes.filter((n) => n.date?.start.startsWith('2026-11-02')).length).toBe(1)
    first.close()
    second.close()
  })

  it('does not undo a pulled change when saving an older copy of the object', async () => {
    const { user, phone, page } = setup()
    const task = (await (await user.request('/api/objects', json({ typeId: page, title: 'Task' }))).json()) as ObjectRecord
    await phone.sync.sync()
    const base = phone.store.getObject(task.id)!
    await user.request(`/api/objects/${task.id}`, json({ ...task, description: 'From the laptop' }, 'PUT'))
    await phone.sync.sync()
    // The page was opened before the pull and only the title was edited on it.
    phone.store.saveObject({ ...base, title: 'Task, renamed' }, now(), base)
    await phone.sync.sync()
    const stored = await serverObject(user.request, task.id)
    expect([stored.title, stored.description]).toEqual(['Task, renamed', 'From the laptop'])
  })

  it('deletes a type with its objects offline, follows purges, and drops a space the user left', async () => {
    const { store, user, phone, laptop } = setup()
    const type = (await (await user.request('/api/types', json({ spaceId: 's', name: 'Book' }))).json()) as { id: string }
    const book = (await (await user.request('/api/objects', json({ typeId: type.id, title: 'Dune' }))).json()) as ObjectRecord
    const loose = (await (await user.request('/api/objects', json({ typeId: builtinTypeId('s', 'page'), title: 'Loose' }))).json()) as ObjectRecord
    await phone.sync.sync()
    await laptop.sync.sync()

    phone.online = false
    phone.store.trashType(type.id, now())
    phone.online = true
    await phone.sync.sync()
    await laptop.sync.sync()
    expect(laptop.store.listDeletedTypes('s').map((t) => [t.id, t.objectCount])).toEqual([[type.id, 1]])
    expect(laptop.store.getObject(book.id)?.deletedAt).toBeDefined()

    await user.request(`/api/objects/${loose.id}`, { method: 'DELETE' })
    await user.request(`/api/objects/${loose.id}?forever=1`, { method: 'DELETE' })
    await laptop.sync.sync()
    expect(laptop.store.getObject(loose.id)).toBeUndefined()

    // Added to another space: pulled whole; removed from it: dropped.
    const member = store.listUsers().at(-1)!
    store.putMember({ spaceId: 'other', userId: member.id, role: 'editor', createdAt: at })
    await laptop.sync.sync()
    expect(laptop.store.listSpaces().map((s) => s.id).sort()).toEqual(['other', 's'])
    expect(laptop.store.listTypes('other').length).toBeGreaterThan(3)
    store.removeMember('other', member.id)
    await laptop.sync.sync()
    expect(laptop.store.listSpaces().map((s) => s.id)).toEqual(['s'])
    expect(laptop.store.listTypes('other')).toEqual([])
  })

  it('downloads subscribed calendars and shows their events offline', async () => {
    const { user, phone } = setup()
    const source = (await (await user.request('/api/spaces/s/calendar-sources', json({ url: 'https://example.com/cal.ics', name: 'Work' }))).json()) as { id: string }
    await phone.sync.sync()
    phone.online = false
    const server = (await (await user.request('/api/spaces/s/calendar?from=2026-10-26&to=2026-11-01&timeZone=America/Sao_Paulo')).json()) as { entries: { key: string }[] }
    const local = phone.store.calendar('s', { from: '2026-10-26', to: '2026-11-01' }, 'America/Sao_Paulo')
    expect(local.entries.map((e) => e.key)).toEqual(server.entries.map((e) => e.key))
    expect(local.entries.some((e) => e.kind === 'external' && e.sourceId === source.id)).toBe(true)
  })

  it('sends the whole text again when the server lacks what an update builds on', async () => {
    const { user, phone, page } = setup()
    const note = (await (await user.request('/api/objects', json({ typeId: page, title: 'Note', content: { body: paragraphs('A') } }))).json()) as ObjectRecord
    await phone.sync.sync()
    const editor = phone.edit(note.id)
    editor.type('A', 'B')
    // Pretend the server already had the local text: the update then misses what it builds on.
    const doc = new Y.Doc()
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(editor.doc))
    writeContent(doc, { body: paragraphs('A', 'B', 'C') }, undefined, ['body'])
    phone.store.applyLocalText(note.id, Y.encodeStateAsUpdate(doc), now(), 'editor')
    ;(phone.store as unknown as { setServerVector(id: string, v: Uint8Array): void }).setServerVector(note.id, Y.encodeStateVector(editor.doc))
    await phone.sync.sync()
    await phone.sync.sync()
    expect(phone.store.outboxSize()).toBe(0)
    expect(texts((await serverObject(user.request, note.id)).content.body)).toEqual(['A', 'B', 'C'])
    editor.close()
  })

  it('keeps the changes the server refuses until they are dismissed', async () => {
    const { user, phone, page } = setup()
    const note = (await (await user.request('/api/objects', json({ typeId: page, title: 'Groceries' }))).json()) as ObjectRecord
    await phone.sync.sync()
    phone.store.saveObject({ ...phone.store.getObject(note.id)!, icon: 'not an icon' as never }, now())
    const result = await phone.sync.sync()
    expect(result.refused.map((r) => [r.table, r.rowId, r.title])).toEqual([['objects', note.id, 'Groceries']])
    expect(result.refused[0]!.reason).toMatch(/icon/)
    expect(phone.store.outboxSize()).toBe(0)
    expect((await serverObject(user.request, note.id)).icon).toBeUndefined()

    expect((await phone.sync.sync()).refused).toEqual([])
    expect(phone.store.refusedChanges()).toEqual(result.refused)
    phone.store.dismissRefused(result.refused[0]!.id)
    expect(phone.store.refusedChanges()).toEqual([])
  })

  it('tells apps to stay off their replica when the server is started with VASTA_REPLICA=0', async () => {
    const store = new NodeStore(':memory:')
    const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-replica-')))
    const off = await createApp({ store, media, replica: false }).request('/api/auth/me')
    expect(off.headers.get('x-vasta-replica')).toBe('off')
    const on = await createApp({ store, media }).request('/api/auth/me')
    expect(on.headers.get('x-vasta-replica')).toBeNull()
  })

  it('splits a repeating date offline ("this and following"), and the copy reaches the server with its text', async () => {
    const { user, phone, page } = setup()
    const date = { start: '2026-10-19T12:00:00.000Z', end: '2026-10-19T13:00:00.000Z', resolution: 'time', rrule: 'FREQ=WEEKLY;COUNT=4', timeZone: 'America/Sao_Paulo' }
    const meeting = (await (await user.request('/api/objects', json({ typeId: page, title: 'Review', date, content: { body: paragraphs('Notes') } }))).json()) as ObjectRecord
    await phone.sync.sync()
    phone.online = false
    phone.store.changeOccurrence({ objectId: meeting.id, field: 'date', occurrence: '2026-10-26T12:00:00.000Z', scope: 'this', change: { cancelled: true } }, 'America/Sao_Paulo', now())
    const { created } = phone.store.changeOccurrence(
      { objectId: meeting.id, field: 'date', occurrence: '2026-11-02T12:00:00.000Z', scope: 'following', change: { start: '2026-11-02T13:00:00.000Z', end: '2026-11-02T14:00:00.000Z' } },
      'America/Sao_Paulo',
      now()
    )
    phone.online = true
    expect((await phone.sync.sync()).refused).toEqual([])
    const original = await serverObject(user.request, meeting.id)
    expect(original.date).toMatchObject({ rrule: 'FREQ=WEEKLY;UNTIL=20261026T090000', exceptions: { '2026-10-26T12:00:00.000Z': { cancelled: true } } })
    const copy = await serverObject(user.request, created!.id)
    expect(copy.date).toMatchObject({ start: '2026-11-02T13:00:00.000Z', rrule: 'FREQ=WEEKLY;COUNT=2' })
    expect(texts(copy.content.body)).toEqual(['Notes', 'Continues from '])
    expect(copy.content.body!.content[1]!.content![1]).toMatchObject({ type: 'mention', attrs: { objectId: meeting.id } })
    const calendar = (await (await user.request('/api/spaces/s/calendar?from=2026-10-19&to=2026-11-15&timeZone=America/Sao_Paulo')).json()) as { entries: { objectId: string; start: string }[] }
    expect(calendar.entries.map((e) => [e.objectId, e.start])).toEqual([
      [meeting.id, '2026-10-19T12:00:00.000Z'],
      [copy.id, '2026-11-02T13:00:00.000Z'],
      [copy.id, '2026-11-09T13:00:00.000Z'],
    ])
  })

  it('saves a quote offline, highlighted in its source, and deleting it removes the highlight', async () => {
    const { user, phone, page } = setup()
    const article = (await (await user.request('/api/objects', json({ typeId: page, title: 'Dune', content: { body: paragraphs('The spice must flow.') } }))).json()) as ObjectRecord
    await phone.sync.sync()
    phone.online = false
    const quote = phone.store.createQuote(article.id, { text: 'spice must flow', note: 'Classic' }, now())
    // The editor highlights the passage with the quote's id.
    const editor = phone.edit(article.id)
    const mark = { type: 'highlight', attrs: { color: 'yellow', quoteId: quote.id } }
    writeContent(editor.doc, { [BODY_PROPERTY_ID]: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The ' }, { type: 'text', text: 'spice must flow', marks: [mark] }, { type: 'text', text: '.' }] }] } as JsonDoc }, undefined, [BODY_PROPERTY_ID])
    editor.close()
    phone.online = true
    expect((await phone.sync.sync()).refused).toEqual([])
    expect(await serverObject(user.request, quote.id)).toMatchObject({ title: 'spice must flow', props: { source: { kind: 'relation', value: [article.id] } } })
    const marked = (await serverObject(user.request, article.id)).content.body!.content[0]!.content![1]!
    expect(marked.marks).toEqual([mark])
    phone.online = false
    phone.store.trashObject(quote.id, now())
    expect(texts(phone.store.getObject(article.id)!.content.body)).toEqual(['The spice must flow.'])
    phone.online = true
    expect((await phone.sync.sync()).refused).toEqual([])
    const after = await serverObject(user.request, article.id)
    expect(after.content.body!.content[0]!.content).toEqual([{ type: 'text', text: 'The spice must flow.' }])
    expect((await serverObject(user.request, quote.id)).deletedAt).toBeDefined()
    // Through the server too, and the device hears of the highlight going.
    const second = (await (await user.request(`/api/objects/${article.id}/quotes`, json({ text: 'The spice' }))).json()) as ObjectRecord
    expect(second.title).toBe('The spice')
    const laptop = phone.edit(article.id)
    const secondMark = { type: 'highlight', attrs: { color: 'yellow', quoteId: second.id } }
    writeContent(laptop.doc, { [BODY_PROPERTY_ID]: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The spice', marks: [secondMark] }, { type: 'text', text: ' must flow.' }] }] } as JsonDoc }, undefined, [BODY_PROPERTY_ID])
    await phone.sync.sync()
    expect(JSON.stringify((await serverObject(user.request, article.id)).content)).toContain(second.id)
    await user.request(`/api/objects/${second.id}`, { method: 'DELETE' })
    expect(JSON.stringify((await serverObject(user.request, article.id)).content)).not.toContain(second.id)
    await phone.sync.sync()
    expect(JSON.stringify(phone.store.getObject(article.id)!.content)).not.toContain(second.id)
    expect(JSON.stringify(readContent(laptop.doc))).not.toContain(second.id)
    laptop.close()
    expect((await user.request(`/api/objects/${article.id}/quotes`, json({ text: ' ' }))).status).toBe(400)
    expect((await user.request('/api/objects/missing/quotes', json({ text: 'x' }))).status).toBe(404)
  })

  it('brings a change that only deletes text to the other devices', async () => {
    const { user, phone, laptop, page } = setup()
    const note = (await (await user.request('/api/objects', json({ typeId: page, title: 'Del', content: { body: paragraphs('Hello brave world') } }))).json()) as ObjectRecord
    await phone.sync.sync()
    await laptop.sync.sync()
    const editor = phone.edit(note.id)
    editor.type('Hello world')
    editor.close()
    await phone.sync.sync()
    expect(texts((await serverObject(user.request, note.id)).content.body)).toEqual(['Hello world'])
    await laptop.sync.sync()
    expect(texts(laptop.store.getObject(note.id)!.content.body)).toEqual(['Hello world'])
  })

  it('makes a day’s note on a second device offline without overruling what was set on it meanwhile', async () => {
    const { user, phone, laptop } = setup()
    await phone.sync.sync()
    await laptop.sync.sync()
    laptop.online = false
    const note = phone.store.dailyNote('s', '2026-11-03', now())
    phone.store.saveObject({ ...note, title: 'Moving day', tagIds: ['tag'] }, now())
    await phone.sync.sync()
    await new Promise((resolve) => setTimeout(resolve, 5))
    // Later, the laptop opens the same day without having heard of it.
    expect(laptop.store.dailyNote('s', '2026-11-03', now()).id).toBe(note.id)
    laptop.online = true
    expect((await laptop.sync.sync()).refused).toEqual([])
    await phone.sync.sync()
    const server = await serverObject(user.request, note.id)
    expect([server.title, server.tagIds, server.createdAt]).toEqual(['Moving day', ['tag'], note.createdAt])
    for (const device of [phone, laptop]) {
      const object = device.store.getObject(note.id)!
      expect([object.title, object.tagIds, object.createdAt]).toEqual([server.title, server.tagIds, server.createdAt])
    }
  })

  it('fills a new replica in pages, going on where a first sync stopped, with its progress', async () => {
    const { store, user, page } = setup()
    const type = store.getType(page)!
    store.transaction(() => {
      for (let i = 0; i < 1500; i++) store.putObject(newObject(type, { title: `Note ${i}`, content: { body: paragraphs(`Text ${i}`) as Doc } }, `n${i}`, at))
    })
    const pulls: string[] = []
    let cut = true
    const tablet = new Device('tablet', (url, init) => {
      if (url.startsWith('/api/sync/pull')) {
        // Offline after the first page.
        if (cut && pulls.length) throw new TypeError('Failed to fetch')
        pulls.push(url)
      }
      return user.request(url, init)
    })
    const progress: [number, number][] = []
    tablet.sync.onFillProgress = (done, total) => progress.push([done, total])
    await expect(tablet.sync.sync()).rejects.toThrow()
    expect(tablet.store.filled()).toBe(false)
    expect(tablet.store.getObject('n0')?.title).toBe('Note 0')
    expect(texts(tablet.store.getObject('n0')!.content.body)).toEqual(['Text 0'])

    tablet.restart()
    cut = false
    pulls.length = 0
    tablet.sync.onFillProgress = (done, total) => progress.push([done, total])
    const result = await tablet.sync.sync()
    expect(tablet.store.filled()).toBe(true)
    expect(texts(tablet.store.getObject('n1499')!.content.body)).toEqual(['Text 1499'])
    // The rest only: not the whole space again.
    expect(pulls).toHaveLength(1)
    expect(pulls[0]).not.toContain('space=')
    const total = tablet.store.rowCount()
    expect(progress.at(-1)).toEqual([total, total])
    expect(progress[0]![0]).toBeLessThan(total)
    // The app worked with the server meanwhile: the rows a fill brings are no news to it.
    expect(result.changes).toEqual([])
    await user.request('/api/objects/n1', json({ ...(await serverObject(user.request, 'n1')), title: 'Renamed' }, 'PUT'))
    expect((await tablet.sync.sync()).changes.map((c) => c.kind === 'object' && c.id)).toEqual(['n1'])
  })

  it('fetches the text a sync did not get to (offline halfway) in the next one', async () => {
    const { user, page } = setup()
    let cut = false
    const tablet = new Device('tablet', (url, init) => {
      if (cut && url.startsWith('/api/sync/text')) throw new TypeError('Failed to fetch')
      return user.request(url, init)
    })
    await tablet.sync.sync()
    const note = (await (await user.request('/api/objects', json({ typeId: page, title: 'Notes', content: { body: paragraphs('From the laptop') } }))).json()) as ObjectRecord
    cut = true
    await expect(tablet.sync.sync()).rejects.toThrow()
    expect(tablet.store.getObject(note.id)?.title).toBe('Notes')
    cut = false
    await tablet.sync.sync()
    expect(texts(tablet.store.getObject(note.id)!.content.body)).toEqual(['From the laptop'])
  })

  it('pushes an edit that only deletes, made while a push was on its way', async () => {
    const { user, page } = setup()
    let meanwhile: (() => void) | undefined
    const tablet = new Device('tablet', async (url, init) => {
      const response = await user.request(url, init)
      if (url === '/api/sync/push') meanwhile?.()
      meanwhile = undefined
      return response
    })
    const note = (await (await user.request('/api/objects', json({ typeId: page, title: 'Del', content: { body: paragraphs('Hello brave world') } }))).json()) as ObjectRecord
    await tablet.sync.sync()
    const editor = tablet.edit(note.id)
    editor.type('Hello brave world', 'Second')
    meanwhile = () => editor.type('Hello world', 'Second')
    await tablet.sync.sync()
    await tablet.sync.sync()
    expect(texts((await serverObject(user.request, note.id)).content.body)).toEqual(['Hello world', 'Second'])
    editor.close()
  })

  it('turns food tracking on offline, and logs food on two devices at once', async () => {
    const { store, user, phone, laptop } = setup()
    await phone.sync.sync()
    phone.online = false
    phone.store.setNutrition('s', true, now())
    const bread = phone.store.createObject({ typeId: builtinTypeId('s', 'food'), title: 'Bread', props: { kcal: { kind: 'number', value: 250 } } }, now())
    phone.store.updateSpace('s', { nutrition: { enabled: true, meals: [{ id: 'cafe', name: 'Café', time: '07:00' }] } })
    phone.store.logFood('s', { sourceId: bread.id, amount: '60', day: '2026-10-20', timeZone: 'UTC' }, now())
    phone.online = true
    await phone.sync.sync()
    expect(store.getType(builtinTypeId('s', 'food'))?.system).toBe('food')
    expect(store.getSpace('s')!.nutrition).toEqual({ enabled: true, meals: [{ id: 'cafe', name: 'Café', time: '07:00' }] })

    await laptop.sync.sync()
    phone.online = laptop.online = false
    phone.store.logFood('s', { sourceId: bread.id, amount: '30', day: '2026-10-20', timeZone: 'UTC' }, now())
    laptop.store.logFood('s', { sourceId: bread.id, amount: '90', day: '2026-10-20', timeZone: 'UTC' }, now())
    expect((await user.request('/api/spaces/s/food', json({ sourceId: bread.id, amount: '10', day: '2026-10-20' }))).status).toBe(201)
    phone.online = laptop.online = true
    await phone.sync.sync()
    await laptop.sync.sync()
    await phone.sync.sync()
    const kcal = (s: { getObject: (id: string) => ObjectRecord | undefined }) => dayTotals(dayEntries(s.getObject(dailyNoteId('s', '2026-10-20'))!)).kcal
    expect([kcal(store), kcal(phone.store), kcal(laptop.store)]).toEqual([475, 475, 475])
  })

  it('changes occurrences through the server too', async () => {
    const { user, page } = setup()
    const date = { start: '2026-10-19T00:00:00.000Z', resolution: 'day', rrule: 'FREQ=DAILY;COUNT=3' }
    const meeting = (await (await user.request('/api/objects', json({ typeId: page, title: 'Walk', date }))).json()) as ObjectRecord
    const change = (body: unknown) => user.request(`/api/objects/${meeting.id}/occurrences`, json(body))
    const moved = await change({ field: 'date', occurrence: '2026-10-20T00:00:00.000Z', scope: 'this', change: { start: '2026-10-25T00:00:00.000Z' }, timeZone: 'America/Sao_Paulo' })
    expect(((await moved.json()) as { object: ObjectRecord }).object.date!.exceptions).toEqual({ '2026-10-20T00:00:00.000Z': { start: '2026-10-25T00:00:00.000Z' } })
    expect((await change({ field: 'date', occurrence: '2026-10-28T00:00:00.000Z', scope: 'this', change: { cancelled: true } })).status).toBe(400)
    expect((await change({ field: 'date', scope: 'this' })).status).toBe(400)
  })
})
