// The app's side of the local replica (replica/worker.ts): start it for the logged-in user, call
// its store, hear what changed, and keep editors' Yjs documents in step with it. Where the
// replica cannot run (no OPFS, e.g. private browsing; another tab already holds it) the app
// keeps talking to the server directly (lib/api.ts decides per call).
import { reactive } from 'vue'
import type * as Yjs from 'yjs'
import type { Id } from '@vasta/core'
import type { RefusedChange, ReplicaChange } from '@vasta/core/client'
import type { Answer, Notice, Request, StoreArgs, StoreMethod, StoreResult, SyncStatus, WorkerEvent } from '../replica/protocol.ts'

export const replica = reactive({
  /** The worker runs and its replica is open. */
  active: false,
  ...({ pending: 0, syncing: false, offline: false, needsUpdate: false } satisfies Partial<SyncStatus>),
  ready: false as boolean,
  filling: undefined as SyncStatus['filling'],
  refused: [] as RefusedChange[],
  lastSyncAt: undefined as string | undefined,
  /** Why this device works without a replica (shown in Settings). */
  reason: '',
})

/** Whether calls are answered by the replica (open, and pulled in full once). */
export const useReplica = () => replica.active && replica.ready

let worker: Worker | undefined
let nextId = 1
const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
const changeListeners = new Set<(changes: ReplicaChange[]) => void>()
const refusedListeners = new Set<(changes: RefusedChange[]) => void>()

/** Thrown for a record the replica does not have, like the server's 404. */
export class ReplicaError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.code = code
  }
}

type Unsent<T> = T extends unknown ? Omit<T, 'id'> : never

function send(request: Unsent<Request>): Promise<unknown> {
  if (!worker) return Promise.reject(new ReplicaError('the replica is not running', 'unavailable'))
  const id = nextId++
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    worker!.postMessage({ ...request, id })
  })
}

function notify(notice: Notice) {
  worker?.postMessage(notice)
}

function onMessage(message: MessageEvent<Answer | WorkerEvent>) {
  const data = message.data
  if ('id' in data) {
    const pending = waiting.get(data.id)
    waiting.delete(data.id)
    if (data.ok) pending?.resolve(data.result)
    else pending?.reject(new ReplicaError(data.error, data.code))
    return
  }
  if (data.event === 'status') Object.assign(replica, data.status)
  else if (data.event === 'changes') for (const listener of changeListeners) listener(data.changes)
  else if (data.event === 'refused') for (const listener of refusedListeners) listener(data.changes)
  else if (data.event === 'text') {
    const session = sessions.get(data.objectId)
    if (session?.doc) Y!.applyUpdate(session.doc, data.update, FROM_REPLICA)
  }
}

/**
 * Open the user's replica and sync it in the background. The first time, while it pulls
 * everything, calls keep going to the server; they switch to the replica once it is filled
 * (`ready`), as when a tab takes it over from another (a page already open keeps its text on the
 * server). False when it cannot run here or is not filled yet. When another tab holds it, this
 * tab works with the server and takes the replica over once that tab closes (see takeOverWhenFree).
 */
export async function startReplica(userId: Id): Promise<boolean> {
  if (worker) return useReplica()
  replica.reason = ''
  if (typeof Worker === 'undefined' || !navigator.storage?.getDirectory) {
    replica.reason = 'This browser cannot keep a local copy (no private file storage, e.g. a private window).'
    return false
  }
  if (replicaTurnedOff()) {
    replica.reason = 'Turned off on this browser (localStorage vasta.replica = off).'
    return false
  }
  try {
    worker = new Worker(new URL('../replica/worker.ts', import.meta.url), { type: 'module', name: 'vasta-replica' })
    worker.onmessage = onMessage
    worker.onerror = () => stopWorker()
    await send({ op: 'open', userId })
    activate()
    return useReplica()
  } catch (error) {
    if ((error as ReplicaError).code === 'busy') {
      replica.reason = 'Another tab has the local copy; this one works online and takes it over when that tab closes.'
      takeOverWhenFree(userId)
      return false
    }
    console.warn('Working without a local replica:', error)
    replica.reason = `Could not open the local copy: ${(error as Error)?.message ?? String(error)}`
    stopWorker()
    return false
  }
}

function activate() {
  replica.active = true
  replica.reason = ''
  // Ask the browser not to evict the replica under storage pressure (iOS is quick to).
  void navigator.storage.persist?.().catch(() => false)
  void send({ op: 'sync' }).catch(() => {})
}

/**
 * Keep the worker waiting for the replica while another tab holds it. Calls switch to the
 * replica once it is open here; a page already open keeps its text on the server (ObjectPage).
 */
function takeOverWhenFree(userId: Id) {
  const waiting = worker
  send({ op: 'open', userId, wait: true }).then(
    () => {
      if (worker === waiting) activate()
    },
    (error: unknown) => {
      if (worker !== waiting) return
      console.warn('Could not take over the local replica:', error)
      replica.reason = `Could not open the local copy: ${(error as Error)?.message ?? String(error)}`
      stopWorker()
    }
  )
}

/** `localStorage['vasta.replica'] = 'off'` keeps this browser talking to the server directly (a way out if the replica misbehaves). */
function replicaTurnedOff() {
  try {
    return localStorage.getItem('vasta.replica') === 'off'
  } catch {
    return false
  }
}

/** The server keeps apps off their replica (VASTA_REPLICA=0). */
export function replicaRefusedByServer() {
  replica.reason = 'Turned off on the server (VASTA_REPLICA=0).'
}

function stopWorker() {
  worker?.terminate()
  worker = undefined
  replica.active = false
  replica.ready = false
  replica.refused = []
  for (const pending of waiting.values()) pending.reject(new ReplicaError('the replica stopped', 'unavailable'))
  waiting.clear()
  for (const session of sessions.values()) session.doc?.destroy()
  sessions.clear()
}

/** Stop the replica; `wipe` deletes it from this browser (logging out). */
export async function stopReplica(options: { wipe?: boolean } = {}) {
  if (options.wipe) await send({ op: 'wipe' }).catch(() => {})
  stopWorker()
}

/** Call a store method of the replica. Arguments are records (often Vue's reactive proxies, which cannot be posted): they go as plain JSON. */
export function callStore<M extends StoreMethod>(method: M, ...args: StoreArgs<M>): Promise<StoreResult<M>> {
  return send({ op: 'store', method, args: JSON.parse(JSON.stringify(args)) as unknown[] }) as Promise<StoreResult<M>>
}

/** Push and pull now; resolves when done (or failed for lack of a network). */
export function syncNow(): Promise<unknown> {
  return send({ op: 'sync' }).catch(() => {})
}

/** Forget a change the server refused (its id), or all of them. */
export function dismissRefused(refusedId?: number): Promise<unknown> {
  return send({ op: 'dismissRefused', refusedId }).catch(() => {})
}

/** Hear about changes the server refuses, as each sync reports them. */
export function onReplicaRefused(listener: (changes: RefusedChange[]) => void): () => void {
  refusedListeners.add(listener)
  return () => refusedListeners.delete(listener)
}

/** Something may have changed on the server (a live event, the network is back). */
export function pokeReplica() {
  notify({ op: 'poke' })
}

export function onReplicaChanges(listener: (changes: ReplicaChange[]) => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

if (typeof document !== 'undefined') {
  // iOS may suspend a hidden app at any moment: write what was typed, and push it.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') notify({ op: 'flush' })
    else pokeReplica()
  })
  window.addEventListener('online', () => pokeReplica())
}

// Text sessions ------------------------------------------------------------------
// An editor edits a Y.Doc of its own here; its updates go to the replica's copy of the document,
// and every other change to that copy (a pull, a capture marked done) comes back as an update.

const FROM_REPLICA = 'replica'
const sessions = new Map<Id, { doc?: Yjs.Doc; count: number; opening?: Promise<Yjs.Doc> }>()
/** Yjs loads with the first editor, not with the app. */
let Y: typeof Yjs | undefined

export interface TextSession {
  doc: Yjs.Doc
  release: () => void
}

/** The object's text as a Y.Doc kept in step with the replica; release it when the editor goes. */
export async function openText(objectId: Id): Promise<TextSession> {
  let session = sessions.get(objectId)
  if (!session) {
    session = { count: 0 }
    sessions.set(objectId, session)
    const current = session
    current.opening = Promise.all([import('yjs'), send({ op: 'openText', objectId }) as Promise<Uint8Array>]).then(([module, state]) => {
      Y ??= module
      const doc = new Y.Doc()
      Y.applyUpdate(doc, state, FROM_REPLICA)
      doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin !== FROM_REPLICA) notify({ op: 'text', objectId, update })
      })
      current.doc = doc
      return doc
    })
    current.opening.catch(() => sessions.delete(objectId))
  }
  session.count++
  const doc = await session.opening!
  let released = false
  return {
    doc,
    release: () => {
      if (released) return
      released = true
      if (--session.count > 0) return
      sessions.delete(objectId)
      notify({ op: 'closeText', objectId })
      doc.destroy()
    },
  }
}
