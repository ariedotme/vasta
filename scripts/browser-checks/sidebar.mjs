// Sidebar sections in the test env: a stray second "Pinned" folds into the first, "Pin to sidebar ›"
// puts a type in several sections at once with checkboxes, rows drag between sections, and
// section headers drag to reorder.
//   node sidebar.mjs [chromium|webkit] [base]
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, webkit } from 'playwright'

const engine = process.argv[2] ?? 'chromium'
const base = process.argv[3] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)

const options = { viewport: { width: 1400, height: 900 }, locale: 'en-US', timezoneId: 'America/Sao_Paulo' }
const launched = engine === 'webkit' ? undefined : await chromium.launch()
const context = launched ? await launched.newContext(options) : await webkit.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'vasta-sidebar-')), options)
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
      const shot = path.join(tmpdir(), `vasta-sidebar-${engine}.png`)
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
await page.waitForSelector('nav', { timeout: 30000 })

// A space of its own, so the checks start from a known sidebar.
const tag = `${engine}-${Date.now() % 100000}`
const space = await post('/api/spaces', { name: `Sidebar ${tag}` })
const sections = space.sidebar
const own = sections[0]
const types = (await get(`/api/spaces/${space.id}`)).types
const book = await post('/api/types', { spaceId: space.id, name: `Book ${tag}`, pluralName: `Books ${tag}` })
await put(`/api/spaces/${space.id}`, {
  ...space,
  sidebar: [{ id: 'pinned', name: 'Pinned', items: [] }, ...sections, { id: 'reading', name: 'Reading', items: [] }, { id: 'later', name: 'Later', items: [] }],
})
const sidebar = async () => (await get('/api/spaces')).find((s) => s.id === space.id).sidebar
const headerNames = () => page.locator('nav [data-section]').allTextContents().then((all) => all.map((t) => t.trim()))

step('open the space: the stray Pinned folds into one')
await page.evaluate((id) => localStorage.setItem('vasta.space', id), space.id)
await page.reload()
await page.waitForSelector('nav')
// Switch through the space menu in case the app keeps the last space elsewhere.
if (!(await page.locator('aside').getByText(`Sidebar ${tag}`).count())) {
  await page.locator('aside button[title="Spaces and account"]').click()
  await page.locator('[role=menu]').getByText(`Sidebar ${tag}`).click()
}
await until(async () => JSON.stringify(await headerNames()) === JSON.stringify(['Pinned', 'Reading', 'Later']), 'one Pinned header')
await until(async () => (await sidebar()).filter((s) => s.name === 'Pinned').length === 1, 'one Pinned saved')
const pinnedItems = (await sidebar())[0].items
if (JSON.stringify(pinnedItems) !== JSON.stringify(own.items)) throw new Error(`pinned items changed: ${pinnedItems}`)

step('pin a type in two sections from its right-click menu')
const bookRow = page.locator('nav a', { hasText: `Books ${tag}` })
await bookRow.click({ button: 'right' })
await page.locator('[role=menu] button', { hasText: 'Pin to sidebar' }).hover()
const submenu = page.locator('[role=menu]').nth(1)
await submenu.waitFor()
await submenu.locator('[role=menuitemcheckbox]', { hasText: 'Reading' }).click()
await until(async () => (await submenu.locator('[role=menuitemcheckbox]', { hasText: 'Reading' }).getAttribute('aria-checked')) === 'true', 'Reading checked')
await submenu.locator('[role=menuitemcheckbox]', { hasText: 'Later' }).click()
await page.screenshot({ path: path.join(tmpdir(), `vasta-sidebar-menu-${engine}.png`) })
await until(async () => {
  const s = await sidebar()
  return s.find((x) => x.id === 'reading').items.includes(book.id) && s.find((x) => x.id === 'later').items.includes(book.id)
}, 'type saved in both sections')
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')
await until(async () => (await page.locator('nav a', { hasText: `Books ${tag}` }).count()) === 2, 'type shown in both sections')

step('uncheck from the submenu')
await page.locator('nav a', { hasText: `Books ${tag}` }).last().click({ button: 'right' })
await page.locator('[role=menu] button', { hasText: 'Pinned in sidebar' }).hover()
await page.locator('[role=menu]').nth(1).locator('[role=menuitemcheckbox]', { hasText: 'Later' }).click()
await until(async () => !(await sidebar()).find((x) => x.id === 'later').items.includes(book.id), 'removed from Later')
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')

step('drag the type from Reading to the top of Pinned')
const firstPinned = page.locator('nav a').filter({ hasText: types.find((t) => t.id === own.items.find((i) => i !== types.find((t) => t.system === 'task')?.id))?.pluralName ?? '' }).first()
await page.locator('nav a', { hasText: `Books ${tag}` }).dragTo(firstPinned, { targetPosition: { x: 20, y: 2 } })
await until(async () => {
  const s = await sidebar()
  return !s.find((x) => x.id === 'reading').items.includes(book.id) && s[0].items.includes(book.id)
}, 'moved to Pinned')
const placed = (await sidebar())[0].items
console.log('  Pinned now:', placed.map((id) => types.find((t) => t.id === id)?.pluralName ?? (id === book.id ? 'Books' : id)).join(', '))

step('drag the Later header above Pinned')
await page.locator('nav [data-section="later"]').dragTo(page.locator('nav [data-section]').first(), { targetPosition: { x: 20, y: 2 } })
await until(async () => (await sidebar())[0].id === 'later', 'Later first')
console.log('  sections:', (await sidebar()).map((s) => s.name).join(', '))

if (problems.length) console.log(problems.join('\n'))
console.log(problems.length ? `done with ${problems.length} console problems` : 'ok')
await browser.close()
