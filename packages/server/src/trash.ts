// Deleted spaces, types and objects wait in the trash for TRASH_DAYS, then are purged for good
// (main.ts runs the purge at start and every few hours).
import type { IsoDateTime } from '@vasta/core'
import type { NodeStore } from '@vasta/core/node'

export const TRASH_DAYS = 30

/** Anything deleted at or before this moment has been in the trash long enough. */
export const trashCutoff = (now: IsoDateTime) => new Date(Date.parse(now) - TRASH_DAYS * 86_400_000).toISOString()

/** Purge the types and objects (of every space) that have been in the trash for TRASH_DAYS. */
export const purgeExpiredTrash = (store: NodeStore, now: IsoDateTime) => store.purgeTrash({ cutoff: trashCutoff(now) })
