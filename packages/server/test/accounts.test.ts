import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { builtinTypeId, createBuiltinTypes, type ObjectRecord, type ObjectSummary, type Space, type User } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { AccountService, hashPassword, verifyPassword } from '../src/accounts.ts'
import { createApp } from '../src/app.ts'
import { CaptureService } from '../src/capture.ts'
import { ChangeFeed, DesktopListeners } from '../src/events.ts'

const start = '2026-10-18T12:00:00.000Z'
const APP = { 'x-requested-with': 'vasta', 'content-type': 'application/json' }

function setup() {
  const store = new NodeStore(':memory:')
  // A space imported before accounts existed.
  store.putSpace({ id: 'old', name: 'Imported', sidebar: [], createdAt: start })
  for (const type of createBuiltinTypes('old', start)) store.putType(type)
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-accounts-')))
  const clock = { at: start }
  const now = () => clock.at
  const feed = new ChangeFeed()
  const capture = new CaptureService({ store, media, feed, now, timeZone: 'UTC' })
  const accounts = new AccountService({ store, now, capture })
  const desktop = new DesktopListeners()
  const app = createApp({ store, media, feed, capture, accounts, now, desktop })
  return { store, media, clock, feed, accounts, app, desktop }
}

/** A browser: keeps the session cookie between requests. */
function browser(app: ReturnType<typeof setup>['app']) {
  let cookie = ''
  const request = async (url: string, init: RequestInit = {}) => {
    const response = await app.request(url, { ...init, headers: { ...APP, ...(init.headers as Record<string, string>), ...(cookie ? { cookie } : {}) } })
    const set = response.headers.get('set-cookie')
    if (set) cookie = /Max-Age=0|expires=Thu, 01 Jan 1970/i.test(set) ? '' : set.split(';')[0]!
    return response
  }
  const login = (username: string, password: string) => request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })
  return { request, login, cookie: () => cookie }
}

const PASSWORD = 'correct horse'

describe('passwords', () => {
  it('hashes with a salt and verifies', async () => {
    const a = await hashPassword(PASSWORD)
    expect(a).toMatch(/^scrypt\$65536\$8\$1\$/)
    expect(await hashPassword(PASSWORD)).not.toBe(a)
    expect(await verifyPassword(PASSWORD, a)).toBe(true)
    expect(await verifyPassword('wrong', a)).toBe(false)
    expect(await verifyPassword(PASSWORD, 'garbage')).toBe(false)
  })
})

describe('accounts', () => {
  it('gives the first user the existing spaces and later users a space of their own', async () => {
    const { store, accounts } = setup()
    const arie = await accounts.createUser({ username: 'arie', password: PASSWORD })
    const ana = await accounts.createUser({ username: 'Ana', name: 'Ana Lima', password: PASSWORD, timeZone: 'Europe/Lisbon' })
    expect(store.listUserSpaces(arie.id).map((s) => s.id)).toEqual(['old'])
    const [anaSpace] = store.listUserSpaces(ana.id)
    expect(anaSpace).toMatchObject({ name: 'Ana Lima' })
    expect(store.memberRole(anaSpace!.id, ana.id)).toBe('owner')
    expect(store.listTypes(anaSpace!.id).length).toBeGreaterThan(5)
    await expect(accounts.createUser({ username: 'ANA', password: PASSWORD })).rejects.toThrow('taken')
    await expect(accounts.createUser({ username: 'bo', password: 'short' })).rejects.toThrow('at least 8')
    await expect(accounts.createUser({ username: 'x y', password: PASSWORD })).rejects.toThrow('username')
    expect(() => accounts.unshare(anaSpace!.id, ana.id)).toThrow('last owner')
  })

  it('logs in with a cookie, needs the app header for changes, and logs out', async () => {
    const { app, accounts } = setup()
    const b = browser(app)
    expect(await (await b.request('/api/auth/me')).json()).toEqual({ error: 'log in first', noUsers: true })
    await accounts.createUser({ username: 'arie', password: PASSWORD })

    expect((await b.request('/api/spaces')).status).toBe(401)
    expect((await b.login('arie', 'nope nope')).status).toBe(401)
    const login = await b.login('ARIE', PASSWORD)
    expect(login.status).toBe(200)
    expect(login.headers.get('set-cookie')).toMatch(/vasta_session=.+; .*HttpOnly.*SameSite=Lax/)
    expect(((await (await b.request('/api/auth/me')).json()) as User).username).toBe('arie')
    expect(((await (await b.request('/api/spaces')).json()) as Space[]).map((s) => s.id)).toEqual(['old'])

    // A cookie alone is not enough to change anything (cross-site requests cannot add the header).
    const page = builtinTypeId('old', 'page')
    const forged = await b.request('/api/objects', { method: 'POST', body: JSON.stringify({ typeId: page }), headers: { 'x-requested-with': '' } })
    expect(forged.status).toBe(403)
    expect((await b.request('/api/objects', { method: 'POST', body: JSON.stringify({ typeId: page }) })).status).toBe(201)
    expect((await app.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'arie', password: PASSWORD }) })).status).toBe(403)

    expect((await b.request('/api/auth/logout', { method: 'POST' })).status).toBe(204)
    expect(b.cookie()).toBe('')
    expect((await b.request('/api/spaces')).status).toBe(401)
  })

  it('creates the first account from the web app with the setup code, and only the first', async () => {
    const { app, accounts, store } = setup()
    const b = browser(app)
    const code = accounts.setupCode()!
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(accounts.setupCode()).toBe(code)
    const setUp = (body: Record<string, string>) => b.request('/api/auth/setup', { method: 'POST', body: JSON.stringify(body) })

    expect(await (await setUp({ code: 'AAAA-AAAA-AAAA', username: 'arie', password: PASSWORD })).json()).toEqual({ error: 'wrong setup code; it is in the server’s log' })
    expect((await setUp({ code, username: 'arie', password: 'short' })).status).toBe(400)
    expect((await app.request('/api/auth/setup', { method: 'POST', body: JSON.stringify({ code, username: 'arie', password: PASSWORD }) })).status).toBe(403)

    const created = await setUp({ code: code.toLowerCase().replaceAll('-', ' '), username: 'arie', name: 'Arie', password: PASSWORD, timeZone: 'America/Sao_Paulo' })
    expect(created.status).toBe(201)
    expect(((await (await b.request('/api/auth/me')).json()) as User)).toMatchObject({ username: 'arie', name: 'Arie', timeZone: 'America/Sao_Paulo' })
    // The first account owns the spaces that had no members.
    expect(store.listUserSpaces((await created.json() as User).id).map((s) => s.id)).toEqual(['old'])

    expect(accounts.setupCode()).toBeUndefined()
    expect(await (await browser(app).request('/api/auth/setup', { method: 'POST', body: JSON.stringify({ code, username: 'eve', password: PASSWORD }) })).json()).toEqual({ error: 'this server already has an account; log in instead' })
  })

  it('lets the first account invite people, who make their own account with the link, once', async () => {
    const { app, accounts, store, clock } = setup()
    const arie = await accounts.createUser({ username: 'arie', password: PASSWORD })
    const admin = browser(app)
    await admin.login('arie', PASSWORD)

    const made = await admin.request('/api/auth/invites', { method: 'POST', body: JSON.stringify({ spaceId: 'old', role: 'editor' }) })
    expect(made.status).toBe(201)
    const { code, invite } = (await made.json()) as { code: string; invite: { id: string; expiresAt: string } }
    expect(invite.expiresAt).toBe('2026-10-25T12:00:00.000Z')
    expect(await (await admin.request('/api/auth/accounts')).json()).toMatchObject({ admin: true, users: [{ username: 'arie' }], invites: [{ id: invite.id, spaceName: 'Imported', role: 'editor' }] })

    // Whoever has the link sees what it is, without logging in.
    const ana = browser(app)
    expect(await (await ana.request(`/api/auth/invite?code=${code}`)).json()).toEqual({ expiresAt: invite.expiresAt, invitedBy: 'arie', spaceName: 'Imported' })
    expect((await ana.request('/api/auth/invite?code=nope')).status).toBe(404)
    const join = (body: Record<string, string>, as = ana) => as.request('/api/auth/join', { method: 'POST', body: JSON.stringify(body) })
    expect(await (await join({ code, username: 'arie', password: PASSWORD })).json()).toEqual({ error: 'the username arie is taken' })
    const joined = await join({ code, username: 'ana', name: 'Ana Lima', password: PASSWORD })
    expect(joined.status).toBe(201)
    const anaId = ((await joined.json()) as User).id
    expect(((await (await ana.request('/api/auth/me')).json()) as User).username).toBe('ana')
    expect(store.memberRole('old', anaId)).toBe('editor')
    // Used up.
    expect((await join({ code, username: 'eve', password: PASSWORD }, browser(app))).status).toBe(400)

    // Only the first account invites, and an invite expires after a week.
    expect((await ana.request('/api/auth/invites', { method: 'POST', body: '{}' })).status).toBe(403)
    expect(await (await ana.request('/api/auth/accounts')).json()).toEqual({ admin: false, adminName: 'arie' })
    const later = accounts.createInvite(arie.id)
    clock.at = '2026-10-25T12:00:01.000Z'
    expect(accounts.invite(later.code)).toBeUndefined()
    expect(accounts.listInvites()).toEqual([])
  })

  it('keeps users out of spaces they are not members of', async () => {
    const { app, store, accounts, feed } = setup()
    await accounts.createUser({ username: 'arie', password: PASSWORD })
    const ana = await accounts.createUser({ username: 'ana', password: PASSWORD })
    const anaSpace = store.listUserSpaces(ana.id)[0]!
    const arie = browser(app)
    const her = browser(app)
    await arie.login('arie', PASSWORD)
    await her.login('ana', PASSWORD)

    const page = builtinTypeId('old', 'page')
    const secret = (await (await arie.request('/api/objects', { method: 'POST', body: JSON.stringify({ typeId: page, title: 'Secret diary' }) })).json()) as ObjectRecord

    expect(((await (await her.request('/api/spaces')).json()) as Space[]).map((s) => s.id)).toEqual([anaSpace.id])
    for (const url of ['/api/spaces/old', '/api/spaces/old/search?q=secret', `/api/objects/${secret.id}`, `/api/objects/${secret.id}/backlinks`, `/api/types/${page}`, `/api/types/${page}/objects`]) {
      expect((await her.request(url)).status, url).toBe(404)
    }
    expect((await her.request(`/api/objects/${secret.id}`, { method: 'PUT', body: JSON.stringify({ ...secret, title: 'mine' }) })).status).toBe(404)
    expect((await her.request(`/api/objects/${secret.id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await her.request('/api/objects', { method: 'POST', body: JSON.stringify({ typeId: page }) })).status).toBe(400)
    expect((await her.request('/api/types', { method: 'POST', body: JSON.stringify({ spaceId: 'old', name: 'Mine' }) })).status).toBe(400)
    expect((await her.request('/api/spaces/old/daily-notes/2026-10-18', { method: 'POST' })).status).toBe(404)
    expect(await (await her.request(`/api/objects?ids=${secret.id}`)).json()).toEqual([])
    expect(store.getObject(secret.id)!.title).toBe('Secret diary')

    // Her own objects cannot move to a type of another space either.
    const own = (await (await her.request('/api/objects', { method: 'POST', body: JSON.stringify({ typeId: builtinTypeId(anaSpace.id, 'page') }) })).json()) as ObjectRecord
    expect((await her.request(`/api/objects/${own.id}`, { method: 'PUT', body: JSON.stringify({ ...own, typeId: page }) })).status).toBe(400)

    // Live changes only reach members of the space.
    const stream = (await her.request('/api/events')).body!.getReader()
    feed.emit({ kind: 'object', id: secret.id, spaceId: 'old', typeId: page, updatedAt: start })
    feed.emit({ kind: 'object', id: own.id, spaceId: anaSpace.id, typeId: own.typeId, updatedAt: start })
    let text = ''
    while (!text.includes(own.id)) text += new TextDecoder().decode((await stream.read()).value)
    await stream.cancel()
    expect(text).not.toContain(secret.id)

    // Once shared, she can use it.
    accounts.share('old', ana.id, 'editor')
    expect(((await (await her.request(`/api/objects/${secret.id}`)).json()) as ObjectRecord).title).toBe('Secret diary')
    expect(((await (await her.request('/api/spaces')).json()) as Space[]).map((s) => s.id).sort()).toEqual([anaSpace.id, 'old'].sort())
    const found = (await (await her.request('/api/spaces/old/search?q=diary')).json()) as ObjectSummary[]
    expect(found.map((o) => o.id)).toEqual([secret.id])
  })

  it('captures with per-user tokens into the token owner\'s space', async () => {
    const { app, store, accounts } = setup()
    await accounts.createUser({ username: 'arie', password: PASSWORD })
    const ana = await accounts.createUser({ username: 'ana', password: PASSWORD })
    const anaSpace = store.listUserSpaces(ana.id)[0]!
    const { secret } = accounts.createToken(ana.id, 'browser', 'capture')
    const bearer = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }

    const response = await app.request('/api/capture/note', { method: 'POST', headers: bearer, body: JSON.stringify({ text: 'hello' }) })
    expect(response.status).toBe(201)
    const { dailyNoteId } = (await response.json()) as { dailyNoteId: string }
    expect(store.getObject(dailyNoteId)!.spaceId).toBe(anaSpace.id)
    expect((await app.request('/api/capture/note', { method: 'POST', headers: bearer, body: JSON.stringify({ text: 'x', spaceId: 'old' }) })).status).toBe(400)
    // A capture token cannot read the rest of the API.
    expect((await app.request('/api/spaces', { headers: bearer })).status).toBe(401)
    expect(store.listTokens(ana.id)[0]!.lastUsedAt).toBe(start)
  })

  it('locks a name after repeated failures', async () => {
    const { app, accounts, clock } = setup()
    await accounts.createUser({ username: 'arie', password: PASSWORD })
    const b = browser(app)
    for (let i = 0; i < 5; i++) expect((await b.login('arie', 'wrong password')).status).toBe(401)
    expect((await b.login('arie', PASSWORD)).status).toBe(429)
    clock.at = '2026-10-18T12:00:31.000Z'
    expect((await b.login('arie', PASSWORD)).status).toBe(200)
  }, 20_000)

  it('changes the password, logging out the other sessions', async () => {
    const { app, accounts } = setup()
    await accounts.createUser({ username: 'arie', password: PASSWORD })
    const laptop = browser(app)
    const phone = browser(app)
    await laptop.login('arie', PASSWORD)
    await phone.login('arie', PASSWORD)
    const change = (current: string, password: string) => laptop.request('/api/auth/password', { method: 'PUT', body: JSON.stringify({ current, password }) })
    expect((await change('wrong one', 'new password')).status).toBe(400)
    expect((await change(PASSWORD, 'new password')).status).toBe(204)
    expect((await laptop.request('/api/spaces')).status).toBe(200)
    expect((await phone.request('/api/spaces')).status).toBe(401)
    expect((await phone.login('arie', 'new password')).status).toBe(200)
  })

  it('expires sessions after 30 days without use, and slides while used', async () => {
    const { app, accounts, clock } = setup()
    await accounts.createUser({ username: 'arie', password: PASSWORD })
    const b = browser(app)
    await b.login('arie', PASSWORD)
    clock.at = '2026-11-10T12:00:00.000Z' // 23 days later: renewed
    const renewed = await b.request('/api/spaces')
    expect(renewed.headers.get('set-cookie')).toMatch(/expires=Thu, 10 Dec 2026/i)
    clock.at = '2026-12-09T12:00:00.000Z'
    expect((await b.request('/api/spaces')).status).toBe(200)
    clock.at = '2027-02-01T00:00:00.000Z'
    expect((await b.request('/api/spaces')).status).toBe(401)
  })

  it('needs a login for media', async () => {
    const { app, media, accounts } = setup()
    await accounts.createUser({ username: 'arie', password: PASSWORD })
    const { key } = await media.put(new Uint8Array([1, 2, 3]), 'dot.png')
    expect((await app.request(`/media/${key}`)).status).toBe(401)
    const b = browser(app)
    await b.login('arie', PASSWORD)
    const ok = await b.request(`/media/${key}`)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toMatch(/^private/)
  })

  it('updates the profile from the app', async () => {
    const { app, store, accounts } = setup()
    const arie = await accounts.createUser({ username: 'arie', password: PASSWORD })
    const ana = await accounts.createUser({ username: 'ana', password: PASSWORD })
    const b = browser(app)
    await b.login('arie', PASSWORD)
    const put = (body: unknown) => b.request('/api/auth/me', { method: 'PUT', body: JSON.stringify(body) })
    const saved = await put({ name: ' Arie S ', timeZone: 'America/Sao_Paulo', captureSpaceId: 'old' })
    expect(await saved.json()).toMatchObject({ name: 'Arie S', timeZone: 'America/Sao_Paulo', captureSpaceId: 'old' })
    expect(await (await put({ timeZone: 'Mars/Olympus' })).json()).toEqual({ error: 'unknown time zone Mars/Olympus' })
    expect((await put({ captureSpaceId: store.listUserSpaces(ana.id)[0]!.id })).status).toBe(400)
    expect((await put({ name: '' })).status).toBe(400)
    await put({ timeZone: null, captureSpaceId: null })
    const user = store.getUser(arie.id)!
    expect(user.name).toBe('Arie S')
    expect(user.timeZone).toBeUndefined()
    expect(user.captureSpaceId).toBeUndefined()

    // Inbox preferences: the word and fading are kept; an empty word and no fading clear them.
    expect(await (await put({ inbox: { reviewedLabel: ' Triaged ', fadeReviewed: true } })).json()).toMatchObject({ inbox: { reviewedLabel: 'Triaged', fadeReviewed: true } })
    expect(store.getUser(arie.id)!.inbox).toEqual({ reviewedLabel: 'Triaged', fadeReviewed: true })
    await put({ inbox: { reviewedLabel: '  ', fadeReviewed: false } })
    expect(store.getUser(arie.id)!.inbox).toBeUndefined()
  })

  it('creates spaces and manages members; only owners manage, anyone may leave', async () => {
    const { app, store, accounts } = setup()
    await accounts.createUser({ username: 'arie', password: PASSWORD })
    const ana = await accounts.createUser({ username: 'ana', password: PASSWORD })
    await accounts.createUser({ username: 'bo', password: PASSWORD })
    const arie = browser(app)
    const her = browser(app)
    await arie.login('arie', PASSWORD)
    await her.login('ana', PASSWORD)
    const send = (who: typeof arie, method: string, url: string, body?: unknown) => who.request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) })

    const created = await send(arie, 'POST', '/api/spaces', { name: 'Home', icon: { kind: 'emoji', value: '🏠' } })
    expect(created.status).toBe(201)
    const home = (await created.json()) as Space
    expect(home).toMatchObject({ name: 'Home', icon: { kind: 'emoji', value: '🏠' } })
    expect(store.listTypes(home.id).length).toBeGreaterThan(5)

    const members = `/api/spaces/${home.id}/members`
    expect((await send(her, 'GET', members)).status).toBe(404)
    expect(await (await send(arie, 'POST', members, { username: 'nobody' })).json()).toEqual({ error: 'no user called nobody' })
    expect((await send(arie, 'POST', members, { username: 'ANA' })).status).toBe(201)
    expect((await send(arie, 'POST', members, { username: 'ana' })).status).toBe(400)
    const list = (await (await send(her, 'GET', members)).json()) as { username: string; role: string }[]
    expect(list.map((m) => [m.username, m.role])).toEqual([['arie', 'owner'], ['ana', 'editor']])

    // Editors use the space (renaming included) but do not manage its members.
    expect((await send(her, 'PUT', `/api/spaces/${home.id}`, { name: 'Our home' })).status).toBe(200)
    expect((await send(her, 'POST', members, { username: 'bo' })).status).toBe(403)
    expect((await send(her, 'PUT', `${members}/${ana.id}`, { role: 'owner' })).status).toBe(403)
    const arieId = store.findUserByUsername('arie')!.id
    expect((await send(her, 'DELETE', `${members}/${arieId}`)).status).toBe(403)

    // A space keeps at least one owner.
    expect(await (await send(arie, 'PUT', `${members}/${arieId}`, { role: 'editor' })).json()).toEqual({ error: 'a space needs at least one owner' })
    expect((await send(arie, 'PUT', `${members}/${ana.id}`, { role: 'owner' })).status).toBe(200)
    expect((await send(arie, 'PUT', `${members}/${arieId}`, { role: 'editor' })).status).toBe(200)
    expect((await send(arie, 'POST', members, { username: 'bo' })).status).toBe(403)
    expect(await (await send(her, 'DELETE', `${members}/${ana.id}`)).json()).toEqual({ error: 'the last owner of a space cannot leave it' })

    // Leaving is always allowed for the rest.
    expect((await send(arie, 'DELETE', `${members}/${arieId}`)).status).toBe(204)
    expect((await send(arie, 'GET', members)).status).toBe(404)
    expect(store.listMembers(home.id).map((m) => m.userId)).toEqual([ana.id])
  })

  it('gives the desktop app a token that only hears notifications, one per device', async () => {
    const { app, store, accounts, desktop } = setup()
    const arie = await accounts.createUser({ username: 'arie', password: PASSWORD })
    const b = browser(app)
    await b.login('arie', PASSWORD)
    const make = async () => ((await (await b.request('/api/auth/desktop-token', { method: 'POST', body: JSON.stringify({ device: 'Mac 3f2a' }) })).json()) as { token: string }).token
    const first = await make()
    const token = await make()
    expect(store.listTokens(arie.id).map((t) => [t.name, t.scope])).toEqual([['Desktop notifications · Mac 3f2a', 'notify']])
    const bearer = (secret: string) => ({ authorization: `Bearer ${secret}`, 'content-type': 'application/json' })
    // Neither capture nor the API, nor another token.
    expect((await app.request('/api/capture/note', { method: 'POST', headers: bearer(token), body: JSON.stringify({ text: 'hi' }) })).status).toBe(401)
    expect((await app.request('/api/spaces', { headers: bearer(token) })).status).toBe(401)
    expect((await app.request('/api/auth/desktop-token', { method: 'POST', headers: bearer(token), body: '{}' })).status).toBe(401)
    expect((await app.request('/api/notifications', { headers: bearer(first) })).status).toBe(401)

    const response = await app.request('/api/notifications', { headers: bearer(token) })
    expect(response.status).toBe(200)
    expect(desktop.count(arie.id)).toBe(1)
    const reader = response.body!.getReader()
    await reader.read()
    expect(desktop.send(arie.id, { key: 'k', title: 'Lunch not logged', message: '1 200 kcal so far' })).toBe(1)
    let text = ''
    while (!text.includes('Lunch')) text += new TextDecoder().decode((await reader.read()).value)
    expect(text).toContain('event: notify')
    await reader.cancel()
  })

  it('manages capture tokens per user', async () => {
    const { app, store, accounts } = setup()
    await accounts.createUser({ username: 'arie', password: PASSWORD })
    const ana = await accounts.createUser({ username: 'ana', password: PASSWORD })
    const theirs = accounts.createToken(ana.id, 'phone', 'capture').token
    const b = browser(app)
    await b.login('arie', PASSWORD)

    const response = await b.request('/api/tokens', { method: 'POST', body: JSON.stringify({ name: 'browser' }) })
    expect(response.status).toBe(201)
    const { token, secret } = (await response.json()) as { token: { id: string; scope: string }; secret: string }
    expect(token.scope).toBe('capture')
    expect(secret).toMatch(/^vst_/)
    const capture = await app.request('/api/capture/note', { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) })
    expect(capture.status).toBe(201)

    const listed = (await (await b.request('/api/tokens')).json()) as { id: string; lastUsedAt?: string }[]
    expect(listed.map((t) => t.id)).toEqual([token.id])
    expect(listed[0]!.lastUsedAt).toBe(start)
    expect(JSON.stringify(listed)).not.toContain(secret)
    expect((await b.request(`/api/tokens/${theirs.id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await b.request(`/api/tokens/${token.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(store.listTokens().map((t) => t.id)).toEqual([theirs.id])
  })

  it('links Telegram with a code from the app', async () => {
    const { app, store, accounts } = setup()
    const arie = await accounts.createUser({ username: 'arie', password: PASSWORD })
    const b = browser(app)
    await b.login('arie', PASSWORD)
    expect(await (await b.request('/api/auth/telegram')).json()).toEqual({ linked: false })
    const { code } = (await (await b.request('/api/auth/telegram/code', { method: 'POST' })).json()) as { code: string }
    expect(code).toMatch(/^[A-Z2-9]{8}$/)
    accounts.linkTelegram(code, 4242)
    expect(await (await b.request('/api/auth/telegram')).json()).toEqual({ linked: true })
    expect((await b.request('/api/auth/telegram', { method: 'DELETE' })).status).toBe(204)
    expect(store.getUser(arie.id)!.telegramUserId).toBeUndefined()
  })

  it('keeps the login throttle across restarts', async () => {
    const { store, accounts, clock } = setup()
    await accounts.createUser({ username: 'arie', password: PASSWORD })
    for (let i = 0; i < 5; i++) await accounts.verifyLogin('arie', 'wrong one')
    // A new service on the same database, as after a restart.
    const restarted = new AccountService({ store, now: () => clock.at })
    await expect(restarted.verifyLogin('arie', PASSWORD)).rejects.toThrow('too many failed logins')
    clock.at = '2026-10-18T12:01:00.000Z'
    expect(await restarted.verifyLogin('arie', PASSWORD)).toBeTruthy()
    expect(store.loginFailure('arie')).toBeUndefined()
  })

  it('lists sessions, revokes one, and logs out everywhere else', async () => {
    const { app, accounts, clock } = setup()
    await accounts.createUser({ username: 'arie', password: PASSWORD })
    const phone = browser(app)
    const laptop = browser(app)
    await phone.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'arie', password: PASSWORD }), headers: { 'user-agent': 'iPhone Safari' } })
    clock.at = '2026-10-18T12:05:00.000Z'
    await laptop.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'arie', password: PASSWORD }), headers: { 'user-agent': 'Mac Firefox' } })
    const tablet = browser(app)
    await tablet.login('arie', PASSWORD)

    clock.at = '2026-10-18T12:10:00.000Z'
    type Info = { id: string; userAgent?: string; current: boolean; lastSeenAt?: string }
    const list = (await (await laptop.request('/api/auth/sessions')).json()) as Info[]
    expect(list).toHaveLength(3)
    expect(list.filter((s) => s.current).map((s) => s.userAgent)).toEqual(['Mac Firefox'])
    expect(list[0]).toMatchObject({ current: true, lastSeenAt: '2026-10-18T12:10:00.000Z' })
    expect(list.every((s) => /^[a-f0-9]{16}$/.test(s.id))).toBe(true)

    const phoneSession = list.find((s) => s.userAgent === 'iPhone Safari')!
    expect((await laptop.request(`/api/auth/sessions/${phoneSession.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await phone.request('/api/spaces')).status).toBe(401)
    expect((await laptop.request('/api/auth/sessions/0000000000000000', { method: 'DELETE' })).status).toBe(404)

    expect((await laptop.request('/api/auth/sessions', { method: 'DELETE' })).status).toBe(204)
    expect((await tablet.request('/api/spaces')).status).toBe(401)
    expect((await laptop.request('/api/spaces')).status).toBe(200)
  })

  it('deletes a space to the trash, then purges it after 30 days', async () => {
    const { app, accounts, store, clock } = setup()
    const arie = await accounts.createUser({ username: 'arie', password: PASSWORD })
    const ana = await accounts.createUser({ username: 'ana', password: PASSWORD })
    const owner = browser(app)
    await owner.login('arie', PASSWORD)
    const home = (await (await owner.request('/api/spaces', { method: 'POST', body: JSON.stringify({ name: 'Home' }) })).json()) as Space
    accounts.share(home.id, ana.id, 'editor')
    const page = (await (await owner.request('/api/objects', { method: 'POST', body: JSON.stringify({ typeId: builtinTypeId(home.id, 'page'), title: 'Groceries' }) })).json()) as ObjectRecord
    store.putUser({ ...store.getUser(arie.id)!, captureSpaceId: home.id })

    const editor = browser(app)
    await editor.login('ana', PASSWORD)
    const del = (b: ReturnType<typeof browser>, id: string, name: string) => b.request(`/api/spaces/${id}`, { method: 'DELETE', body: JSON.stringify({ name }) })
    expect((await del(editor, home.id, 'Home')).status).toBe(403)
    expect((await del(owner, home.id, 'Hom')).status).toBe(400)
    // The user's only other space is 'old'; deleting both is refused at the last one.
    expect((await del(owner, home.id, 'Home')).status).toBe(204)
    expect((await del(owner, 'old', 'Imported')).status).toBe(400)

    // Gone for every member at once.
    const names = async (b: ReturnType<typeof browser>) => ((await (await b.request('/api/spaces')).json()) as Space[]).map((s) => s.name)
    expect(await names(owner)).toEqual(['Imported'])
    expect((await owner.request(`/api/objects/${page.id}`)).status).toBe(404)
    expect(accounts.captureSpaceId(store.getUser(arie.id)!)).toBe('old')
    // Ana had only her own space and Home: she keeps hers.
    expect(await names(editor)).toEqual(['ana'])

    // Restored within 30 days, it is back as it was.
    accounts.restoreSpace(home.id)
    expect(await names(owner)).toEqual(['Imported', 'Home'])
    expect((await del(owner, home.id, 'Home')).status).toBe(204)

    clock.at = '2026-11-16T12:00:00.000Z'
    expect(accounts.purgeDeletedSpaces()).toEqual([])
    clock.at = '2026-11-17T12:00:01.000Z'
    expect(accounts.purgeDeletedSpaces().map((s) => s.name)).toEqual(['Home'])
    expect(store.listDeletedSpaces()).toEqual([])
    expect(store.getObject(page.id)).toBeUndefined()
    expect(store.listTypes(home.id)).toEqual([])
    expect(store.getUser(arie.id)?.captureSpaceId).toBeUndefined()
  })

  it('gives a user left without spaces a new one', async () => {
    const { app, accounts, store } = setup()
    const arie = await accounts.createUser({ username: 'arie', password: PASSWORD })
    const ana = await accounts.createUser({ username: 'ana', password: PASSWORD })
    const shared = accounts.createSpace('Shared', arie.id)
    accounts.share(shared.id, ana.id, 'owner')
    const b = browser(app)
    await b.login('ana', PASSWORD)
    const own = store.listUserSpaces(ana.id).find((s) => s.id !== shared.id)!
    expect((await b.request(`/api/spaces/${own.id}`, { method: 'DELETE', body: JSON.stringify({ name: own.name }) })).status).toBe(204)
    // Then removed from the shared space by its other owner: the next listing makes her a new one.
    accounts.unshare(shared.id, ana.id)
    const spaces = (await (await b.request('/api/spaces')).json()) as Space[]
    expect(spaces).toHaveLength(1)
    expect(spaces[0]).toMatchObject({ name: 'ana' })
    expect(store.memberRole(spaces[0]!.id, ana.id)).toBe('owner')
  })
})
