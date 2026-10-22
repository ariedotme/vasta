import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { builtinTypeId, createBuiltinTypes, type ObjectType } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { CaptureService } from '../src/capture.ts'
import { isCapturable, leadingType, parseCaptureLine, parseDay } from '@vasta/core'

// 2026-10-18 is a Sunday.
const context = { today: '2026-10-18', timeZone: 'America/Sao_Paulo' }
const at = '2026-10-18T12:00:00.000Z'
const task = createBuiltinTypes('s', at).find((t) => t.system === 'task')!
const book: ObjectType = {
  id: 'book', spaceId: 's', name: 'Livro', pluralName: 'Livros', createdAt: at, updatedAt: at, views: [],
  properties: [
    { id: 'body', kind: 'rich-text', name: 'Notes' },
    { id: 'author', kind: 'relation', name: 'Autor', targetTypeIds: ['person'], multiple: false },
    { id: 'rating', kind: 'number', name: 'Nota' },
    { id: 'read', kind: 'checkbox', name: 'Lido' },
    { id: 'genre', kind: 'select', name: 'Gênero', multiple: true, options: [{ id: 'scifi', label: 'Ficção científica' }] },
    { id: 'site', kind: 'url', name: 'Site' },
  ],
}

describe('capture line', () => {
  it('reads task properties in Portuguese and English, leaving other words in the title', () => {
    const parsed = parseCaptureLine('Comprar café due:sexta priority:alta', task, context)
    expect(parsed).toMatchObject({ title: 'Comprar café', errors: [], newOptions: [] })
    expect(parsed.props).toEqual({
      due: { kind: 'date', value: { start: '2026-10-23T00:00:00.000Z', resolution: 'day' } },
      priority: { kind: 'select', value: ['high'] },
    })
    // A time after the date, aliases for keys and options, a unique prefix.
    expect(parseCaptureLine('Call Ana prazo:amanhã 15h30 prio:low status:feito', task, context).props).toEqual({
      due: { kind: 'date', value: { start: '2026-10-19T18:30:00.000Z', resolution: 'time' } },
      priority: { kind: 'select', value: ['low'] },
      status: { kind: 'select', value: ['done'] },
    })
    expect(parseCaptureLine('Re: meeting at https://example.com/x note:yes', task, context)).toMatchObject({ title: 'Re: meeting at https://example.com/x note:yes', props: {} })
  })

  it('reads days', () => {
    expect(parseDay('hoje', context.today)).toBe('2026-10-18')
    expect(parseDay('Domingo', context.today)).toBe('2026-10-25') // the next one, not today
    expect(parseDay('monday', context.today)).toBe('2026-10-19')
    expect(parseDay('terça-feira', context.today)).toBe('2026-10-20')
    expect(parseDay('25/10', context.today)).toBe('2026-10-25')
    expect(parseDay('10/10', context.today)).toBe('2027-10-10') // passed this year
    expect(parseDay('1/2/27', context.today)).toBe('2027-02-01')
    expect(parseDay('2026-12-01', context.today)).toBe('2026-12-01')
    expect(parseDay('31/02', context.today)).toBeUndefined()
    expect(parseCaptureLine('Pay rent due:31/02', task, context)).toMatchObject({ title: 'Pay rent due:31/02', props: {}, errors: ['Due: “31/02”'] })
    expect(parseCaptureLine('Standup due:"segunda 9:30"', task, context).props.due).toEqual({ kind: 'date', value: { start: '2026-10-19T12:30:00.000Z', resolution: 'time' } })
    expect(parseCaptureLine('Lunch due:1pm', task, context).props.due).toEqual({ kind: 'date', value: { start: '2026-10-18T16:00:00.000Z', resolution: 'time' } })
  })

  it('reads every kind of property, with quotes, lists and new options', () => {
    const parsed = parseCaptureLine('Duna autor:"Frank Herbert" nota:4,5 lido:sim genero:"ficção científica,Clássico" site:https://dune.example', book, context)
    expect(parsed.title).toBe('Duna')
    expect(parsed.props).toMatchObject({
      rating: { kind: 'number', value: 4.5 },
      read: { kind: 'checkbox', value: true },
      site: { kind: 'url', value: 'https://dune.example' },
    })
    expect(parsed.relations).toEqual([{ propertyId: 'author', titles: ['Frank Herbert'] }])
    expect(parsed.newOptions.map((n) => n.option.label)).toEqual(['Clássico'])
    expect(parsed.props.genre).toEqual({ kind: 'select', value: ['scifi', parsed.newOptions[0]!.option.id] })
    expect(parseCaptureLine('Emma nota:muito', book, context).errors).toEqual(['Nota: “muito”'])
  })
})

describe('leading type', () => {
  const list: ObjectType = { ...book, id: 'list', name: 'Reading list', pluralName: 'Reading lists' }
  const types = [...createBuiltinTypes('s', at), book, list]

  it('finds the longest run of words that names a type, with or without a slash', () => {
    expect(leadingType(types, '/Livro Duna nota:5')).toMatchObject({ type: { id: 'book' }, rest: 'Duna nota:5' })
    expect(leadingType(types, 'livros Duna')).toMatchObject({ type: { id: 'book' }, rest: 'Duna' })
    expect(leadingType(types, '/reading list Summer\nbooks to take')).toMatchObject({ type: { id: 'list' }, rest: 'Summer\nbooks to take' })
    expect(leadingType(types, '/task Buy coffee')).toMatchObject({ type: { system: 'task' }, rest: 'Buy coffee' })
    expect(leadingType(types, '/Livro')).toMatchObject({ type: { id: 'book' }, rest: '' })
    expect(leadingType(types, '/usr/bin is a folder')).toBeUndefined()
  })

  it('offers types made from a title and properties', () => {
    expect(types.filter(isCapturable).map((t) => t.system ?? t.id)).toEqual(['page', 'tag', 'collection', 'task', 'habit', 'book', 'list'])
  })
})

describe('capture with a line', () => {
  it('creates missing relation targets and select options once, and reuses them', async () => {
    const store = new NodeStore(':memory:')
    store.putSpace({ id: 's', name: 'Space', sidebar: [], createdAt: at })
    for (const type of createBuiltinTypes('s', at)) store.putType(type)
    store.putType({ ...book, properties: book.properties.map((p) => (p.kind === 'relation' ? { ...p, targetTypeIds: ['person'] } : p)) })
    store.putType({ id: 'person', spaceId: 's', name: 'Pessoa', pluralName: 'Pessoas', properties: [], views: [], createdAt: at, updatedAt: at })
    const capture = new CaptureService({ store, media: new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-line-'))), now: () => at, timeZone: 'America/Sao_Paulo' })

    const first = await capture.object({ type: 'livro', line: 'Duna autor:"Frank Herbert" genero:Clássico nota:5' })
    expect(first.summary).toBe('Livro “Duna”, autor Frank Herbert, nota 5, gênero Clássico')
    const herbert = first.objects[1]!
    expect(herbert).toMatchObject({ title: 'Frank Herbert', typeId: 'person' })
    expect(store.getObject(first.objects[0]!.id)!.props.author).toEqual({ kind: 'relation', value: [herbert.id] })

    const second = await capture.object({ type: 'livro', line: 'Messias autor:"frank herbert" genero:classico' })
    expect(second.objects).toHaveLength(1)
    expect(store.getObject(second.objects[0]!.id)!.props.author).toEqual({ kind: 'relation', value: [herbert.id] })
    const genre = store.getType('book')!.properties.find((p) => p.id === 'genre')
    expect(genre?.kind === 'select' && genre.options.map((o) => o.label)).toEqual(['Ficção científica', 'Clássico'])

    // A relation to daily notes takes a day: that day's note, made when missing.
    store.putType({ ...book, id: 'reading', name: 'Leitura', pluralName: 'Leituras', properties: [{ id: 'day', kind: 'relation', name: 'Dia', targetTypeIds: [builtinTypeId('s', 'daily-note')], multiple: true }] })
    const reading = await capture.object({ type: 'leitura', line: 'Capítulo 3 dia:hoje,amanhã' })
    const days = (store.getObject(reading.objects[0]!.id)!.props.day as { value: string[] }).value.map((id) => store.getObject(id)?.date?.start.slice(0, 10))
    expect(days).toEqual(['2026-10-18', '2026-10-19'])

    const todo = await capture.task({ line: 'Comprar café due:sexta priority:alta', priority: 'low' })
    expect(todo.summary).toBe('Task “Comprar café”, due Fri 23 Oct, priority Low')
    expect(store.listObjects(builtinTypeId('s', 'task'))[0]!.props.status).toEqual({ kind: 'select', value: ['todo'] })
  })
})
