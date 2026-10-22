// How long the first login takes until the app shows (it works with the server meanwhile), until the
// replica is filled in the background, and a reload, on the built app.
//   node firstsync.mjs [chromium|webkit]   (webkit: iPhone 15 profile, persistent for OPFS)
import { chromium, devices, webkit } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const [engine = 'chromium'] = process.argv.slice(2)
const base = 'http://127.0.0.1:5184'
const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['iPhone 15']
const context = await (engine === 'webkit' ? webkit : chromium).launchPersistentContext(
  mkdtempSync(path.join(tmpdir(), `vasta-firstsync-${engine}-`)),
  engine === 'webkit' ? { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } : {}
)
const page = context.pages()[0] ?? (await context.newPage())
await page.goto(base)
// Playwright's WebKit keeps OPFS across profiles: start from an empty one, or this is no first sync.
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory()
  for await (const name of root.keys()) await root.removeEntry(name, { recursive: true })
})
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
const sync = []
page.on('requestfinished', (request) => {
  const url = new URL(request.url())
  if (url.pathname.startsWith('/api/sync/')) sync.push(url.pathname)
})
let start = Date.now()
await page.click('button[type=submit]')
// The phone layout keeps the sidebar hidden.
await page.waitForSelector('#login-username', { state: 'detached', timeout: 120000 })
await page.waitForSelector('nav', { state: 'attached', timeout: 120000 })
console.log(`${engine}: login to app: ${Date.now() - start} ms`)
// Settings › This device, without loading the page again (that would restart the fill).
await page.evaluate(() => {
  history.pushState({}, '', '/settings')
  dispatchEvent(new PopStateEvent('popstate'))
})
await page.waitForSelector('#device')
await page.waitForFunction(() => document.querySelector('#device')?.textContent?.includes('Keeps a copy of your spaces'), null, { timeout: 300000 })
console.log(`${engine}: replica filled: ${Date.now() - start} ms (${sync.length} sync requests)`)
start = Date.now()
await page.reload()
await page.waitForSelector('nav', { state: 'attached', timeout: 60000 })
console.log(`${engine}: reload with the replica: ${Date.now() - start} ms`)
await page.goto(`${base}/settings`)
await page.waitForSelector('#device')
console.log((await page.textContent('#device')).replace(/\s+/g, ' ').trim())
// Offline, an object the pull brought (the last of the bench data, when there is one) opens from the replica.
const last = process.env.LAST_OBJECT
if (last) {
  await context.setOffline(true)
  await page.goto(`${base}/o/${last}`).catch(() => page.evaluate((path) => history.pushState({}, '', path), `/o/${last}`))
  await page.waitForSelector('.ProseMirror', { timeout: 20000 })
  console.log(`offline, ${last}: ${(await page.textContent('.ProseMirror')).slice(0, 60)}`)
}
await context.close()
