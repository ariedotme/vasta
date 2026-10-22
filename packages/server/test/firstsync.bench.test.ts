// How long a device's first sync takes against a big space (docs/sync-plan.md, "Measured").
// Skipped unless VASTA_BENCH is set: `VASTA_BENCH=1 pnpm vitest run firstsync`.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import sqliteWasm from '@sqlite.org/sqlite-wasm'
import { expect, it } from 'vitest'
import { BODY_PROPERTY_ID, builtinTypeId, createBuiltinTypes, newObject, type Doc } from '@vasta/core'
import { ClientStore } from '@vasta/core/client'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { wasmDatabase } from '@vasta/core/sql-wasm'
import { SyncClient, httpTransport } from '@vasta/core/sync-client'
import { createApp } from '../src/app.ts'
import { CalendarService } from '../src/calendars.ts'
import { ChangeFeed } from '../src/events.ts'
import { asUser } from './helpers.ts'

const COUNT = Number(process.env.VASTA_BENCH_COUNT ?? 5000)

it.skipIf(!process.env.VASTA_BENCH)(`first sync of ${COUNT} objects`, { timeout: 600_000 }, async () => {
  const at = '2026-10-19T12:00:00.000Z'
  const store = new NodeStore(':memory:')
  store.putSpace({ id: 's', name: 's', sidebar: [], createdAt: at })
  for (const type of createBuiltinTypes('s', at)) store.putType(type)
  const type = store.getType(builtinTypeId('s', 'page'))!
  const paragraph = (i: number, n: number) => ({ type: 'paragraph', content: [{ type: 'text', text: `Paragraph ${n} of note ${i}, with a few more words to search.` }] })
  let started = performance.now()
  store.transaction(() => {
    for (let i = 0; i < COUNT; i++) {
      const body = { type: 'doc', content: [1, 2, 3, 4, 5].map((n) => paragraph(i, n)) } as Doc
      store.putObject(newObject(type, { title: `Note ${i}`, content: { [BODY_PROPERTY_ID]: body } }, `o${i}`, at))
    }
  })
  console.log(`server: ${COUNT} objects written in ${Math.round(performance.now() - started)} ms`)
  for (const [name, read] of [["list", () => store.listSpaceObjects("s")], ["search ''", () => store.search("s", "")], ["search note", () => store.search("s", "note 4")]] as const) {
    const t = performance.now()
    read()
    console.log(`server ${name}: ${Math.round(performance.now() - t)} ms`)
  }

  const media = new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-bench-')))
  const feed = new ChangeFeed()
  const now = () => new Date().toISOString()
  const calendars = new CalendarService({ store, feed, now, fetch: (async () => new Response('', { status: 404 })) as typeof fetch })
  const app = createApp({ store, media, feed, calendars })
  const user = asUser(app, store, { spaces: ['s'] })
  const sqlite3 = await sqliteWasm()
  const device = new ClientStore(wasmDatabase(new sqlite3.oo1.DB(':memory:')), 'bench')
  const sync = new SyncClient(device, httpTransport(async (url, init) => user.request(url, init)))

  started = performance.now()
  await sync.sync()
  console.log(`first sync: ${Math.round(performance.now() - started)} ms`)
  started = performance.now()
  await sync.sync()
  console.log(`sync with nothing new: ${Math.round(performance.now() - started)} ms`)

  expect(device.getObject(`o${COUNT - 1}`)?.content[BODY_PROPERTY_ID]?.content).toHaveLength(5)
  expect(device.search('s', 'paragraph').length).toBeGreaterThan(0)
})
