// Back on a phone (390×844, touch): with a dialog, the command palette, a menu or the side drawer open
// it closes that and the page and its address stay (a second Back then leaves the page; Type settings
// opened from the address drop ?settings=1; with a change they ask first); a list comes
// back scrolled where it was left and a page opened starts at its top; the left-edge swipe (the
// browser's own Back on an iPhone) opens no drawer in a browser tab, but still does in the installed
// Home Screen app (faked with navigator.standalone), and a swipe left on the open drawer closes it.
//   node phone-back.mjs [chromium|webkit] [base]      ALL=1: go on after a failing step
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, webkit } from 'playwright'

const engine = process.argv[2] ?? 'chromium'
const base = process.argv[3] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)

const options = { viewport: { width: 390, height: 844 }, hasTouch: true, ...(engine === 'webkit' ? {} : { isMobile: true }), locale: 'en-US', timezoneId: 'America/Toronto' }
const launched = engine === 'webkit' ? undefined : await chromium.launch()
const context = launched ? await launched.newContext(options) : await webkit.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'vasta-phone-back-')), options)
const browser = launched ?? context
// The installed app: iOS sets navigator.standalone for a Home Screen app.
await context.addInitScript(() => {
  if (localStorage.getItem('check.standalone')) Object.defineProperty(navigator, 'standalone', { value: true })
})
const page = context.pages()[0] ?? (await context.newPage())
const problems = []
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !/401|TextSelection endpoint|due to access control checks|async component loader|linkifyjs: already initialized|Failed to load resource/.test(m.text()) && problems.push(`${m.type()}: ${m.text()}`))
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (name) => console.log(`• ${name}`)
async function until(check, what, timeout = 10000) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`timed out: ${what}`)
    await sleep(200)
  }
}
const headers = { 'x-requested-with': 'vasta' }
const get = async (url) => (await page.request.get(`${base}${url}`)).json()
const post = async (url, data) => (await page.request.post(`${base}${url}`, { headers, data })).json()

/** The browser's Back (as the edge swipe does), then time for the router to put the entry back. */
async function back() {
  await page.evaluate(() => history.back())
  await sleep(700)
}
const where = () => page.evaluate(() => location.pathname + location.search)
const scrolled = () => page.evaluate(() => document.querySelector('main').scrollTop)
const scrollTo = (top) => page.evaluate((top) => (document.querySelector('main').scrollTop = top), top)
const gone = (selector, what) => until(async () => (await page.locator(selector).count()) === 0, what)
const drawer = '.fixed.inset-0.z-30'
const palette = 'input[placeholder^="Search"]'
const dialog = '[role=dialog]'
/** Touches as the page sees a swipe: a start at `from`, the finger lifting at `to` (x, px). */
const swipe = (from, to) =>
  page.evaluate(
    ({ from, to }) => {
      const root = document.querySelector('main').closest('.flex.h-full.flex-col')
      const fire = (type, x) => {
        const event = new Event(type, { bubbles: true })
        const touches = [{ clientX: x, clientY: 450 }]
        Object.defineProperty(event, 'touches', { value: type === 'touchstart' ? touches : [] })
        Object.defineProperty(event, 'changedTouches', { value: touches })
        root.dispatchEvent(event)
      }
      fire('touchstart', from)
      fire('touchend', to)
    },
    { from, to }
  )

await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('main', { timeout: 30000 })

const tag = `${engine}-${Date.now() % 100000}`
const space = (await get('/api/spaces'))[0]
const bundle = await get(`/api/spaces/${space.id}`)
const taskType = bundle.types.find((t) => t.system === 'task')
const tasks = []
for (let i = 0; i < 40; i++) tasks.push(await post('/api/objects', { typeId: taskType.id, title: `PhoneBack ${tag} ${String(i).padStart(2, '0')}` }))
const listPath = `/t/${taskType.id}`
await sleep(2000) // the replica pulls them

/** The Tasks list, reached from the side drawer: one more step in history. */
async function openList() {
  await page.locator('header button[title="Menu"]').click()
  await page.locator(`nav a[href="${listPath}"]`).first().click()
  await until(async () => (await where()).startsWith(listPath), 'the Tasks list')
  await page.locator(`main a[href="/o/${tasks[0].id}"]`).first().waitFor()
}

const failed = []
/** Each scenario starts from Home and the list, so one failing (ALL=1 goes on) leaves the next unharmed. */
async function scenario(name, run) {
  step(name)
  try {
    await page.goto(base)
    await page.waitForSelector('main', { timeout: 30000 })
    await openList()
    await run(await where())
  } catch (error) {
    if (!process.env.ALL) throw error
    failed.push(name)
    console.log(`  FAIL: ${error.message}`)
  }
}

try {
  await scenario('Back with the side drawer open closes it; the list stays', async (list) => {
    await page.locator('header button[title="Menu"]').click()
    await page.locator(drawer).waitFor()
    await back()
    await gone(drawer, 'Back closes the drawer')
    if ((await where()) !== list) throw new Error(`Back with the drawer open left the list: ${await where()}`)
  })

  await scenario('Back with the command palette open closes it; the list stays', async (list) => {
    await page.locator('header button[title^="Search"]').click()
    await page.locator(palette).waitFor()
    await back()
    await gone(palette, 'Back closes the command palette')
    if ((await where()) !== list) throw new Error(`Back with the palette open left the list: ${await where()}`)
  })

  await scenario('Back with a dialog open (New type, from the palette) closes it; the list stays; the next Back leaves the list', async (list) => {
    await page.locator('header button[title^="Search"]').click()
    await page.locator(palette).fill('new type')
    await sleep(400)
    await page.keyboard.press('Enter')
    await page.locator(dialog).waitFor()
    await back()
    await gone(dialog, 'Back closes the dialog')
    if ((await where()) !== list) throw new Error(`Back with a dialog open left the list: ${await where()}`)
    await back()
    await until(async () => !(await where()).startsWith(listPath), 'Back leaves the list')
  })

  await scenario('Back with a menu open (the type page\'s More) closes it; the list stays', async (list) => {
    await page.locator('main button[title="More"]').first().click()
    const item = page.getByRole('button', { name: 'Type settings…' }).or(page.getByText('Type settings…'))
    await item.first().waitFor()
    await back()
    await gone('text=Type settings…', 'Back closes the menu')
    if ((await where()) !== list) throw new Error(`Back with a menu open left the list: ${await where()}`)
  })

  await scenario('Type settings opened from the sidebar (?settings=1): Back closes them and the address loses ?settings', async () => {
    await page.locator('header button[title="Menu"]').click()
    // A type under All types; a long press on a phone opens the same menu a right-click does.
    const books = page.locator('nav a[href^="/t/"]', { hasText: 'Books' }).first()
    const booksPath = await books.getAttribute('href')
    await books.dispatchEvent('contextmenu', { clientX: 120, clientY: 300 })
    await page.getByText('Type settings…').first().click()
    await page.locator(dialog).waitFor()
    await until(async () => (await where()) === `${booksPath}?settings=1`, 'the address with ?settings=1')
    await back()
    await gone(dialog, 'Back closes Type settings')
    await until(async () => (await where()) === booksPath, `the address back to ${booksPath} (is ${await where()})`, 3000)
  })

  await scenario('Back in Type settings with a change asks first; Back again keeps the change', async () => {
    await page.locator('main button[title="More"]').first().click()
    await page.getByText('Type settings…').first().click()
    await page.locator(dialog).waitFor()
    await page.locator(`${dialog} input`).first().fill(`Tasks ${tag}`)
    await back()
    await page.getByText('Discard your changes to this type?').waitFor({ timeout: 3000 })
    await back()
    await gone('text=Discard your changes to this type?', 'Back closes the question')
    if ((await page.locator(`${dialog} input`).first().inputValue()) !== `Tasks ${tag}`) throw new Error('the change was lost')
    await page.getByRole('button', { name: 'Discard' }).click().catch(() => {})
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Discard' }).click()
    await gone(dialog, 'Discard closes Type settings')
  })

  await scenario('a list scrolled down, a task opened from it starts at its top, Back returns to the same place', async () => {
    await scrollTo(1200)
    const left = await scrolled()
    if (left < 1000) throw new Error(`the list is too short to scroll: ${left}`)
    const visible = await page.evaluate(() => {
      const top = document.querySelector('main').getBoundingClientRect().top
      return [...document.querySelectorAll('main a[href^="/o/"]')].find((a) => a.getBoundingClientRect().top > top + 40)?.getAttribute('href')
    })
    // A script's click: Playwright's would scroll the link into view first.
    await page.evaluate((href) => document.querySelector(`main a[href="${href}"]`).click(), visible)
    await until(async () => (await where()).startsWith('/o/'), 'the task page')
    await sleep(500)
    if ((await scrolled()) !== 0) throw new Error(`the task page opened scrolled: ${await scrolled()}`)
    await back()
    await until(async () => (await where()).startsWith(listPath), 'Back to the list')
    await until(async () => Math.abs((await scrolled()) - left) <= 2, `the list back at ${left} (is ${await scrolled()})`, 4000)
  })

  await scenario('an edge swipe in a browser tab opens no drawer; a swipe left on the open drawer still closes it', async () => {
    await swipe(4, 300)
    await sleep(400)
    if ((await page.locator(drawer).count()) > 0) throw new Error('a swipe from the left edge opened the drawer in a browser tab')
    await page.locator('header button[title="Menu"]').click()
    await page.locator(drawer).waitFor()
    await swipe(250, 100)
    await gone(drawer, 'a swipe left closes the drawer')
  })

  await scenario('in the installed app the edge swipe opens the drawer', async () => {
    await page.evaluate(() => localStorage.setItem('check.standalone', '1'))
    await page.reload()
    await page.waitForSelector('main', { timeout: 30000 })
    if (!(await page.evaluate(() => navigator.standalone))) throw new Error('standalone was not faked')
    await swipe(4, 300)
    await page.locator(drawer).waitFor({ timeout: 3000 })
  })

  if (failed.length) throw new Error(`failed: ${failed.join(' | ')}`)
  if (problems.length) throw new Error(problems.join('\n'))
  console.log(`\nAll phone-back checks passed for ${engine}.`)
} catch (error) {
  const shot = path.join(tmpdir(), `vasta-phone-back-${engine}.png`)
  await page.screenshot({ path: shot }).catch(() => {})
  console.log('screenshot:', shot)
  if (problems.length) console.log(problems.join('\n'))
  throw error
} finally {
  await page.evaluate(() => localStorage.removeItem('check.standalone')).catch(() => {})
  for (const task of tasks) await page.request.delete(`${base}/api/objects/${task.id}`, { headers }).catch(() => {})
  await browser.close()
}
