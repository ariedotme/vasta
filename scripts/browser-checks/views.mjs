// Walk the app's screens with the local replica (test env only): no errors, same data as the server,
// trash and Undo, search, a second tab (no replica there), logout.
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)
const browser = await chromium.launch()
const context = await browser.newContext()
if (process.env.MODE === 'json') await context.addInitScript(() => localStorage.setItem('vasta.replica', 'off'))
const page = await context.newPage()
const problems = []
const watch = (p, name) => {
  p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !/401|TextSelection endpoint/.test(m.text()) && problems.push(`${name} ${m.type()}: ${m.text()}`))
  p.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`))
}
watch(page, 'tab1')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (name) => console.log(`• ${name}`)
async function until(check, what, timeout = 15000) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeout) {
      console.log(problems.join('\n'))
      throw new Error(`timed out: ${what}`)
    }
    await sleep(250)
  }
}
const get = async (url) => (await page.request.get(`${base}${url}`)).json()

await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav', { timeout: 30000 })
const spaces = await get('/api/spaces')
const space = spaces[0]
const bundle = await get(`/api/spaces/${space.id}`)

step('every type page lists what the server lists')
for (const type of bundle.types.filter((t) => bundle.counts[t.id]).slice(0, 6)) {
  await page.goto(`${base}/t/${type.id}`)
  const server = await get(`/api/types/${type.id}/objects`)
  await until(async () => (await page.textContent('main')).includes(server[0].title || ''), `type ${type.name} shows its objects`)
  console.log(`  ${type.name}: ${server.length} objects`)
}

step('home, inbox, calendar, trash, settings render')
for (const path of ['/', '/inbox', '/calendar', '/trash', '/settings']) {
  await page.goto(`${base}${path}`)
  await sleep(800)
  if (!(await page.textContent('body')).trim()) throw new Error(`${path} is empty`)
}

step('search from the palette')
await page.goto(base)
await sleep(500)
const target = (await get(`/api/spaces/${space.id}/search?q=&limit=5`)).find((o) => o.title)
await page.keyboard.press('Meta+k')
await page.fill('input[placeholder="Search or create…"]', target.title.slice(0, 6))
await until(async () => (await page.textContent('body')).includes(target.title), `palette finds ${target.title}`)
await page.keyboard.press('Escape')

step('move to the trash and undo')
const pageType = bundle.types.find((t) => t.system === 'page')
const victim = await (await page.request.post(`${base}/api/objects`, { headers: { 'x-requested-with': 'vasta' }, data: { typeId: pageType.id, title: 'Trash me' } })).json()
await sleep(1500)
await page.goto(`${base}/o/${victim.id}`)
await page.waitForSelector('textarea[data-large-text]')
await page.locator('article button[title="More"]').first().click()
await page.locator('button', { hasText: 'Move to trash' }).click()
await until(async () => (await get(`/api/objects/${victim.id}`)).deletedAt, 'deleted on the server')
await page.locator('[role=status] button', { hasText: 'Undo' }).click()
await until(async () => !(await get(`/api/objects/${victim.id}`)).deletedAt, 'restored on the server')

step('a second tab works too (straight to the server) and both see each other’s edits')
const second = await context.newPage()
watch(second, 'tab2')
await second.goto(`${base}/o/${victim.id}`)
await second.waitForSelector('textarea[data-large-text]', { timeout: 20000 })
await page.goto(`${base}/o/${victim.id}`)
await page.waitForSelector('textarea[data-large-text]')
await second.fill('textarea[data-large-text]', 'Renamed in tab 2')
await until(async () => (await page.inputValue('textarea[data-large-text]')) === 'Renamed in tab 2', 'tab 1 sees tab 2')
await page.fill('textarea[data-large-text]', 'Renamed in tab 1')
await until(async () => (await second.inputValue('textarea[data-large-text]')) === 'Renamed in tab 1', 'tab 2 sees tab 1', 20000)
await second.close()

step('log out and in again')
await page.goto(base)
await page.click('button[title="Spaces and account"]')
await page.locator('button', { hasText: 'Log out' }).click()
await page.waitForSelector('#login-username')
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav', { timeout: 30000 })
await page.goto(`${base}/o/${victim.id}`)
await until(async () => (await page.inputValue('textarea[data-large-text]').catch(() => '')) === 'Renamed in tab 1', 'replica again after login')

if (problems.length) console.log(`console problems:\n  ${problems.join('\n  ')}`)
console.log('OK')
await browser.close()
