// "/Type" in quick capture and ⌘K (test env only): "/liv" lists the types, Enter picks one, a
// relation's `name:` lists its objects, the line's properties show before saving; quick capture
// embeds the new object in today's note, ⌘K creates and opens it; the desktop capture panel's
// questions (vasta:capture-suggest) get the same list; Ctrl+Enter, in the dialog or from the panel,
// opens what it made. As the desktop app (its globals faked),
// since only it opens quick capture.
//   node capture.mjs [base]      MODE=json: with the replica turned off (HTTP mode)
import { chromium } from 'playwright'
const base = process.argv[2] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error('test env only (5183/5184)')
const browser = await chromium.launch()
setTimeout(() => (console.log('timed out'), process.exit(1)), 90000).unref()
const context = await browser.newContext()
await context.addInitScript((json) => {
  if (json) localStorage.setItem('vasta.replica', 'off')
  window.__VASTA_DESKTOP__ = { version: '0.1.6', shortcut: 'CommandOrControl+Shift+Space', updates: '', setShortcut: true }
  window.panelAnswers = []
  window.panelCalls = []
  window.__TAURI_INTERNALS__ = { invoke: async (command, args) => (window.panelCalls.push([command, args]), command === 'capture_suggestions' && window.panelAnswers.push(args.answer), null) }
}, process.env.MODE === 'json')
const page = await context.newPage()
await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav', { state: 'attached', timeout: 30000 })
const clean = (text) => text.replace(/\s+/g, ' ').trim()
const headers = { 'x-requested-with': 'vasta' }
const get = async (path) => (await page.request.get(`${base}${path}`)).json()

// A type of books in every space, so the capture space has one whichever it is.
const name = `Livro${Date.now() % 100000}`
for (const space of await get('/api/spaces')) {
  const type = await (await page.request.post(`${base}/api/types`, { headers, data: { spaceId: space.id, name, pluralName: `${name}s` } })).json()
  const properties = [...type.properties, { id: 'author', kind: 'relation', name: 'Autor', targetTypeIds: [], multiple: false }, { id: 'rating', kind: 'number', name: 'Nota' }]
  await page.request.put(`${base}/api/types/${type.id}`, { headers, data: { ...type, properties } })
}
await page.reload()
await page.waitForSelector('nav', { state: 'attached', timeout: 30000 })
await page.waitForTimeout(1500)

// Quick capture.
await page.evaluate(() => window.dispatchEvent(new Event('vasta:capture')))
const field = page.locator('textarea[placeholder*="/ for an object"]')
await field.waitFor()
await field.pressSequentially(`/${name.slice(0, -1).toLowerCase()}`)
await page.waitForTimeout(500)
const listed = await page.locator('[role=listbox][aria-label=Suggestions] [role=option]').allTextContents()
console.log('listed:', listed.map(clean))
if (!listed.map(clean).includes(name)) throw new Error('the type is not listed')
// Pick the book type (it may not be first).
for (let i = 0; i < 6 && clean(await page.locator('[role=option][aria-selected=true]').textContent()) !== name; i++) await page.keyboard.press('ArrowDown')
await page.keyboard.press('Enter')
console.log('picked:', JSON.stringify(await field.inputValue()))
// A person to pick as the author (a page: the relation takes any type).
const space = (await get('/api/spaces')).find((s) => s.name === 'Meu Espaço') ?? (await get('/api/spaces'))[0]
const pageType = (await get(`/api/spaces/${space.id}`)).types.find((t) => t.system === 'page')
await page.request.post(`${base}/api/objects`, { headers, data: { typeId: pageType.id, title: 'Frank Herbert' } })
await page.waitForTimeout(1500)
await field.pressSequentially('Duna autor:frank her')
await page.waitForTimeout(800)
const people = (await page.locator('[role=listbox][aria-label=Suggestions] [role=option]').allTextContents()).map(clean)
console.log('authors offered:', people)
if (!people.some((p) => p.startsWith('Frank Herbert'))) throw new Error('the relation offers no Frank Herbert')
while (!clean(await page.locator('[role=option][aria-selected=true]').textContent()).startsWith('Frank Herbert')) await page.keyboard.press('ArrowDown')
await page.keyboard.press('Enter')
console.log('after the pick:', JSON.stringify(await field.inputValue()))
await field.pressSequentially('nota:4,5')
const preview = clean(await page.locator('[data-testid=capture-preview]').textContent())
console.log('preview:', preview)
if (!preview.includes('“Duna”') || !preview.includes('autor Frank Herbert, nota 4.5')) throw new Error('wrong preview')
await page.keyboard.press('Enter')
await field.waitFor({ state: 'detached' })
await page.waitForTimeout(1500)
const toast = clean((await page.locator('body').textContent()).match(/Livro\d+ “Duna”.*?Espaço|Livro\d+ “Duna”.{0,80}/)?.[0] ?? '')
console.log('notice:', toast)
const books = []
for (const space of await get('/api/spaces')) books.push(...(await get(`/api/spaces/${space.id}`)).types.filter((t) => t.name === name))
const dune = (await Promise.all(books.map((t) => get(`/api/types/${t.id}/objects`).catch(() => [])))).flat().find((o) => o.title === 'Duna')
if (!dune) throw new Error('no Duna on the server')
const object = await get(`/api/objects/${dune.id}`)
console.log('on the server:', object.title, JSON.stringify(object.props))
if (object.props.rating?.value !== 4.5 || object.props.author?.value?.length !== 1) throw new Error('the properties did not arrive')
const today = await get(`/api/spaces/${object.spaceId}/inbox?today=${new Date().toLocaleDateString('sv')}`)
const item = today.items.find((i) => i.objectIds.includes(dune.id))
console.log('in today’s note:', !!item, item?.channel)
if (!item) throw new Error('not embedded in today’s note')

// The capture panel asks through the app; the web app answers with the same list.
await page.evaluate((text) => window.dispatchEvent(new CustomEvent('vasta:capture-suggest', { detail: { text, cursor: text.length, seq: 7 } })), `/${name.slice(0, -1).toLowerCase()}`)
await page.waitForTimeout(800)
const [panel] = await page.evaluate(() => window.panelAnswers)
console.log('panel answer:', panel?.seq, panel?.items.map((i) => i.label).slice(0, 4))
if (panel?.seq !== 7 || !panel.items.some((i) => i.label === name)) throw new Error('the panel got no types')
await page.evaluate((text) => window.dispatchEvent(new CustomEvent('vasta:capture-suggest', { detail: { text, cursor: text.length, seq: 8 } })), `/${name} Duna autor:frank`)
await page.waitForTimeout(800)
const second = (await page.evaluate(() => window.panelAnswers))[1]
console.log('panel relation:', second?.items.map((i) => i.text), '|', second?.preview)
if (!second?.items.some((i) => i.text.includes('autor:"Frank Herbert"'))) throw new Error('the panel got no authors')

// ⌘K.
await page.keyboard.press('Control+k')
const query = page.locator('input[placeholder="Search or create…"]')
await query.waitFor()
await query.pressSequentially(`/${name.slice(0, -1).toLowerCase()}`)
await page.waitForTimeout(400)
for (let i = 0; i < 6 && !clean(await page.locator('.max-w-xl .bg-hover').first().textContent()).startsWith(name); i++) await page.keyboard.press('ArrowDown')
await page.keyboard.press('Enter')
console.log('⌘K picked:', JSON.stringify(await query.inputValue()))
await query.pressSequentially('Hyperion nota:4')
await page.waitForTimeout(300)
console.log('⌘K result:', clean(await page.locator('.max-w-xl .bg-hover').first().textContent()))
await page.keyboard.press('Enter')
await page.waitForURL(/\/o\//)
await page.waitForTimeout(1500)
const created = await get(`/api/objects/${new URL(page.url()).pathname.split('/').pop()}`)
console.log('⌘K created:', created.title, JSON.stringify(created.props))
if (created.title !== 'Hyperion' || created.props.rating?.value !== 4) throw new Error('⌘K did not read the line')

// Ctrl+Enter in quick capture saves and opens the object it made.
await page.evaluate(() => window.dispatchEvent(new Event('vasta:capture')))
await field.waitFor()
await field.fill(`/${name} Endymion nota:3`)
await page.keyboard.press('Control+Enter')
await field.waitFor({ state: 'detached' })
await page.waitForURL((url) => url.pathname !== `/o/${created.id}` && url.pathname.startsWith('/o/'))
await page.waitForTimeout(800)
const endymion = await get(`/api/objects/${new URL(page.url()).pathname.split('/').pop()}`)
console.log('Ctrl+Enter opened:', endymion.title, JSON.stringify(endymion.props))
if (endymion.title !== 'Endymion' || endymion.props.rating?.value !== 3) throw new Error('Ctrl+Enter did not open the new object')

// The panel's Ctrl+Enter: a plain text opens today's note, and the app is told it saved.
await page.evaluate(() => window.dispatchEvent(Object.assign(new CustomEvent('vasta:capture-text', { detail: 'Ctrl+Enter from the panel' }), { open: true })))
await page.waitForURL((url) => url.pathname !== `/o/${endymion.id}` && url.pathname.startsWith('/o/'))
await page.waitForTimeout(800)
const note = await get(`/api/objects/${new URL(page.url()).pathname.split('/').pop()}`)
const saved = await page.evaluate(() => window.panelCalls.filter(([c]) => c === 'capture_result').at(-1)?.[1])
console.log('panel Ctrl+Enter opened:', note.typeId, note.date?.start, '| answered:', JSON.stringify(saved))
if (!note.typeId.startsWith('daily-note') || !JSON.stringify(note.content).includes('Ctrl+Enter from the panel') || saved?.ok !== true) throw new Error('the panel capture did not open today’s note')
await browser.close()
