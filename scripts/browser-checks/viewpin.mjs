// A view pinned in the sidebar, in the test env: Tasks' "…" menu pins the open view, the row opens
// that view even from another view of Tasks, only it is the raised row, picking another view drops
// the link, deleting the view takes the row away, a view's tab drags into a section, and Tasks
// itself pinned shows in its section too. A type reopens on the view last picked, not on one opened
// by default.
//   node viewpin.mjs [chromium|webkit] [base]
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, webkit } from 'playwright'

const engine = process.argv[2] ?? 'chromium'
const base = process.argv[3] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)

const options = { viewport: { width: 1400, height: 900 }, locale: 'en-US', timezoneId: 'America/Sao_Paulo' }
const launched = engine === 'webkit' ? undefined : await chromium.launch()
const context = launched ? await launched.newContext(options) : await webkit.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'vasta-viewpin-')), options)
const browser = launched ?? context
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
      const shot = path.join(tmpdir(), `vasta-viewpin-${engine}.png`)
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

// A space of its own, with a "Today" view on its Tasks.
const tag = `${engine}-${Date.now() % 100000}`
const space = await post('/api/spaces', { name: `Views ${tag}` })
await page.evaluate((id) => localStorage.setItem('vasta.space', id), space.id)
await page.reload()
await page.waitForSelector('nav')
if (!(await page.locator('aside').getByText(`Views ${tag}`).count())) {
  await page.locator('aside button[title="Spaces and account"]').click()
  await page.locator('[role=menu]').getByText(`Views ${tag}`).click()
}
const tasks = (await get(`/api/spaces/${space.id}`)).types.find((t) => t.system === 'task')
const sidebar = async () => (await get('/api/spaces')).find((s) => s.id === space.id).sidebar
const tasksRow = page.locator('nav a', { hasText: /^\s*Tasks/ }).first()
await tasksRow.click()
await page.waitForURL(`**/t/${tasks.id}`)
await page.locator('button[title="Add view"]').click()
await page.locator('form input').last().fill('Today')
await page.locator('form button[type=submit]').click()
await until(async () => (await get(`/api/spaces/${space.id}`)).types.find((t) => t.id === tasks.id).views.some((v) => v.name === 'Today'), 'Today saved')
const today = (await get(`/api/spaces/${space.id}`)).types.find((t) => t.id === tasks.id).views.find((v) => v.name === 'Today')

step("Tasks' menu pins the open view")
await page.locator('button[title="More"]').click()
await page.getByRole('button', { name: /Pin view to sidebar/ }).click()
await page.locator('[role=menu] button', { hasText: 'Pinned' }).click()
await page.keyboard.press('Escape')
const item = `${tasks.id}?view=${encodeURIComponent(today.id)}`
await until(async () => (await sidebar())[0].items.includes(item), 'view pinned')
const viewRow = page.locator('nav a', { hasText: /^\s*Today\s*$/ })
await until(() => viewRow.count(), 'Today row in the sidebar')

step('the row opens Today from another view, and only it is raised')
const firstView = (await get(`/api/spaces/${space.id}`)).types.find((t) => t.id === tasks.id).views[0]
await page.locator('main [role=button]', { hasText: firstView.name }).first().click()
await viewRow.click()
await until(async () => new URL(page.url()).searchParams.get('view') === today.id, 'Today in the address')
await until(async () => (await page.locator('main [role=button].font-medium', { hasText: 'Today' }).count()) > 0, 'Today tab picked')
const raised = (row) => row.evaluate((el) => el.className.includes('shadow'))
if (!(await raised(viewRow))) throw new Error('Today row not raised')
if (await raised(tasksRow)) throw new Error('Tasks row raised too')

step('another view drops the link, Tasks is raised again')
await page.locator('main [role=button]', { hasText: firstView.name }).first().click()
await until(async () => !new URL(page.url()).searchParams.get('view'), 'view link dropped')
await until(async () => (await raised(tasksRow)) && !(await raised(viewRow)), 'Tasks raised')

step('deleting the view takes its row away')
await viewRow.click()
await until(async () => new URL(page.url()).searchParams.get('view') === today.id, 'Today open')
await page.locator('button[title="More"]').click()
await page.getByRole('button', { name: /Delete view/ }).click()
await page.locator('form button[type=submit]', { hasText: 'Delete view' }).click()
await until(async () => !(await sidebar()).some((s) => s.items.includes(item)), 'pin removed')
await until(async () => (await viewRow.count()) === 0, 'row gone')

step("a view's tab dragged into Pinned pins it")
const firstItem = `${tasks.id}?view=${encodeURIComponent(firstView.id)}`
await page.locator('main [role=button]', { hasText: firstView.name }).first().dragTo(page.locator('nav [data-section]').first())
await until(async () => (await sidebar())[0].items.includes(firstItem), 'dragged view pinned')
await until(() => page.locator('nav a', { hasText: new RegExp(`^\\s*${firstView.name}\\s*$`) }).count(), 'dragged view row')

step('Tasks pinned shows in its section as well as at the top')
if ((await sidebar()).some((s) => s.items.includes(tasks.id))) throw new Error('a new space pins Tasks')
await page.locator('button[title="More"]').click()
await page.getByRole('button', { name: /^Pin to sidebar/ }).click()
await page.locator('[role=menu] button', { hasText: 'Pinned' }).click()
await page.keyboard.press('Escape')
await until(async () => (await sidebar())[0].items.includes(tasks.id), 'Tasks pinned')
await until(async () => (await page.locator('nav a', { hasText: /^\s*Tasks/ }).count()) === 2, 'two Tasks rows')

step('a view opened by default is not remembered, one picked is')
const remembered = () => page.evaluate((key) => localStorage.getItem(key), `vasta.view.${tasks.id}`)
await page.evaluate((key) => localStorage.removeItem(key), `vasta.view.${tasks.id}`)
await page.goto(`${base}/t/${tasks.id}`)
await until(async () => (await page.locator('main [role=button].font-medium', { hasText: firstView.name }).count()) > 0, 'first view open')
if ((await remembered()) !== null) throw new Error('the first view, never picked, was remembered')
await page.locator('button[title="Add view"]').click()
await page.locator('form input').last().fill('Later')
await page.locator('form button[type=submit]').click()
await until(async () => (await get(`/api/spaces/${space.id}`)).types.find((t) => t.id === tasks.id).views.some((v) => v.name === 'Later'), 'Later saved')
await page.reload()
await until(async () => (await page.locator('main [role=button].font-medium', { hasText: 'Later' }).count()) > 0, 'reopens on Later')
await page.locator('main [role=button]', { hasText: firstView.name }).first().click()
await until(async () => (await remembered()) === firstView.id, 'picked view remembered')

if (problems.length) throw new Error(problems.join('\n'))
console.log('ok')
await browser.close()
