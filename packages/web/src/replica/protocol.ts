// Messages between the app and the replica worker (worker.ts). The app calls store methods by
// name; the worker answers each request and sends events: what changed in the replica, Yjs
// updates for open documents, and the sync status.
import type { ClientStore, RefusedChange, ReplicaChange } from '@vasta/core/client'
import type { Id } from '@vasta/core'

/** Store methods the app may call: reads, and writes that go to the outbox. */
export const READ_METHODS = [
  'listSpaces',
  'spaceBundle',
  'search',
  'query',
  'listObjects',
  'getObjectSummaries',
  'requireObject',
  'backlinks',
  'requireType',
  'trash',
  'inbox',
  'calendar',
  'listCalendarSources',
] as const satisfies readonly (keyof ClientStore)[]

export const WRITE_METHODS = [
  'createObject',
  'saveObject',
  'trashObject',
  'untrashObject',
  'createType',
  'saveType',
  'trashType',
  'untrashType',
  'updateSpace',
  'dailyNote',
  'markCaptureDone',
  'capture',
  'captureObject',
  'ensureBlockId',
  'changeOccurrence',
  'createQuote',
  'setNutrition',
  'logFood',
  'logFoodLine',
  'deleteFoodEntry',
  'setPeople',
  'setSprints',
] as const satisfies readonly (keyof ClientStore)[]

export type StoreMethod = (typeof READ_METHODS)[number] | (typeof WRITE_METHODS)[number]
export type StoreArgs<M extends StoreMethod> = Parameters<ClientStore[M]>
export type StoreResult<M extends StoreMethod> = ReturnType<ClientStore[M]>

export type Request =
  /** `wait`: until the tab holding the replica lets it go (closes); otherwise refused at once with `busy`. */
  | { id: number; op: 'open'; userId: Id; wait?: boolean }
  | { id: number; op: 'store'; method: StoreMethod; args: unknown[] }
  | { id: number; op: 'sync' }
  /** Delete the replica (logging out). */
  | { id: number; op: 'wipe' }
  | { id: number; op: 'openText'; objectId: Id }
  /** Forget a refused change (its id), or all of them. */
  | { id: number; op: 'dismissRefused'; refusedId?: number }

/** Messages without an answer, handled in the order sent. */
export type Notice =
  | { op: 'text'; objectId: Id; update: Uint8Array }
  | { op: 'closeText'; objectId: Id }
  /** Write queued text now (the page is being hidden). */
  | { op: 'flush' }
  /** Something may have changed on the server (a live event, back online). */
  | { op: 'poke' }

/** `busy`: another tab holds the replica. */
export type ErrorCode = 'not-found' | 'invalid' | 'unavailable' | 'busy'

export type Answer = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string; code?: ErrorCode }

export interface SyncStatus {
  /** Rows with changes not pushed yet. */
  pending: number
  syncing: boolean
  /** The last sync failed for lack of a network or server. */
  offline: boolean
  /** The server speaks a newer protocol: the app must reload to update. */
  needsUpdate: boolean
  /** The first full pull is done; until then the replica cannot answer for the server. */
  ready: boolean
  /** While the first pull runs: rows pulled so far, of how many. */
  filling?: { done: number; total: number }
  /** Changes the server refused (dropped from the outbox), until dismissed. */
  refused: RefusedChange[]
  /** When the last sync succeeded. */
  lastSyncAt?: string
}

export type WorkerEvent =
  | { event: 'changes'; changes: ReplicaChange[] }
  | { event: 'text'; objectId: Id; update: Uint8Array }
  | { event: 'status'; status: SyncStatus }
  /** The server refused these changes in the last sync. */
  | { event: 'refused'; changes: RefusedChange[] }
