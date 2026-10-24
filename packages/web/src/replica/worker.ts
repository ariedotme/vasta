/// <reference lib="webworker" />
// The replica worker: the user's spaces in SQLite (sqlite-wasm on OPFS, "SAH pool" VFS, which
// needs a dedicated worker and works in Safari 16.4+), the client store over it, and the sync
// loop with the server. See docs/sync.md, "Device".
import sqlite3InitModule, { type SAHPoolUtil } from '@sqlite.org/sqlite-wasm'
import { ClientStore, InvalidError, NotFoundError } from '@vasta/core/client'
import { wasmDatabase } from '@vasta/core/sql-wasm'
import { ProtocolError, SyncClient, httpTransport } from '@vasta/core/sync-client'
import type { Id } from '@vasta/core'
import { Y } from '@vasta/editor-schema/yjs'
import { WRITE_METHODS, type Answer, type ErrorCode, type Notice, type Request, type StoreMethod, type SyncStatus, type WorkerEvent } from './protocol.ts'

declare const self: DedicatedWorkerGlobalScope

const DB_FILE = '/replica.db'
/** The pool's directory in OPFS (sqlite-wasm's default for the name "vasta"). */
const POOL_DIR = '.vasta'
/** Yjs origin of updates from the app's editors (not sent back to them). */
const EDITOR = 'editor'
/** Typing is written to SQLite in batches; the editor's own Y.Doc holds it meanwhile. */
const TEXT_DELAY = 200
const SYNC_DELAY = 800
const MAX_RETRY = 60_000

let pool: SAHPoolUtil | undefined
let store: ClientStore | undefined
let client: SyncClient | undefined
const status: SyncStatus = { pending: 0, syncing: false, offline: false, needsUpdate: false, ready: false, refused: [] }

const post = (message: WorkerEvent) => self.postMessage(message)
const now = () => new Date().toISOString()
const writes = new Set<string>(WRITE_METHODS)

function openStore(): ClientStore {
  const db = new pool!.OpfsSAHPoolDb(DB_FILE)
  return new ClientStore(wasmDatabase(db), 'web')
}

/**
 * One tab at a time holds the replica (the pool keeps its files open). Another tab must not even
 * try: when installing the pool fails, sqlite-wasm deletes the pool's directory, which with a
 * little bad luck would take the other tab's replica and its unsent changes along. The lock is
 * held until this worker ends; with `wait`, until then in the other tab's worker.
 */
function holdReplicaLock(wait: boolean): Promise<boolean> {
  if (!navigator.locks) return Promise.resolve(false)
  return new Promise((resolve) => {
    void navigator.locks.request('vasta-replica', wait ? {} : { ifAvailable: true }, (lock) => {
      resolve(!!lock)
      return lock ? new Promise<void>(() => {}) : undefined
    })
  })
}

/**
 * Wait until every file of the pool can be opened here: the worker that held the lock a moment
 * ago may not have let go of them yet, and installing the pool while one is taken would delete
 * the pool (see holdReplicaLock). Trying a file ourselves deletes nothing.
 */
async function waitForPoolFiles() {
  for (let attempt = 0; ; attempt++) {
    try {
      const root = await navigator.storage.getDirectory()
      const files = await (await root.getDirectoryHandle(POOL_DIR)).getDirectoryHandle('.opaque')
      for await (const handle of files.values()) if (handle instanceof FileSystemFileHandle) (await handle.createSyncAccessHandle()).close()
      return
    } catch (error) {
      if ((error as Error)?.name === 'NotFoundError') return // no replica yet
      if (attempt >= 50) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

let locked = false

async function open(userId: Id, wait = false) {
  if (!store) {
    locked ||= await holdReplicaLock(wait)
    if (!locked) throw Object.assign(new Error('another tab has the replica open'), { code: 'busy' })
    await waitForPoolFiles()
    const sqlite3 = await sqlite3InitModule()
    // Throws where OPFS is missing (private browsing); the app then keeps talking to the server directly.
    pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'vasta', directory: POOL_DIR })
    store = openStore()
  }
  // Another user logged in on this browser: start from nothing.
  if (store.getMeta('replica.user') !== userId) {
    await wipe()
    store = openStore()
    store.setMeta('replica.user', userId)
  }
  store.user = userId
  client = new SyncClient(store, httpTransport((path, init) => fetch(path, init)))
  client.onFillProgress = (done, total) => {
    status.filling = { done, total }
    sendStatus()
  }
  store.onTextUpdate((objectId, update, origin) => {
    if (origin !== EDITOR) post({ event: 'text', objectId, update })
  })
  status.ready = store.filled()
  status.pending = store.outboxSize()
  status.refused = store.refusedChanges()
  sendStatus()
  return { ready: status.ready }
}

async function wipe() {
  clearTimeout(syncTimer)
  store?.close()
  store = undefined
  client = undefined
  await pool?.wipeFiles()
  status.ready = false
  status.filling = undefined
  status.pending = 0
  status.refused = []
}

function sendStatus() {
  post({ event: 'status', status: { ...status } })
}

function sendChanges() {
  const changes = store?.takeChanges() ?? []
  if (changes.length) post({ event: 'changes', changes })
  const pending = store?.outboxSize() ?? 0
  if (pending !== status.pending) {
    status.pending = pending
    sendStatus()
  }
}

// Sync ------------------------------------------------------------------------

let syncTimer: ReturnType<typeof setTimeout> | undefined
let retry = 0

function scheduleSync(delay = SYNC_DELAY) {
  clearTimeout(syncTimer)
  syncTimer = setTimeout(() => void runSync(), delay)
}

async function runSync() {
  if (!client || status.needsUpdate) return
  clearTimeout(syncTimer)
  flushText()
  status.syncing = true
  sendStatus()
  try {
    const result = await client.sync()
    retry = 0
    status.offline = false
    status.ready = true
    status.filling = undefined
    status.lastSyncAt = now()
    status.refused = store?.refusedChanges() ?? []
    if (result.refused.length) post({ event: 'refused', changes: result.refused })
    if (result.changes.length) post({ event: 'changes', changes: result.changes })
  } catch (error) {
    if (error instanceof ProtocolError) status.needsUpdate = true
    else {
      // No network or server; try again later, less and less often.
      status.offline = true
      retry = Math.min(retry ? retry * 2 : 5000, MAX_RETRY)
      scheduleSync(retry)
    }
  } finally {
    status.syncing = false
    sendChanges()
    sendStatus()
  }
}

// Text from the app's editors -------------------------------------------------

const queued = new Map<Id, Uint8Array[]>()
let textTimer: ReturnType<typeof setTimeout> | undefined

function queueText(objectId: Id, update: Uint8Array) {
  const list = queued.get(objectId) ?? []
  list.push(update)
  queued.set(objectId, list)
  if (!textTimer) textTimer = setTimeout(flushText, TEXT_DELAY)
}

function flushText() {
  clearTimeout(textTimer)
  textTimer = undefined
  if (!store || !queued.size) return
  for (const [objectId, updates] of queued) {
    try {
      store.applyLocalText(objectId, Y.mergeUpdates(updates), now(), EDITOR)
    } catch (error) {
      console.error(`Could not save the text of ${objectId}`, error)
    }
  }
  queued.clear()
  sendChanges()
  scheduleSync()
}

// Messages ----------------------------------------------------------------------

async function answer(request: Request): Promise<unknown> {
  if (request.op === 'open') return open(request.userId, request.wait)
  if (request.op === 'wipe') return wipe()
  if (!store) throw Object.assign(new Error('the replica is not open'), { code: 'unavailable' })
  if (request.op === 'sync') {
    await runSync()
    return { ...status }
  }
  if (request.op === 'dismissRefused') {
    store.dismissRefused(request.refusedId)
    status.refused = store.refusedChanges()
    sendStatus()
    return undefined
  }
  if (request.op === 'openText') {
    flushText()
    return store.openText(request.objectId)
  }
  const method = request.method as StoreMethod
  // Text typed a moment ago must be in the rows a read or write sees.
  flushText()
  const result = (store[method] as (...args: unknown[]) => unknown)(...request.args)
  if (writes.has(method)) {
    sendChanges()
    scheduleSync()
  }
  return result
}

function codeOf(error: unknown): ErrorCode | undefined {
  if (error instanceof NotFoundError) return 'not-found'
  if (error instanceof InvalidError) return 'invalid'
  return (error as { code?: ErrorCode }).code
}

self.onmessage = (message: MessageEvent<Request | Notice>) => {
  const data = message.data
  if (!('id' in data)) {
    if (data.op === 'text') queueText(data.objectId, data.update)
    else if (data.op === 'closeText') {
      flushText()
      store?.closeText(data.objectId)
    } else if (data.op === 'flush') flushText()
    else if (data.op === 'poke') scheduleSync(100)
    return
  }
  void answer(data).then(
    (result) => {
      const transfer = result instanceof Uint8Array ? [result.buffer] : []
      self.postMessage({ id: data.id, ok: true, result } satisfies Answer, transfer)
    },
    (error: unknown) => {
      const code = codeOf(error)
      self.postMessage({ id: data.id, ok: false, error: (error as Error)?.message ?? String(error), ...(code ? { code } : {}) } satisfies Answer)
    }
  )
}
