// In-process change feed. The web app listens over Server-Sent Events (/api/events) so an open
// page picks up items captured from other channels.
import type { Id, IsoDateTime } from '@vasta/core'

// Every event names its space: a client only hears about the spaces its user is a member of.
export type ChangeEvent =
  | { kind: 'object'; id: Id; spaceId: Id; typeId: Id; updatedAt: IsoDateTime }
  /** A subscribed calendar synced, failed, or changed its settings. */
  | { kind: 'calendar'; sourceId: Id; spaceId: Id }
  /** A type's definition changed on the server (e.g. a built-in field was added). */
  | { kind: 'type'; id: Id; spaceId: Id }
  /** A synced row of the space changed (any write): sync clients pull. Sent as SSE event `rev`. */
  | { kind: 'rev'; spaceId: Id; rev: number }

export class ChangeFeed {
  private listeners = new Set<(event: ChangeEvent) => void>()

  emit(event: ChangeEvent) {
    for (const listener of this.listeners) listener(event)
  }

  subscribe(listener: (event: ChangeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/** A reminder shown by the desktop app as a system notification. */
export interface DesktopNotification {
  key: string
  title: string
  message: string
  url?: string
}

/**
 * The desktop apps listening for their user's reminders (`/api/events?desktop=1`, from desktop
 * 0.1.10), which show them as system notifications. A reminder reaches the apps open right then.
 */
export class DesktopListeners {
  private byUser = new Map<Id, Set<(notification: DesktopNotification) => void>>()

  listen(userId: Id, listener: (notification: DesktopNotification) => void): () => void {
    const set = this.byUser.get(userId) ?? new Set()
    set.add(listener)
    this.byUser.set(userId, set)
    return () => {
      set.delete(listener)
      if (!set.size) this.byUser.delete(userId)
    }
  }

  count(userId: Id): number {
    return this.byUser.get(userId)?.size ?? 0
  }

  /** How many apps it reached. */
  send(userId: Id, notification: DesktopNotification): number {
    const set = this.byUser.get(userId)
    for (const listener of set ?? []) listener(notification)
    return set?.size ?? 0
  }
}
