// Flow metrics in the test env: tasks moved through their statuses (the activity), then the Tasks
// page's Metrics tab: the numbers, done per week, cumulative flow (hover, table), what waits
// longest. SHOTS=<dir> saves light and dark screenshots.
//   node metrics.mjs [chromium|webkit] [base]
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, webkit } from 'playwright'

const engine = process.argv[2] ?? 'chromium'
const base = process.argv[3] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)

const options = { viewport: { width: 1300, height: 1000 }, locale: 'en-US', timezoneId: 'America/Sao_Paulo' }
const launched = engine === 'webkit' ? undefined : await chromium.launch()
const context = launched ? await launched.newContext(options) : await webkit.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'vasta-metrics-')), options)
const browser = launched ?? context
const page = context.pages()[0] ?? (await context.newPage())
const problems = []
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !/401|404|TextSelection endpoint|due to access control checks|SQLITE_CORRUPT|Importing a module script failed|VUE_ROUTER_R0010|router.onError/.test(m.text()) && problems.push(`${m.type()}: ${m.text()}`))
page.on('pageerror', (e) => !/Importing a module script failed/.test(e.message) && problems.push(`pageerror: ${e.message}`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (name) => console.log(`• ${name}`)
async function until(check, what, timeout = 10000) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeout) {
      console.log(problems.join('\n'))
      const shot = path.join(tmpdir(), `vasta-metrics-${engine}.png`)
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
const put = async (url, data) => (await page.request.put(`${base}${url}`, { headers, data })).json()

await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav', { state: 'attached', timeout: 30000 })

const tag = `${engine}-${Date.now() % 100000}`
const space = await post('/api/spaces', { name: `Metrics ${tag}` })
const task = (await get(`/api/spaces/${space.id}`)).types.find((t) => t.system === 'task')
const status = async (id, value) => {
  const object = await get(`/api/objects/${id}`)
  await put(`/api/objects/${id}`, { ...object, props: { ...object.props, status: { kind: 'select', value: [value] } } })
}
for (const title of ['Ship', 'Fix', 'Write', 'Plan']) {
  const made = await post('/api/objects', { typeId: task.id, title, props: { status: { kind: 'select', value: ['todo'] } } })
  if (title !== 'Plan') await status(made.id, 'doing')
  if (title === 'Ship' || title === 'Fix') await status(made.id, 'done')
}

await page.evaluate((id) => localStorage.setItem('vasta.space', id), space.id)
await page.reload()
await page.waitForSelector('nav', { state: 'attached' })
await until(async () => {
  if (await page.locator('aside').getByText(`Metrics ${tag}`).count()) return true
  await page.locator('aside button[title="Spaces and account"]').click()
  const item = page.locator('[role=menu]').getByText(`Metrics ${tag}`)
  if (await item.count()) await item.click()
  else await page.keyboard.press('Escape')
  await sleep(500)
  return false
}, 'the space open', 30000)

step('the Metrics tab: numbers, charts, what waits longest')
await page.goto(`${base}/t/${task.id}`)
await page.getByRole('button', { name: 'Metrics', exact: true }).click()
const main = page.locator('main')
await until(async () => /Done\s*2\s*in 30 days/.test((await main.textContent()).replace(/\s+/g, ' ')), 'two done')
await until(async () => /In progress\s*1\s*now/.test((await main.textContent()).replace(/\s+/g, ' ')), 'one in progress')
await until(() => page.locator('svg[aria-label^="Cumulative flow"]').count(), 'the flow chart')
const flow = page.locator('svg[aria-label^="Cumulative flow"]')
const box = await flow.boundingBox()
await page.mouse.move(box.x + box.width - 40, box.y + box.height / 2)
await until(async () => /In progress\s*1/.test((await main.textContent()).replace(/\s+/g, ' ')), 'the hover tooltip')
for (const title of ['Write', 'Plan']) await until(() => main.locator('li', { hasText: title }).count(), `${title} waiting`)
if (await main.locator('li', { hasText: 'Ship' }).count()) throw new Error('a done task waits')
await page.getByRole('button', { name: '90 days' }).click()
await until(async () => /in 90 days/.test(await main.textContent()), 'the 90 days')

if (process.env.SHOTS) {
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2)
  await page.screenshot({ path: path.join(process.env.SHOTS, 'metrics-light.png'), fullPage: true })
  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await sleep(300)
  await page.screenshot({ path: path.join(process.env.SHOTS, 'metrics-dark.png'), fullPage: true })
}

if (problems.length) {
  console.log(problems.join('\n'))
  throw new Error('console problems')
}
console.log('ok')
await browser.close()
