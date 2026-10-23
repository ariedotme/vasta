import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { builtinTypeId, type ObjectRecord, type Space, type User } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { AccountService } from '../src/accounts.ts'
import { createApp } from '../src/app.ts'
import { CaptureService } from '../src/capture.ts'
import { ChangeFeed } from '../src/events.ts'
import { Migration, parseTarget, type MigrationState } from '../src/transfer.ts'

const PASSWORD = 'correct horse'

function server(options: { localKey?: string } = {}) {
  const store = new NodeStore(':memory:')
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-transfer-')))
  const feed = new ChangeFeed()
  const capture = new CaptureService({ store, media, feed, timeZone: 'UTC' })
  const accounts = new AccountService({ store, capture })
  const app = createApp({ store, media, feed, capture, accounts, ...options })
  return { store, media, accounts, app }
}

/** A browser: keeps the session cookie, sends the web app's header. */
function browser(app: ReturnType<typeof server>['app']) {
  let cookie = ''
  return async (url: string, init: RequestInit = {}) => {
    const response = await app.request(url, { ...init, headers: { 'x-requested-with': 'vasta', ...(init.headers as Record<string, string>), ...(cookie ? { cookie } : {}) } })
    const set = response.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]!
    return response
  }
}
const json = (body: unknown, method = 'POST') => ({ method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

async function finished(migration: Migration): Promise<MigrationState> {
  while (migration.running) await new Promise((resolve) => setTimeout(resolve, 5))
  return migration.state
}

describe('moving notes to another server', () => {
  it('reads a setup code, an invite link or an invite code', () => {
    expect(parseTarget({ server: 'notes.example.org', code: 'abcd-2345-wxyz' })).toMatchObject({ setupCode: 'abcd-2345-wxyz' })
    expect(parseTarget({ server: 'notes.example.org', code: 'abcd-2345-wxyz' }).server.href).toBe('https://notes.example.org/')
    const link = parseTarget({ code: 'http://192.168.1.5:5174/?invite=Xy_9' })
    expect([link.server.href, link.invite]).toEqual(['http://192.168.1.5:5174/', 'Xy_9'])
    expect(parseTarget({ server: 'https://notes.example.org/today', code: 'Xy_9-longer-code' })).toMatchObject({ invite: 'Xy_9-longer-code' })
    expect(() => parseTarget({ code: 'abcd-2345-wxyz' })).toThrow('type the address of the server')
  })

  it('makes the account with the setup code and moves spaces, rich text, the trash and media', async () => {
    const local = server({ localKey: 'k' })
    const me = browser(local.app)
    expect((await me('/api/auth/local?key=k&name=Arie')).status).toBe(302)
    const localUser = local.store.listUsers()[0]!
    const [space] = (await (await me('/api/spaces')).json()) as Space[]
    const pageType = builtinTypeId(space!.id, 'page')
    const coffee = (await (await me('/api/objects', json({ typeId: pageType, title: 'Coffee' }))).json()) as ObjectRecord
    const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'See ' }, { type: 'mention', attrs: { objectId: coffee.id } }] }] }
    const index = (await (await me('/api/objects', json({ typeId: pageType, title: 'Index', content: { body } }))).json()) as ObjectRecord
    const gone = (await (await me('/api/objects', json({ typeId: pageType, title: 'Old idea' }))).json()) as ObjectRecord
    await me(`/api/objects/${gone.id}`, { method: 'DELETE' })
    const form = new FormData()
    form.set('file', new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], 'photo.png', { type: 'image/png' }))
    const photo = (await (await me(`/api/spaces/${space!.id}/files`, { method: 'POST', body: form })).json()) as ObjectRecord

    const remote = server()
    const setupCode = remote.accounts.setupCode()!
    const migration = new Migration({ store: local.store, media: local.media, fetch: (url, init) => Promise.resolve(remote.app.request(String(url), init)) })

    // A wrong code fails before anything moves; the right one then works.
    migration.start(localUser.id, { server: 'http://vasta.test', code: 'AAAA-AAAA-AAAA', username: 'arie', password: PASSWORD })
    expect(await finished(migration)).toMatchObject({ phase: 'failed', step: 'account', error: 'wrong setup code; it is in the server’s log' })
    expect(remote.store.listUsers()).toEqual([])
    migration.start(localUser.id, { server: 'http://vasta.test', code: setupCode, username: 'arie', name: 'Arie L.', password: PASSWORD, timeZone: 'America/Sao_Paulo' })
    expect(await finished(migration)).toMatchObject({ phase: 'done', server: 'http://vasta.test/', done: 1, total: 1 })

    // On the other server: the account, with the local space and nothing else, logged in with the new password.
    const there = browser(remote.app)
    expect((await there('/api/auth/login', json({ username: 'arie', password: PASSWORD }))).status).toBe(200)
    const user = (await (await there('/api/auth/me')).json()) as User
    expect(user).toMatchObject({ name: 'Arie L.', timeZone: 'America/Sao_Paulo' })
    expect(((await (await there('/api/spaces')).json()) as Space[]).map((s) => [s.id, s.name])).toEqual([[space!.id, space!.name]])
    const moved = (await (await there(`/api/objects/${index.id}`)).json()) as ObjectRecord
    expect(moved).toMatchObject({ title: 'Index', content: { body }, createdBy: user.id, updatedBy: user.id })
    expect(((await (await there(`/api/objects/${coffee.id}/backlinks`)).json()) as unknown[]).length).toBe(1)
    expect(((await (await there(`/api/spaces/${space!.id}/trash`)).json()) as { objects: ObjectRecord[] }).objects.map((o) => o.title)).toEqual(['Old idea'])
    const file = await there(`/media/${photo.media!.file!.key}`)
    expect([file.status, [...new Uint8Array(await file.arrayBuffer())]]).toEqual([200, [137, 80, 78, 71, 1, 2, 3]])
    // Imported as nobody: no activity of the import itself.
    expect(remote.store.objectActivity(index.id)).toEqual([])

    // Trying again resumes with the same account; nothing doubles.
    migration.start(localUser.id, { server: 'http://vasta.test', code: setupCode, username: 'arie', password: PASSWORD })
    expect(await finished(migration)).toMatchObject({ phase: 'done' })
    expect(remote.store.listUsers().length).toBe(1)
    expect(remote.store.listSpaces().length).toBe(1)
  })

  it('joins with an invite link, next to the spaces the account shares', async () => {
    const local = server({ localKey: 'k' })
    await browser(local.app)('/api/auth/local?key=k&name=ana')
    const remote = server()
    const admin = await remote.accounts.createUser({ username: 'arie', password: PASSWORD })
    const shared = remote.accounts.createSpace('Family', admin.id)
    const { code } = remote.accounts.createInvite(admin.id, { spaceId: shared.id })
    const migration = new Migration({ store: local.store, media: local.media, fetch: (url, init) => Promise.resolve(remote.app.request(String(url), init)) })
    migration.start(local.store.listUsers()[0]!.id, { code: `http://vasta.test/?invite=${code}`, username: 'ana', password: PASSWORD })
    expect(await finished(migration)).toMatchObject({ phase: 'done' })
    const ana = remote.store.findUserByUsername('ana')!
    expect(remote.store.listUserSpaces(ana.id).map((s) => s.name).sort()).toEqual(['Family', 'ana'])
  })

  it('refuses an older server before making the account, and rows of spaces that are not yours', async () => {
    const local = server({ localKey: 'k' })
    await browser(local.app)('/api/auth/local?key=k&name=ana')
    const old = server()
    const oldFetch = (url: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(String(url).endsWith('/api/health') ? Response.json({ ok: true }) : old.app.request(String(url), init))
    const migration = new Migration({ store: local.store, media: local.media, fetch: oldFetch })
    migration.start(local.store.listUsers()[0]!.id, { server: 'vasta.test', code: old.accounts.setupCode()!, username: 'ana', password: PASSWORD })
    expect(await finished(migration)).toMatchObject({ phase: 'failed', error: 'vasta.test runs an older Vasta. Update it to 0.3.1 or later, then try again.' })
    expect(old.store.listUsers()).toEqual([])

    const remote = server()
    const owner = await remote.accounts.createUser({ username: 'arie', password: PASSWORD })
    const theirs = remote.store.listUserSpaces(owner.id)[0]!
    await remote.accounts.createUser({ username: 'eve', password: PASSWORD })
    const eve = browser(remote.app)
    await eve('/api/auth/login', json({ username: 'eve', password: PASSWORD }))
    const row = { table: 'spaces', id: theirs.id, spaceId: theirs.id, rev: 1, clock: {}, record: { ...theirs, name: 'Mine now' } }
    expect(await (await eve('/api/import', json({ rows: [row] }))).json()).toEqual({ error: `this server has a space with the id ${theirs.id} already` })
    expect(remote.store.getSpace(theirs.id)!.name).toBe(theirs.name)
    expect((await eve('/api/import/media/abc', { method: 'PUT', body: new Uint8Array([1]) })).status).toBe(400)
    const wrong = `${'0'.repeat(64)}.png`
    expect(await (await eve(`/api/import/media/${wrong}`, { method: 'PUT', body: new Uint8Array([1]) })).json()).toEqual({ error: 'the file does not match its key' })
  })

  it('offers /api/migrate only on the desktop app’s own server', async () => {
    const local = server({ localKey: 'k' })
    const me = browser(local.app)
    await me('/api/auth/local?key=k&name=ana')
    expect(await (await me('/api/migrate')).json()).toEqual({ phase: 'idle', done: 0, total: 0 })
    expect(await (await me('/api/migrate', json({ code: 'AAAA-AAAA-AAAA', username: 'ana', password: PASSWORD }))).json()).toEqual({ error: 'type the address of the server' })

    const remote = server()
    const admin = await remote.accounts.createUser({ username: 'arie', password: PASSWORD })
    const them = browser(remote.app)
    await them('/api/auth/login', json({ username: 'arie', password: PASSWORD }))
    expect(admin.id).toBeTruthy()
    expect((await them('/api/migrate')).status).toBe(404)
  })
})
