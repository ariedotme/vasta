// Insistent reminders through the MCP endpoint: list_reminders, set_reminder, start_reminder,
// remove_reminder (docs/agents.md, docs/reminders.md).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it } from 'vitest'
import { builtinTypeId, createBuiltinTypes, newObject } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { AccountService } from '../src/accounts.ts'
import { createApp } from '../src/app.ts'
import { CaptureService } from '../src/capture.ts'
import { ChangeFeed, DesktopListeners, type DesktopTakeover } from '../src/events.ts'
import { REMINDER_STYLES } from '../src/insistent.ts'
import { ReminderService } from '../src/reminders.ts'
import { asUser } from './helpers.ts'

const AT = '2026-10-20T12:00:00.000Z'

async function setup() {
  const store = new NodeStore(':memory:')
  store.putSpace({ id: 's', name: 'Notes', sidebar: [], createdAt: AT })
  for (const type of createBuiltinTypes('s', AT)) store.putType(type)
  const habitType = store.getType(builtinTypeId('s', 'habit'))!
  const tagType = store.getType(builtinTypeId('s', 'tag'))!
  const page = store.getType(builtinTypeId('s', 'page'))!
  store.putObject(newObject(habitType, { title: 'Escolher quem eu sou', props: { remind: { kind: 'text', value: '9:00' } } }, 'ritual', AT))
  store.putObject(newObject(tagType, { title: 'Afirmação' }, 'affirmation', AT))
  store.putObject(newObject(tagType, { title: 'Privado' }, 'private', AT))
  store.putObject({ ...newObject(page, { title: 'Você é o amor da sua vida.' }, 'p1', AT), tagIds: ['affirmation'] })

  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-mcp-reminders-')))
  const feed = new ChangeFeed()
  const capture = new CaptureService({ store, media, feed, now: () => AT, timeZone: 'America/Sao_Paulo' })
  const accounts = new AccountService({ store, capture })
  const ntfy: Record<string, unknown>[] = []
  const desktop = new DesktopListeners()
  const reminders = new ReminderService({
    store,
    accounts,
    desktop,
    webUrl: 'https://notes.example',
    now: () => Date.parse(AT),
    fetch: (async (_url: string, init?: RequestInit) => {
      ntfy.push(JSON.parse(String(init?.body)))
      return new Response('{}')
    }) as typeof fetch,
  })
  const app = createApp({ store, media, feed, capture, accounts, reminders, now: () => AT, webUrl: 'https://notes.example' })
  const arie = asUser(app, store, { username: 'arie', spaces: ['s'] })
  reminders.save(arie.user.id, { ntfy: { topic: 'arie' } })

  const client = new Client({ name: 'test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://vasta.test/mcp'), {
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers)
        headers.set('authorization', `Bearer ${arie.secret}`)
        return app.request(url.toString(), { ...init, headers })
      },
    })
  )
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    if (result.isError) throw new Error(result.content[0]!.text)
    return JSON.parse(result.content[0]!.text)
  }
  return { store, call, ntfy, desktop, userId: arie.user.id }
}

describe('insistent reminders through the MCP', () => {
  it('makes a reminder on a habit with what fits it, and changes its style', async () => {
    const { call } = await setup()
    const made = await call('set_reminder', { object: 'ritual', content: { kind: 'tag', tag: 'Afirmação', count: 3 }, ack: 'say' })
    expect(made).toMatchObject({ name: 'Escolher quem eu sou', about: { id: 'ritual', title: 'Escolher quem eu sou' }, when: { kind: 'object' }, content: { kind: 'tag', tag: 'Afirmação', count: 3 }, ack: 'say', style: 'escalating' })
    const changed = await call('set_reminder', { id: made.id, style: 'relentless', when: { kind: 'wake', after: '08:00', latest: '11:00' } })
    expect(changed).toMatchObject({ style: 'relentless', repeat: 5, steps: REMINDER_STYLES.relentless.steps, when: { kind: 'wake', after: '08:00', latest: '11:00' }, ack: 'say' })
    expect(await call('set_reminder', { id: made.id, openAfter: 'p1' })).toMatchObject({ openAfter: { id: 'p1', title: 'Você é o amor da sua vida.' } })
    expect(await call('set_reminder', { id: made.id, openAfter: null })).not.toHaveProperty('openAfter')
    await expect(call('set_reminder', { id: made.id, openAfter: 'nope' })).rejects.toThrow('no object nope')
    const { reminders } = await call('list_reminders', { object: 'ritual' })
    expect(reminders.map((r: { id: string }) => r.id)).toEqual([made.id])
    expect(reminders[0].stats).toMatchObject({ total: 0 })
  })

  it('starts a reminder now: its first step goes out, showing its content, and it asks until answered', async () => {
    const { call, ntfy } = await setup()
    const made = await call('set_reminder', { title: 'Teste', when: { kind: 'daily', at: '23:00' }, content: { kind: 'tag', tag: 'Afirmação' }, ack: 'type', style: 'notification' })
    const started = await call('start_reminder', { id: made.id })
    expect(started).toMatchObject({ started: true, nag: { title: 'Teste', ack: 'type', items: [{ title: 'Você é o amor da sua vida.' }], sent: 1 } })
    expect(ntfy).toHaveLength(1)
    expect(JSON.stringify(ntfy[0])).toContain('Você é o amor da sua vida.')
    expect((await call('list_reminders')).askingNow).toEqual([expect.objectContaining({ reminder: made.id, sent: 1 })])
  })

  it('pops a window up in the desktop app for the popup style, and the whole screen for fullscreen', async () => {
    const { call, ntfy, desktop, userId } = await setup()
    const shown: DesktopTakeover[] = []
    desktop.listen(userId, () => {}, { takeover: (t) => shown.push(t) })
    const popup = await call('set_reminder', { title: 'Água', when: { kind: 'daily', at: '23:00' }, content: { kind: 'tag', tag: 'Afirmação' }, ack: 'type', style: 'popup' })
    expect(popup).toMatchObject({ style: 'popup', repeat: null, steps: [{ after: 0, channels: ['popup'] }] })
    await call('start_reminder', { id: popup.id })
    expect(shown).toEqual([expect.objectContaining({ title: 'Água', popup: true, path: expect.stringMatching(/^remind\/.+\?takeover=1&popup=1$/) })])
    const full = await call('set_reminder', { title: 'Tela', when: { kind: 'daily', at: '23:00' }, content: { kind: 'tasks' }, style: 'fullscreen' })
    await call('start_reminder', { id: full.id })
    expect(shown[1]).not.toHaveProperty('popup')
    expect(shown[1]!.path).toMatch(/\?takeover=1$/)
    expect(ntfy).toEqual([])
  })

  it('says what is wrong, keeps hidden tags out, and removes reminders', async () => {
    const { store, call } = await setup()
    await expect(call('set_reminder', { when: { kind: 'daily', at: '09:00' } })).rejects.toThrow('needs a title')
    await expect(call('set_reminder', { title: 'X', content: { kind: 'tag', tag: 'Nope' } })).rejects.toThrow('no tag "Nope"')
    await expect(call('set_reminder', { title: 'X', when: { kind: 'daily', at: '25:00' } })).rejects.toThrow('HH:MM')
    const hidden = await call('set_reminder', { title: 'Hidden later', content: { kind: 'tag', tag: 'Privado' } })
    store.putSpace({ ...store.getSpace('s')!, agents: { hiddenTagIds: ['private'] } })
    expect((await call('list_reminders')).reminders).toEqual([])
    await expect(call('start_reminder', { id: hidden.id })).rejects.toThrow('no reminder')
    await expect(call('set_reminder', { title: 'Y', content: { kind: 'tag', tag: 'Privado' } })).rejects.toThrow('no tag "Privado"')
    store.putSpace({ ...store.getSpace('s')!, agents: {} })
    expect(await call('remove_reminder', { id: hidden.id })).toMatchObject({ removed: true })
    expect((await call('list_reminders')).reminders).toEqual([])
  })
})
