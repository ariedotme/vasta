// Who a write is made for: the user of the request (or Telegram message) being handled. The store
// reads it (Store.actor) to record who made and last changed an object; the server's own jobs
// (purges, calendar syncs, reminders) run outside any user and record nobody.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Id } from '@vasta/core'

const actors = new AsyncLocalStorage<Id>()

/** Run `fn` (and everything it starts) as `userId`. */
export const runAs = <T>(userId: Id, fn: () => T): T => actors.run(userId, fn)

/** The user the current write is made for, if any. */
export const currentActor = (): Id | undefined => actors.getStore()
