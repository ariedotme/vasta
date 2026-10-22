import { DatabaseSync } from 'node:sqlite'
import sqliteWasm from '@sqlite.org/sqlite-wasm'
import { describe, expect, it } from 'vitest'
import { Y, writeContent } from '@vasta/editor-schema/yjs'
import { builtinTypeId, createBuiltinTypes, querySpace, type Doc, type Filter, type FilterGroup, type ObjectRecord } from '../src/index.ts'
import { runQuery, timeBounds } from '../src/query.ts'
import { wasmDatabase } from '../src/sql-wasm.ts'
import { Store, type SqlDatabase } from '../src/store.ts'

const sqlite3 = await sqliteWasm()

// The shared store must behave the same on the server's SQLite and on the browser's.
const backends: [string, () => SqlDatabase][] = [
  ['node:sqlite', () => new DatabaseSync(':memory:')],
  ['sqlite-wasm', () => wasmDatabase(new sqlite3.oo1.DB(':memory:'))],
]

const at = '2026-10-01T12:00:00.000Z'
const later = '2026-10-02T12:00:00.000Z'
const doc = (...paragraphs: string[]): Doc => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
})
const object = (id: string, title: string, extra: Partial<ObjectRecord> = {}): ObjectRecord => ({
  id,
  spaceId: 's',
  typeId: builtinTypeId('s', 'page'),
  title,
  aliases: [],
  tagIds: [],
  collectionIds: [],
  props: {},
  content: {},
  createdAt: at,
  updatedAt: at,
  ...extra,
})

describe.each(backends)('shared store on %s', (_name, open) => {
  const setUp = () => {
    const store = new Store(open())
    store.putSpace({ id: 's', name: 'Space', sidebar: [], createdAt: at })
    for (const type of createBuiltinTypes('s', at)) store.putType(type)
    return store
  }

  it('writes objects with their links, search entries and Yjs text', () => {
    const store = setUp()
    expect(store.clock.node).toMatch(/^node-[0-9a-f]{8}$/)
    store.putObject(object('a', 'Coffee 100%', { aliases: ['Joe'] }))
    store.putObject(
      object('b', 'Morning routine', {
        tagIds: ['a'],
        content: { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Brew ' }, { type: 'mention', attrs: { objectId: 'a', label: 'Coffee' } }] }] } },
      })
    )
    expect(store.backlinks('a').map((b) => [b.object.id, b.kind])).toEqual([['b', 'mention'], ['b', 'tag']])
    expect(store.search('s', 'brew').map((o) => o.id)).toEqual(['b'])
    expect(store.search('s', '100%').map((o) => o.id)).toEqual(['a'])
    expect(store.search('s', 'joe').map((o) => o.id)).toEqual(['a'])
    expect(store.getObjectSummaries(['b'])[0]!.preview).toBe('Brew Coffee')

    const text = store.loadText('b')!
    expect(text.getXmlFragment('body').length).toBe(1)
    const vectors = store.textVectors(['b', 'missing'])
    expect([...vectors.keys()]).toEqual(['b'])
    expect(vectors.get('b')).toEqual(Y.encodeStateVector(text))
    store.close()
  })

  it('finds search rows through search_rows, also in a database from before it or from an older version', () => {
    const store = setUp()
    const ftsRows = (s: Store) => (s.db.prepare('SELECT object_id, title FROM objects_fts ORDER BY object_id').all() as { object_id: string; title: string }[]).map((r) => [r.object_id, r.title])
    store.putObject(object('a', 'Apple pie', { content: { body: doc('Cinnamon') } }))
    store.putObject(object('b', 'Banana bread'))
    store.putObject({ ...store.getObject('a')!, title: 'Apple tart' })
    expect(ftsRows(store)).toEqual([['a', 'Apple tart'], ['b', 'Banana bread']])

    // Written before search_rows existed.
    store.db.exec('DELETE FROM search_rows')
    let reopened = new Store(store.db)
    expect(reopened.getObjectSummaries(['a'])[0]!.preview).toBe('Cinnamon')
    // An older version after a rollback replaces a row under a new rowid.
    reopened.db.prepare('DELETE FROM objects_fts WHERE object_id = ?').run('a')
    reopened.db.prepare('INSERT INTO objects_fts (object_id, title, body) VALUES (?, ?, ?)').run('a', 'Apple crumble', 'Cinnamon')
    reopened = new Store(reopened.db)
    reopened.putObject({ ...reopened.getObject('a')!, title: 'Apple cake' })
    expect(ftsRows(reopened)).toEqual([['a', 'Apple cake'], ['b', 'Banana bread']])
    expect(reopened.search('s', 'cinnamon').map((o) => o.title)).toEqual(['Apple cake'])

    reopened.deleteObject('b', later)
    reopened.purgeObject('a')
    expect(ftsRows(reopened)).toEqual([])
    expect(reopened.db.prepare('SELECT count(*) AS n FROM search_rows').get()!.n).toBe(0)
    reopened.close()
  })

  it('merges a Yjs edit and a whole-object write of the same text', () => {
    const store = setUp()
    store.putObject(object('n', 'Note', { content: { body: doc('one') } }))
    const device = new Y.Doc()
    Y.applyUpdate(device, Y.encodeStateAsUpdate(store.loadText('n')!))
    writeContent(device, { body: doc('one', 'from the device') })

    // A server write appends to the stored text meanwhile; the device's update then merges into it.
    store.putObject(object('n', 'Note', { content: { body: doc('one', 'captured') } }))
    const merged = store.loadText('n')!
    Y.applyUpdate(merged, Y.encodeStateAsUpdate(device))
    const stored = store.putObject(store.getObject('n')!, undefined, merged)
    const texts = stored.content.body!.content!.map((p) => p.content?.[0]?.text)
    expect(texts).toEqual(expect.arrayContaining(['one', 'captured', 'from the device']))
    expect(store.search('s', 'device').map((o) => o.id)).toEqual(['n'])
    store.close()
  })

  it('pages sync changes by revision and keeps tombstones of purged rows', () => {
    const store = setUp()
    const start = store.currentRev()
    for (const id of ['a', 'b', 'c']) store.putObject(object(id, id.toUpperCase()))
    const first = store.syncChanges(['s'], start, 2)
    expect(first.rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(first.more).toBe(true)
    store.putObject(object('a', 'A again'))
    const second = store.syncChanges(['s'], first.rows.at(-1)!.rev, 10)
    expect(second.rows.map((r) => r.id)).toEqual(['c', 'a'])
    expect(second.more).toBe(false)
    expect(store.syncChanges(['other'], start, 10).rows).toEqual([])

    store.deleteObject('b', later)
    expect(store.trashCount('s')).toBe(1)
    store.purgeObject('b')
    expect(store.syncChanges(['s'], second.rows.at(-1)!.rev, 10).tombstones).toEqual([{ table: 'objects', id: 'b', spaceId: 's', rev: store.currentRev() }])
    expect(store.isTombstoned('objects', 'b')).toBe(true)
    expect(store.loadText('b')).toBeUndefined()
    store.close()
  })

  it('moves a type to the trash with its objects and back, and rolls back a failed transaction', () => {
    const store = setUp()
    const type = { ...store.getType(builtinTypeId('s', 'page'))!, id: 'recipes', name: 'Recipe', pluralName: 'Recipes', system: undefined }
    store.putType(type)
    store.putObject(object('r', 'Bread', { typeId: 'recipes', media: { url: 'https://example.com/bread' } }))
    expect(store.findObjectByMediaUrl('recipes', 'https://example.com/bread')?.id).toBe('r')
    store.deleteType('recipes', later)
    expect(store.listDeletedTypes('s').map((t) => [t.id, t.objectCount])).toEqual([['recipes', 1]])
    expect(store.listTypes('s').some((t) => t.id === 'recipes')).toBe(false)
    expect(store.restoreType('recipes', later)?.objects.map((o) => o.id)).toEqual(['r'])
    expect(store.typeCounts('s').recipes).toBe(1)

    const rev = store.currentRev()
    expect(() =>
      store.transaction(() => {
        store.putObject(object('r', 'Changed', { typeId: 'recipes' }))
        throw new Error('stop')
      })
    ).toThrow('stop')
    expect(store.getObject('r')?.title).toBe('Bread')
    expect(store.currentRev()).toBe(rev)
    store.close()
  })

  it('runs queries that filter on a related object\'s field', () => {
    const store = setUp()
    const page = store.getType(builtinTypeId('s', 'page'))!
    store.putType({ ...page, id: 'person', system: undefined, name: 'Person', pluralName: 'People', properties: [{ id: 'country', kind: 'text', name: 'Country' }] })
    store.putType({ ...page, id: 'book', system: undefined, name: 'Book', pluralName: 'Books', properties: [{ id: 'author', kind: 'relation', name: 'Author', targetTypeIds: ['person'], multiple: true }] })
    store.putObject(object('br', 'Machado', { typeId: 'person', props: { country: { kind: 'text', value: 'Brazil' } } }))
    store.putObject(object('us', 'Herbert', { typeId: 'person', props: { country: { kind: 'text', value: 'USA' } } }))
    store.putObject(object('b1', 'Dom Casmurro', { typeId: 'book', props: { author: { kind: 'relation', value: ['br'] } } }))
    store.putObject(object('b2', 'Dune', { typeId: 'book', props: { author: { kind: 'relation', value: ['us'] } } }))
    const query = (value: string) =>
      querySpace(store, 's', { query: { typeIds: ['book'], filter: { kind: 'group', operator: 'and', items: [{ kind: 'filter', field: 'author.country', operator: 'is', value: { kind: 'literal', value } }] } } }, at).map((o) => o.title)
    expect(query('Brazil')).toEqual(['Dom Casmurro'])
    expect(query('USA')).toEqual(['Dune'])
    store.close()
  })

  it('answers a query on when objects were made or changed from the objects around then, as from all of them', () => {
    const store = setUp()
    // Every 5 hours over 20 days, made and changed apart.
    for (let i = 0; i < 100; i++) {
      const made = new Date(Date.parse('2026-10-01T00:00:00.000Z') + i * 5 * 3600_000).toISOString()
      const changed = new Date(Date.parse(made) + (i % 7) * 11 * 3600_000).toISOString()
      store.putObject(object(`o${i}`, `Note ${i}`, { typeId: builtinTypeId('s', i % 3 ? 'page' : 'task'), createdAt: made, updatedAt: changed }))
    }
    const all = store.listSpaceObjects('s')
    const filters: Filter[] = []
    for (const field of ['createdAt', 'updatedAt'])
      for (const operator of ['is', 'before', 'after', 'is-not'] as const) {
        filters.push({ kind: 'filter', field, operator, value: { kind: 'literal', value: '2026-10-06' } })
        filters.push({ kind: 'filter', field, operator, value: { kind: 'literal', value: '2026-10-06T23:30:00.000Z' } })
        filters.push({ kind: 'filter', field, operator, value: { kind: 'variable', name: 'today', offsetDays: -3 } })
      }
    for (const timeZone of ['UTC', 'America/Sao_Paulo', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'])
      for (const typeIds of [[], [builtinTypeId('s', 'task')]])
        for (let i = 0; i < filters.length; i++) {
          const filter: FilterGroup = { kind: 'group', operator: 'and', items: [filters[i]!, filters[(i * 7) % filters.length]!] }
          const input = { query: { typeIds, filter }, today: '2026-10-12', timeZone }
          const types = new Map(store.listTypes('s').map((t) => [t.id, t]))
          const expected = runQuery(all.filter((o) => !typeIds.length || typeIds.includes(o.typeId)), { filter }, { types, today: input.today, timeZone })
          expect(querySpace(store, 's', input, at).map((o) => o.id).sort()).toEqual(expected.map((o) => o.id).sort())
        }
    expect(timeBounds({ kind: 'group', operator: 'and', items: [filters[0]!] }, { today: '2026-10-12', timeZone: 'UTC' })).toEqual({ created: { from: '2026-10-04', to: '2026-10-09' } })
    store.close()
  })

  it('keeps a tag\'s color and parent, and a filter on a tag takes its sub-tags', () => {
    const store = setUp()
    const tag = builtinTypeId('s', 'tag')
    store.putObject(object('recipe', 'recipe', { typeId: tag, color: 'orange' }))
    store.putObject(object('breakfast', 'breakfast', { typeId: tag, parentId: 'recipe' }))
    store.putObject(object('eggs', 'eggs', { typeId: tag, parentId: 'breakfast' }))
    store.putObject(object('p1', 'Pancakes', { tagIds: ['breakfast'] }))
    store.putObject(object('p2', 'Omelette', { tagIds: ['eggs'] }))
    store.putObject(object('p3', 'Notes', {}))
    expect(store.getObject('recipe')?.color).toBe('orange')
    expect(store.getObjectSummaries(['breakfast'])[0]?.parentId).toBe('recipe')
    const tagged = (id: string, operator: 'contains' | 'not-contains' = 'contains') =>
      querySpace(store, 's', { query: { typeIds: [builtinTypeId('s', 'page')], filter: { kind: 'group', operator: 'and', items: [{ kind: 'filter', field: 'tags', operator, value: { kind: 'literal', value: [id] } }] } } }, at)
        .map((o) => o.title)
        .sort()
    expect(tagged('recipe')).toEqual(['Omelette', 'Pancakes'])
    expect(tagged('breakfast')).toEqual(['Omelette', 'Pancakes'])
    expect(tagged('eggs')).toEqual(['Omelette'])
    expect(tagged('recipe', 'not-contains')).toEqual(['Notes'])
    // A cycle (made on two devices at once) does not hang the query.
    store.putObject(object('recipe', 'recipe', { typeId: tag, parentId: 'eggs' }))
    expect(tagged('recipe')).toEqual(['Omelette', 'Pancakes'])
    store.close()
  })
})
