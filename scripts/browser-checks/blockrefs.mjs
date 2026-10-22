// Mentioning and embedding one block of another object (test env only): "@Title#text" lists the
// object's blocks (giving the picked one an id), "@@Title#…" embeds one read-only; the embed
// follows an edit of the original, and the mention and the embed's Open go to the block.
//   node blockrefs.mjs [base]      MODE=json: with the replica turned off (HTTP mode)
import { chromium } from 'playwright'
const base = process.argv[2] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error('test env only (5183/5184)')
const browser = await chromium.launch()
setTimeout(() => (console.log('timed out'), process.exit(1)), 120000).unref()
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } })
if (process.env.MODE === 'json') await context.addInitScript(() => localStorage.setItem('vasta.replica', 'off'))
const page = await context.newPage()
const problems = []
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav', { state: 'attached', timeout: 30000 })
const headers = { 'x-requested-with': 'vasta' }
const get = async (path) => (await page.request.get(`${base}${path}`)).json()
const clean = (text) => text.replace(/\s+/g, ' ').trim()
const until = async (check, what, timeout = 15000) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const value = await check()
    if (value) return value
    await page.waitForTimeout(200)
  }
  throw new Error(`timed out waiting for ${what}`)
}

// The open space, and two pages in it: the source (blocks without ids yet) and the note.
await page.waitForTimeout(1500)
const spaceId = await page.evaluate(() => localStorage.getItem('vasta.space'))
const space = spaceId ? await get(`/api/spaces/${spaceId}`) : await get(`/api/spaces/${(await get('/api/spaces'))[0].id}`)
const pageType = space.types.find((t) => t.system === 'page')
const n = Date.now() % 100000
const para = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const content = { body: { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Chapter 1' }] }, para('The spice must flow.'), para('Fear is the mind-killer.')] } }
const source = await (await page.request.post(`${base}/api/objects`, { headers, data: { typeId: pageType.id, title: `Dune${n}`, content } })).json()
const note = await (await page.request.post(`${base}/api/objects`, { headers, data: { typeId: pageType.id, title: `Notes${n}` } })).json()
await page.waitForTimeout(1500)

await page.goto(`${base}/o/${note.id}`)
const editor = page.locator('.ProseMirror').first()
await editor.click()
await page.waitForTimeout(300)
await page.keyboard.type(`@Dune${n}#spice`)
const listed = await until(async () => {
  const items = (await page.locator('.max-h-80 button').allTextContents()).map(clean)
  return items.some((t) => t.includes('The spice must flow.')) ? items : undefined
}, 'the block list')
console.log('blocks listed:', listed)
await page.keyboard.press('Enter')
await page.waitForTimeout(500)
console.log('mention:', clean(await editor.locator('[data-type=mention], .mx-px').first().textContent()))
await page.keyboard.press('Enter')
await page.keyboard.type(`@@Dune${n}#chap`)
await until(async () => (await page.locator('.max-h-80 button').allTextContents()).some((t) => t.includes('Chapter 1')), 'the heading')
await page.keyboard.press('Enter')
const embed = page.locator('[data-testid=block-embed]').first()
await embed.waitFor()
await until(async () => clean(await embed.textContent()).includes('Chapter 1'), 'the embedded heading')
console.log('embed:', clean(await embed.textContent()))

// Saved with the block ids; the source's blocks got their ids.
const saved = await until(async () => {
  const object = await get(`/api/objects/${note.id}`)
  const nodes = JSON.stringify(object.content)
  return nodes.includes('"blockId"') && nodes.includes('"display":"block"') ? object : undefined
}, 'the note saved')
const sourceNow = await get(`/api/objects/${source.id}`)
const [heading, spice] = sourceNow.content.body.content.map((b) => b.attrs?.id)
console.log('source ids:', heading, spice)
const refs = JSON.stringify(saved.content).match(/"blockId":"([a-z0-9]+)"/g)
console.log('note refers to:', refs)
if (!heading || !spice || !refs.join().includes(heading) || !refs.join().includes(spice)) throw new Error('the references do not point to the blocks')

// The original changes elsewhere: the embed follows.
const edited = structuredClone(sourceNow)
edited.content.body.content[0].content[0].text = 'Chapter One'
await page.request.put(`${base}/api/objects/${source.id}`, { headers, data: { ...edited, base: sourceNow } })
await until(async () => clean(await embed.textContent()).includes('Chapter One'), 'the embed to follow the edit', 20000)
console.log('embed after the edit:', clean(await embed.textContent()))
if (process.env.SHOTS) await page.locator('.ProseMirror').first().screenshot({ path: `${process.env.SHOTS}/blockrefs.png` })

await embed.getByRole('button', { name: /Open/ }).click()
await page.waitForURL(new RegExp(`/o/${source.id}#b-${heading}`))
console.log('Open →', new URL(page.url()).pathname + new URL(page.url()).hash)
await page.goBack()
await page.locator('.mx-px', { hasText: 'The spice' }).first().click()
await page.waitForURL(new RegExp(`/o/${source.id}#b-${spice}`))
console.log('mention →', new URL(page.url()).pathname + new URL(page.url()).hash)

// Two objects with the same title (a page and a task): "@Title#" offers both to choose from, and
// the blocks are those of the one chosen.
const taskType = space.types.find((t) => t.system === 'task')
const twin = await (await page.request.post(`${base}/api/objects`, { headers, data: { typeId: taskType.id, title: `Dune${n}`, content: { body: { type: 'doc', content: [para('Plant the seeds.')] } } } })).json()
await page.waitForTimeout(1500)
await page.goto(`${base}/o/${note.id}`)
await page.locator('.ProseMirror').first().click()
await page.keyboard.press('ControlOrMeta+End')
await page.keyboard.press('Enter')
await page.keyboard.type(`@Dune${n}#`)
const choices = await until(async () => {
  const items = (await page.locator('.max-h-80 button').allTextContents()).map(clean)
  return items.length === 2 && items.every((t) => t.startsWith(`Dune${n}`)) ? items : undefined
}, 'the two objects to choose from')
console.log('same title:', choices)
const taskRow = choices.findIndex((t) => t.includes(taskType.name))
for (let i = 0; i < taskRow; i++) await page.keyboard.press('ArrowDown')
await page.keyboard.press('Enter')
await until(async () => (await page.locator('.max-h-80 button').allTextContents()).some((t) => t.includes('Plant the seeds.')), "the task's blocks")
await page.keyboard.press('Enter')
const twinRefs = await until(async () => {
  const object = await get(`/api/objects/${note.id}`)
  return JSON.stringify(object.content).includes(twin.id) ? object : undefined
}, 'the mention of the task')
console.log('mentions the task:', JSON.stringify(twinRefs.content).includes(`"objectId":"${twin.id}","label":"Dune${n}","blockId"`))
// The choice was for that mention only: the next "@Title#" asks again.
await page.keyboard.press('Enter')
await page.keyboard.type(`@Dune${n}#`)
const again = await until(async () => {
  const items = (await page.locator('.max-h-80 button').allTextContents()).map(clean)
  return items.length === 2 && items.every((t) => t.startsWith(`Dune${n}`)) ? items : undefined
}, 'the two objects offered again')
console.log('asked again:', again)
await page.keyboard.press('Escape')
await page.goto(`${base}/settings`)
console.log('version:', clean(await page.locator('[data-testid=web-version]').textContent()))
if (problems.length) throw new Error(problems.join('\n'))
await browser.close()
