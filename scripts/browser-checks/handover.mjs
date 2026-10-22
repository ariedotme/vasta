// Two tabs: the second works over HTTP while the first holds the replica, takes the replica over
// when the first closes, and keeps saving the page it had open (its text is JSON) to the server.
import { chromium } from 'playwright'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const [base = 'http://127.0.0.1:5183'] = process.argv.slice(2)
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)
const context = await chromium.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'vasta-handover-')))
const first = context.pages()[0] ?? (await context.newPage())
const until = async (check, what, timeout = 15000) => {
  for (const start = Date.now(); Date.now() - start < timeout; await new Promise((r) => setTimeout(r, 200))) if (await check()) return
  throw new Error(`timed out: ${what}`)
}
/** Go to a route inside the app, without loading the page again. */
const visit = (page, route) => page.evaluate((to) => { history.pushState({}, '', to); dispatchEvent(new PopStateEvent('popstate')) }, route)
const device = async (page) => (await page.textContent('#device')).replace(/\s+/g, ' ').trim()

await first.goto(base)
await first.fill('#login-username', 'tester')
await first.fill('#login-password', 'test-password')
await first.click('button[type=submit]')
await first.waitForSelector('nav')
const headers = { 'x-requested-with': 'vasta' }
const space = (await (await first.request.get(`${base}/api/spaces`)).json())[0]
const pageType = (await (await first.request.get(`${base}/api/spaces/${space.id}`)).json()).types.find((t) => t.system === 'page')
const note = await (await first.request.post(`${base}/api/objects`, { headers, data: { typeId: pageType.id, title: 'Handover' } })).json()

const second = await context.newPage()
await second.goto(`${base}/settings`)
await second.waitForSelector('#device')
await until(async () => (await device(second)).includes('Another tab has the local copy'), 'second tab works online')
console.log('second tab:', await device(second))
await visit(second, `/o/${note.id}`)
await second.waitForSelector('.ProseMirror')

await first.close()
await new Promise((r) => setTimeout(r, 1500))
// The page opened before the takeover edits JSON: its typing must reach the server.
await second.locator('.ProseMirror').first().click()
await new Promise((r) => setTimeout(r, 200))
await second.keyboard.type('Typed after the first tab closed')
await until(async () => JSON.stringify((await (await second.request.get(`${base}/api/objects/${note.id}`)).json()).content).includes('first tab closed'), 'typing reaches the server')
console.log('typing on the page opened before the takeover reached the server')

await visit(second, '/settings')
await until(async () => (await device(second)).includes('Keeps a copy'), 'second tab took the replica over')
await until(async () => (await device(second)).includes('Last synced'), 'second tab synced')
console.log('second tab now:', await device(second))

// Offline, the note opens from the replica with the text, and an edit there arrives when back online.
await context.setOffline(true)
await visit(second, `/o/${note.id}`)
await until(async () => ((await second.textContent('.ProseMirror').catch(() => '')) ?? '').includes('first tab closed'), 'note opens offline from the replica')
await second.locator('.ProseMirror').first().click()
await second.keyboard.press('End')
await new Promise((r) => setTimeout(r, 200))
await second.keyboard.type(', and offline')
await new Promise((r) => setTimeout(r, 1000))
await context.setOffline(false)
await second.evaluate(() => dispatchEvent(new Event('online')))
await until(async () => JSON.stringify((await (await second.request.get(`${base}/api/objects/${note.id}`)).json()).content).includes('and offline'), 'offline edit reaches the server', 30000)
console.log('offline edit in the second tab reached the server')
await context.close()
console.log('OK')
