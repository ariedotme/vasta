// A change the server refuses: the toast says so once, Settings › This device lists it until
// dismissed. The server's refusal is faked by answering /api/sync/push here (test env only).
import { chromium } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const [base = 'http://127.0.0.1:5183'] = process.argv.slice(2)
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)
const shots = process.env.SHOTS // a directory for screenshots of the toast and the list
const context = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'vasta-refused-')), process.env.PHONE ? { viewport: { width: 393, height: 852 } } : {})
const page = context.pages()[0] ?? (await context.newPage())
await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav')

const spaces = await (await page.request.get(`${base}/api/spaces`)).json()
const space = spaces[0]
const pageType = (await (await page.request.get(`${base}/api/spaces/${space.id}`)).json()).types.find((t) => t.system === 'page')
const note = await (await page.request.post(`${base}/api/objects`, { headers: { 'x-requested-with': 'vasta' }, data: { typeId: pageType.id, title: 'Refuse me' } })).json()

let refusals = 0
await context.route('**/api/sync/push', async (route) => {
  const { changes } = route.request().postDataJSON()
  refusals += changes.length
  await route.fulfill({ json: { rev: 0, changes: changes.map((c) => ({ table: c.table, id: c.id, lost: [], error: 'refused by the test' })) } })
})
await page.goto(`${base}/o/${note.id}`)
await page.waitForSelector('textarea[data-large-text]')
await page.fill('textarea[data-large-text]', 'Refuse me, renamed')
await page.locator('[role=status]', { hasText: 'The server did not take a change to “Refuse me, renamed”' }).waitFor({ timeout: 15000 })
console.log(`toast shown (${refusals} change refused)`)
if (shots) await page.screenshot({ path: path.join(shots, 'refused-toast.png') })
await page.locator('[role=status] button', { hasText: 'Details' }).click()
await page.waitForURL('**/settings')
const list = page.locator('#device li')
await list.first().waitFor()
if (shots) await page.locator('#device').screenshot({ path: path.join(shots, 'refused-list.png') })
console.log('listed:', (await list.first().textContent()).replace(/\s+/g, ' ').trim())

await context.unroute('**/api/sync/push')
await page.reload()
await page.locator('#device li').first().waitFor()
console.log('after a reload, still listed:', await page.locator('#device li').count())
await page.locator('#device li button[title=Dismiss]').first().click()
await page.locator('#device li').waitFor({ state: 'detached' })
await page.reload()
await page.waitForSelector('#device')
await new Promise((r) => setTimeout(r, 1000))
console.log('after dismissing and a reload:', await page.locator('#device li').count())
await context.close()
console.log('OK')
