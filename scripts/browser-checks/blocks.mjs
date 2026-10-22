// Block colors and links to blocks in the test env: a text color and a background from the block
// menu, "Copy link to block", opening the link (a new load, and a link clicked in the text), ids
// of duplicated blocks, and a toggle that keeps its id when opened.
//   node blocks.mjs [chromium|webkit] [base]        MODE=json: the replica turned off (HTTP mode)
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, webkit } from 'playwright'

const engine = process.argv[2] ?? 'chromium'
const base = process.argv[3] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)

const options = { viewport: { width: 1300, height: 900 }, locale: 'en-US' }
const launched = engine === 'webkit' ? undefined : await chromium.launch()
const context = launched ? await launched.newContext(options) : await webkit.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'vasta-blocks-')), options)
const browser = launched ?? context
if (process.env.MODE === 'json') await context.addInitScript(() => localStorage.setItem('vasta.replica', 'off'))
// The clipboard needs permissions the engines grant differently; keep what is copied instead.
await context.addInitScript(() => {
  if (navigator.clipboard) navigator.clipboard.writeText = async (text) => void (window.__copied = text)
})
const page = context.pages()[0] ?? (await context.newPage())
const problems = []
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !/401|TextSelection endpoint|due to access control checks/.test(m.text()) && problems.push(`${m.type()}: ${m.text()}`))
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (name) => console.log(`• ${name}`)
async function until(check, what, timeout = 10000) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeout) {
      console.log(problems.join('\n'))
      const shot = path.join(tmpdir(), `vasta-blocks-${engine}.png`)
      await page.screenshot({ path: shot })
      console.log('screenshot:', shot)
      throw new Error(`timed out: ${what}`)
    }
    await sleep(200)
  }
}
const headers = { 'x-requested-with': 'vasta' }
const get = async (url) => (await page.request.get(`${base}${url}`)).json()
const post = async (url, data) => (await page.request.post(`${base}${url}`, { headers, data })).json()
const body = async () => (await get(`/api/objects/${created.id}`)).content.body?.content ?? []
const paragraph = (text) => page.locator('.vasta-doc p', { hasText: text })

/** Select the block with this text (Esc) and open the block menu on it. */
async function blockMenu(text) {
  await paragraph(text).click()
  await sleep(150)
  await page.keyboard.press('Escape')
  await sleep(100)
  await paragraph(text).click({ button: 'right' })
  await page.waitForSelector('[role=menu]')
}

await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav', { timeout: 30000 })
const space = (await get('/api/spaces'))[0]
const bundle = await get(`/api/spaces/${space.id}`)
const pageType = bundle.types.find((t) => t.system === 'page')
const created = await post('/api/objects', { typeId: pageType.id, title: `Blocks check ${engine}` })
await sleep(1500)
await page.goto(`${base}/o/${created.id}`)
await page.waitForSelector('.vasta-doc')
await page.click('.vasta-doc')
await sleep(150)
await page.keyboard.type('First line')
await page.keyboard.press('Enter')
await page.keyboard.type('Second line')
await page.keyboard.press('Enter')
for (let i = 0; i < 40; i++) {
  await page.keyboard.type(`Filler ${i}`)
  await page.keyboard.press('Enter')
}
await page.keyboard.type('Last line')

step('every block gets an id')
const ids = await until(async () => {
  const blocks = await body()
  return blocks.length === 43 && blocks.every((b) => b.attrs?.id) ? blocks.map((b) => b.attrs.id) : undefined
}, 'ids on the server')
if (new Set(ids).size !== ids.length) throw new Error('ids are not unique')

step('text color')
await blockMenu('Second line')
await page.click('[role=menu] button:has-text("Color")')
await page.click('[data-colors=text] button[title=red]')
await until(async () => (await paragraph('Second line').getAttribute('class'))?.includes('text-red-600'), 'red text')
step('background')
await blockMenu('First line')
await page.click('[role=menu] button:has-text("Color")')
await page.click('[data-colors=background] button[title=yellow]')
await until(async () => (await paragraph('First line').getAttribute('class'))?.includes('vasta-bg'), 'yellow background')
await until(async () => {
  const [first, second] = await body()
  return first.attrs.background === 'yellow' && second.attrs.textColor === 'red' && first.attrs.id === ids[0]
}, 'colors on the server')

step('copy link to block')
await blockMenu('First line')
await page.click('[role=menu] button:has-text("Copy link to block")')
const link = await until(() => page.evaluate(() => window.__copied), 'copied link')
if (link !== `${base}/o/${created.id}#b-${ids[0]}`) throw new Error(`unexpected link: ${link}`)

step('opening the link scrolls to the block and flashes it')
await page.goto(base)
await page.waitForSelector('nav')
await page.goto(link, { waitUntil: 'commit' })
await until(() => paragraph('First line').evaluate((el) => el.classList.contains('vasta-flash')), 'flash on load')

step('a link in the text opens in the app')
const last = ids[ids.length - 1]
await paragraph('Second line').click()
await page.keyboard.press(engine === 'webkit' || process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
await page.keyboard.type(` see ${base}/o/${created.id}#b-${last} `)
await sleep(500)
const pages = context.pages().length
await page.locator('.vasta-doc a', { hasText: `#b-${last}` }).click()
await until(() => page.url().endsWith(`#b-${last}`), 'hash in the address')
await until(() => paragraph('Last line').evaluate((el) => el.classList.contains('vasta-flash')), 'flash after the click')
if (context.pages().length !== pages) throw new Error('the link opened a new page')

step('a duplicated block gets a new id')
await paragraph('Last line').click()
await sleep(150)
await page.keyboard.press('Escape')
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+d' : 'Control+d')
await until(async () => {
  const blocks = await body()
  const lasts = blocks.filter((b) => b.content?.[0]?.text === 'Last line')
  return lasts.length === 2 && lasts[0].attrs.id === last && lasts[1].attrs.id && lasts[1].attrs.id !== last
}, 'two "Last line" blocks with their own ids')

step('a toggle keeps its id when opened')
await page.keyboard.press('Enter')
await page.keyboard.press('Enter')
await page.keyboard.type('/toggle')
await sleep(300)
await page.keyboard.press('Enter')
await page.keyboard.type('Toggle summary')
const toggle = await until(async () => (await body()).find((b) => b.type === 'details' && b.attrs?.id), 'toggle with an id')
await page.locator('.vasta-doc [data-type=details] > button').first().click()
await until(async () => {
  const now = (await body()).find((b) => b.type === 'details')
  return now?.attrs.open !== toggle.attrs.open && now.attrs.id === toggle.attrs.id
}, 'toggle opened, same id')

console.log(problems.length ? `problems:\n${problems.join('\n')}` : 'no console problems')
await browser.close()
console.log('ok')
