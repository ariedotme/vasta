// Nested tags: a tag may sit under another (#recipe/breakfast under #recipe, ObjectRecord.parentId),
// and filters on a tag take its sub-tags too (core's querySpace). Tags may have a color of their own.
// Making a tag from a path is tagFromPath in actions.ts.
import type { ColorName, Id, ObjectSummary, ObjectType } from '@vasta/core'
import { summaryOf } from './state.ts'

/** Tags without a color of their own. */
export const DEFAULT_TAG_COLOR: ColorName = 'violet'

/** The tags above one, root first (from the summary cache; a cycle stops). */
export function tagAncestors(object: Pick<ObjectSummary, 'id' | 'parentId'> | undefined): ObjectSummary[] {
  const chain: ObjectSummary[] = []
  const seen = new Set(object ? [object.id] : [])
  for (let id = object?.parentId; id && !seen.has(id); ) {
    seen.add(id)
    const parent = summaryOf(id)
    if (!parent) break
    chain.unshift(parent)
    id = parent.parentId
  }
  return chain
}

/** A tag's color: its own, else the nearest parent's that has one, else the default. */
export function tagColor(object: Pick<ObjectSummary, 'id' | 'parentId' | 'color'> | undefined): ColorName {
  return object?.color ?? tagAncestors(object).reverse().find((t) => t.color)?.color ?? DEFAULT_TAG_COLOR
}

/** The parent a tag takes its color from, when it has none of its own. */
export function colorSource(object: Pick<ObjectSummary, 'id' | 'parentId' | 'color'> | undefined): ObjectSummary | undefined {
  return object?.color ? undefined : tagAncestors(object).reverse().find((t) => t.color)
}

/** Every tag under one, at any depth. */
export function descendantsOf(id: Id, tags: ObjectSummary[]): ObjectSummary[] {
  const found: ObjectSummary[] = []
  const queue = [id]
  const seen = new Set(queue)
  while (queue.length) {
    const current = queue.shift()!
    for (const tag of tags) {
      if (tag.parentId !== current || seen.has(tag.id)) continue
      seen.add(tag.id)
      found.push(tag)
      queue.push(tag.id)
    }
  }
  return found
}

/**
 * The color an object's icon shows: a tag's (or a habit's) own color, else its type's. Lists,
 * pickers and ⌘K go through it, so tags look the same everywhere.
 */
export function objectColor(object: Pick<ObjectSummary, 'id' | 'parentId' | 'color'> | undefined, type: ObjectType | undefined): ColorName | undefined {
  if (type?.system === 'tag') return tagColor(object)
  return object?.color ?? type?.color
}
