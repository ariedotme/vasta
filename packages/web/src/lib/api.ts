// Data access for the UI: the same functions answered by the local replica (lib/replica.ts) when
// it runs, and by the server over HTTP otherwise. What only the server can do (fetch a page, store
// a file, delete for good, members, subscriptions) always goes to it, with the replica synced
// before and after.
import type { ActivityEntry, ApiToken, FlowMetrics, Backlink, CalendarEntry, CalendarSource, ColorName, DocNode, FoodEntry, FoodLineAnswer, Icon, Id, InboxPreferences, Invite, LogFoodInput, NutritionSettings, ObjectRecord, ObjectSummary, ObjectType, QueryDef, Space, SpaceRole, TokenScope, User } from '@vasta/core'
import { dayIn } from '@vasta/core'
import type { OccurrenceEdit } from '@vasta/core/calendar'
import type { CaptureAnswer } from '@vasta/core/client'
import { noteNetworkError, noteResponse } from './network.ts'
import { callStore, syncNow, useReplica } from './replica.ts'

let onUnauthorized: (() => void) | undefined

/** Called when the server answers 401 (the session expired or was logged out elsewhere). */
export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
      method,
      // The server refuses cookie-authenticated changes without this header (CSRF protection).
      headers: { 'x-requested-with': 'vasta', ...(body === undefined || body instanceof FormData ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    })
  } catch (error) {
    noteNetworkError()
    throw error
  }
  noteResponse(response)
  if (!response.ok) {
    if (response.status === 401 && !url.startsWith('/api/auth/')) onUnauthorized?.()
    // The server explains bad input in { error }; show that rather than the status.
    const reason = await response.json().then((data: { error?: string }) => data.error).catch(() => undefined)
    throw new Error(reason ?? `${method} ${url} failed: ${response.status}`)
  }
  return (response.status === 204 ? undefined : await response.json()) as T
}

export interface SpaceBundle {
  space: Space
  types: ObjectType[]
  counts: Record<Id, number>
  /** Entries in the trash. */
  trash: number
}

export interface Trash {
  /** Deleted types, with how many objects were deleted together with each. */
  types: (ObjectType & { deletedAt: string; objectCount: number })[]
  /** Objects deleted on their own (not together with their type). */
  objects: ObjectSummary[]
}

/** Settings › Reminders (server/src/reminders.ts); the ntfy token stays on the server. */
export interface ReminderSettings {
  ntfy?: { server: string; topic: string; hasToken: boolean }
  telegram: boolean
  /** As system notifications in the desktop apps open (0.1.10 and later). */
  desktop: boolean
  habits: boolean
  /** Minutes before timed events and tasks; null: none. */
  eventsBefore: number | null
  food: FoodReminders
  telegramReady: boolean
  /** Desktop apps listening for this user right now. */
  desktopApps: number
  work: WorkNotifications
}

/** Food reminders, in spaces that track food; times "HH:MM". */
export interface FoodReminders {
  /** What is left of the day; null: off. */
  dayLeft: string | null
  /** The week's summary: a weekday (0 Sunday … 6 Saturday) and a time; null: off. */
  week: { day: number; at: string } | null
  /** Minutes after a meal's time with nothing logged in it; null: off. */
  mealsAfter: number | null
}

/** Which notifications about others' work also go through the reminder channels. */
export interface WorkNotifications {
  assigned: boolean
  mentioned: boolean
  comments: boolean
}

/** A notification about others' work (server/src/notifications.ts), for the bell. */
export interface Notice {
  id: number
  spaceId: Id
  objectId: Id
  title?: string
  at: string
  actor?: Id
  kind: 'assigned' | 'mentioned' | 'comment'
  text?: string
  read: boolean
}

export interface ReminderChanges {
  /** token: a string sets it, '' clears it, absent keeps it; null turns ntfy off. */
  ntfy?: { server?: string; topic?: string; token?: string } | null
  telegram?: boolean
  desktop?: boolean
  habits?: boolean
  eventsBefore?: number | null
  food?: Partial<FoodReminders>
  work?: Partial<WorkNotifications>
}

export interface CalendarData {
  entries: CalendarEntry[]
  objects: ObjectSummary[]
  /** Per day, how many objects link to its daily note (date references). */
  references: Record<string, number>
}

export interface CalendarSourceInput {
  name?: string
  url?: string
  color?: ColorName
  username?: string
  /** A string sets the password, null removes it, absent keeps it. */
  password?: string | null
  enabled?: boolean
}

export interface Member {
  userId: Id
  username: string
  name: string
  role: SpaceRole
  createdAt: string
}

export interface ProfileInput {
  name?: string
  /** null: use the server's zone. */
  timeZone?: string | null
  /** null: captures go to the first space. */
  captureSpaceId?: Id | null
  /** null: the defaults ("Reviewed", not faded). */
  inbox?: InboxPreferences | null
}

export const authApi = {
  /**
   * The logged-in user, or null; `noUsers` tells that no account exists yet. `replica` is false
   * when the server keeps apps off their local replica (VASTA_REPLICA=0).
   */
  me: async (): Promise<{ user: User | null; noUsers?: boolean; replica: boolean }> => {
    const response = await fetch('/api/auth/me')
    const replica = response.headers.get('x-vasta-replica') !== 'off'
    if (response.status === 401) return { user: null, noUsers: !!((await response.json()) as { noUsers?: boolean }).noUsers, replica }
    if (!response.ok) throw new Error(`the server answered ${response.status}`)
    return { user: (await response.json()) as User, replica }
  },
  login: (username: string, password: string) => request<User>('POST', '/api/auth/login', { username, password }),
  /** The first account on a server that has none, with the setup code from the server's log. */
  setup: (data: { code: string; username: string; name: string; password: string; timeZone: string }) => request<User>('POST', '/api/auth/setup', data),
  /** What an invite link is (without logging in); fails when it is not valid any more. */
  invite: (code: string) => request<{ expiresAt: string; invitedBy: string; spaceName?: string }>('GET', `/api/auth/invite?code=${encodeURIComponent(code)}`),
  /** Make an account with an invite and log into it. */
  join: (data: { code: string; username: string; name: string; password: string; timeZone: string }) => request<User>('POST', '/api/auth/join', data),
  /** The server's accounts and open invites, for its first account; others learn who that is. */
  accounts: () => request<ServerAccounts>('GET', '/api/auth/accounts'),
  createInvite: (spaceId?: Id, role?: SpaceRole) => request<{ invite: Invite; code: string }>('POST', '/api/auth/invites', { ...(spaceId ? { spaceId, role } : {}) }),
  revokeInvite: (id: Id) => request<void>('DELETE', `/api/auth/invites/${id}`),
  logout: () => request<void>('POST', '/api/auth/logout'),
  changePassword: (current: string, password: string) => request<void>('PUT', '/api/auth/password', { current, password }),
  updateProfile: (changes: ProfileInput) => request<User>('PUT', '/api/auth/me', changes),
  /** `bot` is the bot's username, absent when the server runs no bot. */
  telegram: () => request<{ linked: boolean; bot?: string }>('GET', '/api/auth/telegram'),
  reminders: () => request<ReminderSettings>('GET', '/api/auth/reminders'),
  saveReminders: (changes: ReminderChanges) => request<ReminderSettings>('PUT', '/api/auth/reminders', changes),
  testReminders: () => request<{ channel: string; ok: boolean; error?: string }[]>('POST', '/api/auth/reminders/test'),
  /** A token for the desktop app to hear reminders with (scope notify); replaces the device's last one. */
  desktopToken: (device: string) => request<{ token: string }>('POST', '/api/auth/desktop-token', { device }),
  telegramCode: () => request<{ code: string; expiresAt: string; bot?: string }>('POST', '/api/auth/telegram/code'),
  unlinkTelegram: () => request<void>('DELETE', '/api/auth/telegram'),
  channels: () => request<ChannelState>('GET', '/api/auth/channels'),
  /** The chats the bot listens in (the server's first account only); empty: any chat a linked account writes in. */
  setTelegramChats: (allowedChats: TelegramChat[]) => request<ChannelState>('PUT', '/api/auth/channels/telegram', { allowedChats }),
  sessions: () => request<SessionInfo[]>('GET', '/api/auth/sessions'),
  revokeSession: (id: string) => request<void>('DELETE', `/api/auth/sessions/${id}`),
  /** Log out every session but this one. */
  revokeOtherSessions: () => request<void>('DELETE', '/api/auth/sessions'),
}

/** Moving the notes of the desktop app's own server to another server (server/src/transfer.ts). */
export interface MigrationState {
  phase: 'idle' | 'account' | 'notes' | 'media' | 'done' | 'failed'
  server?: string
  done: number
  total: number
  error?: string
  /** Where a failed migration stopped. */
  step?: 'account' | 'notes' | 'media'
}

export const migrationApi = {
  state: () => request<MigrationState>('GET', '/api/migrate'),
  /** `code`: the other server's setup code, or an invite link (which names its server). */
  start: (input: { server: string; code: string; username: string; name: string; password: string; timeZone: string }) => request<MigrationState>('POST', '/api/migrate', input),
}

/** Settings › Server accounts: everything for the server's first account; who that is for the others. */
export type ServerAccounts =
  | { admin: false; adminName: string }
  | { admin: true; adminName: string; users: Pick<User, 'id' | 'username' | 'name' | 'createdAt'>[]; invites: (Invite & { spaceName?: string })[] }

export interface SessionInfo {
  id: string
  userAgent?: string
  createdAt: string
  lastSeenAt?: string
  current: boolean
}

export interface TelegramChat {
  id: number
  title?: string
}

/** The capture channels the server runs (server/src/channels.ts). */
export interface ChannelState {
  telegram: {
    running: boolean
    bot?: string
    /** This account is linked to a Telegram account. */
    linked: boolean
    linkedAccounts: number
    allowedChats: TelegramChat[]
    /** This account set up the server, so it changes the chats. */
    manage: boolean
    /** Chats the bot ignored lately (to the account that manages them). */
    ignoredChats?: (TelegramChat & { at: string })[]
  }
  /** This account's capture tokens. */
  tokens: number
}

/** An item captured into a daily note (see server/src/inbox.ts). */
export interface InboxItem {
  id: Id
  channel: string
  at: string
  done: boolean
  noteId: Id
  day: string
  content: DocNode[]
  objectIds: Id[]
}

const http = {
  spaces: () => request<Space[]>('GET', '/api/spaces'),
  space: (id: Id) => request<SpaceBundle>('GET', `/api/spaces/${id}`),
  search: (spaceId: Id, q: string, limit = 30) =>
    request<ObjectSummary[]>('GET', `/api/spaces/${spaceId}/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  query: (spaceId: Id, body: { query: QueryDef; parentId?: Id; today: string; timeZone: string }) =>
    request<ObjectSummary[]>('POST', `/api/spaces/${spaceId}/query`, body),
  objectsOfType: (typeId: Id) => request<ObjectSummary[]>('GET', `/api/types/${typeId}/objects`),
  summaries: (ids: Id[]) => request<ObjectSummary[]>('GET', `/api/objects?ids=${ids.map(encodeURIComponent).join(',')}`),
  object: (id: Id) => request<ObjectRecord>('GET', `/api/objects/${id}`),
  backlinks: (id: Id) => request<Backlink[]>('GET', `/api/objects/${id}/backlinks`),
  /** The id of the block at `path` in a field of the object's text, given one when it has none (core's blocks.ts). */
  blockId: async (objectId: Id, field: Id, path: number[]) => (await request<{ id: string }>('POST', `/api/objects/${objectId}/block-ids`, { field, path })).id,
  /** With `line`, the title and properties are read from it, e.g. `Dune author:"Frank Herbert"` (core's capture-line.ts). */
  createObject: (data: Partial<ObjectRecord> & { typeId: Id }, line?: string) => request<ObjectRecord>('POST', '/api/objects', line === undefined ? data : { ...data, line }),
  /** `base`: the copy the caller started editing from; only what changed since it is written. */
  saveObject: (object: ObjectRecord, base?: ObjectRecord) => request<ObjectRecord>('PUT', `/api/objects/${object.id}`, base ? { ...object, base } : object),
  /** Save a URL as a weblink, or get the one saved before for it. */
  saveWeblink: (spaceId: Id, url: string) => request<ObjectRecord>('POST', `/api/spaces/${spaceId}/weblinks`, { url }),
  setWeblinkUrl: (id: Id, url: string) => request<ObjectRecord>('PUT', `/api/objects/${id}/weblink`, { url }),
  refreshWeblink: (id: Id) => request<ObjectRecord>('POST', `/api/objects/${id}/refresh-link`),
  /** Save a readable copy of the weblink's page in its "Readable text" field. */
  saveReadable: (id: Id) => request<ObjectRecord & { lostHighlights?: string[] }>('POST', `/api/objects/${id}/readable`),
  /** Store a file as a new image/PDF/audio/video/file object of the space (the editor embeds it). */
  uploadFile: (spaceId: Id, file: File) => {
    const form = new FormData()
    form.set('file', file)
    return request<ObjectRecord>('POST', `/api/spaces/${spaceId}/files`, form)
  },
  /** The space's templates and snippets, whole (core's templates.ts): nothing else lists them. */
  templates: (spaceId: Id) => request<ObjectRecord[]>('GET', `/api/spaces/${spaceId}/templates`),
  /** The daily note of a day ("YYYY-MM-DD"), created on first use. */
  dailyNote: (spaceId: Id, day: string) => request<ObjectRecord>('POST', `/api/spaces/${spaceId}/daily-notes/${day}`),
  /** Change one occurrence of a repeating date, the series from it on, or all of it; `created` is the copy "this and following" makes. */
  changeOccurrence: (edit: OccurrenceEdit, timeZone: string) =>
    request<{ object: ObjectRecord; created?: ObjectRecord }>('POST', `/api/objects/${edit.objectId}/occurrences`, { ...edit, timeZone }),
  /** A quote of a passage of the object's text (a Quote object related to it). */
  createQuote: (sourceId: Id, input: { text: string; note?: string }) => request<ObjectRecord>('POST', `/api/objects/${sourceId}/quotes`, input),
  /** Turn food tracking on (making the Food, Recipe and Nutrition goal types) or off. */
  setNutrition: (spaceId: Id, enabled: boolean) => request<{ space: Space; types: ObjectType[] }>('POST', `/api/spaces/${spaceId}/nutrition`, { enabled }),
  /** Turn sprints on or off, or rename them. */
  setSprints: (spaceId: Id, input: { enabled?: boolean; name?: string; pluralName?: string }) => request<{ space: Space; types: ObjectType[] }>('POST', `/api/spaces/${spaceId}/sprints`, input),
  /** Log something eaten on a day's note (core's logFood). */
  logFood: (spaceId: Id, input: LogFoodInput) => request<{ note: ObjectRecord; entryId: Id; entry: FoodEntry }>('POST', `/api/spaces/${spaceId}/food`, input),
  deleteFoodEntry: (noteId: Id, entryId: Id) => request<ObjectRecord>('DELETE', `/api/objects/${noteId}/food/${entryId}`),
  /** A line of food, as after /food ("2 slices of bread at breakfast"); `today` is used offline. */
  logFoodLine: (spaceId: Id, text: string, _today: string) => request<FoodLineAnswer>('POST', `/api/spaces/${spaceId}/food-line`, { text }),
  /** To the trash. */
  deleteObject: (id: Id) => request<void>('DELETE', `/api/objects/${id}`),
  /** Out of the trash; `type` is set when the object's type was in the trash too and came back with it. */
  restoreObject: (id: Id) => request<{ object: ObjectRecord; type?: ObjectType }>('POST', `/api/objects/${id}/restore`),
  /** Only objects already in the trash. */
  deleteObjectForever: (id: Id) => request<void>('DELETE', `/api/objects/${id}?forever=1`),
  type: (id: Id) => request<ObjectType>('GET', `/api/types/${id}`),
  createType: (data: { spaceId: Id; name: string; pluralName?: string; icon?: Icon }) => request<ObjectType>('POST', '/api/types', data),
  saveType: (type: ObjectType) => request<ObjectType>('PUT', `/api/types/${type.id}`, type),
  /** To the trash, with its objects. */
  deleteType: (id: Id) => request<void>('DELETE', `/api/types/${id}`),
  /** Out of the trash, with the objects deleted together with it. */
  restoreType: (id: Id) => request<{ type: ObjectType; objects: ObjectRecord[] }>('POST', `/api/types/${id}/restore`),
  deleteTypeForever: (id: Id) => request<void>('DELETE', `/api/types/${id}?forever=1`),
  trash: (spaceId: Id) => request<Trash>('GET', `/api/spaces/${spaceId}/trash`),
  emptyTrash: (spaceId: Id) => request<{ types: number; objects: number }>('DELETE', `/api/spaces/${spaceId}/trash`),
  /** Captures of the last `days` days up to `today`, newest first, with summaries of the objects in them. */
  inbox: (spaceId: Id, today: string, days: number) =>
    request<{ items: InboxItem[]; objects: ObjectSummary[] }>('GET', `/api/spaces/${spaceId}/inbox?today=${today}&days=${days}`),
  setCaptureDone: (noteId: Id, captureId: Id, done: boolean) => request<ObjectRecord>('PUT', `/api/objects/${noteId}/captures/${captureId}`, { done }),
  /**
   * Capture a text into today's note (`day` is the device's today, used when the capture is made
   * offline). With `typeId`, the first line is the title and properties of a new object of that
   * type, the rest its body, and the note embeds it.
   */
  capture: (spaceId: Id, text: string, channel: string, _day: string, typeId?: Id) =>
    request<CaptureAnswer>('POST', `/api/spaces/${spaceId}/captures`, typeId ? { text, channel, typeId } : { text, channel }),
  /** Spaces in the trash that the user owned. */
  deletedSpaces: () => request<(Space & { deletedAt: string })[]>('GET', '/api/deleted-spaces'),
  restoreSpace: (id: Id) => request<Space>('POST', `/api/deleted-spaces/${id}/restore`),
  saveSpace: (space: Space) => request<Space>('PUT', `/api/spaces/${space.id}`, space),
  /** Rename a space or change its icon, leaving its sidebar as it is. */
  updateSpace: (id: Id, data: { name?: string; icon?: Icon; nutrition?: NutritionSettings }) => request<Space>('PUT', `/api/spaces/${id}`, data),
  createSpace: (data: { name: string; icon?: Icon }) => request<Space>('POST', '/api/spaces', data),
  /** To the trash for 30 days (owners only); `name` must repeat the space's name. */
  deleteSpace: (id: Id, name: string) => request<void>('DELETE', `/api/spaces/${id}`, { name }),
  members: (spaceId: Id) => request<Member[]>('GET', `/api/spaces/${spaceId}/members`),
  /** A status type's flow metrics over two days (inclusive) in a zone (core metrics.ts). */
  typeMetrics: (typeId: Id, from: string, to: string, timeZone: string) =>
    request<FlowMetrics & { retentionDays: number }>('GET', `/api/types/${typeId}/metrics?from=${from}&to=${to}&timeZone=${encodeURIComponent(timeZone)}`),
  /** The bell: notifications about others' work, newest first, and how many are unread. */
  notices: () => request<{ items: Notice[]; unread: number }>('GET', '/api/notices'),
  /** Mark some notifications read (all without ids). */
  readNotices: (ids?: number[]) => request<{ unread: number }>('POST', '/api/notices/read', ids ? { ids } : {}),
  /** What members did to an object, newest first (the server keeps it; core activity.ts). */
  objectActivity: (id: Id) => request<ActivityEntry[]>('GET', `/api/objects/${id}/activity`),
  /** A space's activity from `since`, oldest first. */
  spaceActivity: (spaceId: Id, since?: string) => request<ActivityEntry[]>('GET', `/api/spaces/${spaceId}/activity${since ? `?since=${encodeURIComponent(since)}` : ''}`),
  /** Days a space keeps activity (0: everything); only owners change it. */
  activitySettings: (spaceId: Id) => request<{ retentionDays: number }>('GET', `/api/spaces/${spaceId}/activity-settings`),
  setActivitySettings: (spaceId: Id, retentionDays: number) => request<{ retentionDays: number }>('PUT', `/api/spaces/${spaceId}/activity-settings`, { retentionDays }),
  /** Add a member by their exact username. */
  addMember: (spaceId: Id, username: string, role: SpaceRole) => request<Member[]>('POST', `/api/spaces/${spaceId}/members`, { username, role }),
  setMemberRole: (spaceId: Id, userId: Id, role: SpaceRole) => request<Member[]>('PUT', `/api/spaces/${spaceId}/members/${userId}`, { role }),
  /** Remove a member, or leave the space when it is the caller. */
  removeMember: (spaceId: Id, userId: Id) => request<void>('DELETE', `/api/spaces/${spaceId}/members/${userId}`),
  tokens: () => request<ApiToken[]>('GET', '/api/tokens'),
  /** The secret is only returned here, once. */
  createToken: (name: string, scope: TokenScope) => request<{ token: ApiToken; secret: string }>('POST', '/api/tokens', { name, scope }),
  revokeToken: (id: Id) => request<void>('DELETE', `/api/tokens/${id}`),
  /** Everything dated between two days (inclusive) in the viewer's zone. */
  calendar: (spaceId: Id, from: string, to: string, timeZone: string) =>
    request<CalendarData>('GET', `/api/spaces/${spaceId}/calendar?from=${from}&to=${to}&timeZone=${encodeURIComponent(timeZone)}`),
  calendarSources: (spaceId: Id) => request<CalendarSource[]>('GET', `/api/spaces/${spaceId}/calendar-sources`),
  addCalendarSource: (spaceId: Id, data: CalendarSourceInput) => request<CalendarSource>('POST', `/api/spaces/${spaceId}/calendar-sources`, data),
  updateCalendarSource: (id: Id, data: CalendarSourceInput) => request<CalendarSource>('PUT', `/api/calendar-sources/${id}`, data),
  deleteCalendarSource: (id: Id) => request<void>('DELETE', `/api/calendar-sources/${id}`),
  syncCalendarSource: (id: Id) => request<CalendarSource>('POST', `/api/calendar-sources/${id}/sync`),
}

type Api = typeof http

const OFFLINE_MESSAGE = 'This needs a connection to the server.'

const now = () => new Date().toISOString()
/** This device's zone, which decides "today" and times such as "15h" in what is typed. */
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/**
 * A call only the server can make, from a device with a replica: push this device's changes
 * first (the server may need them, e.g. an object moved to the trash offline before deleting it
 * for good), then make the call, then pull its result into the replica.
 */
function viaServer<A extends unknown[], R>(call: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    await syncNow()
    let result: R
    try {
      result = await call(...args)
    } catch (error) {
      if (error instanceof TypeError) throw new Error(OFFLINE_MESSAGE)
      throw error
    }
    await syncNow()
    return result
  }
}

/** A record the replica lacks may be on the server already (a capture a moment ago, a link from Telegram): pull once and look again. */
function pullingIfMissing<A extends unknown[], R>(read: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    try {
      return await read(...args)
    } catch (error) {
      if ((error as { code?: string }).code !== 'not-found') throw error
      await syncNow()
      return read(...args)
    }
  }
}

/** What the replica answers while it runs; the rest goes to the server. */
const local: Partial<Api> = {
  spaces: async () => {
    const spaces = await callStore('listSpaces')
    if (spaces.length) return spaces
    // The server gives a user without spaces one of their own.
    await http.spaces()
    await syncNow()
    return callStore('listSpaces')
  },
  space: pullingIfMissing((id) => callStore('spaceBundle', id)),
  search: (spaceId, q, limit = 30) => callStore('search', spaceId, q, Math.min(limit, 100)),
  query: (spaceId, body) => callStore('query', spaceId, body, now()),
  objectsOfType: (typeId) => callStore('listObjects', typeId),
  summaries: (ids) => callStore('getObjectSummaries', ids),
  object: pullingIfMissing((id) => callStore('requireObject', id)),
  backlinks: (id) => callStore('backlinks', id),
  blockId: async (objectId, field, path) => {
    const id = await callStore('ensureBlockId', objectId, field, path, now())
    if (!id) throw new Error('That block is gone.')
    return id
  },
  createObject: (data, line) => callStore('createObject', data, now(), line === undefined ? undefined : { text: line, context: { today: dayIn(now(), timeZone()), timeZone: timeZone() } }),
  saveObject: (object, base) => callStore('saveObject', object, now(), base),
  changeOccurrence: (edit, timeZone) => callStore('changeOccurrence', edit, timeZone, now()),
  createQuote: (sourceId, input) => callStore('createQuote', sourceId, input, now()),
  setNutrition: (spaceId, enabled) => callStore('setNutrition', spaceId, enabled, now()),
  setSprints: (spaceId, input) => callStore('setSprints', spaceId, input, now()),
  logFood: (spaceId, input) => callStore('logFood', spaceId, input, now()),
  deleteFoodEntry: (noteId, entryId) => callStore('deleteFoodEntry', noteId, entryId, now()),
  logFoodLine: (spaceId, text, today) => callStore('logFoodLine', spaceId, text, today, timeZone(), now()),
  dailyNote: (spaceId, day) => callStore('dailyNote', spaceId, day, now()),
  templates: (spaceId) => callStore('listTemplates', spaceId),
  deleteObject: (id) => callStore('trashObject', id, now()),
  restoreObject: (id) => callStore('untrashObject', id, now()),
  type: pullingIfMissing((id) => callStore('requireType', id)),
  createType: (data) => callStore('createType', data, now()),
  saveType: (type) => callStore('saveType', type, now()),
  deleteType: (id) => callStore('trashType', id, now()),
  restoreType: (id) => callStore('untrashType', id, now()),
  trash: (spaceId) => callStore('trash', spaceId),
  inbox: (spaceId, today, days) => callStore('inbox', spaceId, today, days),
  setCaptureDone: (noteId, captureId, done) => callStore('markCaptureDone', noteId, captureId, done, now()),
  // Online the server captures (it turns links into weblinks); offline the replica does.
  capture: async (spaceId, text, channel, day, typeId) => {
    try {
      return await viaServer(http.capture)(spaceId, text, channel, day, typeId)
    } catch (error) {
      if (!(error instanceof Error && error.message === OFFLINE_MESSAGE)) throw error
      const result = typeId
        ? await callStore('captureObject', spaceId, typeId, text, channel, day, now(), timeZone())
        : await callStore('capture', spaceId, text, channel, day, now())
      void syncNow()
      return result
    }
  },
  saveSpace: (space) => callStore('updateSpace', space.id, space),
  updateSpace: (id, data) => callStore('updateSpace', id, data),
  calendar: (spaceId, from, to, timeZone) => callStore('calendar', spaceId, { from, to }, timeZone),
  calendarSources: (spaceId) => callStore('listCalendarSources', spaceId),
  saveWeblink: viaServer(http.saveWeblink),
  setWeblinkUrl: viaServer(http.setWeblinkUrl),
  refreshWeblink: viaServer(http.refreshWeblink),
  saveReadable: viaServer(http.saveReadable),
  uploadFile: viaServer(http.uploadFile),
  deleteObjectForever: viaServer(http.deleteObjectForever),
  deleteTypeForever: viaServer(http.deleteTypeForever),
  emptyTrash: viaServer(http.emptyTrash),
  restoreSpace: viaServer(http.restoreSpace),
  createSpace: viaServer(http.createSpace),
  deleteSpace: viaServer(http.deleteSpace),
  addMember: viaServer(http.addMember),
  setMemberRole: viaServer(http.setMemberRole),
  removeMember: viaServer(http.removeMember),
  addCalendarSource: viaServer(http.addCalendarSource),
  updateCalendarSource: viaServer(http.updateCalendarSource),
  deleteCalendarSource: viaServer(http.deleteCalendarSource),
  syncCalendarSource: viaServer(http.syncCalendarSource),
}

export const api = Object.fromEntries(
  Object.entries(http).map(([name, call]) => [
    name,
    (...args: unknown[]) => {
      const replicaCall = local[name as keyof Api] as ((...args: unknown[]) => unknown) | undefined
      return (useReplica() && replicaCall ? replicaCall : (call as (...args: unknown[]) => unknown))(...args)
    },
  ])
) as Api

/**
 * The server's API even while the replica runs: a page that opened before this tab took the
 * replica over edits its text as JSON, which only the server's save takes.
 */
export const serverApi = http

export const mediaUrl = (key: string) => `/media/${encodeURIComponent(key)}`

/** Largest upload the server takes (MAX_UPLOAD_BYTES in packages/server/src/app.ts). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
