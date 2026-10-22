import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, it } from 'vitest'
import { createBuiltinTypes, setNutritionEnabled } from '@vasta/core'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { createApp } from '../../server/src/app.ts'
import { CaptureService } from '../../server/src/capture.ts'
import { ChangeFeed } from '../../server/src/events.ts'
import { asUser } from '../../server/test/helpers.ts'
import { idOf, parseProps, parseWhere, runCommand, type Call } from '../src/commands.ts'

const AT = '2026-10-19T15:00:00.000Z'

async function setup() {
  const store = new NodeStore(':memory:')
  store.putSpace({ id: 's', name: 'Notes', sidebar: [], createdAt: AT })
  for (const type of createBuiltinTypes('s', AT)) store.putType(type)
  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-cli-')))
  const feed = new ChangeFeed()
  const capture = new CaptureService({ store, media, feed, now: () => AT, timeZone: 'America/Sao_Paulo' })
  const app = createApp({ store, media, feed, capture, now: () => AT, webUrl: 'https://notes.example' })
  const { secret } = asUser(app, store, { username: 'arie' })
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL('http://vasta.test/mcp'), {
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers)
        headers.set('authorization', `Bearer ${secret}`)
        return app.request(url.toString(), { ...init, headers })
      },
    })
  )
  const call: Call = async (name, args = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
    if (result.isError) throw new Error(result.content[0]!.text)
    return JSON.parse(result.content[0]!.text)
  }
  const vasta = (line: string[], stdin = '') => runCommand(line, call, async () => stdin)
  return { store, vasta }
}

describe('vasta CLI', () => {
  it('reads its arguments', () => {
    expect(parseWhere('Due date before 2026-10-25')).toEqual({ field: 'Due date', operator: 'before', value: '2026-10-25' })
    expect(parseWhere('rating gte 4')).toEqual({ field: 'rating', operator: 'gte', value: 4 })
    expect(parseWhere('Tags is-empty')).toEqual({ field: 'Tags', operator: 'is-empty' })
    expect(() => parseWhere('nothing here')).toThrow('operator')
    expect(parseProps(['status=done', 'tags=a, b', 'due='])).toEqual({ status: 'done', tags: ['a', 'b'], due: null })
    expect(idOf('https://notes.example/o/abc#b-x')).toBe('abc')
    expect(idOf('vasta://o/abc')).toBe('abc')
    expect(idOf('abc')).toBe('abc')
  })

  it('lists and logs habits', async () => {
    const { vasta } = await setup()
    await vasta(['new', 'Habit', 'Água', '--prop', 'Daily goal=8', '--prop', 'Unit=copos'])
    await vasta(['new', 'Habit', 'Ler'])
    expect(await vasta(['habit', 'agua', '+3'])).toBe('Água on 2026-10-19: 3/8 copos · streak 0')
    expect(await vasta(['habit', 'Ler'])).toBe('Ler on 2026-10-19: done · streak 1')
    expect(await vasta(['habit', 'Ler', 'undo', '--day', '2026-10-19'])).toBe('Ler on 2026-10-19: not done · streak 0')
    expect(await vasta(['habits'])).toBe('○ Água  3/8 copos  · streak 0 · 30 days 0%\n○ Ler  · streak 0 · 30 days 0%')
  })

  it('logs food and shows a day of it', async () => {
    const { vasta, store } = await setup()
    setNutritionEnabled(store, 's', true, AT)
    await vasta(['tool', 'save_food', JSON.stringify({ food: 'Rice', nutrients: { kcal: 130, protein: 2.5, carbs: 28, fat: 0.3 } })])
    expect(await vasta(['food', 'rice', '150g', 'at', 'lunch'])).toBe('Logged in Lunch: Rice 150 g (195 kcal).\nToday 195 kcal.')
    expect(await vasta(['nutrition'])).toBe('2026-10-19: 195 kcal · protein 4 g · carbs 42 g · fat 0 g\n\nLunch · 195 kcal\n  Rice 150 g  195 kcal')
  })

  it('creates, appends to, shows, finds and captures', async () => {
    const { vasta } = await setup()
    expect(await vasta(['spaces'])).toBe('Notes (default)  s')
    const created = await vasta(['new', 'Task', 'Write', 'the', 'docs', '--prop', 'priority=high', '--text', 'For **agents**.'])
    const id = /\/o\/(\S+)/.exec(created)![1]!
    expect(created).toBe(`Created Write the docs: https://notes.example/o/${id}`)
    await vasta(['append', id], '- step one\n- step two')
    await vasta(['set', id, 'status=done', '--title', 'Write the agent docs'])
    expect(await vasta(['show', `https://notes.example/o/${id}`])).toBe(
      [`# Write the agent docs`, `Task · Notes · https://notes.example/o/${id}`, 'Status: Done', 'Priority: High', '', 'For **agents**.', '', '- step one', '- step two'].join('\n')
    )
    expect(await vasta(['search', 'agents'])).toBe(`Write the agent docs  · Task  ${id}`)
    expect(await vasta(['query', '--type', 'Task', '--where', 'status is Done'])).toBe(`Write the agent docs  · Task  ${id}`)
    expect(JSON.parse(await vasta(['query', '--type', 'Task', '--where', 'status is To do', '--json'])).total).toBe(0)
    expect(await vasta(['capture', 'Buy', 'coffee'])).toMatch(/^Captured into today's note: https:\/\/notes\.example\/o\//)
    await vasta(['append', 'today', 'Evening notes'])
    const today = await vasta(['today'])
    expect(today).toContain('Buy coffee')
    expect(today.endsWith('Evening notes')).toBe(true)
    expect(await vasta(['inbox'])).toMatch(/· agent\nBuy coffee$/)
    await expect(vasta(['new'])).rejects.toThrow('vasta new <type>')
    await expect(vasta(['show', 'missing'])).rejects.toThrow('no object missing')
    expect(JSON.parse(await vasta(['tool', 'list_spaces']))).toEqual([{ id: 's', name: 'Notes', default: true }])
  })
})
