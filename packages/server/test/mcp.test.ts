import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it } from 'vitest'
import { createBuiltinTypes, newType, setNutritionEnabled, type ObjectType } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { createApp } from '../src/app.ts'
import { CaptureService } from '../src/capture.ts'
import { ChangeFeed, type ChangeEvent } from '../src/events.ts'
import { asUser } from './helpers.ts'

const AT = '2026-10-19T15:00:00.000Z'

async function setup() {
  const store = new NodeStore(':memory:')
  for (const [id, name] of [['s', 'Notes'], ['x', 'Not mine']] as const) {
    store.putSpace({ id, name, sidebar: [], createdAt: AT })
    for (const type of createBuiltinTypes(id, AT)) store.putType(type)
  }
  const book: ObjectType = {
    ...newType('s', { name: 'Book', pluralName: 'Books' }, 'book', AT),
    properties: [
      { id: 'body', kind: 'rich-text', name: 'Notes' },
      { id: 'author', kind: 'relation', name: 'Author', targetTypeIds: [], multiple: false },
      { id: 'rating', kind: 'number', name: 'Rating' },
      { id: 'genre', kind: 'select', name: 'Genre', multiple: false, options: [{ id: 'g1', label: 'Sci-fi' }] },
      { id: 'started', kind: 'date', name: 'Started' },
    ],
  }
  store.putType(book)
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-mcp-')))
  const feed = new ChangeFeed()
  const events: ChangeEvent[] = []
  feed.subscribe((e) => events.push(e))
  const capture = new CaptureService({ store, media, feed, now: () => AT, timeZone: 'America/Sao_Paulo' })
  const app = createApp({ store, media, feed, capture, now: () => AT, webUrl: 'https://notes.example' })
  const arie = asUser(app, store, { username: 'arie', spaces: ['s'] })
  const connect = async (secret?: string) => {
    const client = new Client({ name: 'test', version: '1' })
    const transport = new StreamableHTTPClientTransport(new URL('http://vasta.test/mcp'), {
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers)
        if (secret) headers.set('authorization', `Bearer ${secret}`)
        return app.request(url.toString(), { ...init, headers })
      },
    })
    await client.connect(transport)
    return client
  }
  const client = await connect(arie.secret)
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    if (result.isError) throw new Error(result.content[0]!.text)
    return JSON.parse(result.content[0]!.text)
  }
  return { store, app, events, connect, call, client }
}

describe('MCP endpoint', () => {
  it('assigns tasks to members by username and finds what is assigned to the user', async () => {
    const { store, app, call } = await setup()
    const ana = asUser(app, store, { username: 'ana', spaces: ['s'] })
    store.putUser({ ...store.getUser(ana.user.id)!, name: 'Ana Lima' })
    const types = await call('list_types')
    expect(types.find((t: { name: string }) => t.name === 'Task').properties.find((p: { name: string }) => p.name === 'Assignee')).toEqual({ id: 'assignee', name: 'Assignee', kind: 'person', multiple: false })
    const forAna = await call('create_object', { type: 'Task', title: 'Water the plants', properties: { Assignee: 'ana' } })
    await call('create_object', { type: 'Task', title: 'Pay the bills', properties: { Assignee: 'me' } })
    expect(await call('get_object', { id: forAna.id })).toMatchObject({ properties: { Assignee: 'Ana Lima (ana)' }, createdBy: 'arie (arie)', updatedBy: 'arie (arie)' })
    const mine = await call('query', { types: ['Task'], where: [{ field: 'Assignee', operator: 'contains', value: 'me' }] })
    expect(mine.objects.map((o: { title: string }) => o.title)).toEqual(['Pay the bills'])
    const anas = await call('query', { types: ['Task'], where: [{ field: 'Assignee', operator: 'contains', value: 'Ana Lima' }] })
    expect(anas.objects.map((o: { title: string }) => o.title)).toEqual(['Water the plants'])
    await expect(call('create_object', { type: 'Task', title: 'Nope', properties: { Assignee: 'bob' } })).rejects.toThrow('Assignee')
    await call('add_comment', { id: forAna.id, text: 'Before Friday, @ana' })
    expect((await call('get_object', { id: forAna.id })).comments).toEqual([{ by: 'arie (arie)', at: expect.any(String), text: 'Before Friday, @ana' }])
    await expect(call('add_comment', { id: forAna.id, text: '  ' })).rejects.toThrow('needs text')
  })

  it('offers the tools, limited to the token user’s spaces', async () => {
    const { client, call } = await setup()
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['add_comment', 'capture', 'create_object', 'delete_food_entry', 'get_daily_note', 'get_object', 'list_habits', 'list_inbox', 'list_spaces', 'list_templates', 'list_types', 'log_food', 'log_habit', 'nutrition_day', 'query', 'save_food', 'search', 'update_object'])
    expect(await call('list_spaces')).toEqual([{ id: 's', name: 'Notes', default: true }])
    const types = await call('list_types')
    expect(types.find((t: { name: string }) => t.name === 'Book').properties.find((p: { name: string }) => p.name === 'Genre')).toEqual({ id: 'genre', name: 'Genre', kind: 'select', multiple: false, options: ['Sci-fi'] })
    await expect(call('list_types', { space: 'Not mine' })).rejects.toThrow('unknown space')
  })

  it('creates and reads objects with properties and Markdown text', async () => {
    const { call, store, events } = await setup()
    const created = await call('create_object', {
      type: 'books',
      title: 'Dune',
      properties: { author: 'Frank Herbert', rating: 5, Genre: 'Sci-fi', started: '2026-10-01' },
      markdown: '# Thoughts\n\nThe spice **must** flow.\n\n- [ ] finish it',
    })
    expect(created).toMatchObject({
      title: 'Dune',
      type: 'Book',
      space: 'Notes',
      url: `https://notes.example/o/${created.id}`,
      properties: { Author: [{ title: 'Frank Herbert' }], Rating: 5, Genre: 'Sci-fi', Started: '2026-10-01' },
      text: { Notes: '# Thoughts\n\nThe spice **must** flow.\n\n- [ ] finish it' },
    })
    // The author did not exist: a page was made for them, and it links back.
    const author = await call('get_object', { id: created.properties.Author[0].id })
    expect(author).toMatchObject({ title: 'Frank Herbert', type: 'Page', backlinks: [{ id: created.id, title: 'Dune', kind: 'relation' }] })
    expect(store.getObject(created.id)!.content.body!.content[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } })
    expect(events.filter((e) => e.kind === 'object').map((e) => (e as { id: string }).id)).toEqual(expect.arrayContaining([created.id, author.id]))
    expect((await call('search', { query: 'spice' })).map((o: { id: string }) => o.id)).toEqual([created.id])
    await expect(call('create_object', { type: 'Book', properties: { pages: 3 } })).rejects.toThrow('pages: no such property')
    await expect(call('create_object', { type: 'Movie' })).rejects.toThrow('unknown type "Movie"')
  })

  it('appends to, prepends to and replaces text, and changes properties', async () => {
    const { call } = await setup()
    const { id } = await call('create_object', { type: 'Page', title: 'Plan', markdown: 'first' })
    await call('update_object', { id, markdown: 'second' })
    await call('update_object', { id, markdown: 'zeroth', mode: 'prepend' })
    expect((await call('get_object', { id })).text.Notes).toBe('zeroth\n\nfirst\n\nsecond')
    const book = await call('create_object', { type: 'Book', title: 'Old', properties: { rating: 2 } })
    const changed = await call('update_object', { id: book.id, title: 'New', properties: { rating: null, genre: 'Fantasy' }, markdown: 'all new', mode: 'replace' })
    expect(changed).toMatchObject({ title: 'New', properties: { Genre: 'Fantasy' }, text: { Notes: 'all new' } })
    expect(changed.properties.Rating).toBeUndefined()
    // A new option was added to the type, as the app and the captures do.
    expect((await call('list_types')).find((t: { name: string }) => t.name === 'Book').properties.find((p: { name: string }) => p.name === 'Genre').options).toEqual(['Sci-fi', 'Fantasy'])
    await expect(call('update_object', { id: 'nope' })).rejects.toThrow('no object nope')
  })

  it('shows formula values, filters by them, and refuses to set them', async () => {
    const { call, store } = await setup()
    const book = store.getType('book')!
    store.putType({
      ...book,
      properties: [
        ...book.properties,
        { id: 'score', kind: 'formula', name: 'Score', expression: '{rating} * 2' },
        { id: 'by', kind: 'formula', name: 'By', expression: '"by " + {author}' },
      ],
    })
    const dune = await call('create_object', { type: 'Book', title: 'Dune', properties: { rating: 5, author: 'Frank Herbert' } })
    await call('create_object', { type: 'Book', title: 'Emma', properties: { rating: 3 } })
    expect(dune.properties).toMatchObject({ Score: 10, By: 'by Frank Herbert' })
    const types = await call('list_types')
    expect(types.find((t: { name: string }) => t.name === 'Book').properties.find((p: { name: string }) => p.name === 'Score')).toEqual({ id: 'score', name: 'Score', kind: 'formula', formula: '{Rating} * 2' })
    const titles = async (args: Record<string, unknown>) => (await call('query', { types: ['Book'], ...args })).objects.map((o: { title: string }) => o.title)
    expect(await titles({ where: [{ field: 'Score', operator: 'gt', value: 6 }] })).toEqual(['Dune'])
    expect(await titles({ sort: [{ field: 'score', direction: 'asc' }] })).toEqual(['Emma', 'Dune'])
    // The formula reads the related author, which the query loads for it.
    expect(await titles({ where: [{ field: 'By', operator: 'contains', value: 'herbert' }] })).toEqual(['Dune'])
    await expect(call('update_object', { id: dune.id, properties: { score: 3 } })).rejects.toThrow('computed by a formula')
  })

  it('captures into today’s note, lists the inbox and reads daily notes', async () => {
    const { call } = await setup()
    const captured = await call('capture', { text: 'Call the dentist' })
    const today = await call('get_daily_note')
    expect(today.id).toBe(captured.dailyNoteId)
    expect(today.day).toBe('2026-10-19')
    expect(today.text.Notes).toContain('Call the dentist')
    const inbox = await call('list_inbox')
    expect(inbox).toMatchObject([{ channel: 'agent', day: '2026-10-19', done: false, text: 'Call the dentist', dailyNoteId: today.id }])
    await call('update_object', { id: today.id, markdown: '## Evening\n\nRead [@Dune](vasta://o/dune-id).' })
    const note = await call('get_daily_note', { day: '2026-10-19' })
    expect(note.text.Notes.endsWith('## Evening\n\nRead [@Dune](vasta://o/dune-id).')).toBe(true)
    // The captured item is still a captured item.
    expect(await call('list_inbox')).toHaveLength(1)
    await expect(call('get_daily_note', { day: '19/10' })).rejects.toThrow()
  })

  it('lists habits and logs them, with amounts toward a daily goal', async () => {
    const { call, events } = await setup()
    await call('create_object', { type: 'Habit', title: 'Meditate' })
    await call('create_object', { type: 'Habit', title: 'Água', properties: { 'Daily goal': 8, Unit: 'copos' } })
    let water = await call('log_habit', { habit: 'agua', add: 3 })
    expect(water.day).toEqual({ day: '2026-10-19', scheduled: true, done: false, amount: 3 })
    water = await call('log_habit', { habit: water.id, add: 5 })
    expect(water.day.done).toBe(true)
    expect(water.stats.currentStreak).toBe(1)
    await call('log_habit', { habit: 'Meditate', day: '2026-10-18' })
    const habits = await call('list_habits', { recent: 2 })
    expect(habits.map((h: { title: string; day: { done: boolean } }) => [h.title, h.day.done])).toEqual([['Água', true], ['Meditate', false]])
    expect(habits[1].recent).toEqual([{ day: '2026-10-18', done: true }, { day: '2026-10-19', done: false }])
    expect((await call('log_habit', { habit: 'Meditate', day: '2026-10-18', done: false })).recent.at(-1)).toEqual({ day: '2026-10-18', done: false })
    expect(events.filter((e) => e.kind === 'object').length).toBeGreaterThan(3)
    await expect(call('log_habit', { habit: 'Run' })).rejects.toThrow('no habit "Run"')
  })

  it('logs food, reads a day and fills in foods, in a space that tracks food', async () => {
    const { call, store } = await setup()
    await expect(call('log_food', { text: 'bread' })).rejects.toThrow('does not track food')
    setNutritionEnabled(store, 's', true, AT)
    const bread = await call('save_food', { food: 'White bread', per: 50, nutrients: { kcal: 125, protein: 4.5, carbs: 24, fat: 1.5 }, brand: 'Wickbold', portions: [{ name: 'slice', grams: 25 }] })
    expect(bread).toMatchObject({ title: 'White bread', type: 'Food', properties: { Calories: 250, Protein: 9, Carbs: 48, Fat: 3, Brand: 'Wickbold' }, nutrition: { per100g: { kcal: 250, protein: 9 }, portions: [{ name: 'slice', grams: 25 }] }, timesEaten: 0 })
    // 15:00 UTC is noon in São Paulo: lunch.
    const logged = await call('log_food', { text: '2 slices of white bread, tapioca 100g' })
    expect(logged.summary).toBe('Logged in Lunch: White bread 2 slices (125 kcal), Tapioca 100 g (needs nutrition data).\nToday 125 kcal.\nNew food without nutrition data: Tapioca. Fill it in in Vasta.')
    await call('log_food', { food: 'white bread', amount: '1 slice', meal: 'Dinner', day: '2026-10-18' })
    await expect(call('log_food', { food: 'white bread', amount: '1 cup' })).rejects.toThrow('not a portion')
    const day = await call('nutrition_day')
    expect(day).toMatchObject({ day: '2026-10-19', counted: true, totals: { kcal: 125 } })
    const lunch = day.meals.find((m: { meal: string }) => m.meal === 'Lunch')
    expect(lunch.entries.map((e: { name: string; amount: string; needsData?: boolean }) => [e.name, e.amount, !!e.needsData])).toEqual([['White bread', '2 slices', false], ['Tapioca', '100 g', true]])
    const after = await call('delete_food_entry', { entry: lunch.entries[1].id })
    expect(after.meals.find((m: { meal: string }) => m.meal === 'Lunch').entries).toHaveLength(1)
    expect((await call('nutrition_day', { day: '2026-10-18' })).totals.kcal).toBe(62.5)
    // A habit done from food fills from what was logged, and is not checked by hand.
    await call('create_object', { type: 'Habit', title: 'Protein', properties: { 'From food': 'Protein, at least', 'Daily goal': 100, Unit: 'g' } })
    expect((await call('list_habits', { recent: 0 })).find((h: { title: string }) => h.title === 'Protein')).toMatchObject({ fromFood: 'protein-min', day: { amount: 4.5, done: false } })
    await expect(call('log_habit', { habit: 'Protein' })).rejects.toThrow('done from what is logged in Food')
    // Filled in later from its label, the made food is a food like any other.
    expect((await call('save_food', { food: 'tapioca', nutrients: { kcal: 240 } })).nutrition.per100g.kcal).toBe(240)
  })

  it('queries objects by property names and option labels', async () => {
    const { call } = await setup()
    for (const [title, rating, genre] of [['B', 4, 'Sci-fi'], ['A', 5, 'Sci-fi'], ['C', 1, 'Drama']] as const) await call('create_object', { type: 'Book', title, properties: { rating, genre } })
    const result = await call('query', { types: ['Book'], where: [{ field: 'Genre', operator: 'is', value: 'Sci-fi' }], sort: [{ field: 'title' }] })
    expect(result.total).toBe(2)
    expect(result.objects.map((o: { title: string }) => o.title)).toEqual(['A', 'B'])
    const good = await call('query', { types: ['Book'], where: [{ field: 'rating', operator: 'gte', value: 4 }, { field: 'genre', operator: 'is', value: 'Drama' }], match: 'any' })
    expect(good.objects.map((o: { title: string }) => o.title).sort()).toEqual(['A', 'B', 'C'])
    await expect(call('query', { where: [{ field: 'pages', operator: 'is', value: 1 }] })).rejects.toThrow('unknown field "pages"')
  })

  it('keeps out objects of other spaces and tokens without the api scope', async () => {
    const { call, store, app, connect } = await setup()
    const other = store.putObject({ id: 'secret', spaceId: 'x', typeId: store.listTypes('x').find((t) => t.system === 'page')!.id, title: 'Secret', aliases: [], tagIds: [], collectionIds: [], props: {}, content: {}, createdAt: AT, updatedAt: AT })
    await expect(call('get_object', { id: other.id })).rejects.toThrow('no object secret')
    await expect(call('update_object', { id: other.id, title: 'mine now' })).rejects.toThrow('no object secret')
    const capture = asUser(app, store, { username: 'bot', scope: 'capture' })
    await expect(connect(capture.secret)).rejects.toThrow()
    await expect(connect()).rejects.toThrow()
    expect((await app.request('/mcp', { method: 'POST', body: '{}' })).status).toBe(401)
    // No sessions: nothing to stream on a GET.
    const { secret } = asUser(app, store, { username: 'reader' })
    expect((await app.request('/mcp', { headers: { authorization: `Bearer ${secret}`, accept: 'text/event-stream' } })).status).toBe(405)
  })
})
