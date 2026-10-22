// The people of the open space (its members): person properties, "assigned to me", and who made or
// last changed an object. Loaded from the server and kept in localStorage, so names still show
// offline; someone who left the space shows by the name last seen, else as "Former member".
import { computed, reactive, watch } from 'vue'
import type { ColorName, Id, Person } from '@vasta/core'
import { api } from './api.ts'
import { colorNames } from './colors.ts'
import { callStore, useReplica } from './replica.ts'
import { workspace } from './state.ts'

const KEY = 'vasta.people'

export const people = reactive({
  /** The user looking (set by session.ts). */
  me: '' as Id,
  /** Members of the open space, in the order they joined. */
  list: [] as Person[],
  /** Everyone seen in any space, for names of people who left. */
  known: {} as Record<Id, Person>,
})

/** The user looking. */
export const meId = (): Id | undefined => people.me || undefined

/** Whether the open space has someone besides the user (person fields and "Mine" only matter then). */
export const sharedSpace = computed(() => people.list.length > 1)

function readCache(): { spaces: Record<Id, Person[]>; known: Record<Id, Person> } {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return { spaces: {}, known: {} }
}

function writeCache(spaceId: Id, list: Person[]) {
  try {
    const cache = readCache()
    cache.spaces[spaceId] = list
    for (const person of list) cache.known[person.id] = person
    localStorage.setItem(KEY, JSON.stringify(cache))
  } catch {}
}

/** Load the open space's members (after it changes, or members were added or removed). */
export async function loadPeople() {
  const spaceId = workspace.space?.id
  if (!spaceId) return
  const cache = readCache()
  people.known = { ...cache.known, ...people.known }
  if (cache.spaces[spaceId]) people.list = cache.spaces[spaceId]
  try {
    const members = await api.members(spaceId)
    if (workspace.space?.id !== spaceId) return
    people.list = members.map((m) => ({ id: m.userId, username: m.username, name: m.name }))
    for (const person of people.list) people.known[person.id] = person
    writeCache(spaceId, people.list)
    // Lines typed offline (`assignee:ana`) are read by the replica, which has no list of members.
    if (useReplica()) void callStore('setPeople', spaceId, people.list).catch(() => {})
  } catch {}
}

watch(() => workspace.space?.id, loadPeople, { immediate: true })

export const personOf = (id: Id): Person | undefined => people.list.find((p) => p.id === id) ?? people.known[id]

export const personName = (id: Id): string => personOf(id)?.name ?? 'Former member'

/** One or two letters for an avatar: "Ana Lima" → "AL". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return ((words[0]?.[0] ?? '?') + (words.length > 1 ? (words[words.length - 1]![0] ?? '') : '')).toUpperCase()
}

/** A steady color per person, so the same person looks the same everywhere. */
export function personColor(id: Id): ColorName {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return colorNames[Math.abs(hash) % colorNames.length]!
}
