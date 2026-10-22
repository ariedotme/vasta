// A weblink made on a device with a replica: created locally, the server fetches its page (test env only).
import { chromium } from 'playwright'
const base = 'http://127.0.0.1:5183'
const browser = await chromium.launch()
const context = await browser.newContext()
const page = await context.newPage()
const problems = []
page.on('console', (m) => (m.type() === 'error') && !/401/.test(m.text()) && problems.push(m.text()))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav', { timeout: 30000 })
const spaces = await (await page.request.get(`${base}/api/spaces`)).json()
const bundle = await (await page.request.get(`${base}/api/spaces/${spaces[0].id}`)).json()
const weblinkType = bundle.types.find((t) => t.system === 'weblink')
await page.goto(`${base}/t/${weblinkType.id}`)
await sleep(800)
await page.locator(`button[title="New ${weblinkType.name}"]`).click()
await page.waitForSelector('input[placeholder="Paste a link to save this page"]', { timeout: 10000 })
const id = page.url().split('/o/')[1]?.split('?')[0]
console.log('created locally:', id)
await page.fill('input[placeholder="Paste a link to save this page"]', 'https://example.com/')
await page.keyboard.press('Enter')
for (let i = 0; i < 60; i++) {
  const o = await (await page.request.get(`${base}/api/objects/${id}`)).json()
  if (o.media?.url && o.title) {
    console.log('server:', o.title, o.media.url)
    break
  }
  await sleep(500)
}
await sleep(1000)
console.log('page title:', await page.inputValue('textarea[data-large-text]'))
if (problems.length) console.log('problems:', problems.join(' | '))
await browser.close()
