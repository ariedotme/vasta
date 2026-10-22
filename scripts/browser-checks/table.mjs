// Table views and filters through relations in the test env: the Columns menu (hide, reorder by
// dragging), resizing a column by its header edge, a filter on a related object's field on a type
// page and in a query.
//   node table.mjs [chromium|webkit] [base]        MODE=json: the replica turned off (HTTP mode)
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, webkit } from 'playwright'

const engine = process.argv[2] ?? 'chromium'
const base = process.argv[3] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)

const options = { viewport: { width: 1400, height: 900 }, locale: 'en-US', timezoneId: 'America/Sao_Paulo' }
const launched = engine === 'webkit' ? undefined : await chromium.launch()
const context = launched ? await launched.newContext(options) : await webkit.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'vasta-table-')), options)
const browser = launched ?? context
if (process.env.MODE === 'json') await context.addInitScript(() => localStorage.setItem('vasta.replica', 'off'))
const page = context.pages()[0] ?? (await context.newPage())
const problems = []
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !/401|TextSelection endpoint|due to access control checks/.test(m.text()) && problems.push(`${m.type()}: ${m.text()}`))
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (name) => console.log(`• ${name}`)
async function until(check, what, timeout = 10000) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeout) {
      console.log(problems.join('\n'))
      const shot = path.join(tmpdir(), `vasta-table-${engine}.png`)
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
const headerFields = () => page.locator('thead th[data-column]').evaluateAll((ths) => ths.map((th) => th.dataset.column))
const rowTitles = () => page.locator('tbody tr td:first-child').allTextContents().then((all) => all.map((t) => t.trim()))
async function dragBetween(from, to) {
  const a = await from.boundingBox()
  const b = await to.boundingBox()
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + a.width / 2 + ((b.x - a.x) * i) / 8, a.y + a.height / 2 + ((b.y + b.height / 2 - a.y - a.height / 2) * i) / 8)
  await page.mouse.up()
}

await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav', { timeout: 30000 })
const space = (await get('/api/spaces'))[0]
const bundle = await get(`/api/spaces/${space.id}`)
const queryType = bundle.types.find((t) => t.system === 'query')

const tag = `${engine}-${Date.now() % 100000}`
const person = await post('/api/types', { spaceId: space.id, name: `Person ${tag}`, pluralName: `People ${tag}` })
await put(`/api/types/${person.id}`, { ...person, properties: [{ id: 'country', kind: 'text', name: 'Country' }] })
const bookNew = await post('/api/types', { spaceId: space.id, name: `Book ${tag}`, pluralName: `Books ${tag}` })
const book = await put(`/api/types/${bookNew.id}`, {
  ...bookNew,
  properties: [
    { id: 'author', kind: 'relation', name: 'Author', targetTypeIds: [person.id], multiple: true },
    { id: 'pages', kind: 'number', name: 'Pages' },
  ],
  views: [{ id: `${bookNew.id}:all`, name: 'All', layout: 'table' }],
})
const machado = await post('/api/objects', { typeId: person.id, title: `Machado ${tag}`, props: { country: { kind: 'text', value: 'Brazil' } } })
const herbert = await post('/api/objects', { typeId: person.id, title: `Herbert ${tag}`, props: { country: { kind: 'text', value: 'USA' } } })
await post('/api/objects', { typeId: book.id, title: `Dom Casmurro ${tag}`, props: { author: { kind: 'relation', value: [machado.id] }, pages: { kind: 'number', value: 256 } } })
await post('/api/objects', { typeId: book.id, title: `Dune ${tag}`, props: { author: { kind: 'relation', value: [herbert.id] }, pages: { kind: 'number', value: 600 } } })
await post('/api/objects', { typeId: book.id, title: `Both ${tag}`, props: { author: { kind: 'relation', value: [herbert.id, machado.id] } } })
await sleep(1500) // the replica pulls them
const savedView = async () => (await get(`/api/types/${book.id}`)).views[0]

let query
try {
  step('the default table: title, tags, the properties, last edited')
  await page.goto(`${base}/t/${book.id}`)
  await until(async () => (await rowTitles()).length === 3, 'three rows')
  const initial = await headerFields()
  if (initial.join() !== 'title,tags,author,pages,updatedAt') throw new Error(`default columns: ${initial}`)

  step('hide a column from the Columns menu')
  await page.locator('button', { hasText: 'Columns' }).click()
  await page.locator('div[data-column="pages"] button[title="Hide column"]').click()
  await until(async () => !(await headerFields()).includes('pages'), 'Pages hidden')
  await until(async () => (await savedView()).table?.columns.find((c) => c.field === 'pages')?.hidden, 'hidden saved on the view')

  step('reorder by dragging in the menu')
  await dragBetween(page.locator('div[data-column="author"] [title="Drag to reorder"]'), page.locator('div[data-column="tags"]'))
  await until(async () => (await headerFields()).join() === 'title,author,tags,updatedAt', 'Author before Tags')
  await until(async () => (await savedView()).table?.columns.map((c) => c.field).slice(0, 3).join() === 'title,author,tags', 'order saved')
  await page.keyboard.press('Escape')

  step('resize the title column by its edge')
  const before = (await page.locator('thead th[data-column="title"]').boundingBox()).width
  const edge = await page.locator('thead th[data-column="title"] [title="Drag to resize"]').boundingBox()
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2)
  await page.mouse.down()
  for (let i = 1; i <= 6; i++) await page.mouse.move(edge.x + edge.width / 2 + i * 20, edge.y + edge.height / 2)
  await page.mouse.up()
  await until(async () => Math.abs((await savedView()).table?.columns.find((c) => c.field === 'title')?.width - (before + 120)) <= 2, 'width saved')
  const after = (await page.locator('thead th[data-column="title"]').boundingBox()).width
  if (Math.abs(after - before - 120) > 2) throw new Error(`title column ${before} → ${after}`)

  step('filter on the author’s country on the type page')
  await page.locator('button', { hasText: /^\s*Filter/ }).click()
  await page.locator('button', { hasText: 'Add filter' }).click()
  await page.locator('select').filter({ has: page.locator('option[value="author.country"]') }).selectOption('author.country')
  await page.fill('input[placeholder="Value"]', 'brazil')
  await page.keyboard.press('Enter')
  await page.locator('input[placeholder="Value"]').blur()
  await until(async () => (await rowTitles()).sort().join() === [`Both ${tag}`, `Dom Casmurro ${tag}`].join(), 'books with a Brazilian author')
  await until(async () => (await savedView()).filter?.items[0]?.field === 'author.country', 'filter saved')
  await page.keyboard.press('Escape')

  step('the same filter in a query shown as a table')
  query = await post('/api/objects', {
    typeId: queryType.id,
    title: `Brazilian books ${tag}`,
    query: {
      typeIds: [book.id],
      layout: 'table',
      filter: { kind: 'group', operator: 'and', items: [{ kind: 'filter', field: 'author.country', operator: 'is-not', value: { kind: 'literal', value: 'Brazil' } }] },
      table: { columns: [{ field: 'title' }, { field: 'pages' }, { field: 'author', hidden: true }] },
    },
  })
  await sleep(1000)
  await page.goto(`${base}/o/${query.id}`)
  await until(async () => (await rowTitles()).join() === `Dune ${tag}`, 'only Dune has no Brazilian author')
  const queryColumns = await headerFields()
  if (queryColumns.join() !== 'title,pages,tags,updatedAt') throw new Error(`query columns: ${queryColumns}`)
  await page.locator('button', { hasText: 'Columns' }).click()
  await page.locator('div[data-column="author"] button[title="Show column"]').click()
  await until(async () => (await headerFields()).includes('author'), 'Author shown in the query')
  await until(async () => !(await get(`/api/objects/${query.id}`)).query.table.columns.find((c) => c.field === 'author').hidden, 'query columns saved')
} finally {
  if (query) await page.request.delete(`${base}/api/objects/${query.id}`, { headers })
  for (const type of [book, person]) await page.request.delete(`${base}/api/types/${type.id}`, { headers })
}

if (problems.length) console.log(`console problems:\n  ${problems.join('\n  ')}`)
console.log('OK')
await browser.close()
