// Browser check of the local replica against the isolated test env (never the real data).
//   node replica.mjs <chromium|webkit> <base url: http://127.0.0.1:5183 (dev) or :5184 (built, with service worker)>
import { chromium, webkit, devices } from 'playwright'

const [engine = 'chromium', base = 'http://127.0.0.1:5183'] = process.argv.slice(2)
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)
const TOKEN = process.env.CAPTURE_TOKEN
const built = base.endsWith(':5184')

// WebKit has no OPFS in an ephemeral context (like private browsing): use a profile on disk.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const profile = mkdtempSync(path.join(process.env.PROFILE_DIR ?? tmpdir(), `vasta-${engine}-`))
const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['iPhone 15']
const context = await (engine === 'webkit' ? webkit : chromium).launchPersistentContext(profile, engine === 'webkit' ? { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } : {})
const browser = { close: () => context.close() }
const page = context.pages()[0] ?? (await context.newPage())
const problems = []
page.on('console', (m) => {
  const text = m.text()
  if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${text}`)
})
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
const api = []
context.on('request', (r) => {
  const u = new URL(r.url())
  if (u.pathname.startsWith('/api/')) api.push(`${r.method()} ${u.pathname}`)
})

const step = (name) => console.log(`• ${name}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(check, what, timeout = 15000) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeout) {
      if (problems.length) console.log(`console problems:\n  ${problems.join('\n  ')}`)
      console.log('  last api calls:', api.slice(-12).join(' | '))
      throw new Error(`timed out: ${what}`)
    }
    await sleep(250)
  }
}
async function compare(label) {
  const editor = await page.$$eval('.vasta-doc > *', (els) => els.map((e) => e.textContent))
  const server = bodyText(await serverObject(created.id)).split('\n')
  console.log(`  ${label}: editor ${JSON.stringify(editor)} server ${JSON.stringify(server)}`)
}
/** Put the caret at the end of the last block of the body. */
async function endOfText() {
  await page.click('.vasta-doc > :last-child')
  await page.keyboard.press('Meta+ArrowRight')
  // ProseMirror reads the new selection a moment later (selectionchange); Enter right away would split where the caret was.
  await sleep(150)
}
const serverObject = async (id) => (await page.request.get(`${base}/api/objects/${id}`)).json()
const deepText = (n) => n.text ?? (n.content ?? []).map(deepText).join('')
const bodyText = (o) => (o.content?.body?.content ?? []).map(deepText).join('\n')

step('log in')
await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav', { timeout: 30000 })
const opfs = await page.evaluate(async () => {
  try {
    const root = await navigator.storage.getDirectory()
    const names = []
    for await (const [name] of root.entries()) names.push(name)
    return names
  } catch (error) {
    return [`no OPFS: ${error.message}`]
  }
})
console.log('  OPFS:', opfs.join(', ') || '(empty)')

step('create a page on the server and open it')
const spaces = await (await page.request.get(`${base}/api/spaces`)).json()
const bundle = await (await page.request.get(`${base}/api/spaces/${spaces[0].id}`)).json()
const pageType = bundle.types.find((t) => t.system === 'page')
const created = await (
  await page.request.post(`${base}/api/objects`, {
    headers: { 'x-requested-with': 'vasta' },
    data: { typeId: pageType.id, title: `Replica check ${engine}`, content: { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First line' }] }] } } },
  })
).json()
await sleep(1500) // the replica pulls it after the server's live event
api.length = 0
await page.goto(`${base}/o/${created.id}`)
await page.waitForSelector('.vasta-doc')
await until(async () => (await page.textContent('.vasta-doc'))?.includes('First line'), 'text shown')
const reads = api.filter((c) => c.startsWith('GET /api/objects') || c.startsWith('GET /api/spaces'))
console.log(`  reads that went to the server: ${reads.length ? reads.join(', ') : 'none'}`)

step('type in the body; it reaches the server')
await endOfText()
await page.keyboard.press('Enter')
await page.keyboard.type('Typed online')
await until(async () => bodyText(await serverObject(created.id)).includes('Typed online'), 'online text on the server')
await compare('after online typing')

step('go offline, edit title and body, reload nothing yet')
await context.setOffline(true)
await page.click('textarea[data-large-text]')
await page.keyboard.press('Meta+ArrowDown')
await page.keyboard.type(' (offline)')
await endOfText()
await page.keyboard.press('Enter')
await page.keyboard.type('Typed offline')
await sleep(1500)
await compare('after offline typing')
const banner = await until(async () => (await page.textContent('[role=status]').catch(() => '')) || '', 'offline banner')
console.log(`  banner: ${banner.trim()}`)

if (built) {
  step('reload while offline (service worker + replica)')
  await page.reload()
  await page.waitForSelector('.vasta-doc', { timeout: 30000 })
  const shown = await page.textContent('.vasta-doc')
  const title = await page.inputValue('textarea[data-large-text]')
  console.log(`  after offline reload: title "${title}", body has offline text: ${shown.includes('Typed offline')}`)
  if (!shown.includes('Typed offline') || !title.endsWith('(offline)')) throw new Error('offline edits not there after reload')
  await endOfText()
  await page.keyboard.press('Enter')
  await page.keyboard.type('Typed after offline reload')
  await sleep(800)
}

step('back online: everything reaches the server')
await context.setOffline(false)
await until(async () => {
  const o = await serverObject(created.id)
  return o.title.endsWith('(offline)') && bodyText(o).includes('Typed offline') && (!built || bodyText(o).includes('Typed after offline reload'))
}, 'offline edits on the server', 40000)

if (TOKEN) {
  step('a capture from elsewhere shows up live in the open daily note')
  const today = await (await page.request.get(`${base}/api/capture/today`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()
  await page.goto(`${base}/o/${today.dailyNoteId}`)
  await page.waitForSelector('.vasta-doc')
  await endOfText()
  await page.keyboard.press('Enter')
  await page.keyboard.type('Typing while a capture arrives')
  const capture = await page.request.post(`${base}/api/capture/note`, { headers: { authorization: `Bearer ${TOKEN}` }, data: { text: `Captured for ${engine}` } })
  if (capture.status() !== 201) throw new Error(`capture failed: ${capture.status()}`)
  await page.keyboard.type(' and more')
  await until(async () => (await page.textContent('.vasta-doc')).includes(`Captured for ${engine}`), 'capture shown live')
  await until(async () => {
    const t = bodyText(await serverObject(today.dailyNoteId))
    return t.includes(`Captured for ${engine}`) && t.includes('Typing while a capture arrives and more')
  }, 'both on the server')
}

step('a title changed elsewhere shows up on the open page')
await page.goto(`${base}/o/${created.id}`)
await page.waitForSelector('.vasta-doc')
const current = await serverObject(created.id)
await page.request.put(`${base}/api/objects/${created.id}`, { headers: { 'x-requested-with': 'vasta' }, data: { ...current, title: 'Renamed elsewhere' } })
await until(async () => (await page.inputValue('textarea[data-large-text]')) === 'Renamed elsewhere', 'title updated live')

const text = bodyText(await serverObject(created.id))
console.log(`  server text:\n    ${text.split('\n').join('\n    ')}`)
if (problems.length) console.log(`console problems:\n  ${problems.join('\n  ')}`)
console.log('OK')
await browser.close()
