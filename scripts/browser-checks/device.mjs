// Settings > This device on the iPhone profile (built app, test env only), and the update banner.
import { webkit, devices } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const base = 'http://127.0.0.1:5184'
const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['iPhone 15']
const context = await webkit.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'vasta-device-')), { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch, serviceWorkers: 'block' })
const page = context.pages()[0] ?? (await context.newPage())
await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav', { state: 'attached', timeout: 30000 })
await page.goto(`${base}/settings`)
await page.waitForSelector('#device')
await new Promise((r) => setTimeout(r, 1500))
console.log((await page.textContent('#device')).replace(/\s+/g, ' ').trim())
// A different build on the server: the banner appears when the app comes back to the foreground.
await context.route(`${base}/`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<script type="module" crossorigin src="/assets/index-NEWBUILD.js"></script>' }))
console.log(await page.evaluate(async () => ({ running: document.querySelector('script[type=module][src*="/assets/index-"]')?.getAttribute('src'), online: navigator.onLine, fetched: (await (await fetch('/', { cache: 'no-store' })).text()).slice(0, 200) })))
await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
await page.waitForSelector('text=A new version of Vasta is out', { timeout: 5000 })
console.log('update banner: shown')
await context.close()
