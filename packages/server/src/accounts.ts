// Accounts: users, their passwords, browser sessions and bearer tokens, and which spaces they can
// use. Spaces are the unit of access; see docs/accounts.md.
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'
import { builtinTypeId, createBuiltinTypes, isValidTimeZone, type ApiToken, type Id, type InboxPreferences, type Invite, type IsoDateTime, type Space, type SpaceRole, type TokenScope, type User } from '@vasta/core'
import type { NodeStore } from '@vasta/core/node'
import type { CaptureService } from './capture.ts'
import { trashCutoff } from './trash.ts'

export class AccountError extends Error {}

/** A request's identity: a logged-in browser or a bearer token. */
export interface Auth {
  user: User
  /** Set for browser sessions (hashed cookie value). */
  sessionId?: string
  /** Set for bearer tokens. */
  scope?: TokenScope
}

export interface AccountOptions {
  store: NodeStore
  now?: () => IsoDateTime
  /** Base capture service; each user gets a copy scoped to their spaces and time zone. */
  capture?: CaptureService
  /** Space captures go to for users without a capture space of their own, if they can use it. */
  defaultCaptureSpaceId?: Id
  /**
   * VASTA_CAPTURE_TOKEN from before accounts existed: still accepted by the capture API, acting as
   * the oldest user.
   */
  legacyCaptureToken?: string
}

export const SESSION_DAYS = 30
const DAY = 86_400_000
const MIN_PASSWORD = 8
const LINK_CODE_MINUTES = 10

// scrypt with 64 MiB of memory per hash: slow enough to make guessing stored hashes expensive.
const SCRYPT = { N: 2 ** 16, r: 8, p: 1, maxmem: 160 * 1024 * 1024 } satisfies ScryptOptions
const KEY_LENGTH = 32

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

const scryptAsync = (password: string, salt: Buffer, length: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scrypt(password.normalize('NFC'), salt, length, options, (error, key) => (error ? reject(error) : resolve(key))))

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT)
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split('$')
  if (kind !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const N = Number(n)
  const key = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, { N, r: Number(r), p: Number(p), maxmem: 256 * N * Number(r) })
  return timingSafeEqual(key, expected)
}

/** Hashed once at start-up so logins for unknown names take as long as for real ones. */
let dummyHash: Promise<string> | undefined

/** Repeated failures for a name lock it for a while, doubling from 30 s up to 15 min. */
/**
 * Failed logins per username, kept in the database so a restart does not reset them: from the
 * fifth failure in a row, each one locks the name for 30 s, doubling up to 15 minutes. A day
 * without failures starts the count again.
 */
class LoginThrottle {
  private readonly store: NodeStore

  constructor(store: NodeStore) {
    this.store = store
  }

  lockedFor(name: string, now: number): number {
    const entry = this.store.loginFailure(name)
    return entry && entry.until > now ? entry.until - now : 0
  }

  fail(name: string, now: number) {
    const previous = this.store.loginFailure(name)
    const count = (previous && now - previous.updatedAt < DAY ? previous.count : 0) + 1
    const until = count >= 5 ? now + Math.min(30_000 * 2 ** (count - 5), 15 * 60_000) : 0
    this.store.putLoginFailure(name, { count, until, updatedAt: now })
  }

  succeed(name: string) {
    this.store.deleteLoginFailure(name)
  }
}

/** A session as the user sees it in Settings; `id` is a short public handle, not the cookie's hash. */
export interface SessionInfo {
  id: string
  userAgent?: string
  createdAt: IsoDateTime
  lastSeenAt?: IsoDateTime
  current: boolean
}

/** A code people type: letters and digits that cannot be mistaken for each other. */
const linkCode = (length: number) => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return [...randomBytes(length)].map((byte) => alphabet[byte % alphabet.length]).join('')
}

/** How long an invite link works. */
const INVITE_DAYS = 7

const publicSessionId = (id: string) => id.slice(0, 16)

export class AccountService {
  private readonly store: NodeStore
  private readonly now: () => IsoDateTime
  private readonly capture: CaptureService | undefined
  private readonly defaultCaptureSpaceId: Id | undefined
  private readonly legacyToken: string | undefined
  private readonly throttle: LoginThrottle
  private readonly linkCodes = new Map<string, { userId: Id; expiresAt: IsoDateTime }>()
  private setupCodeValue: string | undefined
  private settingUp = false

  constructor(options: AccountOptions) {
    this.store = options.store
    this.now = options.now ?? (() => new Date().toISOString())
    this.capture = options.capture
    this.defaultCaptureSpaceId = options.defaultCaptureSpaceId
    this.legacyToken = options.legacyCaptureToken
    this.throttle = new LoginThrottle(this.store)
  }

  hasUsers(): boolean {
    return this.store.listUsers().length > 0
  }

  // First run: while no account exists, the web app creates the first one with a setup code that
  // only the server's log shows, so whoever reaches a fresh server first cannot claim it.

  /** The code that creates the first account (the same for the whole run), or undefined once there is one. */
  setupCode(): string | undefined {
    if (this.hasUsers()) return undefined
    this.setupCodeValue ??= linkCode(12).replace(/(.{4})(?=.)/g, '$1-')
    return this.setupCodeValue
  }

  /** Create the first account, given the setup code from the server's log. */
  async setUp(code: string, input: { username: string; name?: string; password: string; timeZone?: string }): Promise<User> {
    const expected = this.setupCode()
    if (!expected || this.settingUp) throw new AccountError('this server already has an account; log in instead')
    const normalize = (value: string) => Buffer.from(sha256(value.toUpperCase().replace(/[^A-Z0-9]/g, '')))
    if (!timingSafeEqual(normalize(code), normalize(expected))) throw new AccountError('wrong setup code; it is in the server’s log')
    this.settingUp = true
    try {
      const user = await this.createUser(input)
      this.setupCodeValue = undefined
      return user
    } finally {
      this.settingUp = false
    }
  }

  // Invites: the server's first account (who set it up) makes links that let someone make their own
  // account, once, within a week, optionally joining one of its spaces.

  /** Whether the user is the server's first account, who manages it from the app. */
  isServerAdmin(userId: Id): boolean {
    return this.store.listUsers()[0]?.id === userId
  }

  /** A new invite and its code (shown once; only its hash is kept). */
  createInvite(userId: Id, options: { spaceId?: Id; role?: SpaceRole } = {}): { invite: Invite; code: string } {
    if (!this.isServerAdmin(userId)) throw new AccountError('only the server’s first account invites people')
    if (options.spaceId && !this.isOwner(userId, options.spaceId)) throw new AccountError('you can only invite people into spaces you own')
    const code = randomBytes(18).toString('base64url')
    const at = this.now()
    const invite: Invite = {
      id: randomUUID(),
      createdBy: userId,
      ...(options.spaceId ? { spaceId: options.spaceId, role: options.role ?? 'editor' } : {}),
      createdAt: at,
      expiresAt: new Date(Date.parse(at) + INVITE_DAYS * 86_400_000).toISOString(),
    }
    this.store.putInvite(invite, sha256(code))
    return { invite, code }
  }

  listInvites(): Invite[] {
    return this.store.listInvites(this.now())
  }

  revokeInvite(userId: Id, id: Id) {
    if (!this.isServerAdmin(userId)) throw new AccountError('only the server’s first account manages invites')
    this.store.deleteInvite(id)
  }

  /** The invite a code opens, while it is valid. */
  invite(code: string): Invite | undefined {
    const invite = code ? this.store.findInvite(sha256(code)) : undefined
    return invite && invite.expiresAt > this.now() ? invite : undefined
  }

  /** Make an account with an invite: the invite is used up, and the account joins its space. */
  async join(code: string, input: { username: string; name?: string; password: string; timeZone?: string }): Promise<User> {
    const invite = this.invite(code)
    if (!invite) throw new AccountError('this invite is not valid any more; ask for a new one')
    // Used up before the slow part, so a second request with the same code fails.
    this.store.deleteInvite(invite.id)
    let user: User
    try {
      user = await this.createUser(input)
    } catch (error) {
      this.store.putInvite(invite, sha256(code))
      throw error
    }
    const space = invite.spaceId ? this.store.getSpace(invite.spaceId) : undefined
    if (space) this.share(space.id, user.id, invite.role ?? 'editor')
    return user
  }

  /**
   * Create a user. The first user becomes the owner of every space that has no members yet (the
   * spaces imported before accounts existed); a user left without spaces gets a new one.
   */
  async createUser(input: { username: string; name?: string; password: string; timeZone?: string }): Promise<User> {
    const username = input.username.trim()
    if (!/^[\p{L}\p{N}._-]{2,40}$/u.test(username)) throw new AccountError('a username has 2-40 letters, digits, dots, dashes or underscores')
    if (this.store.findUserByUsername(username)) throw new AccountError(`the username ${username} is taken`)
    if (input.timeZone && !isValidTimeZone(input.timeZone)) throw new AccountError(`unknown time zone ${input.timeZone}`)
    this.checkPassword(input.password)
    const user: User = {
      id: randomUUID(),
      username,
      name: input.name?.trim() || username,
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      createdAt: this.now(),
    }
    const hash = await hashPassword(input.password)
    this.store.transaction(() => {
      const first = !this.hasUsers()
      this.store.putUser(user, hash)
      if (first) for (const space of this.store.spacesWithoutMembers()) this.share(space.id, user.id, 'owner')
      if (!this.store.listUserSpaces(user.id).length) this.createSpace(user.name, user.id)
    })
    return user
  }

  /** A new space with the built-in types, owned by `ownerId`. */
  createSpace(name: string, ownerId: Id): Space {
    const at = this.now()
    const id = randomUUID()
    const pinned = [builtinTypeId(id, 'page'), builtinTypeId(id, 'task')]
    const space: Space = { id, name: name.trim() || 'Space', sidebar: [{ id: randomUUID(), name: 'Pinned', items: pinned }], createdAt: at }
    this.store.transaction(() => {
      this.store.putSpace(space)
      for (const type of createBuiltinTypes(space.id, at)) this.store.putType(type)
      this.share(space.id, ownerId, 'owner')
    })
    return space
  }

  share(spaceId: Id, userId: Id, role: SpaceRole) {
    if (!this.store.getSpace(spaceId)) throw new AccountError(`unknown space ${spaceId}`)
    if (!this.store.getUser(userId)) throw new AccountError(`unknown user ${userId}`)
    this.store.putMember({ spaceId, userId, role, createdAt: this.now() })
  }

  /** Remove a member. A space keeps at least one owner. */
  unshare(spaceId: Id, userId: Id) {
    const members = this.store.listMembers(spaceId)
    const owners = members.filter((m) => m.role === 'owner')
    if (owners.length === 1 && owners[0]!.userId === userId) throw new AccountError('the last owner of a space cannot leave it')
    this.store.removeMember(spaceId, userId)
  }

  /** Add someone to a space by their exact username (there is no user search, so accounts are not listed). */
  addMember(spaceId: Id, username: string, role: SpaceRole): User {
    const user = this.store.findUserByUsername(username)
    if (!user) throw new AccountError(`no user called ${username.trim()}`)
    if (this.store.memberRole(spaceId, user.id)) throw new AccountError(`${user.username} is already a member`)
    this.share(spaceId, user.id, role)
    return user
  }

  /** Change a member's role. A space keeps at least one owner. */
  setRole(spaceId: Id, userId: Id, role: SpaceRole) {
    const current = this.store.memberRole(spaceId, userId)
    if (!current) throw new AccountError('not a member of this space')
    const owners = this.store.listMembers(spaceId).filter((m) => m.role === 'owner')
    if (current === 'owner' && role !== 'owner' && owners.length === 1) throw new AccountError('a space needs at least one owner')
    this.share(spaceId, userId, role)
  }

  canUse(userId: Id, spaceId: Id | undefined): boolean {
    return !!spaceId && this.store.memberRole(spaceId, userId) !== undefined
  }

  /** Owners manage who is in a space; editors change everything else. */
  isOwner(userId: Id, spaceId: Id): boolean {
    return this.store.memberRole(spaceId, userId) === 'owner'
  }

  /** Change a user's display name, time zone, capture space or inbox preferences; null clears the last three. */
  updateProfile(userId: Id, changes: { name?: string; timeZone?: string | null; captureSpaceId?: Id | null; inbox?: InboxPreferences | null }): User {
    const user = this.store.getUser(userId)
    if (!user) throw new AccountError(`unknown user ${userId}`)
    const next: User = { ...user }
    if (changes.name !== undefined) {
      if (!changes.name.trim()) throw new AccountError('the name cannot be empty')
      next.name = changes.name.trim().slice(0, 80)
    }
    if (changes.timeZone === null || changes.timeZone === '') delete next.timeZone
    else if (changes.timeZone !== undefined) {
      if (!isValidTimeZone(changes.timeZone)) throw new AccountError(`unknown time zone ${changes.timeZone}`)
      next.timeZone = changes.timeZone
    }
    if (changes.captureSpaceId === null || changes.captureSpaceId === '') delete next.captureSpaceId
    else if (changes.captureSpaceId !== undefined) {
      if (!this.canUse(userId, changes.captureSpaceId)) throw new AccountError('the capture space must be one of your spaces')
      next.captureSpaceId = changes.captureSpaceId
    }
    if (changes.inbox !== undefined) {
      const label = typeof changes.inbox?.reviewedLabel === 'string' ? changes.inbox.reviewedLabel.trim().slice(0, 40) : ''
      const inbox: InboxPreferences = { ...(label ? { reviewedLabel: label } : {}), ...(changes.inbox?.fadeReviewed === true ? { fadeReviewed: true } : {}) }
      if (Object.keys(inbox).length) next.inbox = inbox
      else delete next.inbox
    }
    this.store.putUser(next)
    return next
  }

  // Telegram linking: the app shows a short-lived code, the user sends it to the bot. Codes live in
  // memory; a restart only means asking for a new one.

  /** A new code for the user (replacing any earlier one), valid for 10 minutes. */
  telegramCode(userId: Id): { code: string; expiresAt: IsoDateTime } {
    const code = linkCode(8)
    const expiresAt = new Date(Date.parse(this.now()) + LINK_CODE_MINUTES * 60_000).toISOString()
    for (const [key, entry] of this.linkCodes) if (entry.userId === userId || entry.expiresAt <= this.now()) this.linkCodes.delete(key)
    this.linkCodes.set(code, { userId, expiresAt })
    return { code, expiresAt }
  }

  /** Link the Telegram account that sent `code`. Throws when the code is unknown or the account is someone else's. */
  linkTelegram(code: string, telegramUserId: number): User {
    const key = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    const entry = this.linkCodes.get(key)
    if (!entry || entry.expiresAt <= this.now()) throw new AccountError('that code is unknown or expired; get a new one in Vasta’s settings')
    const user = this.store.getUser(entry.userId)
    if (!user) throw new AccountError('that code is unknown or expired; get a new one in Vasta’s settings')
    const other = this.store.findUserByTelegram(telegramUserId)
    if (other && other.id !== user.id) throw new AccountError('this Telegram account is linked to another Vasta user; unlink it there first')
    this.linkCodes.delete(key)
    const next: User = { ...user, telegramUserId }
    this.store.putUser(next)
    return next
  }

  unlinkTelegram(userId: Id) {
    const user = this.store.getUser(userId)
    if (!user) return
    const { telegramUserId: _id, ...rest } = user
    this.store.putUser(rest)
  }

  async setPassword(userId: Id, password: string, keepSession?: string) {
    this.checkPassword(password)
    this.store.setPasswordHash(userId, await hashPassword(password))
    // Other browsers and devices have to log in with the new password.
    this.store.deleteUserSessions(userId, keepSession)
  }

  private checkPassword(password: string) {
    if (typeof password !== 'string' || [...password].length < MIN_PASSWORD) throw new AccountError(`a password has at least ${MIN_PASSWORD} characters`)
  }

  /** The user, or undefined for a wrong name or password. Throws while the name is locked. */
  async verifyLogin(username: string, password: string): Promise<User | undefined> {
    const key = username.trim().toLowerCase()
    const now = Date.parse(this.now())
    const wait = this.throttle.lockedFor(key, now)
    if (wait) throw new AccountError(`too many failed logins; try again in ${Math.ceil(wait / 1000)} s`)
    const user = this.store.findUserByUsername(username)
    const stored = user ? this.store.passwordHash(user.id) : undefined
    dummyHash ??= hashPassword(randomUUID())
    const ok = await verifyPassword(String(password ?? ''), stored ?? (await dummyHash))
    if (!user || !ok) {
      this.throttle.fail(key, now)
      return undefined
    }
    this.throttle.succeed(key)
    return user
  }

  /** Start a browser session; the returned secret goes in the cookie. */
  startSession(userId: Id, userAgent?: string): { secret: string; expiresAt: IsoDateTime } {
    const secret = randomBytes(32).toString('base64url')
    const at = this.now()
    const expiresAt = new Date(Date.parse(at) + SESSION_DAYS * DAY).toISOString()
    this.store.deleteExpiredSessions(at)
    this.store.createSession({ id: sha256(secret), userId, createdAt: at, expiresAt, ...(userAgent ? { userAgent: userAgent.slice(0, 200) } : {}) })
    return { secret, expiresAt }
  }

  /**
   * The session's user. Sessions slide: once a day of use, the expiry moves to 30 days from now and
   * `renewedUntil` tells the caller to refresh the cookie.
   */
  session(secret: string): (Auth & { renewedUntil?: IsoDateTime }) | undefined {
    const id = sha256(secret)
    const session = this.store.getSession(id)
    const now = Date.parse(this.now())
    if (!session) return undefined
    if (Date.parse(session.expiresAt) <= now) {
      this.store.deleteSession(id)
      return undefined
    }
    const user = this.store.getUser(session.userId)
    if (!user) return undefined
    // For the session list in Settings; once a minute is plenty, like tokens.
    if (!session.lastSeenAt || now - Date.parse(session.lastSeenAt) > 60_000) this.store.touchSession(id, new Date(now).toISOString())
    if (Date.parse(session.expiresAt) - now < (SESSION_DAYS - 1) * DAY) {
      const renewedUntil = new Date(now + SESSION_DAYS * DAY).toISOString()
      this.store.extendSession(id, renewedUntil)
      return { user, sessionId: id, renewedUntil }
    }
    return { user, sessionId: id }
  }

  endSession(secret: string) {
    this.store.deleteSession(sha256(secret))
  }

  /** The user's browser sessions; `currentId` (the caller's session) is marked. */
  listSessions(userId: Id, currentId?: string): SessionInfo[] {
    const now = this.now()
    return this.store
      .listUserSessions(userId)
      .filter((session) => session.expiresAt > now)
      .map(({ id, userAgent, createdAt, lastSeenAt }) => ({
        id: publicSessionId(id),
        ...(userAgent ? { userAgent } : {}),
        createdAt,
        ...(lastSeenAt ? { lastSeenAt } : {}),
        current: id === currentId,
      }))
  }

  /** Log out one of the user's sessions by its public id; false when there is none. */
  revokeSession(userId: Id, publicId: string): boolean {
    const session = this.store.listUserSessions(userId).find((s) => publicSessionId(s.id) === publicId)
    if (!session) return false
    this.store.deleteSession(session.id)
    return true
  }

  // Deleting spaces: the space goes to the trash (hidden from everyone at once) and is purged
  // TRASH_DAYS later (trash.ts). `vasta space restore` brings it back meanwhile.

  /** Move a space to the trash. Only owners (checked by the caller), and never the user's last space. */
  deleteSpace(userId: Id, spaceId: Id) {
    if (!this.store.getSpace(spaceId)) throw new AccountError(`unknown space ${spaceId}`)
    if (!this.store.listUserSpaces(userId).some((s) => s.id !== spaceId)) throw new AccountError('you cannot delete your only space; create another one first')
    this.store.setSpaceDeleted(spaceId, this.now())
  }

  restoreSpace(spaceId: Id) {
    if (!this.store.listDeletedSpaces().some((s) => s.id === spaceId)) throw new AccountError(`no deleted space ${spaceId}`)
    this.store.setSpaceDeleted(spaceId, null)
  }

  /** Purge spaces deleted more than TRASH_DAYS ago; returns them. */
  purgeDeletedSpaces(): Space[] {
    const cutoff = trashCutoff(this.now())
    const expired = this.store.listDeletedSpaces().filter((s) => s.deletedAt <= cutoff)
    for (const space of expired) this.store.purgeSpace(space.id)
    return expired
  }

  /** The user's spaces; one left without any (its spaces were deleted) gets a new one. */
  spacesOf(user: User): Space[] {
    const spaces = this.store.listUserSpaces(user.id)
    if (spaces.length) return spaces
    return [this.createSpace(user.name, user.id)]
  }

  /** Create a bearer token. The secret is shown once; only its hash is kept. */
  createToken(userId: Id, name: string, scope: TokenScope): { secret: string; token: ApiToken } {
    if (!this.store.getUser(userId)) throw new AccountError(`unknown user ${userId}`)
    const secret = `vst_${randomBytes(24).toString('base64url')}`
    const token: ApiToken = { id: randomUUID(), userId, name: name.trim() || 'token', scope, createdAt: this.now() }
    this.store.putToken(token, sha256(secret))
    return { secret, token }
  }

  bearer(secret: string): Auth | undefined {
    if (this.legacyToken && timingSafeEqual(Buffer.from(sha256(secret)), Buffer.from(sha256(this.legacyToken)))) {
      const user = this.store.listUsers()[0]
      return user ? { user, scope: 'capture' } : undefined
    }
    const token = this.store.findToken(sha256(secret))
    const user = token && this.store.getUser(token.userId)
    if (!token || !user) return undefined
    // Recording every use would write on each capture; once a minute is plenty.
    const at = this.now()
    if (!token.lastUsedAt || Date.parse(at) - Date.parse(token.lastUsedAt) > 60_000) this.store.touchToken(token.id, at)
    return { user, scope: token.scope }
  }

  /** The space a user's captures go to when a channel names none. */
  captureSpaceId(user: User): Id | undefined {
    for (const id of [user.captureSpaceId, this.defaultCaptureSpaceId]) if (this.canUse(user.id, id)) return id
    return this.store.listUserSpaces(user.id)[0]?.id
  }

  /** The capture service as this user: only their spaces, their time zone. */
  captureFor(user: User): CaptureService {
    if (!this.capture) throw new Error('AccountService was created without a capture service')
    const defaultSpaceId = this.captureSpaceId(user)
    return this.capture.scoped({
      ...(defaultSpaceId ? { defaultSpaceId } : {}),
      ...(user.timeZone ? { timeZone: user.timeZone } : {}),
      allowSpace: (spaceId) => this.canUse(user.id, spaceId),
      actor: user.id,
    })
  }
}
