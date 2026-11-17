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
  | { kind: 'space'; id: Id; spaceId: Id }
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

/** A reminder that takes the screen (desktop 0.10 and later): the app opens `path` of the web app full screen. */
export interface DesktopTakeover {
  /** The nag (server/src/insistent.ts). */
  id: string
  title: string
  message: string
  /** The page to show, e.g. "remind/<id>?takeover=1". */
  path: string
  /** Seconds before the way out shows. */
  escapeAfter: number
}

interface DesktopListener {
  notify: (notification: DesktopNotification) => void
  /** Apps that can take the screen (they said so when connecting). */
  takeover?: (takeover: DesktopTakeover) => void
  /** A nag was answered (anywhere) or snoozed: its takeover closes. */
  dismiss?: (id: string) => void
}

/**
 * The desktop apps listening for their user's reminders (`/api/notifications`, from desktop
 * 0.1.11), which show them as system notifications, and from 0.10 take the screen for an
 * insistent reminder's last steps. A reminder reaches the apps open right then.
 */
export class DesktopListeners {
  private byUser = new Map<Id, Set<DesktopListener>>()

  listen(userId: Id, notify: (notification: DesktopNotification) => void, more: Omit<DesktopListener, 'notify'> = {}): () => void {
    const set = this.byUser.get(userId) ?? new Set()
    const listener = { notify, ...more }
    set.add(listener)
    this.byUser.set(userId, set)
    return () => {
      set.delete(listener)
      if (!set.size && this.byUser.get(userId) === set) this.byUser.delete(userId)
    }
  }

  count(userId: Id): number {
    return this.byUser.get(userId)?.size ?? 0
  }

  /** The apps that can take the screen. */
  takeovers(userId: Id): number {
    return [...(this.byUser.get(userId) ?? [])].filter((l) => l.takeover).length
  }

  /** How many apps it reached. */
  send(userId: Id, notification: DesktopNotification): number {
    const set = this.byUser.get(userId)
    for (const listener of set ?? []) listener.notify(notification)
    return set?.size ?? 0
  }

  /** Take the screen in the apps that can; the older ones get a notification. How many apps it reached. */
  takeover(userId: Id, takeover: DesktopTakeover, fallback: DesktopNotification): number {
    const set = this.byUser.get(userId)
    for (const listener of set ?? []) {
      if (listener.takeover) listener.takeover(takeover)
      else listener.notify(fallback)
    }
    return set?.size ?? 0
  }

  dismiss(userId: Id, id: string) {
    for (const listener of this.byUser.get(userId) ?? []) listener.dismiss?.(id)
  }
}
