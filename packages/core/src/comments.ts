// Comments on an object: a discussion apart from its text. Each is a prop of the object,
// `comment:<id>` = `{ kind: 'comment', value: Comment }`, without a property definition (as food
// entries are), so comments written on several devices and offline all arrive and merge one by
// one. Only a comment's author changes or deletes it: the server's store refuses other writes
// (Store.checkAuthorship). Members are mentioned as @username.
import type { Comment, Id, IsoDateTime, ObjectRecord, ObjectSummary, Person } from './model.ts'

export const COMMENT_PREFIX = 'comment:'

export const MAX_COMMENT_LENGTH = 20_000

export class CommentError extends Error {}

/** A write the server's store does not take (another member's comment); nothing of it is written. */
export class WriteRefused extends Error {}

export interface CommentEntry extends Comment {
  id: Id
}

/** An object's comments, oldest first. */
export function commentsOf(object: Pick<ObjectSummary, 'props'>): CommentEntry[] {
  const list: CommentEntry[] = []
  for (const [key, value] of Object.entries(object.props)) {
    if (key.startsWith(COMMENT_PREFIX) && value?.kind === 'comment') list.push({ id: key.slice(COMMENT_PREFIX.length), ...value.value })
  }
  return list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1))
}

function checkText(text: string): string {
  const trimmed = text.trim()
  if (!trimmed) throw new CommentError('a comment needs text')
  if (trimmed.length > MAX_COMMENT_LENGTH) throw new CommentError('the comment is too long')
  return trimmed
}

/** Add a comment by `author` to `object` (changed in place). Returns its id. */
export function addComment(object: Pick<ObjectRecord, 'props'>, author: Id, text: string, at: IsoDateTime, id: Id = crypto.randomUUID()): Id {
  object.props[`${COMMENT_PREFIX}${id}`] = { kind: 'comment', value: { author, at, text: checkText(text) } }
  return id
}

/** Change a comment's text (changed in place); only its author may. */
export function editComment(object: Pick<ObjectRecord, 'props'>, id: Id, author: Id, text: string, at: IsoDateTime) {
  const value = object.props[`${COMMENT_PREFIX}${id}`]
  if (value?.kind !== 'comment') throw new CommentError('no such comment')
  if (value.value.author !== author) throw new CommentError('only its author can change a comment')
  object.props[`${COMMENT_PREFIX}${id}`] = { kind: 'comment', value: { ...value.value, text: checkText(text), editedAt: at } }
}

/** Delete a comment (changed in place); only its author may. */
export function deleteComment(object: Pick<ObjectRecord, 'props'>, id: Id, author: Id) {
  const value = object.props[`${COMMENT_PREFIX}${id}`]
  if (value?.kind !== 'comment') throw new CommentError('no such comment')
  if (value.value.author !== author) throw new CommentError('only its author can delete a comment')
  delete object.props[`${COMMENT_PREFIX}${id}`]
}

/** The members a text mentions as @username (ignoring case). */
export function mentionedPeople(text: string, people: Person[]): Person[] {
  const names = new Set([...text.matchAll(/(?:^|[^\w@])@([\w.-]+)/g)].map((m) => m[1]!.toLowerCase().replace(/[.-]+$/, '')))
  return people.filter((p) => names.has(p.username.toLowerCase()))
}

/**
 * Who may write the comments changed between `before` and `after`: a new comment must be the
 * writer's own, and only an author changes or deletes theirs. The reason it is refused, if it is.
 */
export function commentAuthorshipProblem(before: Pick<ObjectRecord, 'props'> | undefined, after: Pick<ObjectRecord, 'props'>, writer: Id): string | undefined {
  const keys = new Set([...Object.keys(before?.props ?? {}), ...Object.keys(after.props)].filter((k) => k.startsWith(COMMENT_PREFIX)))
  for (const key of keys) {
    const old = before?.props[key]
    const next = after.props[key]
    if (JSON.stringify(old ?? null) === JSON.stringify(next ?? null)) continue
    if (old?.kind === 'comment' && old.value.author !== writer) return 'only its author can change or delete a comment'
    if (next && (next.kind !== 'comment' || next.value.author !== writer)) return 'a comment is written by whoever adds it'
    if (next?.kind === 'comment' && (typeof next.value.text !== 'string' || !next.value.text.trim() || next.value.text.length > MAX_COMMENT_LENGTH)) return 'a comment needs text'
  }
  return undefined
}
