#!/usr/bin/env node
// A load test: a space with many made-up objects, then the real server answering what the app asks
// for (the space, search, a type's objects, a query, a month of the calendar, an object with its
// backlinks, a full sync from nothing) and captures, one after another and many at once. Prints
// how long each took (median, 95th percentile, slowest) and how big the answers were.
//
//   node packages/server/bench/load.ts [objects=20000] [--keep]
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { BODY_PROPERTY_ID, SYNC_PROTOCOL, addDays, builtinTypeId, findOrCreateDailyNote, newObject, newType, textToBlocks, type Doc, type DocNode, type ObjectRecord, type ObjectType } from '@vasta/core'
import { NodeStore } from '@vasta/core/node'
import { AccountService } from '../src/accounts.ts'

const count = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 20000)
const keep = process.argv.includes('--keep')
const dir = mkdtempSync(path.join(tmpdir(), 'vasta-load-'))
const PORT = 5290
const base = `http://127.0.0.1:${PORT}`

// ---------------------------------------------------------------------------
// The data: pages with text that mentions earlier objects, tasks, books, and a daily note per day
// for three years. Objects are made over those three years too, and some changed later, as an
// import keeps them.

const WORDS = 'garden water seedling tomato basil fence compost harvest autumn spring sprint review design sketch library sync engine note idea draft letter recipe bread coffee lunch walk river mountain story chapter author reading habit plan budget travel ticket museum'.split(' ')
let seed = 42
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]!
const sentence = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ').replace(/^./, (c) => c.toUpperCase()) + '.'

const started = performance.now()
const store = new NodeStore(path.join(dir, 'vasta.db'))
const accounts = new AccountService({ store })
const user = await accounts.createUser({ username: 'load', password: 'load-password', timeZone: 'UTC' })
const space = store.listUserSpaces(user.id)[0]!
const { secret } = accounts.createToken(user.id, 'load', 'api')
const at = new Date().toISOString()
const page = store.getType(builtinTypeId(space.id, 'page'))!
const task = store.getType(builtinTypeId(space.id, 'task'))!
const bookBase = newType(space.id, { name: 'Book', pluralName: 'Books' }, randomUUID(), at)
const book: ObjectType = { ...bookBase, properties: [...bookBase.properties, { id: 'author', kind: 'text', name: 'Author' }, { id: 'pages', kind: 'number', name: 'Pages' }] }
store.putType(book)

const made: ObjectRecord[] = []
const body = (mentions: number): Doc => ({
  type: 'doc',
  content: [
    ...textToBlocks(`${sentence(14)} ${sentence(10)}\n${sentence(18)}`),
    ...Array.from({ length: mentions }, () => {
      const target = made.length ? pick(made) : undefined
      return { type: 'paragraph', content: [{ type: 'text', text: `See ${pick(WORDS)} ` }, ...(target ? [{ type: 'mention', attrs: { objectId: target.id, label: target.title } } as DocNode] : [])] } as DocNode
    }),
  ],
})
store.transaction(() => {
  for (let i = 0; i < count; i++) {
    const roll = random()
    const type = roll < 0.6 ? page : roll < 0.9 ? task : book
    const props: ObjectRecord['props'] =
      type === task
        ? { status: { kind: 'select', value: [pick(['todo', 'doing', 'done', 'done'])] }, due: { kind: 'date', value: { start: `${addDays('2026-10-22', Math.floor(random() * 120) - 60)}T00:00:00.000Z`, resolution: 'day' } } }
        : type === book
          ? { author: { kind: 'text', value: `${pick(WORDS)} ${pick(WORDS)}` }, pages: { kind: 'number', value: 100 + Math.floor(random() * 600) } }
          : {}
    const madeAt = new Date(Date.parse(`${addDays('2026-10-22', -365 * 3 + Math.floor((i * 365 * 3) / count))}T00:00:00.000Z`) + random() * 86_400_000).toISOString()
    const changedAt = random() < 0.3 ? new Date(Math.min(Date.parse(madeAt) + random() * 60 * 86_400_000, Date.parse(at))).toISOString() : madeAt
    const object = newObject(type, { title: `${sentence(3).slice(0, -1)} ${i}`, props, content: { [BODY_PROPERTY_ID]: body(type === page ? 1 + Math.floor(random() * 3) : 0) } }, randomUUID(), madeAt)
    made.push(store.putObject({ ...object, updatedAt: changedAt }))
  }
  for (let d = 0; d < 365 * 3; d++) {
    const { note } = findOrCreateDailyNote(store, space.id, addDays('2026-10-22', -d), `${addDays('2026-10-22', -d)}T09:00:00.000Z`)
    store.putObject({ ...note, content: { [BODY_PROPERTY_ID]: body(2) } })
  }
})
const seeded = performance.now() - started
store.close()
const dbSize = statSync(path.join(dir, 'vasta.db')).size

// ---------------------------------------------------------------------------
// The server, as a separate process, like in production.

const serverStart = performance.now()
const server = spawn(process.execPath, ['--no-warnings', fileURLToPath(new URL('../src/main.ts', import.meta.url))], {
  env: { ...process.env, VASTA_DATA: dir, PORT: String(PORT), VASTA_REMINDERS: '0', TELEGRAM_BOT_TOKEN: '', VASTA_FETCH_LINK_META: '0', VASTA_CAPTURE_TOKEN: '' },
  stdio: 'ignore',
})
const stop = () => {
  server.kill()
  if (!keep) rmSync(dir, { recursive: true, force: true })
}
process.on('exit', stop)
for (;;) {
  const ok = await fetch(`${base}/api/health`).then((r) => r.ok, () => false)
  if (ok) break
  if (performance.now() - serverStart > 60_000) throw new Error('the server did not start')
  await new Promise((r) => setTimeout(r, 50))
}
const startup = performance.now() - serverStart

const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }
async function call(method: string, url: string, body?: unknown): Promise<{ ms: number; bytes: number; json: unknown }> {
  const t = performance.now()
  const response = await fetch(`${base}${url}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const text = await response.text()
  const ms = performance.now() - t
  if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${text.slice(0, 200)}`)
  return { ms, bytes: text.length, json: JSON.parse(text) }
}

type Row = { what: string; runs: number; p50: number; p95: number; max: number; size: string }
const rows: Row[] = []
const kb = (bytes: number) => (bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`)
async function measure(what: string, runs: number, run: (i: number) => Promise<{ ms: number; bytes: number }>) {
  const times: number[] = []
  let bytes = 0
  for (let i = 0; i < runs; i++) {
    const result = await run(i)
    times.push(result.ms)
    bytes = Math.max(bytes, result.bytes)
  }
  times.sort((a, b) => a - b)
  const at = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))]!
  rows.push({ what, runs, p50: at(0.5), p95: at(0.95), max: times.at(-1)!, size: kb(bytes) })
}

await measure('space (types, sidebar)', 20, () => call('GET', `/api/spaces/${space.id}`))
await measure('search', 50, () => call('GET', `/api/spaces/${space.id}/search?q=${pick(WORDS)}`))
await measure('all pages of a type', 5, () => call('GET', `/api/types/${page.id}/objects`))
await measure('query: open tasks by due', 20, () =>
  call('POST', `/api/spaces/${space.id}/query`, { query: { typeIds: [task.id], filter: { kind: 'group', operator: 'and', items: [{ kind: 'filter', field: 'status', operator: 'is-not', value: { kind: 'literal', value: ['done'] } }] }, sort: [{ field: 'due', direction: 'asc' }] }, today: '2026-10-22', timeZone: 'UTC' })
)
await measure('calendar: a month', 20, () => call('GET', `/api/spaces/${space.id}/calendar?from=2026-10-01&to=2026-10-31&timeZone=UTC`))
await measure('an object', 50, () => call('GET', `/api/objects/${pick(made).id}`))
await measure('its backlinks', 50, () => call('GET', `/api/objects/${pick(made.slice(0, 200)).id}/backlinks`))

// A new device: everything, 1000 rows at a time.
let pulled = 0
let pullBytes = 0
const pullStart = performance.now()
for (let since = 0, more = true; more; ) {
  const { json, bytes } = await call('GET', `/api/sync/pull?protocol=${SYNC_PROTOCOL}&since=${since}&limit=1000`)
  const page = json as { rows: unknown[]; tombstones?: unknown[]; rev: number; more: boolean }
  pulled += page.rows.length
  pullBytes += bytes
  since = page.rev
  more = page.more
}
rows.push({ what: `full sync (${pulled} rows)`, runs: 1, p50: performance.now() - pullStart, p95: NaN, max: NaN, size: kb(pullBytes) })

await measure('capture, one at a time', 200, (i) => call('POST', '/api/capture/note', { text: `Load note ${i}` }))
const burst = performance.now()
const burstTimes = await Promise.all(Array.from({ length: 50 }, (_, i) => call('POST', '/api/capture/note', { text: `Burst ${i}` }).then((r) => r.ms)))
burstTimes.sort((a, b) => a - b)
rows.push({ what: '50 captures at once', runs: 50, p50: burstTimes[25]!, p95: burstTimes[47]!, max: burstTimes[49]!, size: `${Math.round(performance.now() - burst)} ms all` })

const ms = (value: number) => (Number.isNaN(value) ? '' : value < 10 ? value.toFixed(1) : String(Math.round(value)))
console.log(`\n${count} objects + ${365 * 3} daily notes: seeded in ${(seeded / 1000).toFixed(1)} s, database ${kb(dbSize)}, server ready in ${Math.round(startup)} ms\n`)
console.log(['what'.padEnd(30), 'runs'.padStart(5), 'p50 ms'.padStart(8), 'p95 ms'.padStart(8), 'max ms'.padStart(8), '  size'].join(''))
for (const row of rows) console.log([row.what.padEnd(30), String(row.runs).padStart(5), ms(row.p50).padStart(8), ms(row.p95).padStart(8), ms(row.max).padStart(8), `  ${row.size}`].join(''))
if (keep) console.log(`\nData kept in ${dir}. To open it in a browser: cd packages/server && VASTA_DATA=${dir} PORT=5297 VASTA_REMINDERS=0 node --no-warnings src/main.ts (log in as load / load-password; scripts/browser-checks/scale.mjs times it)`)
process.exit(0)
