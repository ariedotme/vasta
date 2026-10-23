// HTTP API over a Vasta store, for any number of users. The web app logs in with a session cookie
// (/api/auth); capture channels and scripts send bearer tokens. Every route checks that the user
// is a member of the space it touches; see docs/accounts.md.
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { compress } from 'hono/compress'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { serveStatic } from '@hono/node-server/serve-static'
import { streamSSE } from 'hono/streaming'
import type { CalendarSource, ColorName, Icon, Id, InboxPreferences, ObjectRecord, ObjectType, QueryDef, Space, SpaceRole, TokenScope } from '@vasta/core'
import {
  ACTIVITY_RETENTION_CHOICES,
  addDays,
  dayIn,
  flowMetrics,
  statusProperty,
  CommentError,
  WriteRefused,
  NutritionError,
  QuoteError,
  SOURCE_PROPERTY_ID,
  SYNC_PROTOCOL,
  applyEdit,
  canonicalJson,
  createQuote,
  type FoodLineAnswer,
  daysBetween,
  deleteFoodEntry,
  isValidTimeZone,
  logFood,
  newObject,
  newType,
  normalizeNutritionSettings,
  objectFromLine,
  querySpace,
  setNutritionEnabled,
  setSprints,
  SprintError,
} from '@vasta/core'
import { OccurrenceError, calendarObjects, changeOccurrence, compareEntries, dayReferences, objectEntries, type OccurrenceEdit } from '@vasta/core/calendar'
import { checkMediaKey, RangeNotSatisfiableError, type MediaStore } from '@vasta/core/media'
import type { NodeStore } from '@vasta/core/node'
import { AccountError, AccountService, type Auth } from './accounts.ts'
import { currentActor, runAs } from './actor.ts'
import { AgentTools } from './agent.ts'
import { CalendarService, CalendarSyncError, normalizeCalendarUrl } from './calendars.ts'
import { CaptureError, CaptureService, mergeCaptures, type CaptureResult } from './capture.ts'
import { ReminderError, type ReminderService } from './reminders.ts'
import { ChannelSettings, type TelegramChat } from './channels.ts'
import { findOrCreateDailyNote, isValidDay } from './daily.ts'
import { ChangeFeed, type DesktopListeners } from './events.ts'
import { listInbox, setCaptureDone } from './inbox.ts'
import { handleMcp } from './mcp.ts'
import { NotificationService } from './notifications.ts'
import { openApi } from './openapi.ts'
import { MAX_PULL_LIMIT, MAX_PUSH_CHANGES, MAX_TEXT_OBJECTS, pull, push, textUpdates, type SyncChange } from './sync.ts'
import { WeblinkError, WeblinkService } from './weblinks.ts'

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  heic: 'image/heic', pdf: 'application/pdf', mp3: 'audio/mpeg', m4a: 'audio/mp4', oga: 'audio/ogg', ogg: 'audio/ogg',
  wav: 'audio/wav', webm: 'audio/webm', mp4: 'video/mp4', mov: 'video/quicktime',
}

export interface AppOptions {
  store: NodeStore
  media: MediaStore
  now?: () => string
  feed?: ChangeFeed
  /** Shared with other channels (the Telegram bot); created with the system time zone if missing. */
  capture?: CaptureService
  /** Users, sessions and tokens; main.ts shares it with the Telegram bot. */
  accounts?: AccountService
  /** Legacy single bearer token for /api/capture, acting as the oldest user (when `accounts` is not given). */
  captureToken?: string
  /** Subscribed calendars; main.ts starts its periodic sync. */
  calendars?: CalendarService
  /** Saving URLs from the app; shared with the capture service. */
  weblinks?: WeblinkService
  /** Directory of the built web app (packages/web/dist); served for every path outside the API. */
  webDir?: string
  /** The Telegram bot, when it runs: its username, for the linking instructions in settings. */
  /** The Telegram bot: its @username once started, whether it runs, and the chats it listens in. */
  telegram?: { username: () => string | undefined; running?: boolean; channels?: ChannelSettings }
  /** Habit, event and food reminders through ntfy, Telegram and the desktop app (Settings › Reminders). */
  reminders?: ReminderService
  /** Desktop apps listening for reminders on /api/events?desktop=1. */
  desktop?: DesktopListeners
  /** False keeps web apps off their local replica (header `x-vasta-replica: off` on /api/auth/me). Default true. */
  replica?: boolean
  /** The web app's address (VASTA_WEB_URL), for links in agents' results; the request's own address when unset. */
  webUrl?: string
}

type Env = { Variables: { auth: Auth } }

const SESSION_COOKIE = 'vasta_session'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
/**
 * Requests from the web app carry this header. Browsers only add custom headers to cross-site
 * requests after a CORS preflight, which the server never grants, so a cookie-authenticated change
 * without it did not come from Vasta's own pages.
 */
const CLIENT_HEADER = 'x-requested-with'
const CLIENT_VALUE = 'vasta'

const isHttps = (c: Context) => new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https'
const fromApp = (c: Context) => c.req.header(CLIENT_HEADER) === CLIENT_VALUE

/** Largest file accepted by uploads and file captures. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

const uploadLimit = bodyLimit({
  // A little room for the multipart envelope around the file.
  maxSize: MAX_UPLOAD_BYTES + 64 * 1024,
  onError: (c) => c.json({ error: `files can be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` }, 413),
})

/** The file and text fields of a multipart upload. */
async function readUpload(c: Context) {
  const form = await c.req.formData().catch(() => undefined)
  const file = form?.get('file')
  if (!form || !(file instanceof File)) throw new CaptureError('send multipart/form-data with a file field')
  const field = (name: string) => {
    const value = form.get(name)
    return typeof value === 'string' && value ? value : undefined
  }
  const caption = field('caption')
  return {
    file: { data: new Uint8Array(await file.arrayBuffer()), name: file.name || 'file', ...(file.type ? { mimeType: file.type } : {}), ...(caption ? { caption } : {}) },
    field,
  }
}

/** Version of the tools the MCP endpoint offers (docs/agents.md). */
const MCP_VERSION = '1.0.0'

/** At most a little over a year per calendar request, so a bad range cannot expand forever. */
const MAX_CALENDAR_DAYS = 400

export function createApp({ store, media, now = () => new Date().toISOString(), feed = new ChangeFeed(), capture, accounts, captureToken, calendars, weblinks, webDir, telegram, replica = true, webUrl, reminders, desktop }: AppOptions) {
  const app = new Hono<Env>()
  // A write the store refuses (another member's comment) is the caller's mistake, not the server's.
  app.onError((error, c) => {
    if (error instanceof WriteRefused || error instanceof CommentError) return c.json({ error: error.message }, 403)
    // As Hono does without a handler.
    if ('getResponse' in error && typeof error.getResponse === 'function') return error.getResponse() as Response
    console.error(error)
    return c.text('Internal Server Error', 500)
  })
  // JSON answers can be large (a first sync pulls tens of MB on a big space). Only JSON: the event
  // streams (text/event-stream) must reach the client as written, not in compressed blocks.
  app.use('/api/*', compress({ contentTypeFilter: /^application\/json/ }))
  const api = new Hono<Env>()
  store.actor = currentActor
  const notifications = new NotificationService({ store, ...(reminders ? { reminders } : {}), now })
  const links = weblinks ?? new WeblinkService({ store, media, feed, now })
  const baseCapture = capture ?? new CaptureService({ store, media, feed, now, weblinks: links, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })
  const users = accounts ?? new AccountService({ store, now, capture: baseCapture, ...(captureToken ? { legacyCaptureToken: captureToken } : {}) })
  const calendarService = calendars ?? new CalendarService({ store, feed, now })
  const changed = (object: Pick<ObjectRecord, 'id' | 'spaceId' | 'typeId' | 'updatedAt'>) =>
    feed.emit({ kind: 'object', id: object.id, spaceId: object.spaceId, typeId: object.typeId, updatedAt: object.updatedAt })
  const typeChanged = (type: ObjectType) => feed.emit({ kind: 'type', id: type.id, spaceId: type.spaceId })
  store.onRev((spaceId, rev) => feed.emit({ kind: 'rev', spaceId, rev }))

  // Authentication -------------------------------------------------------------
  const setSessionCookie = (c: Context, secret: string, expiresAt: string) =>
    setCookie(c, SESSION_COOKIE, secret, { path: '/', httpOnly: true, sameSite: 'Lax', secure: isHttps(c), expires: new Date(expiresAt) })

  /** Who sent the request: a bearer token, else the session cookie. */
  const identify = (c: Context): Auth | undefined => {
    const header = c.req.header('authorization') ?? ''
    if (header.startsWith('Bearer ')) return users.bearer(header.slice(7).trim())
    const secret = getCookie(c, SESSION_COOKIE)
    const session = secret ? users.session(secret) : undefined
    if (secret && session?.renewedUntil) setSessionCookie(c, secret, session.renewedUntil)
    return session
  }

  const requireAuth = (accept: (auth: Auth) => boolean, error: string) =>
    createMiddleware<Env>(async (c, next) => {
      const auth = identify(c)
      if (!auth || !accept(auth)) return c.json({ error }, 401)
      if (auth.sessionId && !SAFE_METHODS.has(c.req.method) && !fromApp(c)) return c.json({ error: `send the ${CLIENT_HEADER}: ${CLIENT_VALUE} header` }, 403)
      c.set('auth', auth)
      await runAs(auth.user.id, next)
    })
  /** The web app (session) or a token for the whole API. */
  const appAuth = requireAuth((auth) => !!auth.sessionId || auth.scope === 'api', 'log in first')
  /** A capture token, or one for the whole API. */
  const captureAuth = requireAuth((auth) => auth.scope === 'capture' || auth.scope === 'api', 'invalid capture token')
  /** The desktop app's notifications: its own token, or the web app. */
  const notifyAuth = requireAuth((auth) => auth.scope === 'notify' || !!auth.sessionId, 'invalid notification token')
  /** Agents (MCP): a token for the whole API. */
  const agentAuth = requireAuth((auth) => auth.scope === 'api', 'send a token with scope api: Authorization: Bearer <token> (Settings › Capture tokens)')

  const authApi = new Hono<Env>()

  authApi.get('/me', (c) => {
    if (!replica) c.header('x-vasta-replica', 'off')
    const auth = identify(c)
    if (!auth) return c.json({ error: 'log in first', ...(users.hasUsers() ? {} : { noUsers: true }) }, 401)
    return c.json(auth.user)
  })

  authApi.post('/login', async (c) => {
    if (!fromApp(c)) return c.json({ error: `send the ${CLIENT_HEADER}: ${CLIENT_VALUE} header` }, 403)
    const body = await c.req.json<{ username?: string; password?: string }>().catch(() => ({}) as { username?: string; password?: string })
    let user
    try {
      user = await users.verifyLogin(String(body.username ?? ''), String(body.password ?? ''))
    } catch (error) {
      if (error instanceof AccountError) return c.json({ error: error.message }, 429)
      throw error
    }
    if (!user) return c.json({ error: 'wrong username or password' }, 401)
    const { secret, expiresAt } = users.startSession(user.id, c.req.header('user-agent'))
    setSessionCookie(c, secret, expiresAt)
    return c.json(user)
  })

  /** The first account, while there is none: needs the setup code from the server's log. */
  authApi.post('/setup', async (c) => {
    if (!fromApp(c)) return c.json({ error: `send the ${CLIENT_HEADER}: ${CLIENT_VALUE} header` }, 403)
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
    const text = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : '')
    let user
    try {
      user = await users.setUp(text('code'), { username: text('username'), name: text('name'), password: text('password'), ...(text('timeZone') ? { timeZone: text('timeZone') } : {}) })
    } catch (error) {
      if (error instanceof AccountError) return c.json({ error: error.message }, 400)
      throw error
    }
    const { secret, expiresAt } = users.startSession(user.id, c.req.header('user-agent'))
    setSessionCookie(c, secret, expiresAt)
    return c.json(user, 201)
  })

  // Invites (Settings › Server accounts): the server's first account lists the accounts and makes
  // links that let someone make their own; whoever opens one sees what it is, and joins with it.
  authApi.get('/accounts', appAuth, (c) => {
    const me = c.get('auth').user.id
    const admin = store.listUsers()[0]
    if (!users.isServerAdmin(me)) return c.json({ admin: false, adminName: admin?.name ?? '' })
    const spaceName = (id?: Id) => (id ? store.getSpace(id)?.name : undefined)
    return c.json({
      admin: true,
      adminName: admin?.name ?? '',
      users: store.listUsers().map(({ id, username, name, createdAt }) => ({ id, username, name, createdAt })),
      invites: users.listInvites().map((invite) => ({ ...invite, ...(invite.spaceId ? { spaceName: spaceName(invite.spaceId) ?? '' } : {}) })),
    })
  })
  authApi.post('/invites', appAuth, async (c) => {
    const body = await c.req.json<{ spaceId?: unknown; role?: unknown }>().catch(() => ({}) as { spaceId?: unknown; role?: unknown })
    const role = body.role === 'owner' ? 'owner' : 'editor'
    try {
      return c.json(users.createInvite(c.get('auth').user.id, { ...(typeof body.spaceId === 'string' && body.spaceId ? { spaceId: body.spaceId, role } : {}) }), 201)
    } catch (error) {
      if (error instanceof AccountError) return c.json({ error: error.message }, 403)
      throw error
    }
  })
  authApi.delete('/invites/:id', appAuth, (c) => {
    try {
      users.revokeInvite(c.get('auth').user.id, c.req.param('id'))
      return c.body(null, 204)
    } catch (error) {
      if (error instanceof AccountError) return c.json({ error: error.message }, 403)
      throw error
    }
  })
  authApi.get('/invite', (c) => {
    const invite = users.invite(c.req.query('code') ?? '')
    if (!invite) return c.json({ error: 'this invite is not valid any more; ask for a new one' }, 404)
    const space = invite.spaceId ? store.getSpace(invite.spaceId) : undefined
    return c.json({ expiresAt: invite.expiresAt, invitedBy: store.getUser(invite.createdBy)?.name ?? '', ...(space ? { spaceName: space.name } : {}) })
  })
  authApi.post('/join', async (c) => {
    if (!fromApp(c)) return c.json({ error: `send the ${CLIENT_HEADER}: ${CLIENT_VALUE} header` }, 403)
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>)
    const text = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : '')
    let user
    try {
      user = await users.join(text('code'), { username: text('username'), name: text('name'), password: text('password'), ...(text('timeZone') ? { timeZone: text('timeZone') } : {}) })
    } catch (error) {
      if (error instanceof AccountError) return c.json({ error: error.message }, 400)
      throw error
    }
    const { secret, expiresAt } = users.startSession(user.id, c.req.header('user-agent'))
    setSessionCookie(c, secret, expiresAt)
    return c.json(user, 201)
  })

  authApi.post('/logout', (c) => {
    const secret = getCookie(c, SESSION_COOKIE)
    if (secret) users.endSession(secret)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.body(null, 204)
  })

  /** Change the password: other sessions are logged out, this one stays. */
  authApi.put('/password', appAuth, async (c) => {
    const auth = c.get('auth')
    const body = await c.req.json<{ current?: string; password?: string }>().catch(() => ({}) as { current?: string; password?: string })
    try {
      if (!(await users.verifyLogin(auth.user.username, String(body.current ?? '')))) return c.json({ error: 'the current password is wrong' }, 400)
      await users.setPassword(auth.user.id, String(body.password ?? ''), auth.sessionId)
    } catch (error) {
      if (error instanceof AccountError) return c.json({ error: error.message }, 400)
      throw error
    }
    return c.body(null, 204)
  })

  /** Run an account change, answering 400 with the reason when AccountService refuses it. */
  const accountChange = async (c: Context, run: () => Response | Promise<Response>) => {
    try {
      return await run()
    } catch (error) {
      if (error instanceof AccountError) return c.json({ error: error.message }, 400)
      throw error
    }
  }

  /** Name, time zone (null: the server's), capture space (null: the first space) and inbox preferences. */
  authApi.put('/me', appAuth, (c) =>
    accountChange(c, async () => {
      type Profile = { name?: string; timeZone?: string | null; captureSpaceId?: string | null; inbox?: InboxPreferences | null }
      const body = await c.req.json<Profile>().catch(() => ({}) as Profile)
      const changes = {
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(body.timeZone === null || typeof body.timeZone === 'string' ? { timeZone: body.timeZone } : {}),
        ...(body.captureSpaceId === null || typeof body.captureSpaceId === 'string' ? { captureSpaceId: body.captureSpaceId } : {}),
        ...(typeof body.inbox === 'object' ? { inbox: body.inbox } : {}),
      }
      return c.json(users.updateProfile(c.get('auth').user.id, changes))
    })
  )

  // Reminders (Settings › Reminders): the user's channels and what reminds them.
  authApi.get('/reminders', appAuth, (c) => (reminders ? c.json(reminders.view(c.get('auth').user.id)) : c.json({ error: 'reminders are off on this server' }, 404)))

  authApi.put('/reminders', appAuth, async (c) => {
    if (!reminders) return c.json({ error: 'reminders are off on this server' }, 404)
    const body = await c.req.json<Parameters<ReminderService['save']>[1]>().catch(() => ({}))
    try {
      return c.json(reminders.save(c.get('auth').user.id, body))
    } catch (error) {
      if (error instanceof ReminderError) return c.json({ error: error.message }, 400)
      throw error
    }
  })

  authApi.post('/reminders/test', appAuth, async (c) => {
    if (!reminders) return c.json({ error: 'reminders are off on this server' }, 404)
    try {
      return c.json(await reminders.test(c.get('auth').user.id))
    } catch (error) {
      if (error instanceof ReminderError) return c.json({ error: error.message }, 400)
      throw error
    }
  })

  /** Whether Telegram is linked, and the bot to write to (absent when the bot does not run). */
  authApi.get('/telegram', appAuth, (c) => {
    const user = store.getUser(c.get('auth').user.id)
    const bot = telegram?.username()
    return c.json({ linked: user?.telegramUserId !== undefined, ...(bot ? { bot } : {}) })
  })

  /** A one-time code to send to the bot as `/link <code>`. */
  /**
   * A token for the desktop app to hear the user's reminders on its own (/api/notifications), with
   * the window closed: asked by the web app inside it, handed to the app. One per device: a new
   * one replaces the token the device had.
   */
  authApi.post('/desktop-token', appAuth, async (c) => {
    if (!c.get('auth').sessionId) return c.json({ error: 'log in first' }, 401)
    const body = await c.req.json<{ device?: string }>().catch(() => ({}) as { device?: string })
    const device = String(body.device ?? '').replace(/[^\w .()-]/g, '').trim().slice(0, 40)
    if (!device) return c.json({ error: 'device is required' }, 400)
    const userId = c.get('auth').user.id
    const name = `Desktop notifications · ${device}`
    for (const old of store.listTokens(userId)) if (old.scope === 'notify' && old.name === name) store.deleteToken(old.id)
    const { secret } = users.createToken(userId, name, 'notify')
    return c.json({ token: secret }, 201)
  })

  // The desktop app hears its user's reminders here, as SSE `notify` events, while it runs.
  app.get('/api/notifications', notifyAuth, (c) =>
    streamSSE(c, async (stream) => {
      const unlisten = desktop ? desktop.listen(c.get('auth').user.id, (n) => void stream.writeSSE({ event: 'notify', data: JSON.stringify(n) })) : () => {}
      stream.onAbort(unlisten)
      while (!stream.aborted) {
        await stream.write(': ping\n\n')
        await stream.sleep(25_000)
      }
      unlisten()
    })
  )

  authApi.post('/telegram/code', appAuth, (c) => {
    const bot = telegram?.username()
    return c.json({ ...users.telegramCode(c.get('auth').user.id), ...(bot ? { bot } : {}) })
  })

  authApi.delete('/telegram', appAuth, (c) => {
    users.unlinkTelegram(c.get('auth').user.id)
    return c.body(null, 204)
  })

  // Capture channels (Settings): which run, and the bot's chats. Those are the server's, not one
  // user's, so only its first account (who set it up) changes them; everyone else sees the state.
  const channels = telegram?.channels ?? new ChannelSettings(store)
  const isFirstAccount = (userId: Id) => users.isServerAdmin(userId)
  const channelState = (userId: Id) => {
    const bot = telegram?.username()
    const manage = isFirstAccount(userId)
    return {
      telegram: {
        running: !!telegram?.running,
        ...(bot ? { bot } : {}),
        linked: store.getUser(userId)?.telegramUserId !== undefined,
        linkedAccounts: store.listUsers().filter((u) => u.telegramUserId !== undefined).length,
        allowedChats: channels.allowedChats(),
        manage,
        ...(manage ? { ignoredChats: channels.ignoredChats() } : {}),
      },
      tokens: store.listTokens(userId).length,
    }
  }

  authApi.get('/channels', appAuth, (c) => c.json(channelState(c.get('auth').user.id)))

  /** The chats the bot listens in ({ allowedChats: [{ id, title? }] }; empty: any chat a linked account writes in). */
  authApi.put('/channels/telegram', appAuth, async (c) => {
    const userId = c.get('auth').user.id
    if (!isFirstAccount(userId)) return c.json({ error: 'only the account that set up this server changes its channels' }, 403)
    const body = await c.req.json<{ allowedChats?: TelegramChat[] }>().catch(() => ({}) as { allowedChats?: TelegramChat[] })
    if (!Array.isArray(body.allowedChats)) return c.json({ error: 'allowedChats is required' }, 400)
    channels.setAllowedChats(body.allowedChats)
    return c.json(channelState(userId))
  })

  /** The caller's browser sessions, the current one marked. */
  authApi.get('/sessions', appAuth, (c) => c.json(users.listSessions(c.get('auth').user.id, c.get('auth').sessionId)))

  /** Log out every other session ("log out everywhere else"). */
  authApi.delete('/sessions', appAuth, (c) => {
    const auth = c.get('auth')
    store.deleteUserSessions(auth.user.id, auth.sessionId)
    return c.body(null, 204)
  })

  authApi.delete('/sessions/:id', appAuth, (c) => {
    const auth = c.get('auth')
    const current = users.listSessions(auth.user.id, auth.sessionId).find((s) => s.current)
    if (!users.revokeSession(auth.user.id, c.req.param('id'))) return c.json({ error: 'not found' }, 404)
    if (current?.id === c.req.param('id')) deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.body(null, 204)
  })

  // Access: a user only reaches the spaces they are a member of. Records in other spaces answer
  // 404, as if they did not exist.
  const userOf = (c: Context<Env>) => c.get('auth').user
  const allowed = (c: Context<Env>, spaceId: Id | undefined) => users.canUse(userOf(c).id, spaceId)
  const spaceIdsOf = (c: Context<Env>) => new Set(store.listUserSpaces(userOf(c).id).map((s) => s.id))
  const guard = (lookup: (id: string) => Id | undefined) =>
    createMiddleware<Env>(async (c, next) => {
      const spaceId = lookup(c.req.param('id') ?? '')
      if (spaceId !== undefined && !allowed(c, spaceId)) return c.json({ error: 'not found' }, 404)
      await next()
    })
  const guarded: [string, (id: string) => Id | undefined][] = [
    ['/spaces', (id) => id],
    ['/types', (id) => store.getType(id)?.spaceId],
    ['/objects', (id) => store.objectSpaceId(id)],
    ['/calendar-sources', (id) => store.getCalendarSource(id)?.spaceId],
  ]
  for (const [base, lookup] of guarded) {
    api.use(`${base}/:id`, guard(lookup))
    api.use(`${base}/:id/*`, guard(lookup))
  }

  api.get('/spaces', (c) => c.json(users.spacesOf(userOf(c))))

  /** A new space with the built-in types, owned by the caller. */
  api.post('/spaces', async (c) => {
    const body = await c.req.json<{ name?: string; icon?: Icon }>().catch(() => ({}) as { name?: string; icon?: Icon })
    if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400)
    const space = users.createSpace(body.name, userOf(c).id)
    if (body.icon) store.putSpace({ ...space, icon: body.icon })
    return c.json(store.getSpace(space.id), 201)
  })

  // Members: everyone in a space sees who else is; only owners add, remove or change roles, and
  // anyone may leave. A space keeps at least one owner.
  const memberList = (spaceId: Id) =>
    store.listMembers(spaceId).flatMap((m) => {
      const user = store.getUser(m.userId)
      return user ? [{ userId: user.id, username: user.username, name: user.name, role: m.role, createdAt: m.createdAt }] : []
    })
  const ownerOnly = createMiddleware<Env>(async (c, next) => {
    if (!users.isOwner(userOf(c).id, c.req.param('id') ?? '')) return c.json({ error: 'only owners of the space can do this' }, 403)
    await next()
  })

  /**
   * Delete a space (owners only): it goes to the trash for TRASH_DAYS, hidden from every
   * member, then is purged. The body repeats the space's name ({ name }) so a stray request
   * cannot delete one.
   */
  api.delete('/spaces/:id', ownerOnly, (c) =>
    accountChange(c, async () => {
      const space = store.getSpace(c.req.param('id'))
      const body = await c.req.json<{ name?: string }>().catch(() => ({}) as { name?: string })
      if (!space) return c.json({ error: 'not found' }, 404)
      if (body.name?.trim() !== space.name.trim()) return c.json({ error: 'type the name of the space to delete it' }, 400)
      users.deleteSpace(userOf(c).id, space.id)
      return c.body(null, 204)
    })
  )
  /** Spaces in the trash that the caller owned, for the trash page. */
  const deletedSpacesOf = (userId: Id) =>
    store.listDeletedSpaces().filter((s) => store.listMembers(s.id).some((m) => m.userId === userId && m.role === 'owner'))

  api.get('/deleted-spaces', (c) => c.json(deletedSpacesOf(userOf(c).id)))

  api.post('/deleted-spaces/:id/restore', (c) =>
    accountChange(c, () => {
      const space = deletedSpacesOf(userOf(c).id).find((s) => s.id === c.req.param('id'))
      if (!space) return c.json({ error: 'not found' }, 404)
      users.restoreSpace(space.id)
      return c.json(store.getSpace(space.id))
    })
  )
  const roleOf = (value: unknown): SpaceRole | undefined => (value === 'owner' || value === 'editor' ? value : undefined)

  api.get('/spaces/:id/members', (c) => c.json(memberList(c.req.param('id'))))

  api.post('/spaces/:id/members', ownerOnly, (c) =>
    accountChange(c, async () => {
      const body = await c.req.json<{ username?: string; role?: string }>().catch(() => ({}) as { username?: string; role?: string })
      users.addMember(c.req.param('id'), String(body.username ?? ''), roleOf(body.role) ?? 'editor')
      return c.json(memberList(c.req.param('id')), 201)
    })
  )

  api.put('/spaces/:id/members/:userId', ownerOnly, (c) =>
    accountChange(c, async () => {
      const body = await c.req.json<{ role?: string }>().catch(() => ({}) as { role?: string })
      const role = roleOf(body.role)
      if (!role) return c.json({ error: 'role is owner or editor' }, 400)
      users.setRole(c.req.param('id'), c.req.param('userId'), role)
      return c.json(memberList(c.req.param('id')))
    })
  )

  api.delete('/spaces/:id/members/:userId', (c) =>
    accountChange(c, () => {
      const spaceId = c.req.param('id')
      const target = c.req.param('userId')
      if (target !== userOf(c).id && !users.isOwner(userOf(c).id, spaceId)) return c.json({ error: 'only owners of the space can manage its members' }, 403)
      if (!store.memberRole(spaceId, target)) return c.json({ error: 'not found' }, 404)
      users.unshare(spaceId, target)
      return c.body(null, 204)
    })
  )

  // Tokens: each user sees and manages only their own. The secret is returned once, on creation.
  api.get('/tokens', (c) => c.json(store.listTokens(userOf(c).id)))

  api.post('/tokens', async (c) => {
    const body = await c.req.json<{ name?: string; scope?: string }>().catch(() => ({}) as { name?: string; scope?: string })
    if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400)
    const scope: TokenScope = body.scope === 'api' ? 'api' : 'capture'
    const { secret, token } = users.createToken(userOf(c).id, body.name.slice(0, 60), scope)
    return c.json({ token, secret }, 201)
  })

  api.delete('/tokens/:id', (c) => {
    const id = c.req.param('id')
    if (!store.listTokens(userOf(c).id).some((t) => t.id === id)) return c.json({ error: 'not found' }, 404)
    store.deleteToken(id)
    return c.body(null, 204)
  })

  api.get('/spaces/:id', (c) => {
    const space = store.getSpace(c.req.param('id'))
    if (!space) return c.json({ error: 'not found' }, 404)
    return c.json({ space, types: store.listTypes(space.id), counts: store.typeCounts(space.id), trash: store.trashCount(space.id) })
  })

  // Routes that change a stored row read it after the body: a write landing while the body
  // arrives (a device's push) would otherwise be overwritten with the copy read before it.
  api.put('/spaces/:id', async (c) => {
    const body = await c.req.json<Partial<Space>>()
    const existing = store.getSpace(c.req.param('id'))
    if (!existing) return c.json({ error: 'not found' }, 404)
    const nutrition = normalizeNutritionSettings(body.nutrition)
    const space: Space = {
      ...existing,
      ...(body.name?.trim() ? { name: body.name.trim() } : {}),
      ...(body.icon ? { icon: body.icon } : {}),
      ...(Array.isArray(body.sidebar) ? { sidebar: body.sidebar } : {}),
      ...(nutrition ? { nutrition } : {}),
    }
    store.putSpace(space)
    return c.json(space)
  })

  /** Turn food tracking on (making its types) or off (hiding it; nothing is deleted). */
  api.post('/spaces/:id/nutrition', async (c) => {
    const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({}) as { enabled?: boolean })
    if (!store.getSpace(c.req.param('id'))) return c.json({ error: 'not found' }, 404)
    const result = setNutritionEnabled(store, c.req.param('id'), body.enabled !== false, now())
    for (const type of result.types) typeChanged(type)
    return c.json(result)
  })

  /** Turn sprints on or off, or rename them: `{ enabled?, name?, pluralName? }` (core sprints.ts). */
  api.post('/spaces/:id/sprints', async (c) => {
    const body = await c.req.json<{ enabled?: unknown; name?: unknown; pluralName?: unknown }>().catch(() => ({}) as Record<string, unknown>)
    if (!store.getSpace(c.req.param('id'))) return c.json({ error: 'not found' }, 404)
    try {
      const result = setSprints(store, c.req.param('id'), {
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.pluralName === 'string' ? { pluralName: body.pluralName } : {}),
      }, now())
      for (const type of result.types) typeChanged(type)
      return c.json(result)
    } catch (error) {
      if (error instanceof SprintError) return c.json({ error: error.message }, 400)
      throw error
    }
  })

  /** Log something eaten: `{ sourceId, amount, day, meal?, at?, timeZone? }`. */
  api.post('/spaces/:id/food', async (c) => {
    const body = await c.req.json<{ sourceId?: string; amount?: string; day?: string; meal?: string; at?: string; timeZone?: string }>().catch(() => ({}) as Record<string, undefined>)
    if (!store.getSpace(c.req.param('id'))) return c.json({ error: 'not found' }, 404)
    if (!body.day || !isValidDay(body.day)) return c.json({ error: 'day must be YYYY-MM-DD' }, 400)
    if (body.at !== undefined && Number.isNaN(Date.parse(body.at))) return c.json({ error: 'at must be a time' }, 400)
    try {
      const result = logFood(store, c.req.param('id'), {
        sourceId: String(body.sourceId ?? ''),
        amount: String(body.amount ?? ''),
        day: body.day,
        ...(body.meal ? { meal: String(body.meal) } : {}),
        ...(body.at ? { at: new Date(body.at).toISOString() } : {}),
        timeZone: body.timeZone && isValidTimeZone(body.timeZone) ? body.timeZone : (userOf(c).timeZone ?? 'UTC'),
      }, now())
      changed(result.note)
      return c.json(result, 201)
    } catch (error) {
      if (error instanceof NutritionError) return c.json({ error: error.message }, error.message.endsWith('not found') ? 404 : 400)
      throw error
    }
  })

  /** The space's templates and snippets (core's templates.ts), whole: they are listed nowhere else. */
  api.get('/spaces/:id/templates', (c) => {
    const space = store.getSpace(c.req.param('id'))
    if (!space) return c.json({ error: 'not found' }, 404)
    return c.json(store.listTemplates(space.id))
  })

  api.get('/spaces/:id/search', (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 30) || 30, 100)
    return c.json(store.search(c.req.param('id'), c.req.query('q') ?? '', limit))
  })

  /** Open a daily note by date ("YYYY-MM-DD", in the client's calendar), creating it on first use. */
  api.post('/spaces/:id/daily-notes/:day', (c) => {
    const space = store.getSpace(c.req.param('id'))
    const day = c.req.param('day')
    if (!space) return c.json({ error: 'not found' }, 404)
    if (!isValidDay(day)) return c.json({ error: 'day must be YYYY-MM-DD' }, 400)
    const { note, created } = findOrCreateDailyNote(store, space.id, day, now())
    if (created) changed(note)
    return c.json(note, created ? 201 : 200)
  })

  /**
   * Run a query. `parentId` is the object it is embedded in (the `parent` variable); `today` and
   * `timeZone` come from the client so "today" matches the user's calendar.
   */
  api.post('/spaces/:id/query', async (c) => {
    const space = store.getSpace(c.req.param('id'))
    if (!space) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json<{ query: QueryDef; parentId?: string; today?: string; timeZone?: string }>()
    if (!body.query || !Array.isArray(body.query.typeIds)) return c.json({ error: 'query is required' }, 400)
    const { query, parentId, today, timeZone } = body
    return c.json(querySpace(store, space.id, { query, ...(parentId ? { parentId } : {}), ...(today ? { today } : {}), ...(timeZone ? { timeZone } : {}), me: userOf(c).id, people: store.people(space.id) }, now()))
  })

  /**
   * Everything dated between two days (inclusive, "YYYY-MM-DD" in `timeZone`): daily notes, objects'
   * dates and date properties (repeats expanded) and events of subscribed calendars. `objects` holds
   * the summaries the entries point to, `references` how many objects link to each day (its note or
   * date objects).
   */
  api.get('/spaces/:id/calendar', (c) => {
    const space = store.getSpace(c.req.param('id'))
    if (!space) return c.json({ error: 'not found' }, 404)
    const from = c.req.query('from') ?? ''
    const to = c.req.query('to') ?? ''
    if (!isValidDay(from) || !isValidDay(to) || to < from) return c.json({ error: 'from and to must be YYYY-MM-DD, from <= to' }, 400)
    if (daysBetween(from, to) > MAX_CALENDAR_DAYS) return c.json({ error: `at most ${MAX_CALENDAR_DAYS} days at a time` }, 400)
    const requestedZone = c.req.query('timeZone')
    const timeZone = requestedZone && isValidTimeZone(requestedZone) ? requestedZone : 'UTC'
    const types = new Map(store.listTypes(space.id).map((t) => [t.id, t]))
    const range = { from, to }
    const objects = calendarObjects(store, space.id, types, range)
    const entries = [...objectEntries(objects, types, range, timeZone), ...calendarService.entries(space.id, range, timeZone)].sort(compareEntries)
    const used = new Set(entries.map((e) => e.objectId).filter(Boolean))
    return c.json({ entries, objects: objects.filter((o) => used.has(o.id)), references: dayReferences(objects, types, range, timeZone, (ids) => store.linkCounts(ids)) })
  })

  // Inbox ---------------------------------------------------------------------
  /**
   * Items captured in the last `days` days (default 14, at most 365) up to `today` (the client's
   * day), newest first, with summaries of the objects in them.
   */
  api.get('/spaces/:id/inbox', (c) => {
    const space = store.getSpace(c.req.param('id'))
    if (!space) return c.json({ error: 'not found' }, 404)
    const requested = c.req.query('today')
    const today = requested && isValidDay(requested) ? requested : now().slice(0, 10)
    const days = Math.min(Math.max(Number(c.req.query('days') ?? 14) || 14, 1), 365)
    const items = listInbox(store, space.id, today, days)
    const objects = store.getObjectSummaries([...new Set(items.flatMap((i) => i.objectIds))]).filter((o) => o.spaceId === space.id)
    return c.json({ items, objects })
  })

  /** Mark a captured item of a daily note done or not done ({ done }). */
  api.put('/objects/:id/captures/:captureId', async (c) => {
    const body = await c.req.json<{ done?: boolean }>().catch(() => ({}) as { done?: boolean })
    const note = setCaptureDone(store, c.req.param('id'), c.req.param('captureId'), !!body.done, now())
    if (!note) return c.json({ error: 'not found' }, 404)
    changed(note)
    return c.json(note)
  })

  /**
   * Capture a text into today's note of the space ({ text, channel }), as the capture channels do
   * (links become weblinks); the desktop app's quick capture uses it when online. With `typeId`,
   * the text's first line is the title and properties of a new object of that type, the other
   * lines its body, and the note embeds it.
   */
  api.post('/spaces/:id/captures', async (c) => {
    const space = store.getSpace(c.req.param('id'))
    if (!space) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json<{ text?: string; channel?: string; typeId?: string }>().catch(() => ({}) as { text?: string; channel?: string; typeId?: string })
    const channel = /^[a-z]{1,20}$/.test(body.channel ?? '') ? body.channel! : 'app'
    const text = String(body.text ?? '')
    if (body.typeId === undefined) return respond(c, () => capturesOf(c).note({ spaceId: space.id, text, channel }))
    const type = store.getType(String(body.typeId))
    if (!type || type.spaceId !== space.id) return c.json({ error: 'unknown type' }, 400)
    const [line = '', ...rest] = text.split('\n')
    return respond(c, () => capturesOf(c).object({ spaceId: space.id, type: type.id, line, text: rest.join('\n'), channel }))
  })

  /** A line of food, as after /food: `{ text }` (core's logFoodLine, in the user's time zone). */
  api.post('/spaces/:id/food-line', async (c) => {
    const space = store.getSpace(c.req.param('id'))
    if (!space) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json<{ text?: string }>().catch(() => ({}) as { text?: string })
    return respondFood(c, () => capturesOf(c).food({ spaceId: space.id, text: String(body.text ?? '') }))
  })

  // Weblinks -----------------------------------------------------------------
  const weblinkResponse = async (c: Context, run: () => Promise<ObjectRecord>) => {
    try {
      return c.json(await run())
    } catch (error) {
      if (error instanceof WeblinkError) return c.json({ error: error.message }, 400)
      throw error
    }
  }

  /** Save a URL as a weblink, or return the one saved before for it (200 instead of 201). Not logged in the daily note. */
  api.post('/spaces/:id/weblinks', async (c) => {
    const space = store.getSpace(c.req.param('id'))
    if (!space) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json<{ url?: string; title?: string }>().catch(() => ({}) as { url?: string; title?: string })
    try {
      const { object, created } = await links.save(space.id, { url: body.url ?? '', ...(body.title ? { title: body.title } : {}) })
      return c.json(object, created ? 201 : 200)
    } catch (error) {
      if (error instanceof WeblinkError) return c.json({ error: error.message }, 400)
      throw error
    }
  })

  // Files --------------------------------------------------------------------
  /**
   * Upload a file (multipart: `file`, optional `caption`) as a new image/PDF/audio/video/file object
   * of the space, without an entry in the daily note; the editor embeds it where it was dropped.
   */
  api.post('/spaces/:id/files', uploadLimit, async (c) => {
    const space = store.getSpace(c.req.param('id'))
    if (!space) return c.json({ error: 'not found' }, 404)
    try {
      const { file } = await readUpload(c)
      return c.json(await baseCapture.upload(space.id, file), 201)
    } catch (error) {
      if (error instanceof CaptureError) return c.json({ error: error.message }, 400)
      throw error
    }
  })

  /** Set (or change) the address of a weblink and load the page's metadata. */
  api.put('/objects/:id/weblink', async (c) => {
    const body = await c.req.json<{ url?: string }>().catch(() => ({}) as { url?: string })
    return weblinkResponse(c, () => links.setUrl(c.req.param('id'), body.url ?? ''))
  })

  api.post('/objects/:id/refresh-link', (c) => weblinkResponse(c, () => links.refresh(c.req.param('id'))))

  /** Save (or replace) the readable text of the page in the weblink's "Readable text" field. */
  api.post('/objects/:id/readable', (c) => weblinkResponse(c, () => links.saveReadable(c.req.param('id'))))

  // Subscribed calendars ------------------------------------------------------
  const sourceInput = async (c: Context) => {
    const body = await c.req.json<{ name?: string; url?: string; color?: ColorName; username?: string; password?: string | null; enabled?: boolean }>()
    return body
  }
  const syncAndReturn = async (id: string) => {
    try {
      await calendarService.sync(id)
    } catch (error) {
      if (!(error instanceof CalendarSyncError)) throw error
    }
    return store.getCalendarSource(id)
  }

  api.get('/spaces/:id/calendar-sources', (c) => c.json(store.listCalendarSources(c.req.param('id'))))

  /** Subscribe to a calendar and fetch it right away; a failed first fetch is reported in `error`. */
  api.post('/spaces/:id/calendar-sources', async (c) => {
    const space = store.getSpace(c.req.param('id'))
    if (!space) return c.json({ error: 'not found' }, 404)
    const body = await sourceInput(c)
    let target: ReturnType<typeof normalizeCalendarUrl>
    try {
      target = normalizeCalendarUrl(body.url ?? '')
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400)
    }
    if (store.listCalendarSources(space.id).some((s) => s.url === target.url)) return c.json({ error: 'this calendar is already subscribed' }, 400)
    const username = body.username?.trim() || target.username
    const password = body.password || target.password
    const source: CalendarSource = {
      id: randomUUID(),
      spaceId: space.id,
      name: body.name?.trim() || new URL(target.url).hostname,
      url: target.url,
      ...(body.color ? { color: body.color } : {}),
      ...(username ? { username } : {}),
      enabled: true,
      createdAt: now(),
    }
    store.putCalendarSource(source, password ?? null)
    const synced = await syncAndReturn(source.id)
    // Without a name of its own, a calendar takes the one its feed declares.
    const feedName = body.name?.trim() ? undefined : calendarService.feedName(source.id)
    if (synced && feedName) {
      store.putCalendarSource({ ...synced, name: feedName })
      return c.json(store.getCalendarSource(source.id), 201)
    }
    return c.json(synced, 201)
  })

  /** Change a subscription. `password`: a string replaces it, null removes it, absent keeps it. */
  api.put('/calendar-sources/:id', async (c) => {
    const body = await sourceInput(c)
    const existing = store.getCalendarSource(c.req.param('id'))
    if (!existing) return c.json({ error: 'not found' }, 404)
    let url = existing.url
    if (body.url !== undefined && body.url !== existing.url) {
      try {
        url = normalizeCalendarUrl(body.url).url
      } catch (error) {
        return c.json({ error: (error as Error).message }, 400)
      }
    }
    const username = body.username === undefined ? existing.username : body.username.trim()
    const { color: _color, username: _username, ...rest } = existing
    const color = body.color === undefined ? existing.color : body.color
    const source: CalendarSource = {
      ...rest,
      name: body.name?.trim() || existing.name,
      url,
      ...(color ? { color } : {}),
      ...(username ? { username } : {}),
      enabled: body.enabled ?? existing.enabled,
    }
    store.putCalendarSource(source, body.password === undefined ? undefined : body.password || null)
    calendarService.forget(source.id)
    const refetch = url !== existing.url || body.password !== undefined || username !== existing.username || (source.enabled && !existing.enabled)
    if (refetch) return c.json(await syncAndReturn(source.id))
    feed.emit({ kind: 'calendar', sourceId: source.id, spaceId: source.spaceId })
    return c.json(store.getCalendarSource(source.id))
  })

  api.delete('/calendar-sources/:id', (c) => {
    const id = c.req.param('id')
    const source = store.getCalendarSource(id)
    store.deleteCalendarSource(id)
    calendarService.forget(id)
    if (source) feed.emit({ kind: 'calendar', sourceId: id, spaceId: source.spaceId })
    return c.body(null, 204)
  })

  api.post('/calendar-sources/:id/sync', async (c) => {
    if (!store.getCalendarSource(c.req.param('id'))) return c.json({ error: 'not found' }, 404)
    return c.json(await syncAndReturn(c.req.param('id')))
  })

  api.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const userId = userOf(c).id
      const unsubscribe = feed.subscribe((event) => {
        if (users.canUse(userId, event.spaceId)) void stream.writeSSE({ event: event.kind === 'rev' ? 'rev' : 'change', data: JSON.stringify(event) })
      })
      // The desktop app shows the user's reminders as system notifications (Settings › Reminders).
      const unlisten = c.req.query('desktop') === '1' && desktop ? desktop.listen(userId, (n) => void stream.writeSSE({ event: 'notify', data: JSON.stringify(n) })) : () => {}
      stream.onAbort(() => {
        unsubscribe()
        unlisten()
      })
      // Comments keep proxies from closing an idle connection.
      while (!stream.aborted) {
        await stream.write(': ping\n\n')
        await stream.sleep(25_000)
      }
      unsubscribe()
      unlisten()
    })
  )

  // Sync (docs/sync-plan.md) ---------------------------------------------------
  const speaksProtocol = (value: unknown) => Number(value) === SYNC_PROTOCOL
  const wrongProtocol = (c: Context) => c.json({ error: `this server speaks sync protocol ${SYNC_PROTOCOL}`, protocol: SYNC_PROTOCOL }, 409)

  /**
   * Rows and tombstones changed after revision `since` in the caller's spaces, oldest first,
   * `limit` at a time (`more` while there are others). `space` limits it to one space, e.g. one
   * just shared with the caller, pulled from 0. `spaces` lists the spaces the caller can see now.
   * `count=1` also answers how many are left after the page (`remaining`), for a progress bar.
   */
  api.get('/sync/pull', (c) => {
    if (!speaksProtocol(c.req.query('protocol'))) return wrongProtocol(c)
    const since = Math.max(Math.floor(Number(c.req.query('since') ?? 0)) || 0, 0)
    const limit = Math.min(Math.max(Math.floor(Number(c.req.query('limit') ?? 500)) || 500, 1), MAX_PULL_LIMIT)
    const spaces = [...spaceIdsOf(c)]
    const space = c.req.query('space')
    if (space && !spaces.includes(space)) return c.json({ error: 'not found' }, 404)
    return c.json({ protocol: SYNC_PROTOCOL, ...pull(store, space ? [space] : spaces, since, limit, c.req.query('count') === '1'), spaces })
  })

  /** Field changes with their HLCs; answers, per change, the fields that lost (or why it was refused). */
  api.post('/sync/push', bodyLimit({ maxSize: 32 * 1024 * 1024, onError: (c) => c.json({ error: 'push fewer changes at a time' }, 413) }), async (c) => {
    const body = await c.req.json<{ protocol?: unknown; changes?: unknown }>().catch(() => undefined)
    if (!body || typeof body !== 'object') return c.json({ error: 'the body must be JSON' }, 400)
    if (!speaksProtocol(body.protocol)) return wrongProtocol(c)
    if (!Array.isArray(body.changes)) return c.json({ error: 'changes is required' }, 400)
    if (body.changes.length > MAX_PUSH_CHANGES) return c.json({ error: `at most ${MAX_PUSH_CHANGES} changes at a time` }, 400)
    const result = push(store, spaceIdsOf(c), body.changes as SyncChange[], now)
    // Open pages of the app hear about the rows as if they were saved through the other routes.
    for (const row of result.written) {
      if (row.table === 'objects') changed(row.record as ObjectRecord)
      else if (row.table === 'types') typeChanged(row.record as ObjectType)
      else if (row.table === 'calendar_sources') feed.emit({ kind: 'calendar', sourceId: row.id, spaceId: row.spaceId })
    }
    return c.json({ protocol: SYNC_PROTOCOL, rev: result.rev, changes: result.changes })
  })

  /**
   * Yjs updates of rich text the caller lacks: `{ objects: { <id>: <state vector, base64; empty
   * for all of it> } }` → `{ objects: { <id>: <update, base64> } }`. A client asks for the objects
   * whose pulled `textVector` has changes its own lacks.
   */
  api.post('/sync/text', bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) => c.json({ error: 'ask for fewer objects at a time' }, 413) }), async (c) => {
    const body = await c.req.json<{ protocol?: unknown; objects?: unknown }>().catch(() => undefined)
    if (!body || typeof body !== 'object') return c.json({ error: 'the body must be JSON' }, 400)
    if (!speaksProtocol(body.protocol)) return wrongProtocol(c)
    const objects = body.objects
    if (!objects || typeof objects !== 'object' || Array.isArray(objects)) return c.json({ error: 'objects is required' }, 400)
    if (Object.keys(objects).length > MAX_TEXT_OBJECTS) return c.json({ error: `at most ${MAX_TEXT_OBJECTS} objects at a time` }, 400)
    return c.json({ protocol: SYNC_PROTOCOL, objects: textUpdates(store, spaceIdsOf(c), objects as Record<string, unknown>) })
  })

  /** The iCalendar data of a subscribed calendar, for a replica whose copy is older than the row's `dataVersion`. */
  api.get('/sync/calendars/:id', (c) => {
    if (!speaksProtocol(c.req.query('protocol'))) return wrongProtocol(c)
    const source = store.getCalendarSource(c.req.param('id'))
    const data = source && spaceIdsOf(c).has(source.spaceId) ? store.calendarData(source.id) : undefined
    if (!source || !data) return c.json({ error: 'not found' }, 404)
    return c.json({ protocol: SYNC_PROTOCOL, data: data.data, version: source.dataVersion ?? '' })
  })

  api.get('/types/:id', (c) => {
    const type = store.getType(c.req.param('id'))
    if (!type) return c.json({ error: 'not found' }, 404)
    return c.json(type)
  })

  api.get('/types/:id/objects', (c) => c.json(store.listObjects(c.req.param('id'))))

  api.post('/types', async (c) => {
    const body = await c.req.json<{ spaceId: string; name: string; pluralName?: string; icon?: Icon }>()
    if (!body.spaceId || !store.getSpace(body.spaceId) || !allowed(c, body.spaceId) || !body.name?.trim()) return c.json({ error: 'spaceId and name are required' }, 400)
    const type = newType(body.spaceId, body, randomUUID(), now())
    store.putType(type)
    return c.json(type, 201)
  })

  api.put('/types/:id', async (c) => {
    const existing = store.getType(c.req.param('id'))
    if (!existing) return c.json({ error: 'not found' }, 404)
    const body = await c.req.json<ObjectType>()
    const type: ObjectType = { ...body, id: existing.id, spaceId: existing.spaceId, createdAt: existing.createdAt, updatedAt: now() }
    if (existing.system) type.system = existing.system
    store.putType(type)
    return c.json(type)
  })

  /** Move a type and its objects to the trash; with ?forever=1, delete a type already in the trash for good. */
  api.delete('/types/:id', (c) => {
    const type = store.getType(c.req.param('id'))
    if (!type) return c.json({ error: 'not found' }, 404)
    if (c.req.query('forever') === '1') {
      if (!type.deletedAt) return c.json({ error: 'move the type to the trash first' }, 400)
      store.purgeType(type.id)
      return c.body(null, 204)
    }
    if (type.deletedAt) return c.json({ error: 'not found' }, 404)
    if (type.system) return c.json({ error: 'built-in types cannot be deleted' }, 400)
    const objects = store.listObjects(type.id)
    store.deleteType(type.id, now())
    typeChanged(type)
    for (const object of objects) changed({ ...object, updatedAt: now() })
    return c.body(null, 204)
  })

  /** Take a type out of the trash, with the objects deleted together with it. */
  api.post('/types/:id/restore', (c) => {
    const result = store.restoreType(c.req.param('id'), now())
    if (!result) return c.json({ error: 'the type is not in the trash' }, 400)
    typeChanged(result.type)
    for (const object of result.objects) changed(object)
    return c.json(result)
  })

  // Trash ---------------------------------------------------------------------
  /** Deleted types (with how many objects went with each) and objects deleted on their own, newest first. */
  api.get('/spaces/:id/trash', (c) => {
    const spaceId = c.req.param('id')
    if (!store.getSpace(spaceId)) return c.json({ error: 'not found' }, 404)
    return c.json({ types: store.listDeletedTypes(spaceId), objects: store.listDeletedObjects(spaceId) })
  })

  /** Empty the trash of a space. */
  api.delete('/spaces/:id/trash', (c) => {
    const spaceId = c.req.param('id')
    if (!store.getSpace(spaceId)) return c.json({ error: 'not found' }, 404)
    return c.json(store.purgeTrash({ spaceId }))
  })

  api.get('/objects', (c) => {
    const ids = (c.req.query('ids') ?? '').split(',').filter(Boolean).slice(0, 200)
    const spaces = spaceIdsOf(c)
    return c.json(store.getObjectSummaries(ids).filter((o) => spaces.has(o.spaceId)))
  })

  api.get('/objects/:id', (c) => {
    const object = store.getObject(c.req.param('id'))
    if (!object) return c.json({ error: 'not found' }, 404)
    return c.json(object)
  })

  /** The id of a block of the object's text ({ field, path }), given one when it has none, to mention or embed it. */
  api.post('/objects/:id/block-ids', async (c) => {
    const body = await c.req.json<{ field?: string; path?: number[] }>().catch(() => ({}) as { field?: string; path?: number[] })
    if (typeof body.field !== 'string' || !Array.isArray(body.path) || !body.path.every((i) => Number.isInteger(i) && i >= 0)) return c.json({ error: 'field and path are required' }, 400)
    const before = store.getObject(c.req.param('id'))?.updatedAt
    const id = store.ensureBlockId(c.req.param('id'), body.field, body.path, now())
    if (!id) return c.json({ error: 'no such block' }, 404)
    const object = store.getObject(c.req.param('id'))!
    if (object.updatedAt !== before) changed(object)
    return c.json({ id })
  })

  // Activity (core activity.ts): what members did to an object, or in a space; recorded by the
  // store, kept for the space's retention (owners change it).
  api.get('/objects/:id/activity', (c) => c.json(store.objectActivity(c.req.param('id'), Math.min(Math.max(Number(c.req.query('limit') ?? 200) || 200, 1), 1000))))

  api.get('/spaces/:id/activity', (c) => {
    const since = c.req.query('since')
    const until = c.req.query('until')
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 5000) || 5000, 1), 100_000)
    return c.json(store.spaceActivity(c.req.param('id'), { ...(since ? { since } : {}), ...(until ? { until } : {}), limit }))
  })

  /**
   * A status type's flow metrics over `from`..`to` (days, in `timeZone`; the last 30 by default):
   * lead and cycle times, throughput, cumulative flow, ages (core metrics.ts).
   */
  api.get('/types/:id/metrics', (c) => {
    const type = store.getType(c.req.param('id'))
    const status = statusProperty(type)
    if (!type || !status) return c.json({ error: 'this type has no status to measure' }, 400)
    const zone = c.req.query('timeZone')
    const timeZone = zone && isValidTimeZone(zone) ? zone : capturesOf(c).timeZone
    const today = dayIn(now(), timeZone)
    const to = isValidDay(c.req.query('to') ?? '') ? c.req.query('to')! : today
    const from = isValidDay(c.req.query('from') ?? '') ? c.req.query('from')! : addDays(to, -29)
    if (from > to || daysBetween(from, to) > 400) return c.json({ error: 'from must be before to, at most 400 days apart' }, 400)
    const objects = store.listObjects(type.id)
    const ids = new Set(objects.map((o) => o.id))
    const activity = store.spaceActivity(type.spaceId).filter((e) => ids.has(e.objectId))
    return c.json({ ...flowMetrics(objects, activity, status, { from, to, timeZone }), retentionDays: store.activityRetention(type.spaceId) })
  })

  api.get('/spaces/:id/activity-settings', (c) => c.json({ retentionDays: store.activityRetention(c.req.param('id')) }))

  api.put('/spaces/:id/activity-settings', ownerOnly, async (c) => {
    const body = await c.req.json<{ retentionDays?: unknown }>().catch(() => ({}) as { retentionDays?: unknown })
    const days = Number(body.retentionDays)
    if (!(ACTIVITY_RETENTION_CHOICES as readonly number[]).includes(days)) return c.json({ error: `retentionDays is one of ${ACTIVITY_RETENTION_CHOICES.join(', ')} (0: keep everything)` }, 400)
    store.setActivityRetention(c.req.param('id'), days)
    store.purgeActivity(now())
    return c.json({ retentionDays: days })
  })

  // Notifications about others' work (notifications.ts): the bell's list and marking them read.
  api.get('/notices', (c) => {
    const user = userOf(c).id
    return c.json({ items: notifications.list(user, Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200)), unread: notifications.unread(user) })
  })

  api.post('/notices/read', async (c) => {
    const body = await c.req.json<{ ids?: unknown }>().catch(() => ({}) as { ids?: unknown })
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is number => Number.isInteger(id)) : undefined
    notifications.markRead(userOf(c).id, ids)
    return c.json({ unread: notifications.unread(userOf(c).id) })
  })

  api.get('/objects/:id/backlinks', (c) => {
    const spaces = spaceIdsOf(c)
    return c.json(store.backlinks(c.req.param('id')).filter((b) => spaces.has(b.object.spaceId)))
  })

  // With `line`, the title and properties are read from it as captures read theirs (capture-line.ts).
  api.post('/objects', async (c) => {
    const { line, ...body } = await c.req.json<Partial<ObjectRecord> & { line?: string }>()
    const type = body.typeId ? store.getType(body.typeId) : undefined
    if (!type || !allowed(c, type.spaceId)) return c.json({ error: 'typeId is required' }, 400)
    if (typeof line === 'string') {
      const captures = capturesOf(c)
      const made = objectFromLine(store, { type, line, ...(body.title ? { title: body.title } : {}), at: now(), context: captures.lineContext(type.spaceId) })
      store.transaction(() => {
        if (made.type) store.putType(made.type)
        for (const object of [...made.related, made.object]) store.putObject(object)
      })
      if (made.type) typeChanged(made.type)
      for (const object of made.related) changed(object)
      changed(made.object)
      return c.json(store.getObject(made.object.id), 201)
    }
    const object = newObject(type, body, randomUUID(), now())
    const stored = store.putObject(object)
    changed(stored)
    return c.json(stored, 201)
  })

  // The body's updatedAt is the version the client edited. If items were captured into the object
  // since, they are kept (see mergeCaptures) and returned, so the client can show them. Media
  // (files, a weblink's page data) is only changed by the server, so the body's copy is ignored.
  // With `base`, the copy the client started from, only what differs from it is written (fields,
  // and rich-text fields whole), so a change made elsewhere meanwhile is not undone; without it
  // (apps from before it), the body replaces the object.
  api.put('/objects/:id', async (c) => {
    const { base, ...body } = await c.req.json<ObjectRecord & { base?: ObjectRecord }>()
    const existing = store.getObject(c.req.param('id'))
    if (!existing) return c.json({ error: 'not found' }, 404)
    if (body.typeId !== existing.typeId && store.getType(body.typeId)?.spaceId !== existing.spaceId) return c.json({ error: 'unknown type' }, 400)
    const { media: _media, ...merged } = mergeCaptures(existing, body)
    let object: ObjectRecord
    if (base && typeof base === 'object') {
      const content = { ...existing.content }
      for (const field of new Set([...Object.keys(body.content ?? {}), ...Object.keys(base.content ?? {})])) {
        if (canonicalJson(body.content?.[field] ?? null) === canonicalJson(base.content?.[field] ?? null)) continue
        if (merged.content[field]) content[field] = merged.content[field]
        else delete content[field]
      }
      const fields = applyEdit(existing, body, base)
      if (!fields && canonicalJson(content) === canonicalJson(existing.content)) return c.json(existing)
      object = { ...(fields ?? existing), content, updatedAt: now() }
    } else {
      object = {
        ...merged,
        ...(existing.media ? { media: existing.media } : {}),
        id: existing.id,
        spaceId: existing.spaceId,
        createdAt: existing.createdAt,
        updatedAt: now(),
      }
    }
    const stored = store.putObject(object)
    changed(stored)
    return c.json(stored)
  })

  /**
   * Change one occurrence of a repeating date (`field`: "date" or a date property), the series
   * from it on, or all of it; see changeOccurrence in core/src/calendar.ts. `created` is the copy
   * "this and following" makes.
   */
  api.post('/objects/:id/occurrences', async (c) => {
    const body = await c.req.json<Omit<OccurrenceEdit, 'objectId'> & { timeZone?: string }>()
    if (typeof body.field !== 'string' || typeof body.occurrence !== 'string' || !['this', 'following', 'all'].includes(body.scope) || !body.change || typeof body.change !== 'object') {
      return c.json({ error: 'field, occurrence, scope and change are required' }, 400)
    }
    const timeZone = body.timeZone && isValidTimeZone(body.timeZone) ? body.timeZone : 'UTC'
    try {
      const result = changeOccurrence(store, { objectId: c.req.param('id'), field: body.field, occurrence: body.occurrence, scope: body.scope, change: body.change }, now(), timeZone)
      changed(result.object)
      if (result.created) changed(result.created)
      return c.json(result)
    } catch (error) {
      if (error instanceof OccurrenceError) return c.json({ error: error.message }, 400)
      throw error
    }
  })

  /** A quote of a passage of the object's text ({ text, note? }): a Quote object related to it (createQuote). */
  api.delete('/objects/:id/food/:entryId', (c) => {
    const note = deleteFoodEntry(store, c.req.param('id'), c.req.param('entryId'), now())
    if (!note) return c.json({ error: 'not found' }, 404)
    changed(note)
    return c.json(note)
  })

  api.post('/objects/:id/quotes', async (c) => {
    const body = await c.req.json<{ text?: string; note?: string }>().catch(() => ({}) as { text?: string; note?: string })
    try {
      const quote = createQuote(store, c.req.param('id'), { text: String(body.text ?? ''), ...(body.note ? { note: String(body.note) } : {}) }, now())
      changed(quote)
      return c.json(quote, 201)
    } catch (error) {
      if (error instanceof QuoteError) return c.json({ error: error.message }, error.message === 'not found' ? 404 : 400)
      throw error
    }
  })

  /** Move an object to the trash; with ?forever=1, delete one already in the trash for good. */
  api.delete('/objects/:id', (c) => {
    const existing = store.getObject(c.req.param('id'))
    if (c.req.query('forever') === '1') {
      if (!existing) return c.json({ error: 'not found' }, 404)
      if (!existing.deletedAt) return c.json({ error: 'move the object to the trash first' }, 400)
      store.purgeObject(existing.id)
      return c.body(null, 204)
    }
    store.deleteObject(c.req.param('id'), now())
    const object = store.getObject(c.req.param('id'))
    if (object) changed(object)
    // A quote's source lost its highlight.
    const source = object?.props[SOURCE_PROPERTY_ID]
    if (source?.kind === 'relation') for (const id of source.value) {
      const record = store.getObject(id)
      if (record) changed(record)
    }
    return c.body(null, 204)
  })

  /** Take an object out of the trash; its type comes back too when it is in the trash (`type` in the answer). */
  api.post('/objects/:id/restore', (c) => {
    const result = store.restoreObject(c.req.param('id'), now())
    if (!result) return c.json({ error: 'the object is not in the trash' }, 400)
    if (result.type) typeChanged(result.type)
    changed(result.object)
    return c.json(result)
  })

  // Capture API: bearer tokens only; captures go to the token owner's spaces -------------
  const captureApi = new Hono<Env>()
  captureApi.use(captureAuth)
  const capturesOf = (c: Context<Env>) => users.captureFor(userOf(c))

  const respond = async (c: Context, run: () => Promise<CaptureResult>) => {
    try {
      const result = await run()
      return c.json(
        {
          dailyNoteId: result.dailyNote.id,
          blockId: result.blockId,
          objects: result.objects.map((o) => ({ id: o.id, typeId: o.typeId, title: o.title })),
          ...(result.summary ? { summary: result.summary } : {}),
          ...(result.unreadable ? { unreadable: result.unreadable } : {}),
        },
        201
      )
    } catch (error) {
      if (error instanceof CaptureError) return c.json({ error: error.message }, 400)
      throw error
    }
  }
  /** A line of food logged (CaptureService.food), as the app and the capture API answer it. */
  const respondFood = async (c: Context, run: () => Promise<FoodLineAnswer> | FoodLineAnswer) => {
    try {
      return c.json(await run(), 201)
    } catch (error) {
      if (error instanceof CaptureError) return c.json({ error: error.message }, 400)
      throw error
    }
  }
  const jsonBody = async <T>(c: Context): Promise<T> => {
    try {
      return await c.req.json<T>()
    } catch {
      throw new CaptureError('the body must be JSON')
    }
  }

  captureApi.get('/today', (c) => {
    try {
      const captures = capturesOf(c)
      const note = captures.todayNote(c.req.query('spaceId'))
      return c.json({ day: captures.today(), dailyNoteId: note.id })
    } catch (error) {
      if (error instanceof CaptureError) return c.json({ error: error.message }, 400)
      throw error
    }
  })
  captureApi.post('/note', (c) => respond(c, async () => capturesOf(c).note(await jsonBody(c))))
  captureApi.post('/weblink', (c) => respond(c, async () => capturesOf(c).weblink(await jsonBody(c))))
  captureApi.post('/task', (c) => respond(c, async () => capturesOf(c).task(await jsonBody(c))))
  captureApi.post('/object', (c) => respond(c, async () => capturesOf(c).object(await jsonBody(c))))
  /** `{ text, spaceId? }`: what was eaten, as after /food ("2 slices of bread at breakfast"). */
  captureApi.post('/food', (c) => respondFood(c, async () => capturesOf(c).food(await jsonBody(c))))
  // multipart/form-data: file, and optional caption, channel and spaceId fields.
  captureApi.post('/file', uploadLimit, (c) =>
    respond(c, async () => {
      const { file, field } = await readUpload(c)
      const channel = field('channel')
      const spaceId = field('spaceId')
      return capturesOf(c).file({ ...file, ...(channel ? { channel } : {}), ...(spaceId ? { spaceId } : {}) })
    })
  )

  // Order matters: login and capture answer before the session check that guards the rest.
  app.get('/api/health', (c) => c.json({ ok: true }))
  app.get('/api/openapi.json', (c) => c.json(openApi))
  // Agents: the MCP endpoint (docs/agents.md).
  app.all(
    '/mcp',
    bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) => c.json({ error: 'the request is too large' }, 413) }),
    agentAuth,
    (c) => {
      const origin = new URL(c.req.url)
      const address = webUrl ?? `${isHttps(c) ? 'https' : origin.protocol.slice(0, -1)}://${c.req.header('x-forwarded-host') ?? origin.host}`
      return handleMcp(c.req.raw, new AgentTools({ store, accounts: users, feed, now, user: userOf(c), webUrl: address }), MCP_VERSION)
    }
  )
  app.route('/api/auth', authApi)
  app.route('/api/capture', captureApi)
  app.use('/api/*', appAuth)
  app.use('/media/*', appAuth)
  app.route('/api', api)

  // Streamed from the media store; a `Range` (audio and video seeking) gets a 206 with that part.
  app.get('/media/:key', async (c) => {
    const key = c.req.param('key')
    try {
      checkMediaKey(key)
    } catch {
      return c.json({ error: 'invalid key' }, 400)
    }
    let file
    try {
      file = await media.get(key, c.req.header('range'))
    } catch (error) {
      if (error instanceof RangeNotSatisfiableError) return c.body(null, 416, { 'content-range': `bytes */${error.size}` })
      throw error
    }
    if (!file) return c.json({ error: 'not found' }, 404)
    const extension = path.extname(key).slice(1)
    return c.body(file.body, file.range ? 206 : 200, {
      'content-type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
      'content-length': String(file.length),
      'accept-ranges': 'bytes',
      ...(file.range ? { 'content-range': `bytes ${file.range.start}-${file.range.end}/${file.size}` } : {}),
      // Content-addressed, so it never changes; private because it needs a login.
      'cache-control': 'private, max-age=31536000, immutable',
    })
  })

  if (webDir) {
    // The built web app. Vite names its assets by content hash, so they can be cached for good;
    // index.html must always be fresh. Unknown paths are client-side routes and get index.html.
    app.use('/assets/*', compress())
    app.use('/assets/*', async (c, next) => {
      await next()
      if (c.res.ok) c.header('cache-control', 'public, max-age=31536000, immutable')
    })
    // The service worker and manifest must be checked on every load so a deploy reaches clients.
    app.use('/sw.js', async (c, next) => {
      await next()
      c.header('cache-control', 'no-cache')
    })
    app.use('/manifest.webmanifest', async (c, next) => {
      await next()
      c.header('cache-control', 'no-cache')
    })
    app.use('*', serveStatic({ root: webDir }))
    app.get('*', async (c, next) => {
      if (/^\/(api|media|assets|desktop)\//.test(c.req.path)) return c.json({ error: 'not found' }, 404)
      c.header('cache-control', 'no-cache')
      return serveStatic({ root: webDir, path: 'index.html' })(c, next)
    })
  }

  return app
}
