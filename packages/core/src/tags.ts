// Tags by path: a tag may sit under another (#recipe/breakfast under #recipe, ObjectRecord.parentId),
// so "recipe/breakfast" names a tag level by level. The web app and the agent tools both resolve
// paths with these.
import type { ColorName, Id } from './model.ts'

/** Every color of the app's palette (ColorName), in the pickers' order. */
export const COLOR_NAMES = ['gray', 'red', 'orange', 'amber', 'yellow', 'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'fuchsia', 'pink', 'rose'] as const satisfies readonly ColorName[]

export const isColorName = (value: string): value is ColorName => (COLOR_NAMES as readonly string[]).includes(value)

/** "#recipe / breakfast" → ["recipe", "breakfast"]. */
export function tagPathParts(path: string): string[] {
  return path
    .split('/')
    .map((part) => part.trim().replace(/^#/, '').trim())
    .filter(Boolean)
}

/** The tag right under `parentId` (at the top when undefined) titled `title`, ignoring case. */
export function childTag<T extends { title: string; parentId?: Id | null | undefined }>(tags: readonly T[], parentId: Id | undefined, title: string): T | undefined {
  const wanted = title.trim().toLowerCase()
  return tags.find((t) => (t.parentId ?? undefined) === parentId && t.title.trim().toLowerCase() === wanted)
}

/** A tag's path ("recipe/breakfast"), from the tags above it (a cycle stops). */
export function tagPath(id: Id, tagOf: (id: Id) => { title: string; parentId?: Id | null | undefined } | undefined): string {
  const parts: string[] = []
  const seen = new Set<Id>()
  for (let at: Id | null | undefined = id; at && !seen.has(at); ) {
    seen.add(at)
    const tag = tagOf(at)
    if (!tag) break
    parts.unshift(tag.title)
    at = tag.parentId
  }
  return parts.join('/')
}
