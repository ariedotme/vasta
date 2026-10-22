import type { InjectionKey } from 'vue'
import type { Id } from '@vasta/core'

/** Id of the object whose page is open; queries embedded in its documents use it as `parent`. */
export const PAGE_OBJECT_ID: InjectionKey<Id> = Symbol('page-object-id')

/** How deep in embedded blocks a document is: inside one, another is only a link (no endless nesting). */
export const BLOCK_EMBED_DEPTH: InjectionKey<number> = Symbol('block-embed-depth')
