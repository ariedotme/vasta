// The store on Node.js (server, CLI tools): the shared store on the built-in node:sqlite, the
// server's one-time migrations, and accounts (users, members, sessions, tokens), which never sync.
import { DatabaseSync } from 'node:sqlite'
import type { ApiToken, Id, InboxPreferences, Invite, Person, Space, SpaceMember, SpaceRole, TokenScope, User } from './model.ts'
import { Store, rowToSpace, textHash, type Row } from './store.ts'

export type { PulledRow, SqlDatabase, SyncRow, SyncTombstone } from './store.ts'
export type { SyncChange, SyncChangeResult } from './sync.ts'

function rowToUser(row: Row): User {
  return {
    id: row.id as string,
    username: row.username as string,
    name: row.name as string,
    ...(row.time_zone ? { timeZone: row.time_zone as string } : {}),
    ...(row.capture_space_id ? { captureSpaceId: row.capture_space_id as string } : {}),
    ...(row.telegram_user_id != null ? { telegramUserId: Number(row.telegram_user_id) } : {}),
    ...(row.inbox ? { inbox: JSON.parse(row.inbox as string) as InboxPreferences } : {}),
    createdAt: row.created_at as string,
  }
}

function rowToToken(row: Row): ApiToken {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    scope: row.scope as TokenScope,
    createdAt: row.created_at as string,
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at as string } : {}),
  }
}

function rowToInvite(row: Row): Invite {
  return {
    id: row.id as string,
    createdBy: row.created_by as string,
    ...(row.space_id ? { spaceId: row.space_id as string } : {}),
    ...(row.role ? { role: row.role as SpaceRole } : {}),
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
  }
}

function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL;')
  return db
}

export class NodeStore extends Store {
  declare readonly db: DatabaseSync

  protected override get announcesDeletions() {
    return true
  }

  protected override get recordsActivity() {
    return true
  }

  constructor(path: string) {
    super(openDatabase(path), 'server')
    this.backfillSync()
    this.convertText()
    this.fixTaskStatuses()
    this.hashCalendarData()
  }

  /** Calendars fetched before replicas existed get the hash of their data (its dataVersion). */
  private hashCalendarData() {
    const rows = this.db.prepare('SELECT id, data FROM calendar_sources WHERE data IS NOT NULL AND data_hash IS NULL').all() as Row[]
    for (const row of rows) this.db.prepare('UPDATE calendar_sources SET data_hash = ? WHERE id = ?').run(textHash(row.data as string), row.id as string)
  }

  // Accounts -----------------------------------------------------------------

  /** Insert a user, or update everything but the password of an existing one. */
  putUser(user: User, passwordHash?: string) {
    const values = [user.username, user.name, user.timeZone ?? null, user.captureSpaceId ?? null, user.telegramUserId ?? null, user.inbox ? JSON.stringify(user.inbox) : null]
    if (this.getUser(user.id)) {
      this.db.prepare('UPDATE users SET username = ?, name = ?, time_zone = ?, capture_space_id = ?, telegram_user_id = ?, inbox = ? WHERE id = ?').run(...values, user.id)
    } else {
      if (!passwordHash) throw new Error('a new user needs a password')
      this.db
        .prepare('INSERT INTO users (id, username, name, time_zone, capture_space_id, telegram_user_id, inbox, created_at, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(user.id, ...values, user.createdAt, passwordHash)
    }
    if (passwordHash) this.setPasswordHash(user.id, passwordHash)
  }

  setPasswordHash(userId: Id, hash: string) {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId)
  }

  passwordHash(userId: Id): string | undefined {
    const row = this.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as Row | undefined
    return row?.password_hash as string | undefined
  }

  getUser(id: Id): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined
    return row ? rowToUser(row) : undefined
  }

  findUserByUsername(username: string): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim()) as Row | undefined
    return row ? rowToUser(row) : undefined
  }

  findUserByTelegram(telegramUserId: number): User | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE telegram_user_id = ?').get(telegramUserId) as Row | undefined
    return row ? rowToUser(row) : undefined
  }

  /** Oldest first. */
  listUsers(): User[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY created_at, rowid').all() as Row[]).map(rowToUser)
  }

  deleteUser(id: Id) {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id)
  }

  putMember(member: SpaceMember) {
    this.db
      .prepare('INSERT INTO space_members (space_id, user_id, role, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (space_id, user_id) DO UPDATE SET role = excluded.role')
      .run(member.spaceId, member.userId, member.role, member.createdAt)
  }

  removeMember(spaceId: Id, userId: Id) {
    this.db.prepare('DELETE FROM space_members WHERE space_id = ? AND user_id = ?').run(spaceId, userId)
  }

  listMembers(spaceId: Id): SpaceMember[] {
    return (this.db.prepare('SELECT * FROM space_members WHERE space_id = ? ORDER BY created_at, rowid').all(spaceId) as Row[]).map((row) => ({
      spaceId: row.space_id as string,
      userId: row.user_id as string,
      role: row.role as SpaceRole,
      createdAt: row.created_at as string,
    }))
  }

  /** A space's members as person values show them. */
  people(spaceId: Id): Person[] {
    return this.listMembers(spaceId).flatMap((m) => {
      const user = this.getUser(m.userId)
      return user ? [{ id: user.id, username: user.username, name: user.name }] : []
    })
  }

  memberRole(spaceId: Id, userId: Id): SpaceRole | undefined {
    const row = this.db
      .prepare('SELECT m.role FROM space_members m JOIN spaces s ON s.id = m.space_id WHERE m.space_id = ? AND m.user_id = ? AND s.deleted_at IS NULL')
      .get(spaceId, userId) as Row | undefined
    return row?.role as SpaceRole | undefined
  }

  /** The spaces a user is a member of, in the order they were created. */
  listUserSpaces(userId: Id): Space[] {
    return (
      this.db
        .prepare('SELECT s.* FROM spaces s JOIN space_members m ON m.space_id = s.id WHERE m.user_id = ? AND s.deleted_at IS NULL ORDER BY s.created_at')
        .all(userId) as Row[]
    ).map(rowToSpace)
  }

  /** Spaces nobody is a member of (e.g. imported before accounts existed). */
  spacesWithoutMembers(): Space[] {
    return (this.db.prepare('SELECT * FROM spaces WHERE deleted_at IS NULL AND id NOT IN (SELECT space_id FROM space_members) ORDER BY created_at').all() as Row[]).map(rowToSpace)
  }

  createSession(session: { id: string; userId: Id; createdAt: string; expiresAt: string; userAgent?: string }) {
    this.db
      .prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)')
      .run(session.id, session.userId, session.createdAt, session.expiresAt, session.userAgent ?? null)
  }

  getSession(id: string): { userId: Id; expiresAt: string; lastSeenAt?: string } | undefined {
    const row = this.db.prepare('SELECT user_id, expires_at, last_seen_at FROM sessions WHERE id = ?').get(id) as Row | undefined
    return row ? { userId: row.user_id as string, expiresAt: row.expires_at as string, ...(row.last_seen_at ? { lastSeenAt: row.last_seen_at as string } : {}) } : undefined
  }

  /** A user's sessions, most recently used first. */
  listUserSessions(userId: Id): { id: string; userAgent?: string; createdAt: string; lastSeenAt?: string; expiresAt: string }[] {
    const rows = this.db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY coalesce(last_seen_at, created_at) DESC').all(userId) as Row[]
    return rows.map((row) => ({
      id: row.id as string,
      createdAt: row.created_at as string,
      expiresAt: row.expires_at as string,
      ...(row.user_agent ? { userAgent: row.user_agent as string } : {}),
      ...(row.last_seen_at ? { lastSeenAt: row.last_seen_at as string } : {}),
    }))
  }

  touchSession(id: string, at: string) {
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(at, id)
  }

  loginFailure(name: string): { count: number; until: number; updatedAt: number } | undefined {
    const row = this.db.prepare('SELECT count, until, updated_at FROM login_failures WHERE name = ?').get(name) as Row | undefined
    return row ? { count: Number(row.count), until: Number(row.until), updatedAt: Number(row.updated_at) } : undefined
  }

  putLoginFailure(name: string, failure: { count: number; until: number; updatedAt: number }) {
    this.db
      .prepare('INSERT INTO login_failures (name, count, until, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET count = excluded.count, until = excluded.until, updated_at = excluded.updated_at')
      .run(name, failure.count, failure.until, failure.updatedAt)
  }

  deleteLoginFailure(name: string) {
    this.db.prepare('DELETE FROM login_failures WHERE name = ?').run(name)
  }

  extendSession(id: string, expiresAt: string) {
    this.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(expiresAt, id)
  }

  deleteSession(id: string) {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  /** Log a user out everywhere, except the session kept (when changing the password from the app). */
  deleteUserSessions(userId: Id, keep?: string) {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id IS NOT ?').run(userId, keep ?? null)
  }

  deleteExpiredSessions(now: string) {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now)
  }

  putToken(token: ApiToken, hash: string) {
    this.db
      .prepare('INSERT INTO api_tokens (id, user_id, name, hash, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(token.id, token.userId, token.name, hash, token.scope, token.createdAt)
  }

  findToken(hash: string): ApiToken | undefined {
    const row = this.db.prepare('SELECT * FROM api_tokens WHERE hash = ?').get(hash) as Row | undefined
    return row ? rowToToken(row) : undefined
  }

  touchToken(id: Id, at: string) {
    this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(at, id)
  }

  listTokens(userId?: Id): ApiToken[] {
    const rows = userId
      ? this.db.prepare('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at').all(userId)
      : this.db.prepare('SELECT * FROM api_tokens ORDER BY created_at').all()
    return (rows as Row[]).map(rowToToken)
  }

  deleteToken(id: Id) {
    this.db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id)
  }

  putInvite(invite: Invite, hash: string) {
    this.db
      .prepare('INSERT INTO invites (id, hash, created_by, space_id, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(invite.id, hash, invite.createdBy, invite.spaceId ?? null, invite.role ?? null, invite.createdAt, invite.expiresAt)
  }

  findInvite(hash: string): Invite | undefined {
    const row = this.db.prepare('SELECT * FROM invites WHERE hash = ?').get(hash) as Row | undefined
    return row ? rowToInvite(row) : undefined
  }

  /** Oldest first; expired ones are deleted on the way. */
  listInvites(now: string): Invite[] {
    this.db.prepare('DELETE FROM invites WHERE expires_at <= ?').run(now)
    return (this.db.prepare('SELECT * FROM invites ORDER BY created_at').all() as Row[]).map(rowToInvite)
  }

  deleteInvite(id: Id) {
    this.db.prepare('DELETE FROM invites WHERE id = ?').run(id)
  }
}
