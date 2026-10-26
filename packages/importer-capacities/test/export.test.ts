import { describe, expect, it } from 'vitest'
import { BODY_PROPERTY_ID, createBuiltinTypes, type DocNode, type ObjectRecord, type PropertyDef } from '@vasta/core'
import { humanize, mapExport, type ExportTarget } from '../src/export.ts'

const at = '2026-10-26T12:00:00.000Z'
const file = (fields: string, body = '') => `---\n${fields}\n---\n\n${body}\n`

function target(extra: Partial<ExportTarget> = {}): ExportTarget {
  let n = 0
  return { spaceId: 's', types: createBuiltinTypes('s', at), tags: [], dailyNote: () => undefined, exists: () => false, newId: () => `id${++n}`, ...extra }
}

const markdown: Record<string, string> = {
  'Pessoas/Ada Lovelace.md': file("type: 'Pessoa'\ntitle: Ada Lovelace\naliases: Ada, Countess\ntags: [Math, History]\ncategoria: Autor, Matemática\ncontato: null"),
  'Pessoas/Bob.md': file("type: 'Pessoa'\ntitle: Bob\ntags: [Math]\ncategoria: Amigo"),
  'Livros/Notes on the Engine.md': file(
    "type: 'Livro'\ntitle: Notes on the Engine\nautor: ['[Ada Lovelace](../Pessoas/Ada%20Lovelace.md)']\nlido: true\npaginas: 120\nlidoEm: '2026-05-02T19:30:00.000Z -> 2026-05-02T22:00:00.000Z'\nsite: https://example.com/notes\ncapa: '[Cover](../Images/Cover.md)'",
    'Written by [Ada](../Pessoas/Ada%20Lovelace.md), see [[Bob|my friend]] and [[Date/2026-05-04]].\n\n[Bob](../Pessoas/Bob.md)\n\n- [ ] read it\n\n[Gone](../Pessoas/Gone.md) and [[Nobody]]'
  ),
  'Images/Cover.md': file("type: 'Image'\ntitle: Cover\ncreatedAt: '2026-05-12T11:01:21.134Z'\ntipoMime: image/png\ncategoria: Photo", 'Media: ![Imagem](./Media/Cover.png)'),
  'Images/Remote.md': file("type: 'Image'\ntitle: Remote", 'Media: ![Imagem](https://example.com/a.jpg)'),
  'Images/Lost.md': file("type: 'Image'\ntitle: Lost", 'Media: Não incluído'),
  'Weblinks/Video.md': file(
    "type: 'Weblink'\ntitle: A video\ndescription: >-\n  A long\n  description\nurl: https://www.youtube.com/watch?v=x\nurlDoIframe: https://www.youtube.com/embed/x\ndominio: www.youtube.com"
  ),
  'Tasks/Write.md': file("type: 'Task'\ntitle: Write\nstatus: In Progress\nprioridade: High\nprazo: '2026-06-01T00:00:00.000Z'\nconcluida: null"),
  'DailyNotes/2026-05-08.md': file("type: 'DailyNote'\ntitle: 8 de maio de 2026\ndate: '2026-05-08T00:00:00.000Z'\nrevisada: false", 'A day with [[Notes on the Engine]].'),
  'Queries/Reading.md': file("type: 'Query'\ntitle: Reading\nicon: ph-books"),
  'Pages/Home.md': file("type: 'Page'\ntitle: Home\nicon: 🏠", '[Reading](../Queries/Reading.md)'),
  'Stray.md': '# no front matter',
}
const media = { 'Images/Media/Cover.png': { key: `${'a'.repeat(64)}.png`, name: 'Cover.png', sizeBytes: 3, mimeType: 'image/png' } }

const byTitle = (objects: ObjectRecord[], title: string) => objects.find((o) => o.title === title)!
const prop = (defs: PropertyDef[], name: string) => defs.find((p) => p.name === name)!

describe('humanize', () => {
  it('splits camel case into a sentence', () => {
    expect(humanize('PersonagemDeRpg')).toBe('Personagem de rpg')
    expect(humanize('percentualDeGordura')).toBe('Percentual de gordura')
    expect(humanize('PDFs')).toBe('PDFs')
  })
})

describe('mapExport', () => {
  const result = mapExport({ markdown, media }, target(), at)
  const { objects, types, report } = result

  it('makes types from the front matter and reads their properties off the values', () => {
    const person = types.find((t) => t.name === 'Pessoa')!
    expect(person.pluralName).toBe('Pessoas')
    expect(prop(person.properties, 'Categoria')).toMatchObject({ kind: 'select', multiple: true })
    expect(person.properties.some((p) => p.name === 'Contato')).toBe(false)

    const book = types.find((t) => t.name === 'Livro')!
    expect(prop(book.properties, 'Autor')).toMatchObject({ kind: 'relation', multiple: true, targetTypeIds: [person.id] })
    expect(prop(book.properties, 'Capa')).toMatchObject({ kind: 'relation', multiple: false, targetTypeIds: ['image:s'] })
    expect(prop(book.properties, 'Lido')).toMatchObject({ kind: 'checkbox' })
    expect(prop(book.properties, 'Paginas')).toMatchObject({ kind: 'number' })
    expect(prop(book.properties, 'Lido em')).toMatchObject({ kind: 'date', withTime: true, allowRange: true })
    expect(prop(book.properties, 'Site')).toMatchObject({ kind: 'url' })
    expect(report.types.created).toEqual(['Livro', 'Pessoa'])
  })

  it('sets fields, tags and property values', () => {
    const ada = byTitle(objects, 'Ada Lovelace')
    expect(ada.aliases).toEqual(['Ada', 'Countess'])
    const tags = objects.filter((o) => o.typeId === 'tag:s')
    expect(tags.map((t) => t.title).sort()).toEqual(['History', 'Math'])
    expect(byTitle(objects, 'Bob').tagIds).toEqual([tags.find((t) => t.title === 'Math')!.id])

    const book = byTitle(objects, 'Notes on the Engine')
    const defs = types.find((t) => t.name === 'Livro')!.properties
    expect(book.props[prop(defs, 'Autor').id]).toEqual({ kind: 'relation', value: [ada.id] })
    expect(book.props[prop(defs, 'Lido em').id]).toEqual({ kind: 'date', value: { start: '2026-05-02T19:30:00.000Z', end: '2026-05-02T22:00:00.000Z', resolution: 'time' } })
    expect(byTitle(objects, 'Home').icon).toEqual({ kind: 'emoji', value: '🏠' })
    expect(byTitle(objects, 'Reading')).toMatchObject({ icon: { kind: 'icon', value: 'ph:books' }, query: { typeIds: [] } })
  })

  it('turns links to notes into mentions, a link on its own line into an embed, and dates into daily notes', () => {
    const book = byTitle(objects, 'Notes on the Engine')
    const [first, embed, list, last] = book.content[BODY_PROPERTY_ID]!.content as DocNode[]
    const daily = objects.find((o) => o.typeId === 'daily-note:s' && o.date?.start.startsWith('2026-05-04'))!
    expect(first!.content!.filter((n) => n.type === 'mention').map((n) => n.attrs)).toEqual([
      { objectId: byTitle(objects, 'Ada Lovelace').id, label: 'Ada' },
      { objectId: byTitle(objects, 'Bob').id, label: 'my friend' },
      { objectId: daily.id, label: '2026-05-04' },
    ])
    expect(embed).toEqual({ type: 'objectEmbed', attrs: { objectId: byTitle(objects, 'Bob').id, display: 'inline' } })
    expect(list!.type).toBe('taskList')
    expect(last!.content!.map((n) => n.text)).toEqual(['Gone', ' and ', 'Nobody'])
    expect(report.unresolvedLinks).toEqual(['Gone', 'Nobody'])
    expect((byTitle(objects, 'Home').content[BODY_PROPERTY_ID]!.content[0] as DocNode).attrs).toMatchObject({ display: 'embed' })
  })

  it('reads media and weblinks into their fields', () => {
    expect(byTitle(objects, 'Cover').media).toEqual({ file: media['Images/Media/Cover.png'], sizeBytes: 3, mimeType: 'image/png' })
    expect(byTitle(objects, 'Cover').createdAt).toBe('2026-05-12T11:01:21.134Z')
    expect(byTitle(objects, 'Remote').media).toEqual({ url: 'https://example.com/a.jpg', host: 'example.com' })
    expect(report.media).toEqual({ attached: 1, missing: ['Images/Lost.md'] })
    expect(byTitle(objects, 'A video')).toMatchObject({
      description: 'A long description',
      media: { url: 'https://www.youtube.com/watch?v=x', embedUrl: 'https://www.youtube.com/embed/x', host: 'www.youtube.com' },
    })
  })

  it("maps a task's status, priority and due date to the Task type's", () => {
    const task = byTitle(objects, 'Write')
    expect(task.props).toEqual({ status: { kind: 'select', value: ['doing'] }, priority: { kind: 'select', value: ['high'] }, due: { kind: 'date', value: { start: '2026-06-01T00:00:00.000Z', resolution: 'day' } } })
  })

  it('gives daily notes their day and derived id, and skips files without a type', () => {
    const note = objects.find((o) => o.date?.start === '2026-05-08T00:00:00.000Z')!
    expect(note).toMatchObject({ id: 'daily-s-2026-05-08', title: '' })
    expect(report.skipped).toEqual(['Stray.md'])
  })
})

describe('mapExport into a space with notes', () => {
  it('shares types and tags by name, and adds to the daily note of a day', () => {
    const existingNote: ObjectRecord = {
      id: 'mine',
      spaceId: 's',
      typeId: 'daily-note:s',
      title: '',
      aliases: [],
      tagIds: [],
      collectionIds: [],
      props: {},
      content: { [BODY_PROPERTY_ID]: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'mine' }] }] } },
      date: { start: '2026-05-08T00:00:00.000Z', resolution: 'day' },
      createdAt: at,
      updatedAt: at,
    }
    const person = { ...createBuiltinTypes('s', at)[0]!, id: 'people', name: 'pessoa', system: undefined, properties: [{ id: 'cat', kind: 'select' as const, name: 'Categoria', multiple: true, options: [{ id: 'o1', label: 'autor' }] }] }
    const { objects, types, report } = mapExport(
      { markdown, media },
      target({ types: [...createBuiltinTypes('s', at), person], tags: [{ id: 'math', title: 'math' }], dailyNote: (day) => (day === '2026-05-08' ? existingNote : undefined) }),
      at
    )
    expect(report.types.matched).toEqual(['pessoa'])
    const ada = byTitle(objects, 'Ada Lovelace')
    expect(ada.typeId).toBe('people')
    expect(ada.props.cat).toEqual({ kind: 'select', value: ['o1', expect.any(String)] })
    expect(types.find((t) => t.id === 'people')!.properties[0]).toMatchObject({ options: [{ label: 'autor' }, { label: 'Matemática' }, { label: 'Amigo' }] })
    expect(ada.tagIds[0]).toBe('math')
    expect(report.tags).toEqual({ created: 1, matched: 1 })

    const note = objects.find((o) => o.id === 'mine')!
    expect(note.content[BODY_PROPERTY_ID]!.content.map((n) => n.content?.[0]?.text)).toEqual(['mine', 'A day with '])
    expect(report.mergedDailyNotes).toBe(1)
  })
})
