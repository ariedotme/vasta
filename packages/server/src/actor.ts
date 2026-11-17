// Who a write is made for: the user of the request (or Telegram message) being handled, and the
// agent it came through (an MCP token's name) when it was one. The store reads them (Store.actor,
// Store.via) to record who made and last changed an object; the server's own jobs (purges,
// calendar syncs, reminders) run outside any user and record nobody.
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Id } from '@vasta/core'

const actors = new AsyncLocalStorage<{ userId: Id; via?: string }>()

/** Run `fn` (and everything it starts) as `userId`, through the agent `via` if given. */
export const runAs = <T>(userId: Id, fn: () => T, via?: string): T => actors.run(via ? { userId, via } : { userId }, fn)

/** Run `fn` as nobody: its writes keep the authors they carry and record no activity (imports). */
export const outsideActor = <T>(fn: () => T): T => actors.exit(fn)

/** The user the current write is made for, if any. */
export const currentActor = (): Id | undefined => actors.getStore()?.userId

/** The agent the current write comes through, if any. */
export const currentVia = (): string | undefined => actors.getStore()?.via
