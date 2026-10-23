// Templates and snippets in the test env: a task saved as a template opens in template mode, "{{"
// inserts a placeholder chip, the type's New uses the default template (its question asked, the
// placeholders resolved, the cursor where it says), the template is listed nowhere else, ⌘K
// completes "/Task:" with it, and a snippet goes into a page from the "/" menu by its trigger.
//   node templates.mjs [chromium|webkit] [base]        MODE=json: the replica turned off (HTTP mode)
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, webkit } from 'playwright'

const engine = process.argv[2] ?? 'chromium'
const base = process.argv[3] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)

const options = { viewport: { width: 1300, height: 900 }, locale: 'en-US' }
const launched = engine === 'webkit' ? undefined : await chromium.launch()
const context = launched ? await launched.newContext(options) : await webkit.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'vasta-templates-')), options)
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
      const shot = path.join(tmpdir(), `vasta-templates-${engine}.png`)
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
const tag = `${engine}${process.env.MODE === 'json' ? '-json' : ''}-${Date.now() % 100000}`

await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav', { timeout: 30000 })
const space = (await get('/api/spaces'))[0]
const bundle = await get(`/api/spaces/${space.id}`)
const taskType = bundle.types.find((t) => t.system === 'task')
const pageType = bundle.types.find((t) => t.system === 'page')
const name = `Bug ${tag}`
const source = await post('/api/objects', {
  typeId: taskType.id,
  title: '{{title}} [bug]',
  content: { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reported by {{ask:Who saw it?}}' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Steps: ' }] }] } },
})
await sleep(1500)

step('save a task as a template')
await page.goto(`${base}/o/${source.id}`)
await page.waitForSelector('.vasta-doc p')
await page.click('button[title="More"]')
await page.click('button:has-text("Save as template")')
await page.waitForSelector('text=Save as template')
await page.locator('input').last().fill(name)
await page.click('button:has-text("Save template")')
await page.click('text=Open')
await page.waitForSelector('[data-template-banner]')
const templateId = page.url().split('/o/')[1]

step('"{{" inserts a placeholder chip')
await page.locator('.vasta-doc p').nth(1).click()
await page.keyboard.press('End')
await page.keyboard.type(' {{curs')
await page.waitForSelector('button:has-text("cursor")')
await page.keyboard.press('Enter')
await until(async () => (await page.locator('[data-placeholder-chip]').count()) === 1, 'a chip in the text')

step('make it the default')
await page.click('[data-template-banner] button:has-text("Make default")')
await until(async () => (await page.locator('[data-template-banner]').textContent()).includes('· default'), 'marked default')
await sleep(1500)

step('the template is listed nowhere else')
const listed = await get(`/api/types/${taskType.id}/objects`)
if (listed.some((o) => o.id === templateId)) throw new Error('the template is in the type’s list')
const found = await get(`/api/spaces/${space.id}/search?q=${encodeURIComponent('[bug]')}`)
if (found.some((o) => o.id === templateId)) throw new Error('search finds the template')

step('New makes a task from the default, asking its question')
await page.goto(`${base}/t/${taskType.id}`)
await page.waitForSelector('[data-new-split]')
await page.click('[data-new-split] button >> nth=0')
await page.waitForSelector('text=Who saw it?')
await page.keyboard.type('Lena')
await page.click('button:has-text("Create")')
await page.waitForURL(/\/o\/.+cursor=/)
await until(async () => (await page.locator('.vasta-doc p').first().textContent()) === 'Reported by Lena', 'the answer in the text')
if (await page.locator('[data-placeholder-chip]').count()) throw new Error('a chip is left in the new task')
await until(async () => page.evaluate(() => document.activeElement?.closest('.vasta-doc') !== null), 'the cursor in the text')
await page.keyboard.type('click save')
await until(async () => /^Steps:\s+click save\s*$/.test(await page.locator('.vasta-doc p').nth(1).textContent()), 'typed where {{cursor}} was')
const made = page.url().split('/o/')[1].split('?')[0]
await sleep(1500)
const task = await get(`/api/objects/${made}`)
if (task.template) throw new Error('the new task is a template')

step('the chevron lists the template')
await page.goto(`${base}/t/${taskType.id}`)
await page.click('[data-new-split] button[title="Templates"]')
await page.waitForSelector(`text=${name}`)
await page.keyboard.press('Escape')

step('⌘K completes /Task: with it')
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
await page.keyboard.type(`/${taskType.name}:Bug`)
await page.waitForSelector(`text=${name}`)
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')

step('a snippet goes in by its trigger from the / menu')
const trigger = `sig${tag.replace(/[^a-z0-9]/g, '')}`
await post('/api/objects', { typeId: pageType.id, title: 'Sig', content: { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '— signed in {{title}}' }] }] } }, template: { kind: 'snippet', name: `Signature ${tag}`, trigger } })
const target = await post('/api/objects', { typeId: pageType.id, title: `Snippets ${tag}`, content: { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }] }] } } })
await sleep(1500)
await page.goto(`${base}/o/${target.id}`)
await page.waitForSelector('.vasta-doc p')
await page.locator('.vasta-doc p').first().click()
await page.keyboard.press('End')
await page.keyboard.type(`/${trigger}`)
await page.waitForSelector(`text=Signature ${tag}`)
await page.keyboard.press('Enter')
await until(async () => (await page.locator('.vasta-doc p').first().textContent()) === `Hello — signed in Snippets ${tag}`, 'the snippet inline')

if (problems.length) {
  console.log(problems.join('\n'))
  throw new Error('console problems')
}
console.log('ok')
await browser.close()
