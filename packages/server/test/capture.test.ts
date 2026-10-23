import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { builtinTypeId, createBuiltinTypes, dayEntries, newObject, portionsValue, setNutritionEnabled, type CaptureInfo, type DocNode, type ObjectRecord } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { createApp } from '../src/app.ts'
import { CaptureService } from '../src/capture.ts'
import { localDay } from '../src/daily.ts'
import { ChangeFeed, type ChangeEvent } from '../src/events.ts'
import { AccountService } from '../src/accounts.ts'
import { TelegramBot, telegramAccess, type TelegramUpdate } from '../src/telegram.ts'
import { textToBlocks } from '@vasta/core'
import { parsePageMeta } from '../src/web-meta.ts'
import { asUser } from './helpers.ts'

const TOKEN = 'secret-token'

function setup(start = '2026-10-18T11:59:00.000Z') {
  const store = new NodeStore(':memory:')
  store.putSpace({ id: 's', name: 'Space', sidebar: [], createdAt: start })
  for (const type of createBuiltinTypes('s', start)) store.putType(type)
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-capture-')))
  const clock = { at: start }
  const feed = new ChangeFeed()
  const events: ChangeEvent[] = []
  feed.subscribe((e) => events.push(e))
  const capture = new CaptureService({
    store, media, feed, now: () => clock.at, timeZone: 'America/Sao_Paulo',
    fetchMeta: async (url) => ({ meta: { title: `Title of ${new URL(url).pathname}` }, previewImageUrl: 'https://img.example/p.png' }),
  })
  const raw = createApp({ store, media, feed, capture, captureToken: TOKEN, now: () => clock.at })
  // The legacy token captures as the oldest user, created here.
  const app = asUser(raw, store, { username: 'arie' })
  return { store, media, capture, raw, app, clock, events }
}

const body = (note: ObjectRecord) => note.content.body!.content
const captureOf = (node: DocNode) => node.attrs?.capture as CaptureInfo
const post = (url: string, data: unknown, token = TOKEN) =>
  ({ method: 'POST', body: JSON.stringify(data), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } }) as const

describe('daily notes', () => {
  it('uses the capture time zone to pick the day', () => {
    expect(localDay('2026-10-19T01:30:00.000Z', 'America/Sao_Paulo')).toBe('2026-10-18')
    expect(localDay('2026-10-19T01:30:00.000Z', 'UTC')).toBe('2026-10-19')
  })

  it('opens a daily note by date, creating it once', async () => {
    const { app, store } = setup()
    const first = await app.request('/api/spaces/s/daily-notes/2026-10-18', { method: 'POST' })
    const again = await app.request('/api/spaces/s/daily-notes/2026-10-18', { method: 'POST' })
    expect(first.status).toBe(201)
    expect(again.status).toBe(200)
    const note = (await again.json()) as ObjectRecord
    expect(note).toMatchObject({ typeId: builtinTypeId('s', 'daily-note'), date: { start: '2026-10-18T00:00:00.000Z', resolution: 'day' } })
    expect(store.listObjects(builtinTypeId('s', 'daily-note'))).toHaveLength(1)
    expect((await app.request('/api/spaces/s/daily-notes/2026-02-30', { method: 'POST' })).status).toBe(400)
  })
})

describe('capture service', () => {
  it('appends notes to today as callouts with the channel and time, in order', async () => {
    const { capture, clock, events } = setup()
    await capture.note({ text: 'first **thought**', channel: 'telegram' })
    clock.at = '2026-10-18T12:05:00.000Z'
    const { dailyNote } = await capture.note({ text: 'second\nline two\n\nnew paragraph' })

    const blocks = body(dailyNote)
    expect(blocks.map((b) => b.type)).toEqual(['callout', 'callout', 'paragraph'])
    expect(blocks[0]!.attrs).toMatchObject({ icon: { kind: 'icon', value: 'ph:telegram-logo' }, capture: { channel: 'telegram', at: '2026-10-18T11:59:00.000Z' } })
    expect(captureOf(blocks[1]!)).toMatchObject({ channel: 'api', at: '2026-10-18T12:05:00.000Z' })
    expect(blocks[1]!.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'second' }, { type: 'hardBreak' }, { type: 'text', text: 'line two' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'new paragraph' }] },
    ])
    expect(events.flatMap((e) => (e.kind === 'object' && e.id === dailyNote.id ? [e.updatedAt] : [])).at(-1)).toBe('2026-10-18T12:05:00.000Z')
  })

  it('starts a new daily note after local midnight', async () => {
    const { capture, clock } = setup('2026-10-19T02:00:00.000Z') // 23:00 in São Paulo
    const late = await capture.note({ text: 'late' })
    clock.at = '2026-10-19T03:10:00.000Z' // 00:10 the next day
    const early = await capture.note({ text: 'early' })
    expect(late.dailyNote.date?.start).toBe('2026-10-18T00:00:00.000Z')
    expect(early.dailyNote.date?.start).toBe('2026-10-19T00:00:00.000Z')
  })

  it('saves URLs in a note as weblinks, reusing one saved before', async () => {
    const { capture, store } = setup()
    const first = await capture.note({ text: 'read https://example.com/post later' })
    const second = await capture.note({ text: 'https://example.com/post' })

    const weblinks = store.listObjects(builtinTypeId('s', 'weblink'))
    expect(weblinks).toHaveLength(1)
    expect(weblinks[0]).toMatchObject({ title: 'Title of /post', media: { url: 'https://example.com/post', host: 'example.com', previewImageUrl: 'https://img.example/p.png' } })
    expect(first.objects[0]!.id).toBe(weblinks[0]!.id)
    const [withText, onlyLink] = body(second.dailyNote).filter((b) => b.type === 'callout')
    expect(withText!.content!.map((b) => b.type)).toEqual(['paragraph', 'objectEmbed'])
    expect(withText!.content![0]!.content![1]).toMatchObject({ text: 'https://example.com/post', marks: [{ type: 'link', attrs: { href: 'https://example.com/post' } }] })
    expect(onlyLink!.content).toEqual([{ type: 'objectEmbed', attrs: { objectId: weblinks[0]!.id, display: 'wide-card' } }])
  })

  it('creates tasks and objects of any type by name', async () => {
    const { capture, store } = setup()
    const book = (await (await asUser(createApp({ store, media: new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'v-'))) }), store).request('/api/types', {
      method: 'POST', body: JSON.stringify({ spaceId: 's', name: 'Livro', pluralName: 'Livros' }), headers: { 'content-type': 'application/json' },
    })).json()) as { id: string }

    const task = await capture.task({ title: 'Buy coffee', due: '2026-10-20', priority: 'high', note: 'the good one' })
    expect(task.objects[0]).toMatchObject({
      typeId: builtinTypeId('s', 'task'),
      props: { status: { kind: 'select', value: ['todo'] }, due: { kind: 'date', value: { start: '2026-10-20T00:00:00.000Z', resolution: 'day' } }, priority: { kind: 'select', value: ['high'] } },
    })
    const object = await capture.object({ type: 'livros', title: 'Duna', text: 'Frank Herbert' })
    expect(object.objects[0]).toMatchObject({ typeId: book.id, title: 'Duna' })
    expect(capture.resolveType('s', 'Página')).toBeUndefined()
    expect(capture.resolveType('s', 'page')?.system).toBe('page')
    await expect(capture.object({ type: 'nope', title: 'x' })).rejects.toThrow('unknown type')
    await expect(capture.task({ title: 'x', due: 'tomorrow' })).rejects.toThrow('due must be')
  })

  it('stores files as media objects of the matching type', async () => {
    const { capture, media } = setup()
    const result = await capture.file({ data: new Uint8Array([1, 2, 3]), name: 'photo.jpg', mimeType: 'image/jpeg', caption: 'sunset' })
    const image = result.objects[0]!
    expect(image.typeId).toBe(builtinTypeId('s', 'image'))
    expect(media.pathOf(image.media!.file!.key)).toMatch(/\.jpg$/)
    expect(body(result.dailyNote)[0]!.content!.map((b) => b.type)).toEqual(['paragraph', 'objectEmbed'])
  })
})

describe('saving an object that received captures meanwhile', () => {
  it('keeps captured blocks the client has not seen, and only those', async () => {
    const { app, capture, clock } = setup()
    const opened = capture.todayNote()
    const edited = { ...opened, content: { body: { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text: 'typed in the app' }] }] } } }

    clock.at = '2026-10-18T12:01:00.000Z'
    await capture.note({ text: 'from the phone' })
    clock.at = '2026-10-18T12:02:00.000Z'
    const saved = (await (await app.request(`/api/objects/${opened.id}`, { ...post('', edited), method: 'PUT' })).json()) as ObjectRecord
    expect(body(saved).map((b) => b.type)).toEqual(['paragraph', 'callout', 'paragraph'])

    // The client now has the merged copy and deletes the captured block: it stays deleted.
    clock.at = '2026-10-18T12:03:00.000Z'
    const removed = { ...saved, content: { body: { type: 'doc' as const, content: [body(saved)[0]!] } } }
    const final = (await (await app.request(`/api/objects/${opened.id}`, { ...post('', removed), method: 'PUT' })).json()) as ObjectRecord
    expect(body(final).map((b) => b.type)).toEqual(['paragraph'])
  })
})

describe('capture API', () => {
  it('requires the token', async () => {
    const { raw, store } = setup()
    expect((await raw.request('/api/capture/note', post('', { text: 'hi' }, 'wrong'))).status).toBe(401)
    expect((await raw.request('/api/capture/note', { method: 'POST', body: '{}' })).status).toBe(401)
    const withoutLegacy = createApp({ store, media: new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'v-'))) })
    expect((await withoutLegacy.request('/api/capture/note', post('', { text: 'hi' }))).status).toBe(401)
  })

  it('captures notes, weblinks, tasks, objects and files', async () => {
    const { raw: app, store } = setup()
    const note = await app.request('/api/capture/note', post('', { text: 'hello', channel: 'shortcuts' }))
    expect(note.status).toBe(201)
    const { dailyNoteId } = (await note.json()) as { dailyNoteId: string }
    expect((await app.request('/api/capture/weblink', post('', { url: 'https://example.com/a', note: 'nice' }))).status).toBe(201)
    expect((await app.request('/api/capture/task', post('', { title: 'Call mom' }))).status).toBe(201)
    const lined = await app.request('/api/capture/task', post('', { line: 'Pay rent due:2026-11-01 priority:high due2:x' }))
    expect(await lined.json()).toMatchObject({ summary: 'Task “Pay rent due2:x”, due Sun 1 Nov, priority High', objects: [{ title: 'Pay rent due2:x' }] })
    expect((await app.request('/api/capture/object', post('', { type: 'page', title: 'Idea' }))).status).toBe(201)
    expect((await app.request('/api/capture/object', post('', { type: 'nope' }))).status).toBe(400)
    expect((await app.request('/api/capture/note', post('', { text: ' ' }))).status).toBe(400)
    // Food, once the space tracks it.
    expect((await app.request('/api/capture/food', post('', { text: 'rice 100g' }))).status).toBe(400)
    setNutritionEnabled(store, 's', true, '2026-10-18T11:59:00.000Z')
    const food = await app.request('/api/capture/food', post('', { text: 'rice 100g' }))
    expect(food.status).toBe(201)
    expect(await food.json()).toMatchObject({ day: '2026-10-18', created: [{ title: 'Rice' }], entries: [{ name: 'Rice', grams: 100 }] })

    const form = new FormData()
    form.set('file', new File([new Uint8Array([37, 80, 68, 70])], 'doc.pdf', { type: 'application/pdf' }))
    form.set('caption', 'invoice')
    const file = await app.request('/api/capture/file', { method: 'POST', body: form, headers: { authorization: `Bearer ${TOKEN}` } })
    expect(file.status).toBe(201)

    const today = (await (await app.request('/api/capture/today', { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { day: string; dailyNoteId: string }
    expect(today).toEqual({ day: '2026-10-18', dailyNoteId })
    const daily = store.getObject(dailyNoteId)!
    expect(body(daily).filter((b) => b.type === 'callout').map((b) => captureOf(b).channel)).toEqual(['shortcuts', 'api', 'api', 'api', 'api', 'api'])
    expect(store.backlinks(store.listObjects(builtinTypeId('s', 'pdf'))[0]!.id).map((l) => l.object.id)).toEqual([dailyNoteId])
  })
})

describe('Telegram bot', () => {
  function fakeTelegram(updates: TelegramUpdate[]) {
    const calls: { method: string; body: Record<string, unknown> }[] = []
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/file/bot')) return new Response(new Uint8Array([9, 9, 9]))
      const method = url.split('/').at(-1)!
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      calls.push({ method, body })
      const result =
        method === 'getUpdates' ? updates.filter((u) => u.update_id >= Number(body.offset ?? 0))
        : method === 'getFile' ? { file_path: 'photos/file_1.jpg' }
        : true
      return Response.json({ ok: true, result })
    }) as typeof globalThis.fetch
    return { fetch, calls }
  }

  const message = (id: number, extra: Record<string, unknown>, chatId = 42, userId = 7): TelegramUpdate => ({
    update_id: 100 + id,
    message: { message_id: id, chat: { id: chatId, type: 'private' }, from: { id: userId }, date: 0, ...extra },
  })
  const quiet = { info() {}, warn() {}, error() {} }

  it('captures messages from allowed chats and remembers the offset', async () => {
    const { capture, store } = setup()
    const telegram = fakeTelegram([
      message(1, { text: 'bold idea https://example.com/x', entities: [{ type: 'bold', offset: 0, length: 4 }, { type: 'url', offset: 10, length: 21 }] }),
      message(2, { text: '/task Water the plants priority:high due:tomorrow\nthe ones on the balcony' }),
      message(3, { text: '/new page Trip plan' }),
      message(4, { photo: [{ file_id: 'small', width: 1, height: 1 }, { file_id: 'big', width: 9, height: 9 }], caption: 'view' }),
      message(5, { text: 'hello' }, 666),
      message(6, { text: '/new Spaceship Enterprise' }),
    ])
    const accounts = new AccountService({ store, capture })
    store.putUser({ ...store.listUsers()[0]!, telegramUserId: 7 })
    const bot = new TelegramBot({ token: 't', ...telegramAccess({ store, accounts, allowedChatIds: [42] }), store, fetch: telegram.fetch, log: { info() {}, warn() {}, error() {} } })
    await bot.pollOnce(undefined, 0)
    await bot.pollOnce(undefined, 0)

    expect(store.getMeta('telegram.offset')).toBe('107')
    expect(telegram.calls.filter((c) => c.method === 'getUpdates').map((c) => c.body.offset)).toEqual([0, 107])
    const daily = capture.todayNote()
    const callouts = body(daily).filter((b) => b.type === 'callout')
    expect(callouts).toHaveLength(4)
    expect(callouts.every((b) => captureOf(b).channel === 'telegram')).toBe(true)
    expect(callouts[0]!.content![0]!.content![0]).toEqual({ type: 'text', text: 'bold', marks: [{ type: 'bold' }] })
    expect(callouts[0]!.content![1]!.type).toBe('objectEmbed')
    expect(store.listObjects(builtinTypeId('s', 'task'))[0]).toMatchObject({
      title: 'Water the plants',
      props: { priority: { kind: 'select', value: ['high'] }, due: { kind: 'date', value: { start: '2026-10-19T00:00:00.000Z', resolution: 'day' } } },
    })
    expect(store.listObjects(builtinTypeId('s', 'page'))[0]).toMatchObject({ title: 'Trip plan' })
    expect(store.listObjects(builtinTypeId('s', 'image'))[0]!.media?.file?.sizeBytes).toBe(3)
    expect(telegram.calls.find((c) => c.method === 'getFile')?.body.file_id).toBe('big')

    const replies = telegram.calls.filter((c) => c.method === 'sendMessage').map((c) => [c.body.chat_id, c.body.text])
    expect(replies).toEqual([
      [42, 'Saved: Task “Water the plants”, due Mon 19 Oct, priority High'],
      [42, 'Saved: Page “Trip plan”'],
      [42, expect.stringContaining('No type called “Spaceship”')],
    ])
    expect(telegram.calls.filter((c) => c.method === 'setMessageReaction')).toHaveLength(2)
  })

  it('logs food with /food, and says what it did', async () => {
    const { capture, store } = setup()
    setNutritionEnabled(store, 's', true, '2026-10-18T11:59:00.000Z')
    store.putObject({ ...newObject(store.getType(builtinTypeId('s', 'food'))!, { title: 'Bread', props: { kcal: { kind: 'number', value: 250 }, portions: portionsValue([{ name: 'slice', grams: 25 }]) } }, 'bread', '2026-10-18T11:59:00.000Z') })
    const telegram = fakeTelegram([message(1, { text: '/food 2 slices of bread at breakfast' }), message(2, { text: '/food bread 100g' }), message(3, { text: '/food' })])
    const accounts = new AccountService({ store, capture })
    store.putUser({ ...store.listUsers()[0]!, telegramUserId: 7 })
    await new TelegramBot({ token: 't', ...telegramAccess({ store, accounts, allowedChatIds: [42] }), store, fetch: telegram.fetch, log: quiet }).pollOnce(undefined, 0)
    expect(telegram.calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text)).toEqual([
      'Logged in Breakfast: Bread 2 slices (125 kcal).\nToday 125 kcal.',
      // 08:59 in São Paulo: breakfast too.
      'Logged in Breakfast: Bread 100 g (250 kcal).\nToday 375 kcal.',
      'Not saved: say what you ate, e.g. /food 2 slices of bread, coffee 200 ml',
    ])
    // Not an inbox item: the note has the entries, not callouts.
    expect(capture.todayNote().content.body).toBeUndefined()
    expect(dayEntries(capture.todayNote())).toHaveLength(2)

    expect(capture.food({ text: 'bread 1 slice yesterday' }).summary).toBe('Logged yesterday in Lunch: Bread 1 slice (63 kcal).\nThat day 63 kcal.')
  })

  it('filters by user, and only tells ids while nothing is allowed', async () => {
    const { capture, store } = setup()
    const telegram = fakeTelegram([
      message(1, { text: 'from me in a group' }, -500, 7),
      message(2, { text: 'from a stranger' }, -500, 8),
      message(3, { text: '/id' }, 7, 7),
    ])
    const accounts = new AccountService({ store, capture })
    const bot = new TelegramBot({ token: 't', ...telegramAccess({ store, accounts, allowedUserIds: [7] }), store, fetch: telegram.fetch, log: quiet })
    await bot.pollOnce(undefined, 0)
    const texts = (b: DocNode[]) => b.filter((n) => n.type === 'callout').map((n) => n.content![0]!.content![0]!.text)
    expect(texts(body(capture.todayNote()))).toEqual(['from me in a group'])
    expect(telegram.calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text)).toEqual(["Your user id: 7\nThis chat's id: 7"])

    const setupMode = fakeTelegram([message(9, { text: 'hi' }, 99, 99)])
    const unconfigured = new TelegramBot({ token: 't', ...telegramAccess({ store, accounts }), store, fetch: setupMode.fetch, log: quiet })
    await unconfigured.pollOnce(undefined, 0)
    expect(setupMode.calls.find((c) => c.method === 'sendMessage')?.body.text).toMatch(/^Your user id: 99\nThis chat's id: 99\n\nTo link this Telegram account, open Settings in Vasta .*vasta user telegram <username> 99/)
    expect(texts(body(capture.todayNote()))).toHaveLength(1)
  })

  it('captures each linked sender into their own space, and ignores the rest', async () => {
    const { capture, store } = setup()
    const accounts = new AccountService({ store, capture })
    const arie = store.listUsers()[0]!
    store.putUser({ ...arie, telegramUserId: 7 })
    store.putSpace({ id: 'ana-space', name: 'Ana', sidebar: [], createdAt: '2026-10-18T00:00:00.000Z' })
    for (const type of createBuiltinTypes('ana-space', '2026-10-18T00:00:00.000Z')) store.putType(type)
    const { user: ana } = asUser({ request: () => new Response() }, store, { username: 'ana', spaces: ['ana-space'] })
    store.putUser({ ...ana, telegramUserId: 8, timeZone: 'Asia/Tokyo' })

    const telegram = fakeTelegram([message(1, { text: 'mine' }, 7, 7), message(2, { text: 'hers' }, 8, 8), message(3, { text: 'stranger' }, 9, 9)])
    const bot = new TelegramBot({ token: 't', ...telegramAccess({ store, accounts }), store, fetch: telegram.fetch, log: quiet })
    await bot.pollOnce(undefined, 0)
    const texts = (b: DocNode[]) => b.filter((n) => n.type === 'callout').map((n) => n.content![0]!.content![0]!.text)
    expect(texts(body(capture.todayNote('s')))).toEqual(['mine'])
    // 11:59 UTC is already the 18th in São Paulo and still the 18th in Tokyo (20:59); her note is in her space.
    const hers = accounts.captureFor(store.getUser(ana.id)!)
    expect(hers.timeZone).toBe('Asia/Tokyo')
    expect(texts(body(hers.todayNote()))).toEqual(['hers'])
    expect(() => hers.todayNote('s')).toThrow('unknown space s')
    expect(telegram.calls.filter((c) => c.method === 'sendMessage')).toEqual([])
  })

  it('listens in the chats Settings allows, remembers the others, and lets no stranger in', async () => {
    const { capture, store, app, raw } = setup()
    const accounts = new AccountService({ store, capture })
    store.putUser({ ...store.listUsers()[0]!, telegramUserId: 7 })
    const ana = asUser(raw, store, { username: 'ana' })
    const group = (id: number, text: string, from: number): TelegramUpdate => ({
      update_id: 100 + id,
      message: { message_id: id, chat: { id: -500, type: 'group', title: 'Família' }, from: { id: from }, date: 0, text },
    })
    const send = async (updates: TelegramUpdate[]) => {
      const telegram = fakeTelegram(updates)
      store.setMeta('telegram.offset', '0')
      await new TelegramBot({ token: 't', ...telegramAccess({ store, accounts, allowedChatIds: [42] }), store, fetch: telegram.fetch, log: quiet }).pollOnce(undefined, 0)
    }
    const texts = () => (capture.todayNote().content.body?.content ?? []).filter((n) => n.type === 'callout').map((n) => n.content![0]!.content![0]!.text)
    const json = (data: unknown) => ({ method: 'PUT', body: JSON.stringify(data), headers: { 'content-type': 'application/json', 'x-requested-with': 'vasta' } })

    await send([group(1, 'in the group', 7)])
    expect(texts()).toEqual([])
    const state = await (await app.request('/api/auth/channels')).json()
    expect(state.telegram).toMatchObject({ manage: true, linked: true, linkedAccounts: 1, allowedChats: [{ id: 42 }], ignoredChats: [{ id: -500, title: 'Família' }] })
    // Only the account that set up the server changes the chats; others see them.
    const theirs = await (await ana.request('/api/auth/channels')).json()
    expect(theirs.telegram).toMatchObject({ manage: false, allowedChats: [{ id: 42 }] })
    expect(theirs.telegram.ignoredChats).toBeUndefined()
    expect((await ana.request('/api/auth/channels/telegram', json({ allowedChats: [] }))).status).toBe(403)

    const allowed = await (await app.request('/api/auth/channels/telegram', json({ allowedChats: [{ id: 42 }, { id: -500, title: 'Família' }, { id: 'x' }] }))).json()
    expect(allowed.telegram).toMatchObject({ allowedChats: [{ id: 42 }, { id: -500, title: 'Família' }], ignoredChats: [] })
    // The env list only seeded it: starting the bot again keeps what Settings chose.
    await send([group(2, 'now saved', 7), group(3, 'from a stranger', 9)])
    expect(texts()).toEqual(['now saved'])
  })

  it('links a sender with a code from the app, even before anyone is linked', async () => {
    const { capture, store, clock } = setup()
    const accounts = new AccountService({ store, capture, now: () => clock.at })
    const arie = store.listUsers()[0]!
    const { code } = accounts.telegramCode(arie.id)
    const expired = accounts.telegramCode(asUser({ request: () => new Response() }, store, { username: 'ana' }).user.id).code
    clock.at = '2026-10-18T12:05:00.000Z'
    const telegram = fakeTelegram([
      message(1, { text: '/link WRONG123' }, 7, 7),
      message(2, { text: `/start link-${code.toLowerCase()}` }, 7, 7),
      message(3, { text: 'now saved' }, 7, 7),
    ])
    const bot = new TelegramBot({ token: 't', ...telegramAccess({ store, accounts }), store, fetch: telegram.fetch, log: quiet })
    await bot.pollOnce(undefined, 0)
    const replies = telegram.calls.filter((c) => c.method === 'sendMessage').map((c) => c.body.text)
    expect(replies).toEqual([expect.stringMatching(/^Not linked: that code is unknown or expired/), 'Linked to arie (arie) in Vasta. What you send me now goes into your daily note.'])
    expect(store.getUser(arie.id)?.telegramUserId).toBe(7)
    expect(body(capture.todayNote('s')).filter((n) => n.type === 'callout')).toHaveLength(1)
    // Codes are single use and expire after 10 minutes; one Telegram account links to one user.
    expect(() => accounts.linkTelegram(code, 7)).toThrow('unknown or expired')
    clock.at = '2026-10-18T12:20:00.000Z'
    expect(() => accounts.linkTelegram(expired, 8)).toThrow('unknown or expired')
    const ana = store.findUserByUsername('ana')!
    expect(() => accounts.linkTelegram(accounts.telegramCode(ana.id).code, 7)).toThrow('linked to another Vasta user')
  })
})

describe('helpers', () => {
  it('turns text into paragraphs and links', () => {
    expect(textToBlocks('a\n\n\nb (https://x.io/p).')).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'b (' }, { type: 'text', text: 'https://x.io/p', marks: [{ type: 'link', attrs: { href: 'https://x.io/p' } }] }, { type: 'text', text: ').' }] },
    ])
  })

  it('reads page metadata', () => {
    const html = `<html><head><title>Fallback</title><meta property="og:title" content="Caf&#233; &amp; Co"><meta name="description" content='Best &#233;spresso'><meta property="og:image" content="/i.png"></head>`
    expect(parsePageMeta(html, 'https://cafe.example/menu')).toEqual({
      previewImageUrl: 'https://cafe.example/i.png',
      meta: { title: 'Café & Co', description: 'Best éspresso' },
    })
  })
})
