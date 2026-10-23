import { describe, expect, it } from 'vitest'
import { builtinTypeId, createBuiltinTypes, type ObjectSummary, type ObjectType } from '@vasta/core'
import { complete, type CompletionSource } from './typed-line.ts'

const at = '2026-10-19T12:00:00.000Z'
const daily = builtinTypeId('s', 'daily-note')
const book: ObjectType = {
  id: 'book', spaceId: 's', name: 'Livro', pluralName: 'Livros', createdAt: at, updatedAt: at, views: [],
  properties: [
    { id: 'author', kind: 'relation', name: 'Autor', targetTypeIds: ['person'], multiple: false },
    { id: 'read', kind: 'relation', name: 'Lido em', targetTypeIds: [daily], multiple: false },
    { id: 'genre', kind: 'select', name: 'Gênero', multiple: true, options: [{ id: 'f', label: 'Ficção científica' }, { id: 'c', label: 'Clássico' }] },
  ],
}
const person: ObjectType = { ...book, id: 'person', name: 'Pessoa', pluralName: 'Pessoas', properties: [] }
const summary = (id: string, typeId: string, title: string, day?: string): ObjectSummary =>
  ({ id, typeId, spaceId: 's', title, updatedAt: at, ...(day ? { date: { start: `${day}T00:00:00.000Z`, resolution: 'day' } } : {}) }) as ObjectSummary
const objects = [summary('h', 'person', 'Frank Herbert'), summary('s', 'person', 'Dan Simmons'), summary('d1', daily, '', '2026-10-17'), summary('d2', daily, '', '2026-10-19')]
const source: CompletionSource = {
  types: [...createBuiltinTypes('s', at), book, person],
  today: '2026-10-19',
  objects: async (typeIds, text) => objects.filter((o) => (!typeIds.length || typeIds.includes(o.typeId)) && o.title.toLowerCase().includes(text.toLowerCase())),
}
const at_end = (text: string) => complete(text, text.length, source)

describe('completions of a typed line', () => {
  it('offers the members for a person property, writing the username', async () => {
    const people = [{ id: 'u1', username: 'ana', name: 'Ana Lima' }, { id: 'u2', username: 'arie', name: 'Arie' }]
    const withPeople = { ...source, people }
    const task = builtinTypeId('s', 'task')
    expect(source.types.find((t) => t.id === task)!.properties.some((p) => p.kind === 'person')).toBe(true)
    const found = await complete('/Task Paint assignee:li', '/Task Paint assignee:li'.length, withPeople)
    expect(found.map((c) => c.label)).toEqual(['Ana Lima'])
    expect(found[0]).toMatchObject({ detail: '@ana', text: '/Task Paint assignee:ana ' })
    // Written whole: nothing more to pick.
    expect(await complete('/Task Paint assignee:ana', '/Task Paint assignee:ana'.length, withPeople)).toEqual([])
  })

  it('offers the types after "/", replacing the word typed', async () => {
    const [first] = await at_end('/liv')
    expect(first).toMatchObject({ label: 'Livro', text: '/Livro ', cursor: 7 })
  })

  it('offers the objects of a relation, quoting titles with spaces', async () => {
    const found = await at_end('/Livro Duna autor:fra')
    expect(found.map((c) => c.label)).toEqual(['Frank Herbert'])
    expect(found[0]).toMatchObject({ detail: 'Pessoa', text: '/Livro Duna autor:"Frank Herbert" ' })
    // Words typed after a space still look for the name.
    expect((await at_end('/Livro Duna autor:frank her'))[0]!.text).toBe('/Livro Duna autor:"Frank Herbert" ')
    // In the middle of the line, the rest stays.
    const text = '/Livro Duna autor:da nota:5'
    const [middle] = await complete(text, text.indexOf(' nota'), source)
    expect(middle!.text).toBe('/Livro Duna autor:"Dan Simmons" nota:5')
  })

  it('offers days for a relation to daily notes, latest first, and reads one typed', async () => {
    expect((await at_end('/Livro Duna lido:')).map((c) => c.text.split('lido:')[1])).toEqual(['2026-10-19 ', '2026-10-17 '])
    expect((await at_end('/Livro Duna lido:tomorrow'))[0]!.text).toBe('/Livro Duna lido:2026-10-20 ')
  })

  it('offers the options of a select not chosen yet, keeping the ones before a comma', async () => {
    const found = await at_end('/Livro Duna gênero:clássico,fic')
    expect(found.map((c) => c.text)).toEqual(['/Livro Duna gênero:"clássico,Ficção científica" '])
  })

  it('offers nothing in the body, nor for a text without a type', async () => {
    expect(await at_end('/Livro Duna\nautor:fra')).toEqual([])
    expect(await at_end('Duna autor:fra')).toEqual([])
  })
})

describe('completions of a line of food', () => {
  const types = createBuiltinTypes('s', at, [...createBuiltinTypes('s', at).map((t) => t.system!), 'food', 'recipe'])
  const foods = [
    { ...summary('white', builtinTypeId('s', 'food'), 'White bread'), props: { portions: { kind: 'portions', value: [{ name: 'slice', grams: 25 }] } } } as ObjectSummary,
    { ...summary('rice', builtinTypeId('s', 'food'), 'Rice'), props: {} } as ObjectSummary,
  ]
  const food: CompletionSource = {
    types,
    today: '2026-10-19',
    objects: async (typeIds, text) => foods.filter((o) => typeIds.includes(o.typeId) && o.title.toLowerCase().includes(text.toLowerCase())),
  }
  const end = (text: string) => complete(text, text.length, food)

  it('offers /food after "/" once the space tracks food, and not the Food type', async () => {
    expect((await end('/fo')).map((c) => c.label)).toEqual(['/food'])
    expect((await at_end('/fo')).map((c) => c.label)).not.toContain('/food')
  })

  it('offers foods after an amount, and nothing while an amount is typed', async () => {
    const [bread] = await end('/food 2 slices of whi')
    expect(bread).toMatchObject({ label: 'White bread', detail: '1 slice = 25 g', text: '/food 2 slices of White bread ', cursor: 30 })
    expect((await end('/food white bread 2 slices, ri')).map((c) => c.text)).toEqual(['/food white bread 2 slices, Rice '])
    expect(await end('/food rice 15')).toEqual([])
    expect(await end('/food rice')).toEqual([])
  })
})
