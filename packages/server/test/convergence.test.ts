// A randomized convergence test of sync (docs/sync.md, "Testing"). The
// real server app, two or three devices with a replica (ClientStore on sqlite-wasm, editors on its
// Y.Docs) and a browser tab without one (whole-object PUT with `base`) take a seeded random
// sequence of steps: going offline and back, editing text and fields, trashing and restoring, the
// server capturing, an agent updating objects, quotes made and deleted, syncs, an app closed
// halfway through a sync, food logged on a day's note and deleted. At the end everyone syncs until quiet; then every replica, open editor
// and page must equal the server, nothing may wait in an outbox or be refused, and every field
// must hold the newest value a user (or the agent) gave it.
//
// `pnpm test` runs a few fixed seeds. More: `VASTA_SEEDS=500 pnpm vitest run convergence` (seeds
// 1–500), `VASTA_SEED=1234` for one (with `VASTA_LOG=1` to print its steps), `VASTA_STEPS` for
// longer runs. Everything random comes from the seed, so a failure replays exactly.
import { seedRandom, seeded } from './seeded-random.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BODY_PROPERTY_ID,
  afterSave,
  applyFields,
  builtinTypeId,
  canonicalJson,
  createBuiltinTypes,
  foodEntryKey,
  newType,
  portionsValue,
  recordFields,
  setNutritionEnabled,
  type Doc,
  type FieldClock,
  type Id,
  type ObjectRecord,
} from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { BLOCK_TYPES, vastaSchema } from '@vasta/editor-schema'
import { readContent, writeContent, type JsonDoc, type JsonNode, type Y } from '@vasta/editor-schema/yjs'
import { AccountService } from '../src/accounts.ts'
import { AgentError, AgentTools } from '../src/agent.ts'
import { createApp } from '../src/app.ts'
import { CaptureService } from '../src/capture.ts'
import { ChangeFeed } from '../src/events.ts'
import { Device, asUser, now, paragraphs, type Request } from './helpers.ts'

const STEPS = Number(process.env.VASTA_STEPS ?? 150)
const SEEDS = process.env.VASTA_SEED
  ? [Number(process.env.VASTA_SEED)]
  : Array.from({ length: Number(process.env.VASTA_SEEDS ?? 6) }, (_, i) => i + 1)
const START = Date.parse('2026-10-20T10:00:00.000Z')
const json = (body: unknown, method = 'POST') => ({ method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const clone = <T>(value: T): T => structuredClone(value)

/** Seeded choices for the steps. */
function random(seed: number) {
  const next = seeded(seed)
  const int = (n: number) => Math.floor(next() * n)
  return { int, chance: (p: number) => next() < p, pick: <T>(list: readonly T[]): T => list[int(list.length)]! }
}
type Random = ReturnType<typeof random>

// ---------------------------------------------------------------------------
// Editing a document's JSON as an editor would: each edit is turned into Yjs by the same diff
// y-prosemirror runs on every transaction (writeContent), or saved whole without a replica.

type Mark = { type: string; attrs?: Record<string, unknown> }
type Char = { ch: string; marks: Mark[] }

const MARK_ORDER = Object.keys(vastaSchema().marks)
const isTextblock = (node: JsonNode) => (node.type === 'paragraph' || node.type === 'heading') && (node.content ?? []).every((n) => n.type === 'text')
const charsOf = (node: JsonNode): Char[] => (node.content ?? []).flatMap((n) => [...n.text!].map((ch) => ({ ch, marks: (n.marks ?? []) as Mark[] })))

function setChars(node: JsonNode, chars: Char[]) {
  const content: JsonNode[] = []
  for (const { ch, marks } of chars) {
    const last = content.at(-1)
    if (last && canonicalJson(last.marks ?? []) === canonicalJson(marks)) last.text += ch
    else content.push({ type: 'text', text: ch, ...(marks.length ? { marks } : {}) })
  }
  if (content.length) node.content = content
  else delete node.content
}

const withMark = (marks: Mark[], mark: Mark) => [...marks.filter((m) => m.type !== mark.type), mark].sort((a, b) => MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type))
const charsFrom = (text: string, marks: Mark[] = []): Char[] => [...text].map((ch) => ({ ch, marks }))
const blockId = (r: Random) => Array.from({ length: 8 }, () => r.pick([...'abcdefghijklmnopqrstuvwxyz0123456789'])).join('')

/** One random edit of a document (changed in place); returns what it did. */
function editDoc(r: Random, doc: JsonDoc, word: string, quoteIds: Id[]): string {
  const blocks = doc.content
  const textblocks = blocks.filter(isTextblock)
  const range = (node: JsonNode) => {
    const length = charsOf(node).length
    const from = r.int(length)
    return [from, from + 1 + r.int(Math.min(length - from, 8))] as const
  }
  const op = r.pick(['insert', 'insert', 'insert', 'delete', 'replace', 'mark', 'highlight', 'split', 'join', 'move', 'color', 'id', 'paragraph', 'remove', 'heading'] as const)
  const block = r.pick(textblocks.length ? textblocks : [undefined])
  const filled = textblocks.filter((n) => charsOf(n).length)
  const target = filled.length ? r.pick(filled) : undefined
  switch (op) {
    case 'insert': {
      if (!block) break
      const chars = charsOf(block)
      const at = r.int(chars.length + 1)
      chars.splice(at, 0, ...charsFrom(` ${word}`, chars[at - 1]?.marks ?? []))
      setChars(block, chars)
      return `insert "${word}" at ${at}`
    }
    case 'delete':
    case 'replace': {
      if (!target) break
      const [from, to] = range(target)
      const chars = charsOf(target)
      chars.splice(from, to - from, ...(op === 'replace' ? charsFrom(word, chars[from]?.marks ?? []) : []))
      setChars(target, chars)
      return `${op} ${from}–${to}`
    }
    case 'mark':
    case 'highlight': {
      if (!target || (op === 'highlight' && !quoteIds.length)) break
      const [from, to] = range(target)
      const mark: Mark = op === 'mark' ? { type: r.pick(['bold', 'italic']) } : { type: 'highlight', attrs: { color: 'yellow', quoteId: r.pick(quoteIds) } }
      const chars = charsOf(target)
      const all = chars.slice(from, to).every((c) => c.marks.some((m) => canonicalJson(m) === canonicalJson(mark)))
      for (const c of chars.slice(from, to)) c.marks = all ? c.marks.filter((m) => m.type !== mark.type) : withMark(c.marks, mark)
      setChars(target, chars)
      return `${all ? 'unmark' : 'mark'} ${mark.type} ${from}–${to}`
    }
    case 'split': {
      if (!block) break
      const chars = charsOf(block)
      const at = r.int(chars.length + 1)
      const { id: _id, ...attrs } = block.attrs ?? {}
      const second: JsonNode = { type: 'paragraph', ...(Object.keys(attrs).length && block.type === 'paragraph' ? { attrs } : {}) }
      setChars(second, chars.slice(at))
      setChars(block, chars.slice(0, at))
      blocks.splice(blocks.indexOf(block) + 1, 0, second)
      return `split at ${at}`
    }
    case 'join': {
      const at = blocks.findIndex((n, i) => isTextblock(n) && blocks[i + 1] && isTextblock(blocks[i + 1]!))
      if (at < 0) break
      setChars(blocks[at]!, [...charsOf(blocks[at]!), ...charsOf(blocks[at + 1]!)])
      blocks.splice(at + 1, 1)
      return `join ${at}`
    }
    case 'move': {
      if (blocks.length < 2) break
      const at = r.int(blocks.length - 1)
      ;[blocks[at], blocks[at + 1]] = [blocks[at + 1]!, blocks[at]!]
      return `move ${at} down`
    }
    case 'color': {
      if (!block) break
      const name = r.pick(['textColor', 'background'])
      const value = r.pick(['red', 'blue', null])
      block.attrs = { ...block.attrs, [name]: value }
      return `${name} ${value}`
    }
    case 'id': {
      if (!blocks.length) break
      const node = r.pick(blocks)
      node.attrs = { ...node.attrs, id: blockId(r) }
      return 'new block id'
    }
    case 'paragraph': {
      const at = r.int(blocks.length + 1)
      blocks.splice(at, 0, { type: 'paragraph', content: [{ type: 'text', text: word }] })
      return `paragraph "${word}" at ${at}`
    }
    case 'remove': {
      if (blocks.length < 2) break
      const at = r.int(blocks.length)
      blocks.splice(at, 1)
      return `remove block ${at}`
    }
    case 'heading': {
      if (!block) break
      if (block.type === 'heading') {
        block.type = 'paragraph'
        if (block.attrs) delete block.attrs.level
      } else {
        block.type = 'heading'
        block.attrs = { ...block.attrs, level: 2 }
      }
      return `to ${block.type}`
    }
  }
  blocks.push({ type: 'paragraph', content: [{ type: 'text', text: word }] })
  return `append "${word}"`
}

/** Give every block an id, and a new one to repeated ids, as the editor's blockIdFixes plugin does. */
function fixBlockIds(doc: JsonDoc, r: Random) {
  const seen = new Set<string>()
  const walk = (node: JsonNode) => {
    if (BLOCK_TYPES.includes(node.type)) {
      const id = node.attrs?.id
      if (typeof id !== 'string' || seen.has(id)) node.attrs = { ...node.attrs, id: blockId(r) }
      seen.add(node.attrs!.id as string)
    }
    node.content?.forEach(walk)
  }
  doc.content.forEach(walk)
}

// ---------------------------------------------------------------------------
// The object page (packages/web/src/views/ObjectPage.vue): a copy of the object being edited,
// `base` (the copy last loaded or saved), saved with only what changed since `base`.

interface PageApi {
  get(id: Id): Promise<ObjectRecord>
  save(object: ObjectRecord, base: ObjectRecord): Promise<ObjectRecord>
  /** The clock of the object's fields where the save is stamped (the device's, or the server's). */
  clock(id: Id): FieldClock
}

/** Every value a user gave a field, with the HLC it was stamped with. */
class Intents {
  readonly fields = new Map<string, { hlc: string; value: unknown }[]>()

  /** Note the fields of `id` whose HLC moved from `before` to `after`, with the values they were given. */
  note(id: Id, names: Iterable<string>, before: FieldClock, after: FieldClock, values: Record<string, unknown>) {
    for (const name of names) {
      const hlc = after[name]
      if (!hlc || hlc === before[name]) continue
      const key = `${id} ${name}`
      this.fields.set(key, [...(this.fields.get(key) ?? []), { hlc, value: values[name] ?? null }])
    }
  }
}

class Page {
  object!: ObjectRecord
  base!: ObjectRecord
  unsaved = false
  /** Fields the user changed since the last save. */
  edited = new Set<string>()
  readonly api: PageApi
  readonly id: Id

  constructor(api: PageApi, id: Id) {
    this.api = api
    this.id = id
  }

  async open() {
    this.object = await this.api.get(this.id)
    this.base = clone(this.object)
  }

  change(field: string, value: unknown) {
    this.object = applyFields('objects', this.object, { [field]: value })
    this.edited.add(field)
    this.unsaved = true
  }

  editText(fn: (doc: JsonDoc) => void) {
    const doc = clone((this.object.content[BODY_PROPERTY_ID] as JsonDoc | undefined) ?? ({ type: 'doc', content: [] } as JsonDoc))
    fn(doc)
    this.object = { ...this.object, content: { ...this.object.content, [BODY_PROPERTY_ID]: doc as Doc } }
    this.unsaved = true
  }

  async save(intents: Intents) {
    if (!this.unsaved) return
    const before = this.api.clock(this.id)
    const sent = clone(this.object)
    const saved = await this.api.save(this.object, this.base)
    this.base = clone(saved)
    this.object = afterSave(this.object, sent, saved)
    this.unsaved = false
    intents.note(this.id, this.edited, before, this.api.clock(this.id), recordFields('objects', sent))
    this.edited.clear()
  }

  /** A change to the object arrived (its updatedAt): reload unless there are unsaved edits. */
  async reload(updatedAt?: string) {
    if (this.unsaved || (updatedAt && updatedAt < this.object.updatedAt)) return
    const fresh = await this.api.get(this.id)
    this.base = clone(fresh)
    this.object = fresh
  }
}

// ---------------------------------------------------------------------------

/** A step that cannot happen now (offline, or the object is not there yet). */
class Skip extends Error {}

interface Replica {
  kind: 'replica'
  name: string
  device: Device
  page?: Page
  editor?: ReturnType<Device['edit']> & { id: Id }
  syncing?: Promise<void>
}

interface Tab {
  kind: 'tab'
  name: string
  online: boolean
  request: Request
  page?: Page
}

type Actor = Replica | Tab
/** An actor and the object its page shows, for the log. */
const who = (actor: Actor) => (actor.page ? `${actor.name}@${actor.page.id.slice(0, 8)}` : actor.name)
const isOnline = (actor: Actor) => (actor.kind === 'tab' ? actor.online : actor.device.online)

async function run(seed: number) {
  const r = random(seed)
  // Everything else random (Yjs client ids, UUIDs, HLC nodes) from another stream of the same seed.
  seedRandom(seed * 7919 + 1)
  let time = START
  vi.setSystemTime(time)

  const store = new NodeStore(':memory:')
  store.putSpace({ id: 's', name: 's', sidebar: [], createdAt: now() })
  for (const type of createBuiltinTypes('s', now())) store.putType(type)
  const book = {
    ...newType('s', { name: 'Book' }, 'book', now()),
    properties: [
      { id: BODY_PROPERTY_ID, kind: 'rich-text' as const, name: 'Notes' },
      { id: 'author', kind: 'text' as const, name: 'Author' },
      { id: 'rating', kind: 'number' as const, name: 'Rating' },
    ],
  }
  store.putType(book)
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-convergence-')))
  const feed = new ChangeFeed()
  const capture = new CaptureService({ store, media, feed, now, timeZone: 'UTC' })
  const app = createApp({ store, media, feed, capture })
  const user = asUser(app, store, { spaces: ['s'] })
  const agent = new AgentTools({ store, accounts: new AccountService({ store, now, capture }), feed, now, user: user.user, webUrl: 'https://vasta.test' })
  const page = builtinTypeId('s', 'page')

  const pool: Id[] = []
  const quotes: { id: Id; sourceId: Id }[] = []
  const intents = new Intents()
  const refused: unknown[] = []
  const log: string[] = []
  let words = 0
  const word = () => `w${++words}`
  const today = () => new Date(time).toISOString().slice(0, 10)

  for (const [typeId, title, ...lines] of [
    [page, 'Plan', 'Buy flour and water', 'Call the bank'],
    [page, 'Journal', 'A quiet morning', 'Rain later'],
    [book.id, 'Dune', 'The spice must flow'],
    [book.id, 'Emma', 'Handsome, clever and rich'],
  ]) {
    const response = await user.request('/api/objects', json({ typeId, title, content: { body: paragraphs(...lines) } }))
    pool.push(((await response.json()) as ObjectRecord).id)
  }
  setNutritionEnabled(store, 's', true, now())
  const bread = (await (
    await user.request('/api/objects', json({ typeId: builtinTypeId('s', 'food'), title: 'Bread', props: { kcal: { kind: 'number', value: 250 }, portions: portionsValue([{ name: 'slice', grams: 30 }]) } }))
  ).json()) as ObjectRecord
  /** Food logged: the note and entry, and whether it was deleted since. */
  const eaten: { noteId: Id; entryId: Id; deleted: boolean }[] = []

  const actors: Actor[] = []
  for (let i = 0; i < 2 + r.int(2); i++) actors.push({ kind: 'replica', name: `device${i + 1}`, device: new Device(`device${i + 1}`, user.request) })
  const tab: Tab = {
    kind: 'tab',
    name: 'tab',
    online: true,
    request: (input, init) => {
      if (!tab.online) throw new Skip('offline')
      return user.request(input, init)
    },
  }
  actors.push(tab)
  const replicas = actors.filter((a): a is Replica => a.kind === 'replica')
  for (const replica of replicas) await replica.device.sync.sync()

  const serverClock = (id: Id) => store.syncRow('objects', id)?.clock ?? {}
  const tabApi: PageApi = {
    async get(id) {
      const response = await tab.request(`/api/objects/${id}`)
      if (response.status === 404) throw new Skip('not on the server yet')
      if (response.status !== 200) throw new Error(`GET ${id}: ${response.status}`)
      return (await response.json()) as ObjectRecord
    },
    async save(object, base) {
      const response = await tab.request(`/api/objects/${object.id}`, json({ ...object, base }, 'PUT'))
      if (response.status !== 200) throw new Error(`PUT ${object.id}: ${response.status}`)
      return (await response.json()) as ObjectRecord
    },
    clock: serverClock,
  }
  const replicaApi = (device: Device): PageApi => ({
    get: async (id) => device.store.requireObject(id),
    save: async (object, base) => device.store.saveObject(object, now(), base),
    clock: (id) => device.store.syncRow('objects', id)?.clock ?? {},
  })

  const sync = (replica: Replica) =>
    replica.device.sync.sync().then(
      (result) => void refused.push(...result.refused),
      (error) => {
        if (!(error instanceof TypeError && error.message === 'Failed to fetch')) throw error
      }
    )

  async function open(actor: Actor, id: Id) {
    if (actor.kind === 'tab') {
      if (actor.page) await actor.page.save(intents)
      const next = new Page(tabApi, id)
      await next.open()
      actor.page = next
      return
    }
    if (!actor.device.store.getObject(id)) throw new Skip('not on this device yet')
    if (actor.page) await actor.page.save(intents)
    actor.editor?.close()
    actor.page = new Page(replicaApi(actor.device), id)
    await actor.page.open()
    actor.editor = Object.assign(actor.device.edit(id), { id })
  }

  const quotesOf = (id: Id) => quotes.filter((q) => q.sourceId === id).map((q) => q.id)

  async function textEdit(actor: Actor) {
    const id = actor.page!.id
    const w = word()
    if (actor.kind === 'tab') {
      let done = ''
      actor.page!.editText((doc) => {
        done = editDoc(r, doc, w, quotesOf(id))
        fixBlockIds(doc, r)
      })
      return done
    }
    const editor = actor.editor!
    const doc = clone(readContent(editor.doc)[BODY_PROPERTY_ID] ?? ({ type: 'doc', content: [] } as JsonDoc))
    const done = editDoc(r, doc, w, quotesOf(id))
    fixBlockIds(doc, r)
    writeContent(editor.doc, { [BODY_PROPERTY_ID]: doc }, undefined, [BODY_PROPERTY_ID])
    return done
  }

  function fieldEdit(actor: Actor) {
    const target = actor.page!
    const n = ++words
    const choices: [string, unknown][] = [
      ['title', `T${n}`],
      ['description', r.chance(0.7) ? `D${n}` : null],
      ['icon', r.chance(0.8) ? { kind: 'emoji', value: r.pick(['📱', '💻', '📚', '🌧️']) } : null],
      ['tagIds', r.chance(0.8) ? [`tag${n}`] : []],
    ]
    if (target.object.typeId !== builtinTypeId('s', 'daily-note')) choices.push(['date', r.chance(0.8) ? { start: `2026-11-${10 + r.int(18)}T00:00:00.000Z`, resolution: 'day' } : null])
    if (target.object.typeId === book.id) choices.push(['props.author', r.chance(0.8) ? { kind: 'text', value: `A${n}` } : null], ['props.rating', { kind: 'number', value: n }])
    const [field, value] = r.pick(choices)
    target.change(field, value)
    return `${field} = ${JSON.stringify(value)}`
  }

  async function trashOrRestore(actor: Actor) {
    const id = actor.page!.id
    const deleted = !!actor.page!.object.deletedAt
    if (actor.kind === 'tab') {
      await actor.page!.save(intents)
      const before = serverClock(id)
      const response = deleted ? await tab.request(`/api/objects/${id}/restore`, { method: 'POST' }) : await tab.request(`/api/objects/${id}`, { method: 'DELETE' })
      if (response.ok) intents.note(id, ['deletedAt'], before, serverClock(id), recordFields('objects', store.getObject(id)!))
    } else {
      const local = actor.device.store
      await actor.page!.save(intents)
      const before = replicaApi(actor.device).clock(id)
      if (deleted && local.getObject(id)?.deletedAt) local.untrashObject(id, now())
      else if (!deleted) local.trashObject(id, now())
      intents.note(id, ['deletedAt'], before, replicaApi(actor.device).clock(id), recordFields('objects', local.getObject(id)!))
    }
    await actor.page!.reload()
    return deleted ? 'restore' : 'trash'
  }

  /** A word of the server's copy of an object, to quote. */
  function passage(id: Id): string | undefined {
    const text = (store.getObject(id)?.content[BODY_PROPERTY_ID]?.content ?? []).flatMap((n) => (n.content ?? []).map((c) => c.text ?? '')).join(' ')
    const found = text.split(/\s+/).filter(Boolean)
    return found.length ? r.pick(found) : undefined
  }

  const steps: [number, () => Promise<string | undefined>][] = [
    [6, async () => {
      const actor = r.pick(actors)
      if (actor.kind === 'tab') actor.online = !actor.online
      else actor.device.online = !actor.device.online
      return `${actor.name} ${isOnline(actor) ? 'online' : 'offline'}`
    }],
    [8, async () => {
      const actor = r.pick(actors)
      const id = r.pick(pool)
      await open(actor, id)
      return `${who(actor)} opens (${store.getObject(id)?.title ?? 'not on the server'})`
    }],
    [30, async () => {
      const actor = r.pick(actors)
      if (!actor.page) return undefined
      return `${who(actor)} text: ${await textEdit(actor)}`
    }],
    [12, async () => {
      const actor = r.pick(actors)
      if (!actor.page) return undefined
      return `${who(actor)} field: ${fieldEdit(actor)}`
    }],
    [10, async () => {
      const actor = r.pick(actors)
      if (!actor.page?.unsaved) return undefined
      await actor.page.save(intents)
      return `${who(actor)} saves`
    }],
    [5, async () => {
      const actor = r.pick(actors)
      if (!actor.page) return undefined
      const stored = actor.kind === 'tab' ? store.getObject(actor.page.id) : actor.device.store.getObject(actor.page.id)
      if (!stored) return undefined
      await actor.page.reload(stored.updatedAt)
      return `${who(actor)} hears of a change`
    }],
    [3, async () => {
      const actor = r.pick(actors)
      if (!actor.page) return undefined
      return `${who(actor)} ${await trashOrRestore(actor)}`
    }],
    [2, async () => {
      const replica = r.pick(replicas)
      const n = ++words
      const made = replica.device.store.createObject({ typeId: r.pick([page, book.id]), title: `N${n}`, content: { body: paragraphs(`n${n}`) as Doc } }, now())
      pool.push(made.id)
      return `${replica.name} creates ${made.title} ${made.id.slice(0, 8)}`
    }],
    [3, async () => {
      const replica = r.pick(replicas)
      const text = `dc${++words}`
      const result = replica.device.store.capture('s', text, 'desktop', today(), now())
      if (!pool.includes(result.dailyNoteId)) pool.push(result.dailyNoteId)
      return `${replica.name} captures "${text}"`
    }],
    [2, async () => {
      const replica = r.pick(replicas)
      await replica.page?.save(intents)
      replica.editor?.close()
      replica.page = replica.editor = undefined
      replica.device.restart()
      return `${replica.name} restarts`
    }],
    [15, async () => {
      const replica = r.pick(replicas)
      await replica.syncing
      replica.syncing = sync(replica)
      if (r.chance(0.6)) await replica.syncing
      return `${replica.name} syncs`
    }],
    [4, async () => {
      const text = `sc${++words}`
      const response = await user.request('/api/spaces/s/captures', json({ text, channel: 'desktop' }))
      expect(response.status).toBe(201)
      const { dailyNoteId } = (await response.json()) as { dailyNoteId: Id }
      if (!pool.includes(dailyNoteId)) pool.push(dailyNoteId)
      return `server captures "${text}"`
    }],
    [5, async () => {
      const id = r.pick(pool)
      const object = store.getObject(id)
      if (!object || object.deletedAt) return undefined
      const n = ++words
      const input = r.pick([
        { id, title: `M${n}` },
        { id, markdown: `m${n}`, mode: r.pick(['append', 'prepend', 'replace'] as const) },
        ...(object.typeId === book.id ? [{ id, properties: { Author: `MA${n}`, Rating: n } }] : []),
      ])
      const before = serverClock(id)
      try {
        agent.updateObject(input)
      } catch (error) {
        if (error instanceof AgentError) return undefined
        throw error
      }
      intents.note(id, ['title', 'props.author', 'props.rating'], before, serverClock(id), recordFields('objects', store.getObject(id)!))
      return `agent updates ${JSON.stringify(input)}`
    }],
    [3, async () => {
      const id = r.pick(pool)
      const text = store.getObject(id)?.deletedAt ? undefined : passage(id)
      if (!text) return undefined
      const response = await user.request(`/api/objects/${id}/quotes`, json({ text }))
      if (response.status !== 201) return undefined
      const quote = (await response.json()) as ObjectRecord
      quotes.push({ id: quote.id, sourceId: id })
      pool.push(quote.id)
      return `server quotes "${text}" of ${id.slice(0, 8)} as ${quote.id.slice(0, 8)}`
    }],
    [3, async () => {
      const replica = r.pick(replicas)
      const result = replica.device.store.logFood('s', { sourceId: bread.id, amount: r.pick(['2 slices', '150', '1 slice']), day: today(), timeZone: 'UTC' }, now())
      eaten.push({ noteId: result.note.id, entryId: result.entryId, deleted: false })
      if (!pool.includes(result.note.id)) pool.push(result.note.id)
      return `${replica.name} logs food ${result.entryId.slice(0, 8)}`
    }],
    [2, async () => {
      const response = await user.request('/api/spaces/s/food', json({ sourceId: bread.id, amount: '1 slice', day: today(), timeZone: 'UTC' }))
      expect(response.status).toBe(201)
      const result = (await response.json()) as { note: ObjectRecord; entryId: Id }
      eaten.push({ noteId: result.note.id, entryId: result.entryId, deleted: false })
      if (!pool.includes(result.note.id)) pool.push(result.note.id)
      return `server logs food ${result.entryId.slice(0, 8)}`
    }],
    [2, async () => {
      const item = r.pick([...eaten.filter((e) => !e.deleted), undefined])
      if (!item) return undefined
      const replica = r.pick([...replicas, undefined])
      if (replica) {
        if (!replica.device.store.getObject(item.noteId)?.props[foodEntryKey(item.entryId)]) return undefined
        replica.device.store.deleteFoodEntry(item.noteId, item.entryId, now())
      } else if ((await user.request(`/api/objects/${item.noteId}/food/${item.entryId}`, { method: 'DELETE' })).status !== 200) return undefined
      item.deleted = true
      return `${replica?.name ?? 'server'} deletes food ${item.entryId.slice(0, 8)}`
    }],
    [2, async () => {
      const quote = quotes.length ? r.pick(quotes) : undefined
      if (!quote || store.getObject(quote.id)?.deletedAt) return undefined
      const before = serverClock(quote.id)
      await user.request(`/api/objects/${quote.id}`, { method: 'DELETE' })
      intents.note(quote.id, ['deletedAt'], before, serverClock(quote.id), recordFields('objects', store.getObject(quote.id)!))
      return `server deletes quote ${quote.id.slice(0, 8)}`
    }],
  ]
  const total = steps.reduce((sum, [weight]) => sum + weight, 0)

  try {
    for (let step = 0; step < STEPS; step++) {
      time += 1 + r.int(1500)
      vi.setSystemTime(time)
      let roll = r.int(total)
      const [, action] = steps.find(([weight]) => (roll -= weight) < 0)!
      try {
        const done = await action()
        if (done) log.push(`${step}: ${done}`)
      } catch (error) {
        if (!(error instanceof Skip)) throw error
      }
    }

    // Everyone online, pending edits saved, then sync until nothing moves.
    log.push('-- settle')
    tab.online = true
    for (const replica of replicas) replica.device.online = true
    for (const replica of replicas) await replica.syncing
    for (const actor of actors) await actor.page?.save(intents)
    for (let round = 0; ; round++) {
      expect(round, 'sync does not settle').toBeLessThan(10)
      vi.setSystemTime((time += 1000))
      const rev = store.currentRev()
      for (const replica of replicas) await sync(replica)
      if (store.currentRev() === rev && replicas.every((d) => d.device.store.outboxSize() === 0 && d.device.store.pulledRev() === rev)) break
    }
    for (const actor of actors) await actor.page?.reload(actor.kind === 'tab' ? store.getObject(actor.page.id)?.updatedAt : actor.device.store.getObject(actor.page.id)?.updatedAt)

    const rows = (s: { syncChanges: NodeStore['syncChanges'] }) => new Map(s.syncChanges(['s'], 0, 100_000).rows.map((row) => [`${row.table} ${row.id}`, row]))
    const server = rows(store)
    const textOf = (s: { loadText(id: Id): Y.Doc | undefined }, id: Id) => {
      const doc = s.loadText(id)
      return doc ? canonicalJson(readContent(doc)) : '{}'
    }
    expect(refused).toEqual([])
    for (const replica of replicas) {
      const local = rows(replica.device.store)
      expect([...local.keys()].sort(), replica.name).toEqual([...server.keys()].sort())
      for (const [key, row] of server) {
        const mine = local.get(key)!
        if (row.table === 'objects') expect(JSON.parse(textOf(replica.device.store, row.id)), `${replica.name} ${key} text`).toEqual(JSON.parse(textOf(store, row.id)))
        // A device's change that turned out to change nothing on the server (a block two devices
        // deleted) keeps the device's updatedAt: newer, never older.
        const { updatedAt: localTime, ...record } = mine.record as { updatedAt?: string }
        const { updatedAt: serverTime, ...expected } = row.record as { updatedAt?: string }
        expect(JSON.parse(canonicalJson(record)), `${replica.name} ${key}`).toEqual(JSON.parse(canonicalJson(expected)))
        expect((localTime ?? '') >= (serverTime ?? ''), `${replica.name} ${key} updatedAt ${localTime} ≥ ${serverTime}`).toBe(true)
        expect(mine.clock, `${replica.name} ${key} clock`).toEqual(row.clock)
      }
      if (replica.editor) expect(canonicalJson(readContent(replica.editor.doc)), `${replica.name}'s editor`).toBe(textOf(store, replica.editor.id))
    }
    for (const actor of actors) {
      if (!actor.page) continue
      const stored = store.getObject(actor.page.id)!
      const fields = (o: ObjectRecord) => canonicalJson({ ...recordFields('objects', o), media: null })
      expect(fields(actor.page.object), `${actor.name}'s page`).toBe(fields(stored))
      if (actor.kind === 'tab') expect(canonicalJson(actor.page.object.content), `${actor.name}'s page text`).toBe(canonicalJson(stored.content))
    }
    for (const item of eaten) {
      const value = store.getObject(item.noteId)?.props[foodEntryKey(item.entryId)]
      expect(!!value, `food ${item.entryId} ${item.deleted ? 'deleted' : 'logged'}`).toBe(!item.deleted)
    }
    for (const [key, given] of intents.fields) {
      const [id, field] = key.split(' ') as [Id, string]
      const newest = given.reduce((a, b) => (b.hlc > a.hlc ? b : a))
      const row = store.syncRow('objects', id)!
      expect(row.clock[field], `${key}: the newest value given wins`).toBe(newest.hlc)
      expect(canonicalJson(recordFields('objects', row.record)[field] ?? null), `${key} value`).toBe(canonicalJson(newest.value))
    }
  } catch (error) {
    console.log(`seed ${seed} failed; replay with VASTA_SEED=${seed}\n${(process.env.VASTA_LOG ? log : log.slice(-40)).join('\n')}`)
    throw error
  } finally {
    for (const replica of replicas) replica.editor?.close()
    seedRandom()
  }
}

describe('sync convergence', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  for (const seed of SEEDS) it(`converges (seed ${seed})`, () => run(seed), 60_000)
})
