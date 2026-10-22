// Formula properties in the test env: a formula column in a table view, writing one in Type
// settings with field names (and the field buttons), sorting and filtering by it, an error shown
// for a bad formula, and the object page recomputing it as a field changes.
//   node formula.mjs [chromium|webkit] [base]        MODE=json: the replica turned off (HTTP mode)
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, webkit } from 'playwright'

const engine = process.argv[2] ?? 'chromium'
const base = process.argv[3] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)

const options = { viewport: { width: 1400, height: 900 }, locale: 'en-US', timezoneId: 'America/Sao_Paulo' }
const launched = engine === 'webkit' ? undefined : await chromium.launch()
const context = launched ? await launched.newContext(options) : await webkit.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'vasta-formula-')), options)
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
      const shot = path.join(tmpdir(), `vasta-formula-${engine}.png`)
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
const rowTitles = () => page.locator('tbody tr td:first-child').allTextContents().then((all) => all.map((t) => t.trim()))
/** Each row's title with the text of one column. */
async function column(field) {
  const index = await page.locator('thead th[data-column]').evaluateAll((ths, f) => ths.findIndex((th) => th.dataset.column === f), field)
  if (index < 0) return undefined
  return page.locator('tbody tr').evaluateAll((rows, i) => rows.map((tr) => `${tr.children[0].textContent.trim()}=${tr.children[i].textContent.trim()}`), index)
}

await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav', { timeout: 30000 })
const space = (await get('/api/spaces'))[0]

const tag = `${engine}-${Date.now() % 100000}`
const person = await post('/api/types', { spaceId: space.id, name: `Buyer ${tag}`, pluralName: `Buyers ${tag}` })
await put(`/api/types/${person.id}`, { ...person, properties: [{ id: 'country', kind: 'text', name: 'Country' }] })
const orderNew = await post('/api/types', { spaceId: space.id, name: `Order ${tag}`, pluralName: `Orders ${tag}` })
const order = await put(`/api/types/${orderNew.id}`, {
  ...orderNew,
  properties: [
    { id: 'price', kind: 'number', name: 'Price' },
    { id: 'qty', kind: 'number', name: 'Quantity' },
    { id: 'buyer', kind: 'relation', name: 'Buyer', targetTypeIds: [person.id], multiple: false },
    { id: 'total', kind: 'formula', name: 'Total', expression: '{price} * {qty}' },
  ],
  views: [{ id: `${orderNew.id}:all`, name: 'All', layout: 'table' }],
})
const ana = await post('/api/objects', { typeId: person.id, title: `Ana ${tag}`, props: { country: { kind: 'text', value: 'Brazil' } } })
const coffee = await post('/api/objects', { typeId: order.id, title: 'Coffee', props: { price: { kind: 'number', value: 2.5 }, qty: { kind: 'number', value: 4 }, buyer: { kind: 'relation', value: [ana.id] } } })
await post('/api/objects', { typeId: order.id, title: 'Tea', props: { price: { kind: 'number', value: 3 }, qty: { kind: 'number', value: 1 } } })
await post('/api/objects', { typeId: order.id, title: 'Nothing yet' })
await sleep(1500) // the replica pulls them

try {
  step('the formula is a column of the table')
  await page.goto(`${base}/t/${order.id}`)
  await until(async () => (await rowTitles()).length === 3, 'three rows')
  await until(async () => (await column('total'))?.sort().join() === 'Coffee=10,Nothing yet=,Tea=3', 'totals computed')

  step('write a formula in Type settings with names and a field button')
  await page.click('button[title="Type settings"]')
  await page.fill('input[placeholder="New property name"]', 'Score')
  await page.locator('form select').selectOption('formula')
  await page.locator('form button', { hasText: 'Add' }).click()
  const textarea = page.locator('textarea[placeholder="{Price} * {Quantity}"]')
  await textarea.fill('{Price} *')
  await until(() => page.getByText('The formula ends too soon').isVisible(), 'an error for an unfinished formula')
  await textarea.fill('{Price} * 2 + ')
  await page.locator('button', { hasText: /^\s*Quantity\s*$/ }).click()
  await until(async () => (await textarea.inputValue()) === '{Price} * 2 + {Quantity}', 'the field inserted at the cursor')
  await until(() => page.getByText('Gives a number.').isVisible(), 'the kind of value it gives')
  await page.fill('input[placeholder="New property name"]', 'Who')
  await page.locator('form select').selectOption('formula')
  await page.locator('form button', { hasText: 'Add' }).click()
  await page.locator('textarea[placeholder="{Price} * {Quantity}"]').fill('upper({Buyer.Country})')
  await page.locator('button', { hasText: /^\s*Save\s*$/ }).click()
  await until(async () => {
    const saved = await get(`/api/types/${order.id}`)
    const expressions = saved.properties.filter((p) => p.kind === 'formula').map((p) => p.expression)
    return expressions.join('|') === '{price} * {qty}|{price} * 2 + {qty}|upper({buyer.country})'
  }, 'formulas saved with ids')
  await until(async () => (await column('total'))?.length === 3, 'table back')
  const scoreField = (await get(`/api/types/${order.id}`)).properties.find((p) => p.name === 'Score').id
  const whoField = (await get(`/api/types/${order.id}`)).properties.find((p) => p.name === 'Who').id
  await until(async () => (await column(scoreField))?.sort().join() === 'Coffee=9,Nothing yet=,Tea=7', 'the new formula as a column')
  await until(async () => (await column(whoField))?.sort().join() === 'Coffee=BRAZIL,Nothing yet=,Tea=', 'a related object’s field')

  step('sort by the formula')
  await page.locator('button', { hasText: 'Last edited' }).click()
  await page.locator('button', { hasText: /^\s*Total\s*$/ }).last().click()
  await page.keyboard.press('Escape')
  await until(async () => (await rowTitles()).join() === 'Coffee,Tea,Nothing yet', 'largest total first, empty last')

  step('filter by the formula')
  await page.locator('button', { hasText: /^\s*Filter/ }).click()
  await page.locator('button', { hasText: 'Add filter' }).click()
  await page.locator('select').filter({ has: page.locator('option[value="total"]') }).selectOption('total')
  await page.locator('select').filter({ has: page.locator('option[value="gt"]') }).selectOption('gt')
  await page.fill('input[placeholder="Value"]', '5')
  await page.keyboard.press('Enter')
  await page.locator('input[placeholder="Value"]').blur()
  await until(async () => (await rowTitles()).join() === 'Coffee', 'only totals over 5')
  await page.keyboard.press('Escape')

  step('the object page recomputes as a field changes')
  await page.goto(`${base}/o/${coffee.id}`)
  const totalRow = page.locator('.vasta-prop-row', { has: page.locator('.vasta-prop-name', { hasText: /^Total$/ }) })
  await until(async () => (await totalRow.textContent())?.includes('10'), 'Total 10 on the page')
  const price = page.locator('.vasta-prop-row', { has: page.locator('.vasta-prop-name', { hasText: /^Price$/ }) }).locator('input')
  await price.fill('5')
  await price.press('Tab')
  await until(async () => (await totalRow.textContent())?.includes('20'), 'Total 20 after the price changes')
} finally {
  for (const type of [order, person]) await page.request.delete(`${base}/api/types/${type.id}`, { headers })
}

if (problems.length) console.log(`console problems:\n  ${problems.join('\n  ')}`)
console.log('OK')
await browser.close()
