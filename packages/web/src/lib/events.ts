// Live changes, e.g. items captured from Telegram while the app is open. Without a replica they
// come from the server (Server-Sent Events); with one, the server's events only tell the replica
// to pull, and the changes come from the replica once they are in it (also those made on this
// device). Keeps the summary cache and type counts fresh; pages subscribe for their object. A
// change the server refused is told once in a toast (Settings › This device lists them).
import type { Id, IsoDateTime } from '@vasta/core'
import { api } from './api.ts'
import { router } from '../router.ts'
import { notifyDesktop, type DesktopNotification } from './platform.ts'
import { onReplicaChanges, onReplicaRefused, pokeReplica, useReplica } from './replica.ts'
import { cachedSummary, forgetSummary, notice, refreshCounts, refreshSpaces, replaceType, requestSummaries } from './state.ts'

// The server only sends events of the spaces the user is a member of.
export type ChangeEvent =
  | { kind: 'object'; id: Id; spaceId: Id; typeId: Id; updatedAt: IsoDateTime }
  /** A subscribed calendar synced or changed. */
  | { kind: 'calendar'; sourceId: Id; spaceId: Id }
  /** A type's definition changed on the server. */
  | { kind: 'type'; id: Id; spaceId: Id }
  /** A space was renamed, joined or dropped (only from the replica). */
  | { kind: 'space'; id: Id; spaceId?: undefined }

const listeners = new Set<(event: ChangeEvent) => void>()
let source: EventSource | undefined
let countsTimer: ReturnType<typeof setTimeout> | undefined

let stopReplicaChanges: (() => void) | undefined
let stopRefused: (() => void) | undefined

function dispatch(event: ChangeEvent) {
  if (event.kind === 'object') {
    const cached = cachedSummary(event.id)
    if (cached && cached.updatedAt < event.updatedAt) {
      forgetSummary(event.id)
      requestSummaries([event.id])
    }
    clearTimeout(countsTimer)
    countsTimer = setTimeout(() => void refreshCounts(), 500)
  } else if (event.kind === 'type') {
    void api.type(event.id).then(replaceType, () => {})
  } else if (event.kind === 'space') {
    void refreshSpaces()
  }
  for (const listener of listeners) listener(event)
}

export function connectEvents() {
  stopReplicaChanges ??= onReplicaChanges((changes) => {
    for (const change of changes) dispatch(change as ChangeEvent)
  })
  stopRefused ??= onReplicaRefused((changes) => {
    const [first] = changes
    notice.value = {
      message: changes.length === 1 && first?.title ? `The server did not take a change to “${first.title}”.` : `The server did not take ${changes.length === 1 ? 'a change' : `${changes.length} changes`}.`,
      action: { label: 'Details', run: () => router.push('/settings') },
    }
  })
  if (source || typeof EventSource === 'undefined') return
  // The desktop app 0.1.10 shows the user's reminders that this page hears as system
  // notifications; later ones hear them on their own (provideNotifyToken).
  const notifies = !!window.__VASTA_DESKTOP__?.notify && !window.__VASTA_DESKTOP__.notifyStream
  source = new EventSource(notifies ? '/api/events?desktop=1' : '/api/events')
  if (notifies) source.addEventListener('notify', (message) => void notifyDesktop(JSON.parse((message as MessageEvent<string>).data) as DesktopNotification))
  source.addEventListener('change', (message) => {
    if (useReplica()) return
    dispatch(JSON.parse((message as MessageEvent<string>).data) as ChangeEvent)
  })
  source.addEventListener('rev', () => pokeReplica())
}

export function disconnectEvents() {
  source?.close()
  source = undefined
  stopReplicaChanges?.()
  stopReplicaChanges = undefined
  stopRefused?.()
  stopRefused = undefined
}

export function onChange(listener: (event: ChangeEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
