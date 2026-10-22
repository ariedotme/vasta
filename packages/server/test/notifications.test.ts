// Notifications about others' work: assigned, mentioned, a comment on what one follows; the
// bell's list, and the reminder channels for the kinds a user wants.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { addComment, builtinTypeId, createBuiltinTypes, editComment, type ObjectRecord } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { AccountService } from '../src/accounts.ts'
import { createApp } from '../src/app.ts'
import { CaptureService } from '../src/capture.ts'
import { ChangeFeed } from '../src/events.ts'
import type { Notification } from '../src/notifications.ts'
import { ReminderService } from '../src/reminders.ts'
import { asUser } from './helpers.ts'

const at = '2026-10-21T12:00:00.000Z'
const json = (body: unknown, method = 'POST') => ({ method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const TASK = builtinTypeId('s', 'task')
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

function setup() {
  const store = new NodeStore(':memory:')
  store.putSpace({ id: 's', name: 'Work', sidebar: [], createdAt: at })
  for (const type of createBuiltinTypes('s', at)) store.putType(type)
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-notifications-')))
  const capture = new CaptureService({ store, media, feed: new ChangeFeed(), timeZone: 'UTC' })
  const accounts = new AccountService({ store, capture })
  const posts: { topic: string; title: string; message: string; click?: string }[] = []
  const fetch = (async (_url: string, init?: RequestInit) => {
    posts.push(JSON.parse(String(init?.body)))
    return new Response('{}')
  }) as typeof globalThis.fetch
  const reminders = new ReminderService({ store, accounts, webUrl: 'https://notes.example', fetch })
  const app = createApp({ store, media, feed: new ChangeFeed(), capture, accounts, reminders })
  const arie = asUser(app, store, { username: 'arie', spaces: ['s'] })
  const ana = asUser(app, store, { username: 'ana', spaces: ['s'] })
  const bo = asUser(app, store, { username: 'bo', spaces: ['s'] })
  for (const [user, topic] of [[arie, 'arie'], [ana, 'ana'], [bo, 'bo']] as const) reminders.save(user.user.id, { ntfy: { server: 'https://ntfy.sh', topic } })
  return { store, reminders, posts, arie, ana, bo }
}

type As = ReturnType<typeof setup>['arie']
const call = async <T>(as: As, url: string, init?: RequestInit) => {
  const response = await as.request(url, init)
  expect(response.status, url).toBeLessThan(300)
  return (await response.json()) as T
}
const notices = (as: As) => call<{ items: Notification[]; unread: number }>(as, '/api/notices')
const kinds = async (as: As) => (await notices(as)).items.map((n) => `${n.kind}${n.text ? `: ${n.text}` : ''}`)

describe('notifications', () => {
  it('tell people they were assigned, mentioned, or that something they follow got a comment', async () => {
    const { posts, arie, ana, bo } = setup()
    const task = await call<ObjectRecord>(arie, '/api/objects', json({ typeId: TASK, line: 'Fix the gate assignee:ana' }))
    await settle()
    expect(await kinds(ana)).toEqual(['assigned'])
    expect(await kinds(arie)).toEqual([])
    expect(posts).toEqual([{ topic: 'ana', title: 'arie assigned you “Fix the gate”', message: 'In Work', tags: ['bust_in_silhouette'], click: `https://notes.example/o/${task.id}` }])

    // Ana comments: Arie made it, so he follows it. Bo is mentioned.
    const put = async (as: As, change: (o: ObjectRecord) => void) => {
      const object = await call<ObjectRecord>(as, `/api/objects/${task.id}`)
      change(object)
      return call<ObjectRecord>(as, `/api/objects/${task.id}`, json(object, 'PUT'))
    }
    let comment = ''
    await put(ana, (o) => (comment = addComment(o, ana.user.id, 'On it. @bo can you lend the drill?', '2026-10-21T12:05:00.000Z')))
    await settle()
    expect(await kinds(arie)).toEqual(['comment: On it. @bo can you lend the drill?'])
    expect(await kinds(bo)).toEqual(['mentioned: On it. @bo can you lend the drill?'])
    expect(await kinds(ana)).toEqual(['assigned'])

    // Editing it to mention Arie tells only him, as a mention; nobody else again.
    await put(ana, (o) => editComment(o, comment, ana.user.id, 'On it. @bo can you lend the drill? @arie fyi', '2026-10-21T12:06:00.000Z'))
    await settle()
    expect((await kinds(arie))[0]).toBe('mentioned: On it. @bo can you lend the drill? @arie fyi')
    expect((await kinds(bo)).length).toBe(1)

    // Bo commented nothing and is not named: Arie's comment tells Ana (assigned) and not Bo.
    await put(arie, (o) => addComment(o, arie.user.id, 'Thanks', '2026-10-21T12:07:00.000Z'))
    await settle()
    expect((await kinds(ana))[0]).toBe('comment: Thanks')
    expect((await kinds(bo)).length).toBe(1)

    // Reading.
    const before = await notices(arie)
    expect(before.unread).toBe(2)
    await call(arie, '/api/notices/read', json({ ids: [before.items[0]!.id] }))
    expect((await notices(arie)).unread).toBe(1)
    await call(arie, '/api/notices/read', json({}))
    expect((await notices(arie)).unread).toBe(0)
  })

  it('go through the channels only for the kinds a user wants, and are kept for the bell anyway', async () => {
    const { reminders, posts, arie, ana } = setup()
    reminders.save(ana.user.id, { work: { assigned: false } })
    expect(reminders.view(ana.user.id).work).toEqual({ assigned: false, mentioned: true, comments: true })
    await call<ObjectRecord>(arie, '/api/objects', json({ typeId: TASK, line: 'Quiet one assignee:ana' }))
    await settle()
    expect(posts).toEqual([])
    expect(await kinds(ana)).toEqual(['assigned'])
    // Assigned again right after (cleared and set): told once.
    const [task] = (await call<ObjectRecord[]>(arie, '/api/spaces/s/query', json({ query: { typeIds: [TASK] } }))) as ObjectRecord[]
    const full = await call<ObjectRecord>(arie, `/api/objects/${task!.id}`)
    const { assignee, ...rest } = full.props
    await call(arie, `/api/objects/${task!.id}`, json({ ...full, props: rest }, 'PUT'))
    await call(arie, `/api/objects/${task!.id}`, json({ ...full, props: { ...rest, assignee: assignee! } }, 'PUT'))
    await settle()
    expect(await kinds(ana)).toEqual(['assigned'])
  })
})
