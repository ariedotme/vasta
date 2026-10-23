// Moving notes from one Vasta server to another: the desktop app's own server (VASTA_LOCAL_KEY)
// hands its user's spaces to a server where they make an account (Settings › Server accounts; see
// docs/desktop.md). Rows keep their ids and clocks, rich text its Yjs history, media its keys.
//   receiving: importRows (POST /api/import) and the media routes in app.ts, on any server
//   sending:   Migration (POST /api/migrate, GET /api/migrate), on the desktop app's own server
import { readdir } from 'node:fs/promises'
import type { Id, SyncRecords, SyncTable } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import type { NodeStore, SyncRow } from '@vasta/core/node'
import { checkMediaKey, type MediaStore } from '@vasta/core/media'
import { Y } from '@vasta/editor-schema/yjs'

/** One request's worth of rows: spaces before what is in them, types before objects. */
export interface ImportBatch {
  rows: SyncRow[]
  /** The Yjs state of objects' rich text (base64), by object id. */
  texts?: Record<Id, string>
  /** Passwords of subscribed calendars (they never sync), by source id. */
  calendarPasswords?: Record<Id, string>
}

export class ImportError extends Error {}

/** The order rows must be written in: what a row refers to comes first. */
const TABLE_ORDER: SyncTable[] = ['spaces', 'types', 'calendar_sources', 'objects']

/** Largest batch the sender makes (JSON characters); the receiver takes a little more. */
const BATCH_CHARS = 4 * 1024 * 1024
export const MAX_IMPORT_BYTES = 2 * BATCH_CHARS

/**
 * Write a batch for `userId`. A new space becomes theirs (owner); rows of a space that exists must
 * be in one they own, so a batch sent again (a migration resumed) overwrites what the first wrote.
 * Run it outside any actor (actor.ts): the rows keep their authors, and make no activity or
 * notifications.
 */
export function importRows(store: NodeStore, userId: Id, batch: ImportBatch, now: string): number {
  const rows = [...batch.rows].sort((a, b) => TABLE_ORDER.indexOf(a.table) - TABLE_ORDER.indexOf(b.table))
  for (const row of rows) {
    if (!TABLE_ORDER.includes(row.table) || typeof row.id !== 'string' || !row.record || row.record.id !== row.id) throw new ImportError('a row is not one Vasta exports')
  }
  const owns = (spaceId: Id) => store.memberRole(spaceId, userId) === 'owner'
  store.transaction(() => {
    for (const row of rows) {
      const clock = row.clock && typeof row.clock === 'object' ? row.clock : {}
      if (row.table === 'spaces') {
        const { deletedAt, ...space } = row.record as SyncRecords['spaces']
        if (store.getSpace(space.id) || store.isTombstoned('spaces', space.id)) {
          if (!owns(space.id)) throw new ImportError(`this server has a space with the id ${space.id} already`)
        }
        store.putSpace(space, clock)
        if (!store.memberRole(space.id, userId)) store.putMember({ spaceId: space.id, userId, role: 'owner', createdAt: now })
        if (deletedAt) store.setSpaceDeleted(space.id, deletedAt)
        continue
      }
      const spaceId = (row.record as { spaceId?: Id }).spaceId
      if (!spaceId || !owns(spaceId)) throw new ImportError(`${row.table} ${row.id} is not in a space of yours`)
      if (row.table === 'types') store.putType(row.record as SyncRecords['types'], clock)
      else if (row.table === 'calendar_sources') store.putCalendarSource(row.record as SyncRecords['calendar_sources'], batch.calendarPasswords?.[row.id], clock)
      else {
        const text = batch.texts?.[row.id]
        const ydoc = text ? new Y.Doc() : undefined
        if (ydoc && text) Y.applyUpdate(ydoc, Buffer.from(text, 'base64'))
        store.putObject(row.record as SyncRecords['objects'], clock, ydoc)
      }
    }
  })
  return rows.length
}

// -----------------------------------------------------------------------------
// Sending: the desktop app's server moves everything to another server

/** What the user typed: the other server and a setup code, or an invite link (which names its server). */
export interface MigrationInput {
  server?: string
  code: string
  username: string
  name?: string
  password: string
  timeZone?: string
}

export interface MigrationState {
  phase: 'idle' | 'account' | 'notes' | 'media' | 'done' | 'failed'
  /** The other server's address, once known. */
  server?: string
  /** Rows (notes) or files (media) moved so far, of `total`. */
  done: number
  total: number
  error?: string
  /** Where a failed migration stopped. */
  step?: 'account' | 'notes' | 'media'
}

const CLIENT = { 'x-requested-with': 'vasta' }
const SETUP_CODE = /^[A-Z2-9]{4}-?[A-Z2-9]{4}-?[A-Z2-9]{4}$/i

/** The other server and how to make the account there. */
export function parseTarget(input: Pick<MigrationInput, 'server' | 'code'>): { server: URL; setupCode?: string; invite?: string } {
  const code = input.code.trim()
  const asLink = /^https?:\/\//i.test(code) ? URL.parse(code) : undefined
  const invite = asLink?.searchParams.get('invite')
  if (asLink && invite) return { server: new URL('/', asLink), invite }
  const typed = (input.server ?? '').trim()
  if (!typed) throw new ImportError('type the address of the server')
  const server = URL.parse(/^https?:\/\//i.test(typed) ? typed : `https://${typed}`)
  if (!server?.hostname) throw new ImportError(`“${typed}” is not a web address`)
  if (!code) throw new ImportError('paste the setup code or an invite link')
  return SETUP_CODE.test(code) ? { server: new URL('/', server), setupCode: code } : { server: new URL('/', server), invite: code }
}

export interface MigrationOptions {
  store: NodeStore
  media: MediaStore
  fetch?: typeof fetch
}

/** One migration at a time; it remembers the other server's session, so trying again resumes. */
export class Migration {
  state: MigrationState = { phase: 'idle', done: 0, total: 0 }
  private session?: { server: string; cookie: string; userId: Id }
  /** The user whose spaces move (the desktop app's own server has one). */
  private userId: Id = ''
  private readonly options: MigrationOptions
  private readonly fetch: typeof fetch

  constructor(options: MigrationOptions) {
    this.options = options
    this.fetch = options.fetch ?? fetch
  }

  get running() {
    return ['account', 'notes', 'media'].includes(this.state.phase)
  }

  /** Check the input, then move everything in the background (`state` tells how far it got). */
  start(userId: Id, input: MigrationInput): MigrationState {
    if (this.running) return this.state
    this.userId = userId
    const target = parseTarget(input)
    const resumed = this.session?.server === target.server.href
    if (!resumed && (!input.username.trim() || !input.password)) throw new ImportError('choose a username and a password')
    this.state = { phase: 'account', server: target.server.href, done: 0, total: 0 }
    void this.run(target, input).catch((error: Error) => {
      const step = this.state.phase as MigrationState['step']
      this.state = { ...this.state, phase: 'failed', error: error.message, ...(step ? { step } : {}) }
    })
    return this.state
  }

  private async run(target: ReturnType<typeof parseTarget>, input: MigrationInput) {
    const server = target.server.href
    if (this.session?.server !== server) {
      this.session = undefined
      await this.probe(target.server)
      this.session = await this.makeAccount(target, input)
    }
    await this.moveNotes()
    await this.moveMedia()
    this.state = { ...this.state, phase: 'done' }
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL(path, this.session?.server ?? this.state.server)
    const headers = { ...CLIENT, ...(this.session ? { cookie: this.session.cookie } : {}), ...(init.headers as Record<string, string>) }
    let response: Response
    try {
      response = await this.fetch(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(120_000) })
    } catch {
      throw new ImportError(`${url.host} does not answer. Check the address and the connection.`)
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      throw new ImportError(body.error ?? `${url.host} answered ${response.status}`)
    }
    return response
  }

  /** A server too old to take the notes would leave an account with nothing in it: check first. */
  private async probe(server: URL) {
    const response = await this.fetch(new URL('api/health', server), { signal: AbortSignal.timeout(20_000) }).catch(() => undefined)
    if (!response) throw new ImportError(`${server.host} does not answer. Check the address and the connection.`)
    const health = (await response.json().catch(() => undefined)) as { ok?: boolean; import?: number } | undefined
    if (!response.ok || !health?.ok) throw new ImportError(`${server.host} does not look like a Vasta server (it answered ${response.status}).`)
    if (!health.import) throw new ImportError(`${server.host} runs an older Vasta. Update it to 0.3.1 or later, then try again.`)
  }

  private async makeAccount(target: ReturnType<typeof parseTarget>, input: MigrationInput) {
    const body = {
      code: target.setupCode ?? target.invite,
      username: input.username.trim(),
      name: input.name?.trim() || input.username.trim(),
      password: input.password,
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      // The notes bring their own spaces.
      noSpace: true,
    }
    const response = await this.call(target.setupCode ? 'api/auth/setup' : 'api/auth/join', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    const cookie = response.headers.getSetCookie().map((c) => c.split(';')[0]!).find((c) => c.startsWith('vasta_session='))
    if (!cookie) throw new ImportError('the server made the account but did not log in')
    const user = (await response.json()) as { id: Id }
    return { server: target.server.href, cookie, userId: user.id }
  }

  /** Every space of the user, in batches; their user id becomes the new account's. */
  private async moveNotes() {
    const { store } = this.options
    const userId = this.userId
    const spaceIds = [...store.listUserSpaces(userId).map((s) => s.id), ...store.listDeletedSpaces().map((s) => s.id).filter((id) => store.memberRole(id, userId))]
    const rows = spaceIds.length ? store.syncChanges(spaceIds, 0, 1_000_000_000).rows : []
    rows.sort((a, b) => TABLE_ORDER.indexOf(a.table) - TABLE_ORDER.indexOf(b.table) || a.rev - b.rev)
    this.state = { ...this.state, phase: 'notes', done: 0, total: rows.length }
    const toUser = this.session!.userId
    const passwords = Object.fromEntries(
      store.listCalendarSources().flatMap((source) => {
        const password = store.calendarFetchInfo(source.id)?.password
        return password ? [[source.id, password]] : []
      })
    )

    let batch: ImportBatch = { rows: [], texts: {} }
    let size = 0
    const send = async () => {
      if (!batch.rows.length) return
      const calendarPasswords = Object.fromEntries(batch.rows.filter((r) => passwords[r.id]).map((r) => [r.id, passwords[r.id]!]))
      const body = JSON.stringify({ ...batch, ...(Object.keys(calendarPasswords).length ? { calendarPasswords } : {}) }).replaceAll(userId, toUser)
      await this.call('api/import', { method: 'POST', body, headers: { 'content-type': 'application/json' } })
      this.state = { ...this.state, done: this.state.done + batch.rows.length }
      batch = { rows: [], texts: {} }
      size = 0
    }
    for (const row of rows) {
      const ydoc = row.table === 'objects' ? store.loadText(row.id) : undefined
      const text = ydoc ? Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64') : undefined
      const rowSize = JSON.stringify(row).length + (text?.length ?? 0)
      if (size && size + rowSize > BATCH_CHARS) await send()
      batch.rows.push(row)
      if (text) batch.texts![row.id] = text
      size += rowSize
    }
    await send()
  }

  /** The files the other server lacks. */
  private async moveMedia() {
    const { media } = this.options
    const keys = media instanceof NodeMediaStore ? (await readdir(media.root).catch(() => [])).filter((name) => !name.startsWith('.')) : []
    const valid = keys.filter((key) => {
      try {
        return !!checkMediaKey(key)
      } catch {
        return false
      }
    })
    const { missing } = (await (await this.call('api/import/media', { method: 'POST', body: JSON.stringify({ keys: valid }), headers: { 'content-type': 'application/json' } })).json()) as { missing: string[] }
    this.state = { ...this.state, phase: 'media', done: 0, total: missing.length }
    for (const key of missing) {
      const file = await media.get(key)
      if (file) {
        const data = new Uint8Array(await new Response(file.body).arrayBuffer())
        await this.call(`api/import/media/${key}`, { method: 'PUT', body: data, headers: { 'content-type': 'application/octet-stream' } })
      }
      this.state = { ...this.state, done: this.state.done + 1 }
    }
  }
}
