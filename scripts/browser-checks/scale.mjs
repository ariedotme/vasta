// The app on a big space (made by `pnpm load-test 50000 --keep`, served as that script prints): how
// long the first login takes until the app shows, until the local replica has everything, a type
// page with many objects, Today, ⌘K search, and a reload. Times only; nothing is checked.
//   node scale.mjs [base] [username] [password]     (default http://127.0.0.1:5297, load, load-password)
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://127.0.0.1:5297'
const [username, password] = [process.argv[3] ?? 'load', process.argv[4] ?? 'load-password']
const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
const t0 = Date.now()
const since = (t) => `${((Date.now() - t) / 1000).toFixed(1)} s`

await page.goto(base)
await page.fill('#login-username', username)
await page.fill('#login-password', password)
await page.click('button[type=submit]')
await page.waitForSelector('nav', { state: 'attached', timeout: 600000 })
console.log(`app shown after login: ${since(t0)}`)
await page.goto(`${base}/settings`)
await page.waitForSelector('#device')
for (;;) {
  const text = (await page.textContent('#device')) ?? ''
  if (/Last synced/.test(text) && !/Syncing/.test(text)) break
  if (Date.now() - t0 > 900000) throw new Error(`no full replica after 15 min: ${text.slice(0, 200)}`)
  await page.waitForTimeout(500)
}
console.log(`local replica complete: ${since(t0)}`)

let t = Date.now()
await page.locator('aside a', { hasText: 'Pages' }).first().click()
await page.waitForFunction(() => document.querySelectorAll('main a[href^="/o/"]').length > 10, null, { timeout: 120000 })
console.log(`Pages: ${since(t)}`)
t = Date.now()
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+d' : 'Control+d')
await page.waitForURL(/view=day/, { timeout: 60000 })
await page.waitForSelector('main .ProseMirror', { timeout: 60000 })
console.log(`Today: ${since(t)}`)
t = Date.now()
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
await page.keyboard.type('garden')
// The palette's results for "garden" (before, it lists recent objects, some with the word too).
await page.waitForFunction(
  () => {
    const titles = [...document.querySelectorAll('.fixed.inset-0.z-50 .font-medium')].map((e) => e.textContent ?? '')
    return titles.length > 2 && titles.every((title) => /garden/i.test(title))
  },
  null,
  { timeout: 60000 }
)
console.log(`⌘K search: ${since(t)}`)
t = Date.now()
await page.reload()
await page.waitForSelector('nav', { state: 'attached', timeout: 120000 })
console.log(`reload: ${since(t)}`)
if (errors.length) console.log('page errors:', errors.slice(0, 5))
await browser.close()
