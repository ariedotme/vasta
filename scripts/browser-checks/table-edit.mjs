// Editing in table views in the test env: a click on a property's cell edits it in place, for each
// kind (select, multi-select with a new option, text, number, URL, day and timed dates, checkbox,
// relations added, created and removed, person), with the keyboard (Tab, Enter, Space, Escape), on
// a type page (also grouped), in a query (also one the edit filters out), in a query embedded in a
// page; read-only columns, a field changed elsewhere meanwhile, quick edits, a second tab, and (in
// HTTP mode) a save that fails.
//   node table-edit.mjs [chromium|webkit] [base]        MODE=json: the replica turned off (HTTP mode)
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, webkit } from 'playwright'

const engine = process.argv[2] ?? 'chromium'
const base = process.argv[3] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)
const httpMode = process.env.MODE === 'json'

const options = { viewport: { width: 1600, height: 900 }, locale: 'en-US', timezoneId: 'America/Sao_Paulo' }
const launched = engine === 'webkit' ? undefined : await chromium.launch()
const context = launched ? await launched.newContext(options) : await webkit.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'vasta-table-edit-')), options)
const browser = launched ?? context
if (httpMode) await context.addInitScript(() => localStorage.setItem('vasta.replica', 'off'))
const page = context.pages()[0] ?? (await context.newPage())
const problems = []
const watch = (p) => {
  p.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !/401|TextSelection endpoint|due to access control checks/.test(m.text()) && problems.push(`${m.type()}: ${m.text()}`))
  p.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
}
watch(page)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (name) => console.log(`• ${name}`)
async function until(check, what, timeout = 10000) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeout) {
      console.log(problems.join('\n'))
      const shot = path.join(tmpdir(), `vasta-table-edit-${engine}.png`)
      await page.screenshot({ path: shot })
      console.log('screenshot:', shot)
      throw new Error(`timed out: ${what}`)
    }
    await sleep(200)
  }
}
const headers = { 'x-requested-with': 'vasta' }
const get = async (url) => (await page.request.get(`${base}${url}`)).json()
const post = async (url, data) => (await page.request.post(`${base}${url}`, { headers, data })).json()
const put = async (url, data) => (await page.request.put(`${base}${url}`, { headers, data })).json()
// Every table on a page has the same columns (a grouped view draws one per group).
let columns = []
const readColumns = async () => (columns = await page.locator('table').first().locator('thead th[data-column]').evaluateAll((ths) => ths.map((th) => th.dataset.column)))
const row = (title, p = page) => p.locator('tbody tr', { has: p.locator('td:first-child', { hasText: title }) })
const cell = (title, field) => row(title).locator(`td:nth-child(${columns.indexOf(field) + 1})`)
const edit = (title, field) => cell(title, field).locator('[data-edit]')
const text = async (title, field) => (await cell(title, field).textContent()).trim()
const option = (label) => page.locator('[data-overlay] button', { hasText: new RegExp(`^\\s*${label}\\s*$`) })
const overlays = () => page.locator('[data-overlay]').count()
const closed = async (title, field) => (await edit(title, field).count()) === 1
const props = async (id) => (await get(`/api/objects/${id}`)).props
const focusedField = () => page.evaluate(() => document.activeElement?.getAttribute('data-edit'))
async function typeInto(title, field, value) {
  await edit(title, field).click()
  await page.keyboard.press('ControlOrMeta+a')
  if (value) await page.keyboard.type(value)
  else await page.keyboard.press('Backspace')
  await page.keyboard.press('Enter')
}

await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav', { timeout: 30000 })
const space = (await get('/api/spaces'))[0]
const bundle = await get(`/api/spaces/${space.id}`)
const queryType = bundle.types.find((t) => t.system === 'query')
const pageType = bundle.types.find((t) => t.system === 'page')

const tag = `${engine}${httpMode ? '-json' : ''}-${Date.now() % 100000}`
const room = await post('/api/types', { spaceId: space.id, name: `Room ${tag}`, pluralName: `Rooms ${tag}` })
await post('/api/objects', { typeId: room.id, title: `Kitchen ${tag}` })
const choreNew = await post('/api/types', { spaceId: space.id, name: `Chore ${tag}`, pluralName: `Chores ${tag}` })
const opts = (...rows) => rows.map(([id, label, color]) => ({ id, label, color }))
const chore = await put(`/api/types/${choreNew.id}`, {
  ...choreNew,
  properties: [
    { id: 'priority', kind: 'select', name: 'Priority', multiple: false, options: opts(['high', 'High', 'red'], ['low', 'Low', 'gray']) },
    { id: 'labels', kind: 'select', name: 'Labels', multiple: true, options: opts(['wet', 'Wet', 'blue'], ['loud', 'Loud', 'amber']) },
    { id: 'minutes', kind: 'number', name: 'Minutes' },
    { id: 'note', kind: 'text', name: 'Note' },
    { id: 'link', kind: 'url', name: 'Link' },
    { id: 'doon', kind: 'date', name: 'Do on', withTime: false },
    { id: 'at', kind: 'date', name: 'At', withTime: true },
    { id: 'urgent', kind: 'checkbox', name: 'Urgent' },
    { id: 'room', kind: 'relation', name: 'Room', targetTypeIds: [room.id], multiple: true },
    { id: 'who', kind: 'person', name: 'Who', multiple: false },
    { id: 'double', kind: 'formula', name: 'Double', expression: '{minutes} * 2' },
    { id: 'details', kind: 'rich-text', name: 'Details' },
  ],
  views: [
    { id: `${choreNew.id}:all`, name: 'All', layout: 'table', sort: [{ field: 'title', direction: 'asc' }] },
    { id: `${choreNew.id}:grouped`, name: 'Grouped', layout: 'table', groupBy: [{ field: 'priority' }], sort: [{ field: 'title', direction: 'asc' }] },
  ],
})
const dishes = await post('/api/objects', { typeId: chore.id, title: `Dishes ${tag}`, props: { minutes: { kind: 'number', value: 10 } } })
const laundry = await post('/api/objects', { typeId: chore.id, title: `Laundry ${tag}` })
await sleep(1500) // the replica pulls them
const D = `Dishes ${tag}`
const L = `Laundry ${tag}`

let query, filtered, doc, second
try {
  await page.goto(`${base}/t/${chore.id}`)
  await until(async () => (await page.locator('tbody tr').count()) === 2, 'two rows')
  await readColumns()

  step('F1 a select: pick an option; it shows at once and the editor closes')
  await edit(D, 'priority').click()
  await option('High').click()
  await until(async () => (await text(D, 'priority')) === 'High', 'High shown')
  await until(async () => (await props(dishes.id)).priority?.value?.[0] === 'high', 'High saved')
  await until(() => closed(D, 'priority'), 'select editor closed')

  step('F2 F3 a multi-select: two options, one of them new; the picker stays open')
  await edit(D, 'labels').click()
  await option('Wet').click()
  await page.locator('[data-overlay] input[placeholder="New option…"]').fill('Messy')
  await page.keyboard.press('Enter')
  if (!(await overlays())) throw new Error('the multi-select closed after a pick')
  await page.keyboard.press('Escape')
  await until(async () => (await props(dishes.id)).labels?.value?.length === 2, 'two labels saved')
  await until(async () => (await get(`/api/types/${chore.id}`)).properties.find((p) => p.id === 'labels').options.some((o) => o.label === 'Messy'), 'new option on the type')
  await until(async () => (await text(D, 'labels')).replace(/\s+/g, '') === 'WetMessy', 'both labels shown')

  step('F4 text: Enter saves, the focus goes back to the cell')
  await edit(L, 'note').click()
  await page.keyboard.type('fold it')
  await page.keyboard.press('Enter')
  await until(async () => (await props(laundry.id)).note?.value === 'fold it', 'note saved')
  await until(async () => (await focusedField()) === 'note', 'focus back on the cell')

  step('F6 text: Escape puts the value back')
  await page.keyboard.press('Enter')
  await page.keyboard.type(' and iron it')
  await page.keyboard.press('Escape')
  await until(() => closed(L, 'note'), 'Escape ended editing')
  await sleep(500)
  if ((await props(laundry.id)).note?.value !== 'fold it') throw new Error('Escape saved the typing')
  if ((await text(L, 'note')) !== 'fold it') throw new Error('Escape left the typing shown')

  step('F5 text: a click elsewhere saves')
  await edit(D, 'note').click()
  await page.keyboard.type('rinse first')
  await page.locator('h1').first().click()
  await until(async () => (await props(dishes.id)).note?.value === 'rinse first', 'saved on a click elsewhere')

  step('F7 F15 a number: Enter saves and the formula follows; cleared, the value goes')
  await typeInto(D, 'minutes', '25')
  await until(async () => (await props(dishes.id)).minutes?.value === 25, '25 saved')
  await until(async () => (await text(D, 'double')) === '50', 'formula shows 50')
  await typeInto(L, 'minutes', '5')
  await until(async () => (await props(laundry.id)).minutes?.value === 5, '5 saved')
  await typeInto(L, 'minutes', '')
  await until(async () => !(await props(laundry.id)).minutes, 'cleared')

  step('F8 a URL: saved and shown as a link')
  await typeInto(D, 'link', 'https://example.com/dishes')
  await until(async () => (await props(dishes.id)).link?.value === 'https://example.com/dishes', 'URL saved')
  await until(async () => (await cell(D, 'link').locator('a[href="https://example.com/dishes"]').count()) === 1, 'shown as a link')

  step('F9 dates: Tomorrow on a day field, Today on a timed one')
  await edit(L, 'doon').click()
  await option('Tomorrow').click()
  await page.keyboard.press('Escape')
  await until(async () => (await props(laundry.id)).doon?.value?.resolution === 'day', 'a day saved')
  await until(async () => (await text(L, 'doon')) !== '', 'the day shown')
  await edit(L, 'at').click()
  await option('Today').click()
  await page.keyboard.press('Escape')
  await until(async () => (await props(laundry.id)).at?.value?.resolution === 'time', 'a time saved')

  step('F10 a checkbox: one click on, one off, no editor')
  await edit(D, 'urgent').click()
  await until(async () => (await props(dishes.id)).urgent?.value === true, 'on')
  if (await overlays()) throw new Error('a checkbox opened an editor')
  await edit(D, 'urgent').click()
  await until(async () => (await props(dishes.id)).urgent?.value === false, 'off')

  step('F11 F12 relations: add one, create one, remove one while editing, a click outside ends it')
  await edit(D, 'room').click()
  await option(`Kitchen ${tag}`).click()
  await page.locator('[data-overlay] input[placeholder="Search…"]').fill(`Pantry ${tag}`)
  await page.locator('[data-overlay] button', { hasText: `“Pantry ${tag}”` }).click()
  await until(async () => (await props(dishes.id)).room?.value?.length === 2, 'two rooms saved')
  await page.keyboard.press('Escape')
  await until(async () => !(await overlays()), 'picker closed')
  await edit(D, 'room').click()
  const kitchenChip = cell(D, 'room').locator('.group', { hasText: `Kitchen ${tag}` })
  await kitchenChip.hover()
  await kitchenChip.locator('button[title="Remove"]').click()
  await until(async () => (await props(dishes.id)).room?.value?.length === 1, 'Kitchen removed')
  if (!(await cell(D, 'room').locator('button[title="Add"]').count())) throw new Error('removing closed the editor')
  await page.locator('h1').first().click()
  await until(() => closed(D, 'room'), 'editing ended on a click outside')
  await edit(D, 'room').locator('a').first().click()
  await until(async () => (await overlays()) === 1, 'a click on a chip edits')
  if (!page.url().includes(`/t/${chore.id}`)) throw new Error('a click on a chip in the cell navigated')
  await page.keyboard.press('Escape')

  step('F13 a person: pick yourself')
  await edit(L, 'who').click()
  await page.locator('[data-overlay] button', { hasText: 'me' }).first().click()
  await until(async () => (await props(laundry.id)).who?.value?.length === 1, 'person saved')

  step('F14 K3 read-only columns, the title still opens the object, the cell’s role and name')
  for (const field of ['double', 'details', 'updatedAt']) if (await edit(D, field).count()) throw new Error(`${field} is editable`)
  if ((await edit(D, 'priority').getAttribute('role')) !== 'button' || !(await edit(D, 'priority').getAttribute('aria-label')).startsWith('Priority')) throw new Error('cell has no button role or name')
  await row(D).locator('td:first-child a').click()
  await until(() => page.url().includes(`/o/${dishes.id}`), 'the title opens the object')
  await page.goBack()
  await until(async () => (await page.locator('tbody tr').count()) === 2, 'back on the table')
  await readColumns()

  step('K1 K2 the keyboard: Tab to the next cell, Space opens, Escape closes the picker and the focus returns')
  await edit(L, 'priority').focus()
  await page.keyboard.press('Tab')
  if ((await focusedField()) !== 'labels') throw new Error(`Tab went to ${await focusedField()}`)
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Space')
  await until(async () => (await overlays()) === 1, 'Space opened the picker')
  await page.keyboard.press('Escape')
  await until(() => closed(L, 'priority'), 'Escape closed it')
  await until(async () => (await focusedField()) === 'priority', 'focus back after Escape')

  step('D1 a field changed elsewhere meanwhile is kept')
  const now = await get(`/api/objects/${laundry.id}`)
  await put(`/api/objects/${laundry.id}`, { ...now, props: { ...now.props, minutes: { kind: 'number', value: 33 } } })
  await sleep(httpMode ? 0 : 1500)
  await edit(L, 'priority').click()
  await option('Low').click()
  await until(async () => (await props(laundry.id)).priority?.value?.[0] === 'low', 'Low saved')
  if ((await props(laundry.id)).minutes?.value !== 33) throw new Error('the edit in the table overwrote a field changed elsewhere')

  step('D2 two quick edits of one cell: the last one stays')
  await typeInto(D, 'minutes', '1')
  await typeInto(D, 'minutes', '2')
  await until(async () => (await props(dishes.id)).minutes?.value === 2, '2 saved')
  await sleep(800)
  if ((await text(D, 'minutes')) !== '2') throw new Error(`cell shows ${await text(D, 'minutes')} after quick edits`)

  step('D4 a second tab sees the edit')
  second = await context.newPage()
  watch(second)
  await second.goto(`${base}/t/${chore.id}`)
  await until(async () => (await second.locator('tbody tr').count()) === 2, 'two rows in the second tab')
  await typeInto(D, 'note', 'from the first tab')
  await until(async () => (await row(D, second).textContent()).includes('from the first tab'), 'second tab updated', 15000)
  await second.close()
  second = undefined

  if (httpMode) {
    step('D3 a save that fails: an error, and the cell shows the old value')
    const url = `**/api/objects/${dishes.id}`
    await page.route(url, (route) => (route.request().method() === 'PUT' ? route.abort() : route.continue()))
    await edit(D, 'priority').click()
    await option('Low').click()
    await until(async () => (await page.locator('[role="alert"]').count()) > 0, 'error shown')
    await until(async () => (await text(D, 'priority')) === 'High', 'old value back in the cell')
    await page.unroute(url)
    if ((await props(dishes.id)).priority?.value?.[0] !== 'high') throw new Error('the failed save changed the object')
    // The aborted request is logged by the browser; it is what this step asked for.
    problems.splice(0, problems.length, ...problems.filter((p) => !/Failed to load resource|net::ERR_FAILED/.test(p)))
  }

  step('C2 a grouped table: changing the grouped field moves the row')
  await page.locator('button', { hasText: /^\s*Grouped\s*$/ }).click()
  await until(async () => (await page.locator('section header').count()) >= 2, 'groups shown')
  await readColumns()
  const groupOf = (title) => page.locator('section', { has: row(title) }).locator('header').first().textContent()
  if (!(await groupOf(D)).includes('High')) throw new Error(`Dishes is in ${await groupOf(D)}`)
  await edit(D, 'priority').click()
  await option('Low').click()
  await until(async () => (await groupOf(D)).includes('Low'), 'Dishes moved to Low')
  await page.locator('button', { hasText: /^\s*All\s*$/ }).click()

  step('C3 a query shown as a table')
  query = await post('/api/objects', { typeId: queryType.id, title: `Chores ${tag}`, query: { typeIds: [chore.id], layout: 'table', sort: [{ field: 'title', direction: 'asc' }] } })
  await sleep(1000)
  await page.goto(`${base}/o/${query.id}`)
  await until(async () => (await page.locator('tbody tr').count()) === 2, 'two rows in the query')
  await readColumns()
  await edit(D, 'priority').click()
  await option('High').click()
  await until(async () => (await props(dishes.id)).priority?.value?.[0] === 'high', 'High saved from the query')
  await until(async () => (await text(D, 'priority')) === 'High', 'High shown in the query')

  step('C4 a query the edit filters out: the row leaves')
  filtered = await post('/api/objects', {
    typeId: queryType.id,
    title: `Not urgent ${tag}`,
    query: { typeIds: [chore.id], layout: 'table', filter: { kind: 'group', operator: 'and', items: [{ kind: 'filter', field: 'urgent', operator: 'is-not-checked' }] } },
  })
  await sleep(1000)
  await page.goto(`${base}/o/${filtered.id}`)
  await until(async () => (await page.locator('tbody tr').count()) === 2, 'two rows before')
  await readColumns()
  await edit(L, 'urgent').click()
  await until(async () => (await page.locator('tbody tr').count()) === 1, 'Laundry left the list')

  step('C5 a query embedded in a page: edits save, the page does not change, no page errors')
  doc = await post('/api/objects', {
    typeId: pageType.id,
    title: `Chore page ${tag}`,
    content: { body: { type: 'doc', content: [{ type: 'paragraph' }, { type: 'objectEmbed', attrs: { objectId: query.id, display: 'embed' } }] } },
  })
  await sleep(1000)
  await page.goto(`${base}/o/${doc.id}`)
  await until(async () => (await page.locator('tbody tr').count()) === 2, 'two rows in the embed')
  await readColumns()
  // Opening the page gives its blocks ids (and a last empty line) once; compare from there.
  await sleep(2500)
  const before = JSON.stringify((await get(`/api/objects/${doc.id}`)).content)
  await typeInto(D, 'minutes', '40')
  await until(async () => (await props(dishes.id)).minutes?.value === 40, '40 saved from the embed')
  await until(async () => (await text(D, 'double')) === '80', 'formula shows 80 in the embed')
  await edit(D, 'priority').click()
  await option('Low').click()
  await until(async () => (await props(dishes.id)).priority?.value?.[0] === 'low', 'Low saved from the embed')
  await sleep(1000)
  if (JSON.stringify((await get(`/api/objects/${doc.id}`)).content) !== before) throw new Error('editing in the embed changed the page')
} finally {
  await second?.close()
  for (const id of [doc?.id, filtered?.id, query?.id]) if (id) await page.request.delete(`${base}/api/objects/${id}`, { headers })
  for (const type of [chore, room]) await page.request.delete(`${base}/api/types/${type.id}`, { headers })
}

if (problems.length) {
  console.log(`console problems:\n  ${problems.join('\n  ')}`)
  process.exitCode = 1
} else console.log('OK')
await browser.close()
