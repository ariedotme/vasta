// The sync loop of a device: push the outbox, pull what changed (rows with the text the replica
// lacks, then subscribed calendars' data). The transport is the server's sync endpoints over
// HTTP in the app, the app's request function in tests.
import type { ClientStore, RefusedChange, ReplicaChange } from './client-store.ts'
import type { Id } from './model.ts'
import type { PulledRow, SyncTombstone } from './store.ts'
import { SYNC_PROTOCOL, fromBase64, type SyncChange, type SyncChangeResult } from './sync.ts'

export interface PullAnswer {
  rev: number
  more: boolean
  rows: PulledRow[]
  tombstones: SyncTombstone[]
  spaces: Id[]
  /** Rows and tombstones left after this page, when asked for (`count`). */
  remaining?: number
}

export interface SyncTransport {
  /** `count`: also answer how many rows are left after the page (`remaining`). */
  pull(since: number, limit: number, options?: { space?: Id; count?: boolean }): Promise<PullAnswer>
  push(changes: SyncChange[]): Promise<{ rev: number; changes: SyncChangeResult[] }>
  /** Yjs updates (base64) of the given objects beyond the given state vectors (base64). */
  text(vectors: Record<Id, string>): Promise<Record<Id, string>>
  /** A subscribed calendar's iCalendar data; undefined when it has none (or is gone). */
  calendar(id: Id): Promise<{ data: string; version: string } | undefined>
}

/** The server speaks another protocol: this version of the app must be updated first. */
export class ProtocolError extends Error {
  readonly serverProtocol: number

  constructor(serverProtocol: number) {
    super(`the server speaks sync protocol ${serverProtocol}, this app ${SYNC_PROTOCOL}`)
    this.serverProtocol = serverProtocol
  }
}

export interface SyncResult {
  changes: ReplicaChange[]
  /** Changes the server refused in this sync (dropped from the outbox, kept in the store's list). */
  refused: RefusedChange[]
}

// The server's most (MAX_PULL_LIMIT, MAX_TEXT_OBJECTS): each page is one transaction, and on OPFS
// every commit costs.
const PULL_LIMIT = 1000
const TEXT_BATCH = 1000
const PUSH_BATCH = 200

/** A transport over fetch, for the app (and anything else with fetch and a session). */
export function httpTransport(fetcher: (path: string, init?: RequestInit) => Promise<Response>): SyncTransport {
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetcher(path, init)
    if (response.status === 409) {
      const body = (await response.json().catch(() => ({}))) as { protocol?: number }
      throw new ProtocolError(Number(body.protocol ?? 0))
    }
    if (!response.ok) {
      const reason = await response.json().then((data: { error?: string }) => data.error).catch(() => undefined)
      throw Object.assign(new Error(reason ?? `${path} failed: ${response.status}`), { status: response.status })
    }
    return (await response.json()) as T
  }
  const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-requested-with': 'vasta' } })
  return {
    pull: (since, limit, { space, count } = {}) =>
      call(`/api/sync/pull?protocol=${SYNC_PROTOCOL}&since=${since}&limit=${limit}${space ? `&space=${encodeURIComponent(space)}` : ''}${count ? '&count=1' : ''}`),
    push: (changes) => call('/api/sync/push', post({ protocol: SYNC_PROTOCOL, changes })),
    text: async (vectors) => (await call<{ objects: Record<Id, string> }>('/api/sync/text', post({ protocol: SYNC_PROTOCOL, objects: vectors }))).objects,
    calendar: async (id) => {
      try {
        return await call<{ data: string; version: string }>(`/api/sync/calendars/${encodeURIComponent(id)}?protocol=${SYNC_PROTOCOL}`)
      } catch (error) {
        if ((error as { status?: number }).status === 404) return undefined
        throw error
      }
    },
  }
}

export class SyncClient {
  private running: Promise<SyncResult> | undefined
  private again = false

  readonly store: ClientStore
  readonly transport: SyncTransport
  /** Rows pulled so far while the replica is filled for the first time, of how many. */
  onFillProgress?: (done: number, total: number) => void

  constructor(store: ClientStore, transport: SyncTransport) {
    this.store = store
    this.transport = transport
  }

  /** Push and pull until nothing is left; a call during a sync runs it once more afterwards. */
  sync(): Promise<SyncResult> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      const result: SyncResult = { changes: [], refused: [] }
      try {
        do {
          this.again = false
          result.refused.push(...(await this.push()))
          const filled = await this.pull()
          // The app did not use the replica before it was filled: nothing it shows is out of date.
          if (filled) this.store.forgetChanges()
          else result.changes.push(...this.store.takeChanges())
        } while (this.again)
      } finally {
        this.running = undefined
      }
      return result
    })()
    return this.running
  }

  private async push(): Promise<RefusedChange[]> {
    const refused: RefusedChange[] = []
    for (let round = 0; round < 1000; round++) {
      const batch = this.store.pushBatch(PUSH_BATCH)
      if (!batch.changes.length) break
      const answer = await this.transport.push(batch.changes)
      refused.push(...this.store.ackPush(batch, answer.changes))
      if (this.store.outboxSize() === 0) break
    }
    return refused
  }

  /** Pull everything new; true when this filled the replica for the first time. */
  private async pull(): Promise<boolean> {
    const store = this.store
    if (store.pulledRev() === 0) store.setFilled(false)
    const filling = !store.filled()
    let since = store.pulledRev()
    let answer: PullAnswer
    let done = filling ? store.rowCount() : 0
    let total = 0
    do {
      answer = await this.transport.pull(since, PULL_LIMIT, { count: filling && !total })
      // A pull from 0 gets everything of the spaces it lists, even when it stops halfway and
      // goes on in a later sync; a space joined later is pulled from 0 on its own.
      if (since === 0) store.setCompleteSpaces(answer.spaces)
      await this.applyPage(answer)
      since = answer.rev
      store.setPulledRev(since)
      if (filling) {
        done += answer.rows.length + answer.tombstones.length
        total ||= done + (answer.remaining ?? 0)
        this.onFillProgress?.(Math.min(done, total), total)
      }
    } while (answer.more)

    store.dropSpaces(answer.spaces)
    for (const space of answer.spaces.filter((id) => !store.completeSpaces().includes(id))) {
      let from = 0
      let page: PullAnswer
      do {
        page = await this.transport.pull(from, PULL_LIMIT, { space })
        await this.applyPage(page)
        from = page.rev
      } while (page.more)
      store.setCompleteSpaces([...store.completeSpaces(), space])
    }

    // Text an earlier sync did not get to (offline halfway), or that changed again meanwhile.
    const ids = store.staleText()
    for (let i = 0; i < ids.length; i += TEXT_BATCH) {
      const batch = ids.slice(i, i + TEXT_BATCH)
      store.applyRemoteText(await this.fetchText(batch), batch)
    }

    for (const id of store.staleCalendars()) {
      const calendar = await this.transport.calendar(id)
      if (calendar) store.storeCalendarData(id, calendar.data, calendar.version)
      else store.forgetStaleCalendar(id)
    }
    if (filling) store.setFilled(true)
    return filling
  }

  /**
   * Write a page of rows with the text their objects lack, fetched first: each object is written
   * once. When the text does not come (offline halfway), the rows go in without it and a later
   * sync fetches it (`staleText`).
   */
  private async applyPage(page: PullAnswer) {
    const ids = this.store.textToFetch(page.rows)
    const text: Record<Id, Uint8Array> = {}
    try {
      for (let i = 0; i < ids.length; i += TEXT_BATCH) Object.assign(text, await this.fetchText(ids.slice(i, i + TEXT_BATCH)))
    } catch (error) {
      this.store.applyPull(page.rows, page.tombstones)
      throw error
    }
    this.store.applyPull(page.rows, page.tombstones, text)
  }

  private async fetchText(ids: Id[]): Promise<Record<Id, Uint8Array>> {
    const updates = await this.transport.text(this.store.localTextVectors(ids))
    return Object.fromEntries(Object.entries(updates).map(([id, update]) => [id, fromBase64(update)]))
  }
}
