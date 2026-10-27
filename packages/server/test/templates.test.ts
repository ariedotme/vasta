// Templates and snippets are objects kept apart: no listing, search, query, link, count or feed
// may show them. Every way the API lists objects runs here on a space that has some.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { builtinTypeId, createBuiltinTypes, type ObjectRecord } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { AccountService } from '../src/accounts.ts'
import { AgentTools } from '../src/agent.ts'
import { createApp } from '../src/app.ts'
import { CaptureService } from '../src/capture.ts'
import { ChangeFeed } from '../src/events.ts'
import { asUser } from './helpers.ts'

const at = '2026-10-22T12:00:00.000Z'
const json = (body: unknown, method = 'POST') => ({ method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

function setup() {
  const store = new NodeStore(':memory:')
  store.putSpace({ id: 's', name: 'Space', sidebar: [], createdAt: at })
  for (const type of createBuiltinTypes('s', at)) store.putType(type)
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-templates-')))
  const feed = new ChangeFeed()
  const capture = new CaptureService({ store, media, feed, now: () => at, timeZone: 'UTC' })
  const app = createApp({ store, media, feed, capture, now: () => at })
  const user = asUser(app, store, { spaces: ['s'] })
  const agent = new AgentTools({ store, accounts: new AccountService({ store, now: () => at, capture }), feed, now: () => at, user: user.user, webUrl: 'https://vasta.test' })
  return { store, app, user, agent }
}

describe('templates', () => {
  it('never show in a listing, search, query, backlink, count, calendar, inbox, trash or agent tool', async () => {
    const { store, user, agent } = setup()
    const task = builtinTypeId('s', 'task')
    const page = builtinTypeId('s', 'page')
    const create = async (body: Partial<ObjectRecord>) => (await (await user.request('/api/objects', json(body))).json()) as ObjectRecord
    const target = await create({ typeId: page, title: 'Target page' })
    const mention = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Leaky words ' }, { type: 'mention', attrs: { objectId: target.id, label: 'Target page' } }] }] }
    const dated = { kind: 'date', value: { start: '2026-10-22T00:00:00.000Z', resolution: 'day' } }
    const made = [
      await create({ typeId: task, title: 'Leaky task', props: { due: dated as never }, tagIds: [], content: { body: mention as never }, template: { kind: 'template', name: 'Leaky', default: true } }),
      await create({ typeId: page, title: 'Leaky snippet', content: { body: mention as never }, template: { kind: 'snippet', name: 'Leaky snippet', trigger: 'leak' } }),
      await create({ typeId: builtinTypeId('s', 'daily-note'), title: 'Leaky day', date: dated.value as never, template: { kind: 'template', name: 'Day' } }),
    ]
    const leaks = (value: unknown) => {
      const text = JSON.stringify(value)
      return made.filter((t) => text.includes(t.id)).map((t) => t.template!.name)
    }
    const get = async (url: string) => (await user.request(url)).json()
    const post = async (url: string, body: unknown) => (await user.request(url, json(body))).json()

    expect(leaks(await get(`/api/types/${task}/objects`))).toEqual([])
    expect(leaks(await get(`/api/types/${page}/objects`))).toEqual([])
    const bundle = (await get('/api/spaces/s')) as { counts: Record<string, number> }
    expect(bundle.counts[task]).toBeUndefined()
    expect(bundle.counts[page]).toBe(1)
    expect(leaks(await get('/api/spaces/s/search?q=leaky'))).toEqual([])
    expect(leaks(await get('/api/spaces/s/search?q='))).toEqual([])
    expect(leaks(await post('/api/spaces/s/query', { query: { typeIds: [] } }))).toEqual([])
    expect(leaks(await post('/api/spaces/s/query', { query: { typeIds: [task] } }))).toEqual([])
    expect(leaks(await post('/api/spaces/s/query', { query: { typeIds: [], filter: { kind: 'group', operator: 'and', items: [{ kind: 'filter', field: 'createdAt', operator: 'after', value: { kind: 'variable', name: 'today', offsetDays: -30 } }] } } }))).toEqual([])
    expect(leaks(await get(`/api/objects/${target.id}/backlinks`))).toEqual([])
    expect(leaks(await get('/api/spaces/s/calendar?from=2026-10-20&to=2026-10-24'))).toEqual([])
    expect(leaks(await get('/api/spaces/s/inbox?today=2026-10-22&days=7'))).toEqual([])
    expect(leaks(await get('/api/spaces/s/activity'))).toEqual([])
    expect(leaks(agent.search('leaky'))).toEqual([])
    expect(leaks(agent.query({ types: ['Task'] }))).toEqual([])
    expect(leaks(agent.query({}))).toEqual([])
    expect(leaks(agent.types())).toEqual([])
    expect(leaks(agent.dailyNote({ day: '2026-10-22' }))).toEqual([])
    expect(store.findObjectOnDay(builtinTypeId('s', 'daily-note'), '2026-10-22')?.template).toBeUndefined()

    // Listed only on their own.
    const listed = (await get('/api/spaces/s/templates')) as ObjectRecord[]
    expect(listed.map((t) => t.template!.name).sort()).toEqual(['Day', 'Leaky', 'Leaky snippet'])

    // Deleted ones stay out of the trash too.
    for (const t of made) expect((await user.request(`/api/objects/${t.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(leaks(await get('/api/spaces/s/trash'))).toEqual([])
    expect(((await get('/api/spaces/s')) as { trash: number }).trash).toBe(0)
    expect(await get('/api/spaces/s/templates')).toEqual([])
  })

  it('makes the day’s note from the daily note type’s default template', async () => {
    const { user } = setup()
    const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Top 3 for ' }, { type: 'templatePlaceholder', attrs: { value: 'date|dddd' } }] }] }
    await user.request('/api/objects', json({ typeId: builtinTypeId('s', 'daily-note'), title: '', content: { body }, template: { kind: 'template', name: 'Day', default: true } }))
    const note = (await (await user.request('/api/spaces/s/daily-notes/2026-10-23', { method: 'POST' })).json()) as ObjectRecord
    expect(note.template).toBeUndefined()
    expect(note.content.body!.content[0]!.content).toEqual([{ type: 'text', text: 'Top 3 for Friday' }])
  })

  it('starts typed lines from the default template, or the one the line names, with answers from the line', async () => {
    const { user, store } = setup()
    const task = builtinTypeId('s', 'task')
    const body = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
    const create = (data: unknown) => user.request('/api/objects', json(data))
    await create({ typeId: task, title: '', props: { priority: { kind: 'select', value: ['low'] } }, content: { body: body('Default steps') }, template: { kind: 'template', name: 'Chore', default: true } })
    await create({ typeId: task, title: 'Bug: {{title}}', content: { body: body('Reported with {{ask:With whom?}}') }, template: { kind: 'template', name: 'Bug', fills: { due: 'date:+7d' } } })
    const made = async (line: string) => (await (await create({ typeId: task, line })).json()) as ObjectRecord
    const chore = await made('Water plants priority:high')
    expect([chore.title, chore.props.priority, texts(chore)]).toEqual(['Water plants', { kind: 'select', value: ['high'] }, ['Default steps']])
    const bug = await made(':Bug Login breaks with:lena')
    expect([bug.title, texts(bug), bug.props.due?.kind]).toEqual(['Bug: Login breaks', ['Reported with lena'], 'date'])
    // The type and the template in one word, as ⌘K and Telegram read "/Task:Bug …".
    const { leadingType } = await import('@vasta/core')
    expect(leadingType(store.listTypes('s'), '/Task:Bug Login breaks')).toMatchObject({ type: { id: task }, rest: ':Bug Login breaks' })
  })

  it('says which questions a capture line leaves open, and takes their answers', async () => {
    const { user, store } = setup()
    const page = builtinTypeId('s', 'page')
    const { lineAsks } = await import('@vasta/core')
    const create = (data: unknown) => user.request('/api/objects', json(data))
    const branch = { type: 'templateIf', content: [{ type: 'templateBranch', attrs: { condition: 'ask("Body", "Yes", "No") = "Yes"' }, content: [{ type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quote' }] }] }] }] }
    const author = { type: 'paragraph', content: [{ type: 'text', text: 'By {{ask:Author}}' }] }
    await create({ typeId: page, title: '{{ask:Title}}', content: { body: { type: 'doc', content: [author, branch] } }, template: { kind: 'template', name: 'Echo', default: true } })
    const templates = store.listTemplates('s')
    const type = store.getType(page)!
    const labels = (line: string, hasTitle: boolean) => lineAsks(templates, type, line, hasTitle).map((a) => a.label)
    // A typed title takes the place of a title made only of questions.
    expect(labels('Freedom', true)).toEqual(['Author', 'Body'])
    expect(labels('', false)).toEqual(['Title', 'Author', 'Body'])
    expect(labels('Freedom body:no', true)).toEqual(['Author'])
    expect(lineAsks(templates, type, 'x', true)[1]).toEqual({ label: 'Body', options: ['Yes', 'No'] })

    const capture = async (answers: Record<string, string>) => {
      const answer = (await (await user.request('/api/spaces/s/captures', json({ text: 'Freedom', channel: 'desktop', typeId: page, answers }))).json()) as { objects: { id: string }[] }
      const made = store.getObject(answer.objects[0]!.id)!
      return [texts(made)[0], ...(made.content.body?.content ?? []).slice(1).map((n) => n.type)]
    }
    expect(await capture({ Author: 'Freire', Body: 'Yes' })).toEqual(['By Freire', 'blockquote'])
    expect(await capture({ Author: 'Freire', Body: 'No' })).toEqual(['By Freire'])
  })

  it('lets agents list templates and make objects from them', async () => {
    const { user, agent } = setup()
    const task = builtinTypeId('s', 'task')
    const create = (data: unknown) => user.request('/api/objects', json(data))
    await create({ typeId: task, title: 'Bug: {{title}}', content: { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Seen by {{ask:Who saw it?}}' }] }] } }, template: { kind: 'template', name: 'Bug', default: true } })
    expect(agent.templates()).toEqual([expect.objectContaining({ name: 'Bug', kind: 'template', type: 'Task', default: true, asks: [{ label: 'Who saw it?' }] })])
    const made = agent.createObject({ type: 'Task', title: 'Login breaks', answers: { 'Who saw it?': 'Lena' }, markdown: 'More' }) as { title: string; text: Record<string, string> }
    expect(made.title).toBe('Bug: Login breaks')
    expect(made.text.Notes).toContain('Seen by Lena')
    expect(made.text.Notes).toContain('More')
    const blank = agent.createObject({ type: 'Task', title: 'Plain', template: 'blank' }) as { title: string }
    expect(blank.title).toBe('Plain')
    expect(() => agent.createObject({ type: 'Task', title: 'x', template: 'Nope' })).toThrow(/no template “Nope” \(it has Bug\)/)
  })

  it('goes to the trash and comes back with its type', async () => {
    const { user, store } = setup()
    const type = (await (await user.request('/api/types', json({ spaceId: 's', name: 'Recipe' }))).json()) as { id: string }
    await user.request('/api/objects', json({ typeId: type.id, title: '', template: { kind: 'template', name: 'Soup', default: true } }))
    expect(store.listTemplates('s')).toHaveLength(1)
    expect((await user.request(`/api/types/${type.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(store.listTemplates('s')).toEqual([])
    expect((await user.request(`/api/types/${type.id}/restore`, { method: 'POST' })).status).toBe(200)
    expect(store.listTemplates('s').map((t) => t.template!.name)).toEqual(['Soup'])
  })
})

const texts = (object: ObjectRecord) => (object.content.body?.content ?? []).map((n) => (n.content ?? []).map((c) => c.text).join(''))
