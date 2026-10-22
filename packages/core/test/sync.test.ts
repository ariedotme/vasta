import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { Y, readContent } from '@vasta/editor-schema/yjs'
import { builtinTypeId, createBuiltinTypes } from '../src/builtin-types.ts'
import type { ObjectRecord } from '../src/model.ts'
import { afterSave } from '../src/operations.ts'
import { NodeStore } from '../src/store-node.ts'
import {
  ClockDriftError,
  HybridClock,
  MAX_CLOCK_DRIFT_MS,
  applyFields,
  canonicalJson,
  formatHlc,
  hlcAt,
  mergeFields,
  parseHlc,
  recordFields,
  stampChanges,
} from '../src/sync.ts'

const T = Date.parse('2026-10-01T12:00:00.000Z')

describe('hybrid logical clock', () => {
  it('formats HLCs that sort as text and parse back', () => {
    const hlc = formatHlc(T, 10, 'phone')
    expect(hlc).toBe('2026-10-01T12:00:00.000Z-000a-phone')
    expect(parseHlc(hlc)).toEqual({ time: T, counter: 10, node: 'phone' })
    expect(parseHlc('nope')).toBeUndefined()
    const sorted = [formatHlc(T + 1, 0, 'a'), formatHlc(T, 2, 'a'), formatHlc(T, 1, 'b'), formatHlc(T, 1, 'a')]
    expect([...sorted].sort()).toEqual([formatHlc(T, 1, 'a'), formatHlc(T, 1, 'b'), formatHlc(T, 2, 'a'), formatHlc(T + 1, 0, 'a')])
  })

  it('ticks forward even when the wall clock stands still or goes back', () => {
    const clock = new HybridClock('a')
    const first = clock.tick(T)
    const second = clock.tick(T)
    const third = clock.tick(T - 5000)
    expect(first < second && second < third).toBe(true)
    expect(parseHlc(third)).toMatchObject({ time: T, counter: 2 })
    expect(parseHlc(clock.tick(T + 1))).toMatchObject({ time: T + 1, counter: 0 })
  })

  it('orders local writes after a received HLC, and refuses one too far ahead', () => {
    const clock = new HybridClock('server')
    const remote = formatHlc(T + 60_000, 3, 'phone')
    clock.receive(remote, T)
    expect(clock.tick(T) > remote).toBe(true)
    expect(() => clock.receive(formatHlc(T + MAX_CLOCK_DRIFT_MS + 1, 0, 'phone'), T)).toThrow(ClockDriftError)
    expect(() => clock.receive('garbage', T)).toThrow(ClockDriftError)
  })

  it('observes stored HLCs without a drift check', () => {
    const clock = new HybridClock('a')
    const stored = formatHlc(T + 2 * MAX_CLOCK_DRIFT_MS, 7, 'b')
    clock.observe(stored)
    expect(clock.tick(T) > stored).toBe(true)
  })

  it('stamps hlcAt rows with unreadable times at the epoch', () => {
    expect(hlcAt('2026-10-01T12:00:00.000Z', 'n')).toBe('2026-10-01T12:00:00.000Z-0000-n')
    expect(hlcAt('not a date', 'n')).toBe('1970-01-01T00:00:00.000Z-0000-n')
  })
})

describe('sync fields', () => {
  const object: ObjectRecord = {
    id: 'o', spaceId: 's', typeId: 't', title: 'Book', aliases: [], tagIds: ['x'], collectionIds: [],
    props: { status: { kind: 'select', value: ['todo'] } }, content: { body: { type: 'doc', content: [] } },
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  }

  it('splits objects into fields and props one by one, leaving rich text to Yjs', () => {
    const fields = recordFields('objects', object)
    expect(fields).toMatchObject({ title: 'Book', description: null, tagIds: ['x'], 'props.status': { kind: 'select', value: ['todo'] } })
    expect(fields).not.toHaveProperty('content.body')
    expect(fields).not.toHaveProperty('id')
    expect(fields).not.toHaveProperty('updatedAt')
  })

  it('applies fields back, null removing a field or a map entry', () => {
    const next = applyFields('objects', object, { description: 'Novel', 'props.status': null, 'props.rating': { kind: 'number', value: 4 }, 'content.body': null, id: 'ignored' })
    expect(next.description).toBe('Novel')
    expect(next.props).toEqual({ rating: { kind: 'number', value: 4 } })
    expect(next.content).toEqual(object.content)
    expect(next.id).toBe('o')
    expect(object.props.status).toBeDefined()
    expect(applyFields('objects', next, { description: null })).not.toHaveProperty('description')
  })

  it('stamps only the fields that changed, whatever the key order', () => {
    const before = recordFields('objects', object)
    const reordered = { ...object, props: { status: { value: ['todo'], kind: 'select' } as never } }
    expect(stampChanges(before, recordFields('objects', reordered), { title: 'old' }, 'new')).toEqual({ title: 'old' })
    const changed = { ...object, title: 'Novel', props: {} }
    expect(stampChanges(before, recordFields('objects', changed), { title: 'old' }, 'new')).toEqual({ title: 'new', 'props.status': 'new' })
    // A new record: the fields with a value (nothing older can exist to overrule an empty one).
    expect(stampChanges(undefined, before, {}, 'new')).toEqual(Object.fromEntries(['typeId', 'title', 'aliases', 'tagIds', 'collectionIds', 'props.status'].map((name) => [name, 'new'])))
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: undefined }] })).toBe('{"a":[{"d":1}],"b":1}')
  })

  it('keeps the page’s copy in step after a save: changes from elsewhere shown, what was typed meanwhile kept', () => {
    const sent = { ...object, title: 'Dune' }
    // Saved with only what changed since the page's base: the description came from another device.
    const saved = { ...sent, description: 'From the phone', updatedAt: '2026-10-02T00:00:00.000Z' }
    expect(afterSave(sent, sent, saved)).toEqual(saved)
    // Typed while the save was on its way: the title and the text stay as typed, and so does the
    // time the text was edited from (a whole-object save merges captures after it).
    const typing: ObjectRecord = { ...sent, title: 'Dune Messiah', content: { body: { type: 'doc', content: [{ type: 'paragraph' }] } } }
    expect(afterSave(typing, sent, saved)).toEqual({ ...saved, title: 'Dune Messiah', content: typing.content, updatedAt: object.updatedAt })
  })

  it('merges a field only when its HLC is newer', () => {
    const clock = { title: formatHlc(T, 0, 'a'), description: formatHlc(T, 0, 'a') }
    const result = mergeFields(clock, {
      title: { value: 'Newer', hlc: formatHlc(T + 1, 0, 'b') },
      description: { value: 'Older', hlc: formatHlc(T - 1, 0, 'b') },
      icon: { value: null, hlc: formatHlc(T - 1, 0, 'b') },
    })
    expect(result.taken).toEqual({ title: 'Newer', icon: null })
    expect(result.lost).toEqual(['description'])
    expect(result.clock.title).toBe(formatHlc(T + 1, 0, 'b'))
    // The same write again changes nothing and loses nothing.
    expect(mergeFields(result.clock, { title: { value: 'Newer', hlc: formatHlc(T + 1, 0, 'b') } })).toMatchObject({ taken: {}, lost: [] })
  })
})

describe('sync in the node store', () => {
  it('gives every write a new revision and stamps the changed fields', () => {
    const store = new NodeStore(':memory:')
    const at = '2026-10-01T12:00:00.000Z'
    store.putSpace({ id: 's', name: 'S', sidebar: [], createdAt: at })
    for (const type of createBuiltinTypes('s', at)) store.putType(type)
    const page: ObjectRecord = { id: 'p', spaceId: 's', typeId: builtinTypeId('s', 'page'), title: 'One', aliases: [], tagIds: [], collectionIds: [], props: {}, content: {}, createdAt: at, updatedAt: at }
    const revs: [string, number][] = []
    store.onRev((spaceId, rev) => revs.push([spaceId, rev]))
    store.putObject(page)
    const first = store.syncRow('objects', 'p')!
    expect(first.rev).toBe(store.currentRev())
    expect(revs).toEqual([['s', first.rev]])

    store.putObject({ ...page, title: 'Two' })
    const second = store.syncRow('objects', 'p')!
    expect(second.rev).toBe(first.rev + 1)
    expect(second.clock.title! > first.clock.title!).toBe(true)
    expect(second.clock.aliases).toBe(first.clock.aliases)

    // One announcement per space and transaction, after it commits.
    revs.length = 0
    store.transaction(() => {
      store.putObject({ ...page, title: 'Three' })
      store.putObject({ ...page, title: 'Four' })
      expect(revs).toEqual([])
    })
    expect(revs).toEqual([['s', store.currentRev()]])
    revs.length = 0
    expect(() => store.transaction(() => {
      store.putObject({ ...page, title: 'Five' })
      throw new Error('stop')
    })).toThrow('stop')
    expect(revs).toEqual([])
    expect(store.getObject('p')?.title).toBe('Four')

    store.deleteObject('p', at)
    store.purgeObject('p')
    const { tombstones, rows } = store.syncChanges(['s'], second.rev, 100)
    expect(rows.some((r) => r.id === 'p')).toBe(false)
    expect(tombstones).toEqual([{ table: 'objects', id: 'p', spaceId: 's', rev: store.currentRev() }])
    expect(store.isTombstoned('objects', 'p')).toBe(true)
    store.close()
  })

  it('backfills revisions and clocks on a database from before sync', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'vasta-sync-')), 'old.db')
    const db = new DatabaseSync(file)
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '3');
      CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, sidebar TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT);
      INSERT INTO spaces VALUES ('s', 'Old', NULL, '[]', '2025-01-01T00:00:00.000Z', NULL);
      CREATE TABLE types (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, system TEXT, name TEXT NOT NULL, plural_name TEXT NOT NULL,
        description TEXT, icon TEXT, color TEXT, properties TEXT NOT NULL, views TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
      INSERT INTO types VALUES ('t', 's', NULL, 'Book', 'Books', NULL, NULL, NULL, '[]', '[]', '2025-01-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z', NULL);
      CREATE TABLE objects (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, type_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT, icon TEXT,
        cover_url TEXT, aliases TEXT NOT NULL, tag_ids TEXT NOT NULL, collection_ids TEXT NOT NULL, props TEXT NOT NULL, content TEXT NOT NULL,
        date_start TEXT, date_end TEXT, date_res TEXT, date_rrule TEXT, date_tz TEXT, query TEXT, media TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
      INSERT INTO objects VALUES ('o', 's', 't', 'Dune', NULL, NULL, NULL, '[]', '[]', '[]', '{"rating":{"kind":"number","value":5}}', '{}',
        NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2025-01-01T00:00:00.000Z', '2025-03-01T00:00:00.000Z', NULL);
    `)
    db.close()

    const store = new NodeStore(file)
    const object = store.syncRow('objects', 'o')!
    const type = store.syncRow('types', 't')!
    const space = store.syncRow('spaces', 's')!
    expect([space.rev, type.rev, object.rev]).toEqual([1, 2, 3])
    expect(store.currentRev()).toBe(3)
    expect(object.clock.title).toBe(hlcAt('2025-03-01T00:00:00.000Z', store.clock.node))
    expect(object.clock['props.rating']).toBe(object.clock.title)
    expect(type.clock.name).toBe(hlcAt('2025-02-01T00:00:00.000Z', store.clock.node))
    expect(space.clock.sidebar).toBe(hlcAt('2025-01-01T00:00:00.000Z', store.clock.node))
    store.close()

    // Once only, and the node id stays.
    const again = new NodeStore(file)
    expect(again.currentRev()).toBe(3)
    expect(again.clock.node).toBe(store.clock.node)
    again.close()
  })

  it('keeps rich text in a Yjs document per object, converting rows written without one on open', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'vasta-sync-')), 'text.db')
    const at = '2026-10-01T12:00:00.000Z'
    const store = new NodeStore(file)
    store.putSpace({ id: 's', name: 'S', sidebar: [], createdAt: at })
    for (const type of createBuiltinTypes('s', at)) store.putType(type)
    const base: ObjectRecord = { id: 'a', spaceId: 's', typeId: builtinTypeId('s', 'page'), title: 'A', aliases: [], tagIds: [], collectionIds: [], props: {}, content: {}, createdAt: at, updatedAt: at }
    // Written as a capture builds it: default attributes missing, text split in two nodes.
    const callout = { type: 'callout', attrs: { icon: { kind: 'icon', value: 'ph:note' } }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Call ' }, { type: 'text', text: 'the bank' }] }] }
    const stored = store.putObject({ ...base, content: { body: { type: 'doc', content: [callout as never] }, empty: { type: 'doc', content: [] } } })
    expect(stored.content).toEqual({
      body: { type: 'doc', content: [{ type: 'callout', attrs: { icon: { kind: 'icon', value: 'ph:note' }, capture: null }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Call the bank' }] }] }] },
    })
    expect(store.getObject('a')!.content).toEqual(stored.content)
    expect(readContent(store.loadText('a')!)).toEqual(stored.content)
    expect(store.syncRow('objects', 'a')!.clock).not.toHaveProperty('content.body')

    // Other fields change without touching the Yjs document.
    const state = Y.encodeStateAsUpdate(store.loadText('a')!)
    store.putObject({ ...stored, title: 'Renamed' })
    expect(Y.encodeStateAsUpdate(store.loadText('a')!)).toEqual(state)
    expect(store.db.prepare("SELECT rev FROM object_docs WHERE object_id = 'a'").get()).toEqual({ rev: store.syncRow('objects', 'a')!.rev })

    // A version without Yjs (a rollback) wrote 'a' and 'b'; a row of 'c' has text the schema lacks.
    store.putObject({ ...base, id: 'b', title: 'B' })
    store.putObject({ ...base, id: 'c', title: 'C' })
    const doc = (text: string) => JSON.stringify({ body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } })
    store.db.prepare(`UPDATE objects SET content = ?, rev = rev + 1, clock = json_set(clock, '$."content.body"', 'old') WHERE id = 'a'`).run(doc('Edited elsewhere'))
    store.db.prepare("UPDATE objects SET content = ? WHERE id = 'b'").run(doc('Imported'))
    store.db.prepare("DELETE FROM object_docs WHERE object_id = 'b'").run()
    store.db.prepare("UPDATE objects SET content = ? WHERE id = 'c'").run(JSON.stringify({ body: { type: 'doc', content: [{ type: 'mystery' }] } }))
    store.db.prepare("DELETE FROM object_docs WHERE object_id = 'c'").run()
    const rev = store.currentRev()
    store.close()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reopened = new NodeStore(file)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('c: Unknown node type: mystery'))
    warn.mockRestore()
    expect(readContent(reopened.loadText('a')!)).toEqual(JSON.parse(doc('Edited elsewhere')))
    expect(readContent(reopened.loadText('b')!)).toEqual(JSON.parse(doc('Imported')))
    expect(reopened.syncRow('objects', 'a')!.clock).not.toHaveProperty('content.body')
    expect(reopened.loadText('c')).toBeUndefined()
    expect(reopened.getObject('c')!.content.body!.content[0]!.type).toBe('mystery')
    expect(reopened.currentRev()).toBe(rev)

    reopened.deleteObject('b', at)
    reopened.purgeObject('b')
    expect(reopened.loadText('b')).toBeUndefined()
    reopened.close()
  })
})
