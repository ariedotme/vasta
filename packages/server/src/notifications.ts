// Notifications about others' work: someone assigned you (a person field now names you), mentioned
// you in a comment (@username), or commented on something you follow (you made it, a person field
// names you, or you commented on it). Worked out where a user's write is applied (Store.onObjectWrite,
// so the app, sync pushes, captures and agents alike), kept in the `notifications` table for the
// app's bell, and sent through the user's reminder channels (ntfy, Telegram, desktop) when their
// Settings › Reminders ask for that kind. Kept 30 days.
import { commentsOf, mentionedPeople, type Id, type IsoDateTime, type ObjectRecord, type Person, type PropertyValue } from '@vasta/core'
import type { NodeStore } from '@vasta/core/node'
import type { ReminderService } from './reminders.ts'

type Row = Record<string, unknown>

export type NotificationKind = 'assigned' | 'mentioned' | 'comment'

export interface Notification {
  id: number
  spaceId: Id
  objectId: Id
  /** The object's title now (absent once it is gone). */
  title?: string
  at: IsoDateTime
  actor?: Id
  kind: NotificationKind
  text?: string
  read: boolean
}

/** A notification about to be kept: for whom, about what. */
export interface NotificationDraft {
  userId: Id
  kind: NotificationKind
  /** The comment, for mentions and comments. */
  ref?: Id
  text?: string
}

export const NOTIFICATION_DAYS = 30
/** The same person assigned again soon after (a field set, cleared and set) is told once. */
const REPEAT_MS = 10 * 60_000

const peopleIn = (props: Record<Id, PropertyValue>) => new Set(Object.values(props).flatMap((v) => (v?.kind === 'person' ? v.value : [])))

/** Who follows an object: who made it, whom its person fields name, who commented on it. */
export function followersOf(object: ObjectRecord): Set<Id> {
  const followers = peopleIn(object.props)
  if (object.createdBy) followers.add(object.createdBy)
  for (const comment of commentsOf(object)) followers.add(comment.author)
  return followers
}

/** What `actor` writing `after` over `before` tells the space's other members. */
export function notificationsFor(before: ObjectRecord | undefined, after: ObjectRecord, actor: Id, people: Person[]): NotificationDraft[] {
  if (after.deletedAt) return []
  const members = new Set(people.map((p) => p.id))
  const drafts: NotificationDraft[] = []
  const told = new Set<string>()
  const tell = (draft: NotificationDraft) => {
    const key = `${draft.userId}|${draft.kind}|${draft.ref ?? ''}`
    if (draft.userId === actor || !members.has(draft.userId) || told.has(key)) return
    told.add(key)
    drafts.push(draft)
  }

  // Assigned: named by a person field that did not name them before.
  const earlier = before ? peopleIn(before.props) : new Set<Id>()
  for (const id of peopleIn(after.props)) if (!earlier.has(id)) tell({ userId: id, kind: 'assigned' })

  // Comments new or edited by the actor: who they mention, and who follows the object.
  const old = new Map((before ? commentsOf(before) : []).map((c) => [c.id, c]))
  const followers = followersOf(before ?? after)
  for (const comment of commentsOf(after)) {
    if (comment.author !== actor) continue
    const previous = old.get(comment.id)
    if (previous && previous.text === comment.text) continue
    const mentionedBefore = new Set(previous ? mentionedPeople(previous.text, people).map((p) => p.id) : [])
    const mentioned = mentionedPeople(comment.text, people).map((p) => p.id)
    for (const id of mentioned) if (!mentionedBefore.has(id)) tell({ userId: id, kind: 'mentioned', ref: comment.id, text: comment.text })
    if (previous) continue
    for (const id of followers) if (!mentioned.includes(id)) tell({ userId: id, kind: 'comment', ref: comment.id, text: comment.text })
  }
  return drafts
}

const rowToNotification = (row: Row): Notification => ({
  id: Number(row.id),
  spaceId: row.space_id as string,
  objectId: row.object_id as string,
  ...(row.title != null ? { title: row.title as string } : {}),
  at: row.at as string,
  ...(row.actor ? { actor: row.actor as string } : {}),
  kind: row.kind as NotificationKind,
  ...(row.text != null ? { text: row.text as string } : {}),
  read: row.read_at != null,
})

export interface NotificationOptions {
  store: NodeStore
  reminders?: ReminderService
  now?: () => IsoDateTime
}

export class NotificationService {
  private readonly options: NotificationOptions

  constructor(options: NotificationOptions) {
    this.options = options
    options.store.onObjectWrite = (before, after, actor) => this.written(before, after, actor)
  }

  private get store() {
    return this.options.store
  }

  private now() {
    return this.options.now?.() ?? new Date().toISOString()
  }

  /** Inside the write's transaction: keep the notifications, and send them once it is done. */
  private written(before: ObjectRecord | undefined, after: ObjectRecord, actor: Id) {
    const drafts = notificationsFor(before, after, actor, this.store.people(after.spaceId))
    if (!drafts.length) return
    const at = this.now()
    const kept: number[] = []
    for (const draft of drafts) {
      if (draft.kind === 'assigned') {
        const recent = this.store.db
          .prepare("SELECT 1 FROM notifications WHERE user_id = ? AND object_id = ? AND kind = 'assigned' AND at > ?")
          .get(draft.userId, after.id, new Date(Date.parse(at) - REPEAT_MS).toISOString())
        if (recent) continue
      }
      const row = this.store.db
        .prepare('INSERT INTO notifications (user_id, space_id, object_id, at, actor, kind, ref, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
        .get(draft.userId, after.spaceId, after.id, at, actor, draft.kind, draft.ref ?? null, draft.text ?? null) as Row
      kept.push(Number(row.id))
    }
    if (kept.length) setTimeout(() => void this.send(kept).catch((error) => console.error('Notifications:', error)), 0)
  }

  /** Send kept notifications through their users' channels (those still there: a write rolled back takes them along). */
  private async send(ids: number[]) {
    const reminders = this.options.reminders
    if (!reminders) return
    for (const id of ids) {
      const row = this.store.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as Row | undefined
      if (!row) continue
      const notification = rowToNotification(row)
      const actor = notification.actor ? (this.store.getUser(notification.actor)?.name ?? 'Someone') : 'Someone'
      const title = this.store.getObject(notification.objectId)?.title || 'Untitled'
      const heading =
        notification.kind === 'assigned' ? `${actor} assigned you “${title}”` : notification.kind === 'mentioned' ? `${actor} mentioned you in “${title}”` : `${actor} commented on “${title}”`
      await reminders.notify(row.user_id as string, notification.kind, {
        key: `notification:${id}`,
        title: heading,
        message: notification.text ? notification.text.slice(0, 300) : `In ${this.store.getSpace(notification.spaceId)?.name ?? 'Vasta'}`,
        tag: notification.kind === 'assigned' ? 'bust_in_silhouette' : 'speech_balloon',
        icon: notification.kind === 'assigned' ? '👤' : '💬',
        objectId: notification.objectId,
      })
    }
  }

  /** A user's notifications, newest first, in the spaces they are still a member of. */
  list(userId: Id, limit = 50): Notification[] {
    const rows = this.store.db
      .prepare(
        `SELECT n.*, o.title FROM notifications n LEFT JOIN objects o ON o.id = n.object_id
         WHERE n.user_id = ? AND n.space_id IN (SELECT space_id FROM space_members WHERE user_id = ?)
         ORDER BY n.at DESC, n.id DESC LIMIT ?`
      )
      .all(userId, userId, limit) as Row[]
    return rows.map(rowToNotification)
  }

  unread(userId: Id): number {
    return Number(
      (
        this.store.db
          .prepare('SELECT count(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL AND space_id IN (SELECT space_id FROM space_members WHERE user_id = ?)')
          .get(userId, userId) as { n: number }
      ).n
    )
  }

  /** Mark some (or all, without ids) as read. */
  markRead(userId: Id, ids?: number[]) {
    const at = this.now()
    if (!ids) this.store.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(at, userId)
    else for (const id of ids) this.store.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL').run(at, userId, id)
  }

}

/** Delete notifications older than NOTIFICATION_DAYS. */
export function purgeNotifications(store: NodeStore, now: IsoDateTime) {
  store.db.prepare('DELETE FROM notifications WHERE at < ?').run(new Date(Date.parse(now) - NOTIFICATION_DAYS * 86_400_000).toISOString())
}
