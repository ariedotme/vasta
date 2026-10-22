// Quotes in the test env: select a passage, "Save as quote" with a note, the passage is
// highlighted, a click on it opens the quote (related to its source), and deleting the quote
// removes the highlight.
//   node quotes.mjs [chromium|webkit] [base]        MODE=json: the replica turned off (HTTP mode)
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, webkit } from 'playwright'

const engine = process.argv[2] ?? 'chromium'
const base = process.argv[3] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)

const options = { viewport: { width: 1300, height: 900 }, locale: 'en-US' }
const launched = engine === 'webkit' ? undefined : await chromium.launch()
const context = launched ? await launched.newContext(options) : await webkit.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'vasta-quotes-')), options)
const browser = launched ?? context
if (process.env.MODE === 'json') await context.addInitScript(() => localStorage.setItem('vasta.replica', 'off'))
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
      const shot = path.join(tmpdir(), `vasta-quotes-${engine}.png`)
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

await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav', { timeout: 30000 })
const space = (await get('/api/spaces'))[0]
const bundle = await get(`/api/spaces/${space.id}`)
if (!bundle.types.some((t) => t.system === 'quote')) throw new Error('the space has no Quote type (restart the test env server)')
const pageType = bundle.types.find((t) => t.system === 'page')
const source = await post('/api/objects', {
  typeId: pageType.id,
  title: `Quotes check ${engine}`,
  content: { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fear is the mind-killer, said the litany.' }] }] } },
})
await sleep(1500)
await page.goto(`${base}/o/${source.id}`)
await page.waitForSelector('.vasta-doc p')

step('select a passage and save it as a quote')
await page.locator('.vasta-doc p').first().evaluate((p) => {
  const node = p.firstChild
  const range = document.createRange()
  range.setStart(node, 0)
  range.setEnd(node, 'Fear is the mind-killer'.length)
  const selection = getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
})
await page.locator('.vasta-doc').focus()
await page.click('button[title="Save as quote"]')
await page.waitForSelector('text=Save as quote')
await page.keyboard.type('From the litany')
await page.click('button:has-text("Save quote")')
const mark = page.locator('.vasta-doc mark.vasta-quote')
await until(async () => (await mark.count()) === 1 && (await mark.textContent()) === 'Fear is the mind-killer', 'the passage highlighted')
const quoteId = await mark.getAttribute('data-quote-id')
const quote = await until(async () => {
  const q = await get(`/api/objects/${quoteId}`)
  return q?.title ? q : undefined
}, 'the quote on the server')
if (quote.title !== 'Fear is the mind-killer' || quote.props.source?.value?.[0] !== source.id) throw new Error(`unexpected quote: ${JSON.stringify(quote)}`)
if (!JSON.stringify(quote.content.body ?? {}).includes('From the litany')) throw new Error('the note is missing')
await until(async () => JSON.stringify((await get(`/api/objects/${source.id}`)).content.body).includes(quoteId), 'the highlight on the server')

step('a click on the highlight opens the quote')
await page.locator('.vasta-doc p').first().click({ position: { x: 300, y: 5 } })
await sleep(200)
await mark.click()
await until(() => page.url().endsWith(`/o/${quoteId}`), 'the quote page')
await until(async () => (await page.textContent('body')).includes(`Quotes check ${engine}`), 'the source on the quote page')

step('deleting the quote removes the highlight')
await page.request.delete(`${base}/api/objects/${quoteId}`, { headers })
await until(async () => !JSON.stringify((await get(`/api/objects/${source.id}`)).content.body).includes(quoteId), 'highlight gone on the server')
await page.goto(`${base}/o/${source.id}`)
await page.waitForSelector('.vasta-doc p')
await until(async () => (await page.locator('.vasta-doc mark').count()) === 0 && (await page.textContent('.vasta-doc')).includes('Fear is the mind-killer'), 'highlight gone in the editor')

console.log(problems.length ? `problems:\n${problems.join('\n')}` : 'no console problems')
await browser.close()
console.log('ok')
