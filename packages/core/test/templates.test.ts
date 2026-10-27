import { describe, expect, it } from 'vitest'
import { Y, readContent } from '@vasta/editor-schema/yjs'
import { createBuiltinTypes } from '../src/builtin-types.ts'
import type { Doc, DocNode, ObjectRecord, ObjectType } from '../src/model.ts'
import { dailyNoteId } from '../src/operations.ts'
import {
  applySnippet, applyTemplate, findTemplate, formatTemplateDate, parsePlaceholder, scopeAppliesSomewhere, seededText, shiftTemplateDay, snippetApplies,
  templateAsks, templateFromObject, type TemplateContext,
} from '../src/templates.ts'

const AT = '2026-10-22T13:05:00.000Z'
const types = createBuiltinTypes('s', AT)
const typeMap = new Map(types.map((t) => [t.id, t]))
const task = types.find((t) => t.system === 'task')!
const page = types.find((t) => t.system === 'page')!
const daily = types.find((t) => t.system === 'daily-note')!
const text = (value: string, marks?: DocNode['marks']): DocNode => ({ type: 'text', text: value, ...(marks ? { marks } : {}) })
const chip = (value: string): DocNode => ({ type: 'templatePlaceholder', attrs: { value } })
const paragraph = (...content: DocNode[]): DocNode => ({ type: 'paragraph', attrs: { id: 'p' + Math.random().toString(36).slice(2, 6) }, content })
const doc = (...content: DocNode[]): Doc => ({ type: 'doc', content })
const branch = (condition: string | null, ...content: DocNode[]): DocNode => ({ type: 'templateBranch', attrs: { condition }, content })

function template(type: ObjectType, data: Partial<ObjectRecord>, info: Partial<NonNullable<ObjectRecord['template']>> = {}): ObjectRecord {
  return {
    id: 't1', spaceId: 's', typeId: type.id, title: '', aliases: [], tagIds: [], collectionIds: [], props: {}, content: {},
    createdAt: AT, updatedAt: AT, ...data,
    template: { kind: 'template', name: 'T', ...info } as ObjectRecord['template'],
  }
}

const context = (extra: Partial<TemplateContext> = {}): TemplateContext => ({
  at: AT, today: '2026-10-22', timeZone: 'America/Sao_Paulo', types: typeMap, me: 'u1',
  people: [{ id: 'u1', username: 'arie', name: 'Arie' }, { id: 'u2', username: 'lena', name: 'Lena' }], ...extra,
})

const texts = (d: Doc | undefined) => (d?.content ?? []).map((n) => (n.content ?? []).map((c) => c.text ?? (c.type === 'mention' ? `@${c.attrs?.label}` : `<${c.type}>`)).join(''))

describe('placeholders', () => {
  it('reads names, arguments and formats', () => {
    expect(parsePlaceholder('date')).toEqual({ name: 'date', arg: '' })
    expect(parsePlaceholder('date:+7d|D MMM')).toEqual({ name: 'date', arg: '+7d', format: 'D MMM' })
    expect(parsePlaceholder('date|YYYY')).toEqual({ name: 'date', arg: '', format: 'YYYY' })
    expect(parsePlaceholder('choose:Kind|Bug|Feature')).toEqual({ name: 'choose', arg: 'Kind|Bug|Feature' })
    expect(parsePlaceholder('ask:With whom?')).toEqual({ name: 'ask', arg: 'With whom?' })
    expect(parsePlaceholder('data')).toBeUndefined()
  })

  it('shifts and formats days', () => {
    expect(shiftTemplateDay('2026-10-22', '+7d')).toBe('2026-10-29')
    expect(shiftTemplateDay('2026-10-22', '-1w')).toBe('2026-10-15')
    expect(shiftTemplateDay('2026-01-31', '+1m')).toBe('2026-03-03')
    expect(shiftTemplateDay('2026-10-22', 'next monday')).toBe('2026-10-26')
    expect(shiftTemplateDay('2026-10-22', 'nonsense')).toBeUndefined()
    expect(formatTemplateDate('2026-10-22', 'dddd, D MMMM YYYY [at] HH:mm', { hour: 9, minute: 5 })).toBe('Thursday, 22 October 2026 at 09:05')
  })
})

describe('applying a template', () => {
  it('fills the title, text properties and properties a value cannot hold', () => {
    const bug = template(task, { title: '{{title}} ({{date|D MMM}})', props: { status: { kind: 'select', value: ['todo'] } } }, { fills: { due: 'date:+7d', assignee: 'me', priority: 'choose:Priority|High|Low' } })
    const made = applyTemplate(bug, task, context({ title: 'Login breaks', answers: { Priority: 'High' } }))
    expect(made.title).toBe('Login breaks (22 Oct)')
    expect(made.props).toEqual({
      status: { kind: 'select', value: ['todo'] },
      due: { kind: 'date', value: { start: '2026-10-29T00:00:00.000Z', resolution: 'day' } },
      assignee: { kind: 'person', value: ['u1'] },
      priority: { kind: 'select', value: ['high'] },
    })
  })

  it('keeps the typed title over a template title without {{title}}', () => {
    expect(applyTemplate(template(task, { title: 'Untitled bug' }), task, context({ title: 'Mine' })).title).toBe('Mine')
    expect(applyTemplate(template(task, { title: 'Untitled bug' }), task, context()).title).toBe('Untitled bug')
  })

  it('replaces chips in the text, keeping their marks, and gives blocks new ids', () => {
    const meeting = template(page, {
      title: 'Meeting with {{ask:With whom?}}',
      content: { body: doc(paragraph(text('With '), { ...chip('ask:With whom?'), marks: [{ type: 'bold' }] }, text(' on {{date|dddd}}')), paragraph(text('Before: '), chip('yesterday')), paragraph(chip('cursor'))) },
    })
    expect(templateAsks(meeting)).toEqual([{ label: 'With whom?' }])
    const made = applyTemplate(meeting, page, context({ answers: { 'With whom?': 'Lena' } }))
    expect(made.title).toBe('Meeting with Lena')
    expect(texts(made.content.body)).toEqual(['With Lena on Thursday', 'Before: @Wednesday, October 21, 2026', ''])
    expect(made.content.body!.content[0]!.content![1]).toEqual({ type: 'text', text: 'Lena', marks: [{ type: 'bold' }] })
    expect(made.content.body!.content[1]!.content![1]!.attrs?.objectId).toBe(dailyNoteId('s', '2026-10-21'))
    const ids = made.content.body!.content.map((n) => n.attrs?.id)
    expect(ids).not.toContain(meeting.content.body!.content[0]!.attrs?.id)
    expect(made.cursor).toEqual({ field: 'body', blockId: ids[2], offset: 0 })
  })

  it('keeps the first branch whose condition holds', () => {
    const t = template(daily, {
      content: {
        body: doc(
          { type: 'templateIf', content: [branch('weekday(date) = 1', paragraph(text('Weekly review'))), branch('weekday(date) = 5', paragraph(text('Wrap up'))), branch(null, paragraph(text('Plain day')))] },
          { type: 'templateIf', content: [branch('ask("Kind") = "Bug"', paragraph(text('Steps'))), branch('has("Due") and empty(prop("Due"))', paragraph(text('No due')))] },
          paragraph(chip('formula:if(weekday(date) > 5, "Weekend", "Weekday")'))
        ),
      },
    })
    expect(texts(applyTemplate(t, daily, context({ day: '2026-10-26' })).content.body)).toEqual(['Weekly review', 'Weekday'])
    expect(texts(applyTemplate(t, daily, context({ day: '2026-10-23', answers: { Kind: 'Bug' } })).content.body)).toEqual(['Wrap up', 'Steps', 'Weekday'])
    expect(texts(applyTemplate(t, daily, context({ day: '2026-10-25' })).content.body)).toEqual(['Plain day', 'Weekend'])
    expect(templateAsks(t)).toEqual([{ label: 'Kind' }])
  })

  it('asks ask() with answers as a choice, in conditions and formulas', () => {
    const t = template(page, {
      title: '{{ask:Body}}',
      content: {
        body: doc(
          { type: 'templateIf', content: [branch('ask("Body", "Yes", "No") = "Yes"', paragraph(text('Quote')))] },
          paragraph(chip('formula:if(ask(\'Mood\', "Good", \'Bad\') = "Good", "🙂", "🙁")'))
        ),
      },
    })
    expect(templateAsks(t)).toEqual([{ label: 'Body', options: ['Yes', 'No'] }, { label: 'Mood', options: ['Good', 'Bad'] }])
    expect(texts(applyTemplate(t, page, context({ answers: { Body: 'Yes', Mood: 'Bad' } })).content.body)).toEqual(['Quote', '🙁'])
    expect(texts(applyTemplate(t, page, context({ answers: { Body: 'No', Mood: 'Good' } })).content.body)).toEqual(['🙂'])
  })

  it('reads a formula with braces in it as one placeholder', () => {
    const t = template(page, {
      content: {
        body: doc(
          paragraph(chip('formula:if(ask("Body", "Yes", "No") = "Yes", "{ quote }", "")')),
          paragraph(chip('formula:if(selection(“Body”).= “Yes", "> {{cursor}}", "")'))
        ),
      },
    })
    expect(texts(applyTemplate(t, page, context({ answers: { Body: 'Yes' } })).content.body)).toEqual(['{ quote }', ''])
  })

  it('reads the properties it set in conditions', () => {
    const t = template(task, { content: { body: doc({ type: 'templateIf', content: [branch('has("Due") and not empty(prop("Due"))', paragraph(text('Has a due date')))] }) } }, { fills: { due: 'date:+1d' } })
    expect(texts(applyTemplate(t, task, context()).content.body)).toEqual(['Has a due date'])
  })

  it('leaves out what differs between devices when seeded, and gives the same ids each time', () => {
    const t = template(daily, { content: { body: doc(paragraph(text('At {{time}} by '), chip('me'), text(' {{ask:Mood}}')), paragraph(text('{{date|D MMM}}'))) } })
    const a = applyTemplate(t, daily, context({ day: '2026-11-02', seed: 'n1' }))
    const b = applyTemplate(t, daily, context({ day: '2026-11-02', seed: 'n1', answers: { Mood: 'ok' } }))
    expect(texts(a.content.body)).toEqual(['At  by  ', '2 Nov'])
    expect(a).toEqual(b)
  })

  it('takes the selection as blocks alone in a paragraph, else as text', () => {
    const t = template(page, { content: { body: doc(paragraph(chip('selection')), paragraph(text('Quote: '), chip('selection'))) } })
    const made = applyTemplate(t, page, context({ selection: [paragraph(text('one')), paragraph(text('two'))] }))
    expect(texts(made.content.body)).toEqual(['one', 'two', 'Quote: one\ntwo'])
  })

  it('finds templates by name and makes one from an object without its captures and comments', () => {
    const templates = [template(task, { id: 'a' }, { name: 'Bug' }), template(task, { id: 'b' }, { name: 'Feature', default: true }), template(page, { id: 'c' }, { name: 'Bug' })]
    expect(findTemplate(templates, task.id, 'bug')?.id).toBe('a')
    expect(findTemplate(templates, task.id, 'fea')?.id).toBe('b')
    expect(findTemplate(templates, task.id, 'x')).toBeUndefined()
    const source: ObjectRecord = {
      id: 'o', spaceId: 's', typeId: daily.id, title: '', aliases: [], tagIds: [], collectionIds: [], createdAt: AT, updatedAt: AT,
      date: { start: '2026-10-22T00:00:00.000Z', resolution: 'day' },
      props: { 'comment:1': { kind: 'comment', value: { author: 'u1', at: AT, text: 'hi' } } },
      content: { body: doc({ type: 'callout', attrs: { icon: null, capture: { id: 'c', channel: 'api', at: AT } }, content: [paragraph(text('x', [{ type: 'highlight', attrs: { color: 'yellow', quoteId: 'q' } }]))] }) },
    }
    const made = templateFromObject(source, daily, 'My day', 'new', AT)
    expect(made.props).toEqual({})
    expect(made.date).toBeUndefined()
    expect(made.content.body!.content[0]!.attrs).toEqual({ icon: null })
    expect(made.content.body!.content[0]!.content![0]!.content![0]!.marks).toEqual([{ type: 'highlight', attrs: { color: 'yellow' } }])
    expect(made.template).toEqual({ kind: 'template', name: 'My day' })
  })
})

describe('snippets', () => {
  const snippet = (body: DocNode[], scope?: NonNullable<Extract<ObjectRecord['template'], { kind: 'snippet' }>['scope']>): ObjectRecord => ({
    id: 'sn', spaceId: 's', typeId: page.id, title: 'Sig', aliases: [], tagIds: [], collectionIds: [], props: {}, createdAt: AT, updatedAt: AT,
    content: { body: doc(...body) },
    template: { kind: 'snippet', name: 'Sig', ...(scope ? { scope } : {}) },
  })
  const target: ObjectRecord = {
    id: 'o', spaceId: 's', typeId: task.id, title: 'Fix it', aliases: [], tagIds: [], collectionIds: [], content: {}, createdAt: AT, updatedAt: AT,
    props: { status: { kind: 'select', value: ['doing'] } },
  }

  it('is inline for one paragraph, blocks otherwise, reading the object it goes into', () => {
    expect(applySnippet(snippet([paragraph(text('— {{title}}, '), chip('formula:prop("Status")'), chip('cursor'))]), target, task, context())).toEqual({
      inline: [text('— Fix it, '), text('In progress')],
      cursor: { offset: 21 },
    })
    const blocks = applySnippet(snippet([paragraph(text('a')), paragraph(text('b'))]), target, task, context())
    expect(blocks.inline).toBeUndefined()
    expect(texts({ type: 'doc', content: blocks.blocks! })).toEqual(['a', 'b'])
  })

  it('applies where its scope says', () => {
    const ctx = { today: '2026-10-22', timeZone: 'UTC', types: typeMap }
    expect(snippetApplies(snippet([], { typeIds: [page.id] }), target, task, ctx)).toBe(false)
    expect(snippetApplies(snippet([], { requires: [{ name: 'due', kind: 'date' }] }), target, task, ctx)).toBe(true)
    expect(snippetApplies(snippet([], { requires: [{ name: 'Due', kind: 'date', set: true }] }), target, task, ctx)).toBe(false)
    expect(snippetApplies(snippet([], { when: 'prop("Status") != "Done"' }), target, task, ctx)).toBe(true)
    expect(snippetApplies(snippet([], { when: 'prop("Status") = "Done"' }), target, task, ctx)).toBe(false)
    expect(scopeAppliesSomewhere({ requires: [{ name: 'Due', kind: 'date' }] }, types)).toBe(true)
    expect(scopeAppliesSomewhere({ requires: [{ name: 'Due', kind: 'number' }] }, types)).toBe(false)
  })
})

describe('seeded daily text', () => {
  const content = { body: doc(paragraph(text('Plan')), { type: 'callout', attrs: { id: 'c1' }, content: [paragraph(text('Inside'))] }) }

  it('merges two devices’ seeds into one copy and keeps both their edits', () => {
    const a = seededText('daily-s-2026-11-02', content)
    const b = seededText('daily-s-2026-11-02', content)
    for (const [ydoc, word] of [[a, 'From A'], [b, 'From B']] as const) {
      const p = new Y.XmlElement('paragraph')
      p.insert(0, [new Y.XmlText(word)])
      ydoc.getXmlFragment('body').push([p])
    }
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    expect(texts(readContent(a).body as Doc).slice(0, 2)).toEqual(['Plan', '<paragraph>'])
    expect(texts(readContent(a).body as Doc).slice(2).sort()).toEqual(['From A', 'From B'])
    expect(readContent(a)).toEqual(readContent(b))
    expect(readContent(a).body!.content.length).toBe(4)
    expect(a.clientID).not.toBe(b.clientID)
  })

  it('uses another client id for another text', () => {
    const other = { body: doc(paragraph(text('Plan!'))) }
    const a = seededText('n', content)
    const b = seededText('n', other)
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    expect(readContent(a).body!.content.length).toBe(3)
  })
})

