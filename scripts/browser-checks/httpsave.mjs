// Without the replica (HTTP mode: a second tab, a private window, VASTA_REPLICA=0) a save sends
// the copy the page started from, so a rename made elsewhere while typing is not undone, then or
// by the next save.
import { chromium } from 'playwright'
const base = 'http://127.0.0.1:5183'
const browser = await chromium.launch()
const context = await browser.newContext()
await context.addInitScript(() => localStorage.setItem('vasta.replica', 'off'))
const page = await context.newPage()
await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav')
const headers = { 'x-requested-with': 'vasta' }
const space = (await (await page.request.get(`${base}/api/spaces`)).json())[0]
const pageType = (await (await page.request.get(`${base}/api/spaces/${space.id}`)).json()).types.find((t) => t.system === 'page')
const note = await (await page.request.post(`${base}/api/objects`, { headers, data: { typeId: pageType.id, title: 'Shopping' } })).json()

await page.goto(`${base}/o/${note.id}`)
await page.locator('.ProseMirror').first().click()
await new Promise((r) => setTimeout(r, 200))
await page.keyboard.type('Milk')
// Another device renames the note before this page saves (it saves 500 ms after the last key).
const server = await (await page.request.get(`${base}/api/objects/${note.id}`)).json()
await page.request.put(`${base}/api/objects/${note.id}`, { headers, data: { ...server, title: 'Shopping list' } })
await page.keyboard.type(' and eggs')
await new Promise((r) => setTimeout(r, 2000))
const after = await (await page.request.get(`${base}/api/objects/${note.id}`)).json()
const text = JSON.stringify(after.content)
console.log('title:', after.title, '| text has the typing:', text.includes('Milk and eggs'))
if (after.title !== 'Shopping list' || !text.includes('Milk and eggs')) throw new Error('the save undid the rename or lost the text')
// The page shows the rename now, and the next save (more typing) does not write the old title back.
const shown = await page.locator('textarea').first().inputValue()
await page.keyboard.type(' and bread')
await new Promise((r) => setTimeout(r, 2000))
const later = await (await page.request.get(`${base}/api/objects/${note.id}`)).json()
console.log('title shown:', shown, '| title after the next save:', later.title)
if (shown !== 'Shopping list' || later.title !== 'Shopping list' || !JSON.stringify(later.content).includes('Milk and eggs and bread')) throw new Error('the next save wrote the old title back')
await browser.close()
console.log('OK')
