// Device page width, including the calendar's empty/saved note, columns, narrow screens and panes.
// Uses isolated test data only. node page-width.mjs [chromium|webkit] [base]; MODE=json disables replica.
// SETTINGS=0 skips Settings/reload if the browser stalls on that step.
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, webkit } from 'playwright'

const engine = process.argv[2] ?? 'chromium'
const base = process.argv[3] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:5183$/.test(base)) throw new Error(`not the test env: ${base}`)
const options = { viewport: { width: 1920, height: 1080 }, locale: 'en-US', timezoneId: 'America/Toronto' }
const launched = engine === 'webkit' ? undefined : await chromium.launch()
const context = launched ? await launched.newContext(options) : await webkit.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'vasta-page-width-')), options)
const page = context.pages()[0] ?? await context.newPage()
async function go(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  // Let each view finish its async setup before a later document navigation tears it down.
  await page.waitForTimeout(500)
}
if (process.env.MODE === 'json') await context.addInitScript(() => localStorage.setItem('vasta.replica', 'off'))
const problems = []
page.on('pageerror', (error) => { if (!/Importing a module script failed/.test(error.message)) problems.push(`${page.url()}: ${error.stack ?? error.message}`) })
const headers = { 'x-requested-with': 'vasta' }
async function request(method, url, data) {
  const response = await page.request[method](`${base}${url}`, { headers, data })
  assert(response.ok(), `${method} ${url}: ${response.status()} ${await response.text()}`)
  return response.json()
}
const get = (url) => request('get', url)
const post = (url, data) => request('post', url, data)
const put = (url, data) => request('put', url, data)
async function until(check, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return
    await page.waitForTimeout(150)
  }
  throw new Error(`timed out: ${label}`)
}
const objectWidth = () => page.locator('article > div.relative').first()
const dayWidth = () => page.locator('main h1').locator('..')
async function width(locator) { return (await locator.boundingBox()).width }
async function expectWidth(locator, expected) {
  await until(async () => Math.abs(await width(locator) - expected) < 2, `width ${expected}`)
}
// Changing through the shared module also checks that a mounted page updates immediately.
// Settings itself is tested through its visible buttons below. This helper needs the dev server.
async function choose(value) {
  await page.evaluate(async (value) => { (await import('/src/lib/page-width.ts')).pageWidth.value = value }, value)
}
async function openObject(id) {
  await go(`${base}/o/${id}`)
  await page.locator('.vasta-doc').first().waitFor()
}
async function contained() {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal page overflow')
}
const paragraph = (text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const proseDoc = { type: 'doc', content: [paragraph('A long prose page. '.repeat(100))] }
const columnDoc = { type: 'doc', content: [{ type: 'columns', content: ['Left column', 'Right column'].map((text) => ({ type: 'column', content: [paragraph(text)] })) }, paragraph('After columns')] }
try {
  await go(base)
  await page.fill('#login-username', 'tester')
  await page.fill('#login-password', 'test-password')
  await page.click('button[type=submit]')
  await page.waitForSelector('nav', { timeout: 30000 })
  const space = await post('/api/spaces', { name: `Page width ${engine} ${Date.now()}` })
  const bundle = await get(`/api/spaces/${space.id}`)
  const type = bundle.types.find((t) => t.system === 'page')
  const prose = await post('/api/objects', { typeId: type.id, title: `Width prose ${engine}`, date: { start: '2031-04-12', resolution: 'day' }, content: { body: proseDoc } })
  const columns = await post('/api/objects', { typeId: type.id, title: `Width columns ${engine}`, content: { body: columnDoc } })
  const boardType = bundle.types.find((t) => t.system === 'whiteboard')
  const board = await post('/api/objects', { typeId: boardType.id, title: `Width whiteboard ${engine}` })
  await openObject(prose.id)
  // Discard setup errors from leaving the seed workspace; checks start in this run's own space.
  problems.length = 0
  if (process.env.SETTINGS !== '0') {
    await go(`${base}/settings#appearance`)
    const choices = page.getByRole('radiogroup', { name: 'Page width', exact: true })
    await choices.waitFor()
    assert.equal(await choices.getByRole('radio', { checked: true }).textContent().then((text) => text.trim()), 'Standard')
    await choices.getByRole('radio', { name: 'Full width', exact: true }).click()
    await until(() => page.evaluate(() => localStorage.getItem('vasta.page-width') === 'full'), 'stored Full width')
    await choices.getByRole('radio', { name: 'Standard', exact: true }).click()
    await until(() => page.evaluate(() => localStorage.getItem('vasta.page-width') === null), 'cleared Standard override')
    await choices.getByRole('radio', { name: 'Wide', exact: true }).click()
    await until(() => page.evaluate(() => localStorage.getItem('vasta.page-width') === 'wide'), 'stored Wide')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await choices.getByRole('radio', { name: 'Wide', exact: true, checked: true }).waitFor()
  } else {
    await choose('wide')
  }
  await openObject(prose.id)
  await expectWidth(objectWidth(), 1152)
  await choose('standard')
  await expectWidth(objectWidth(), 768)
  await choose('full')
  await until(async () => await width(objectWidth()) > 1400, 'Full width grows with the content area')
  const fullWidth = await width(objectWidth())
  const title = page.locator('textarea[data-large-text]')
  const body = page.locator('.vasta-doc').first()
  const fields = page.locator('.vasta-prop-row').first()
  for (const locator of [body, fields]) {
    const titleBox = await title.boundingBox(), contentBox = await locator.boundingBox()
    assert(Math.abs(titleBox.x - contentBox.x) < 2, 'title, properties and text align')
  }
  await openObject(columns.id)
  for (const choice of ['standard', 'wide']) { await choose(choice); await expectWidth(objectWidth(), 1152) }
  await choose('full')
  await expectWidth(objectWidth(), fullWidth)
  console.log(`✓ ${process.env.SETTINGS !== '0' ? 'settings, persistence, ' : ''}live resizing, aligned object pages and columns`)

  const day = '2031-04-12'
  await go(`${base}/calendar?view=day&date=${day}`)
  await page.getByRole('textbox', { name: 'Daily note', exact: true }).waitFor()
  for (const [choice, expected] of [['standard', 768], ['wide', 1152], ['full', null]]) {
    await choose(choice)
    if (expected) await expectWidth(dayWidth(), expected)
    else assert(await width(dayWidth()) > 1152)
  }
  await page.getByRole('textbox', { name: 'Daily note', exact: true }).fill('A saved daily note')
  await page.getByRole('button', { name: 'Save daily note', exact: true }).click()
  await page.locator('.vasta-doc').getByText('A saved daily note', { exact: true }).waitFor()
  for (const [choice, expected] of [['standard', 768], ['wide', 1152]]) { await choose(choice); await expectWidth(dayWidth(), expected) }
  const daily = await post(`/api/spaces/${space.id}/daily-notes/${day}`, {})
  await choose('standard')
  await put(`/api/objects/${daily.id}`, { ...daily, content: { ...daily.content, body: columnDoc } })
  await page.locator('.vasta-doc').getByText('Left column', { exact: true }).waitFor()
  await expectWidth(dayWidth(), 1152)
  await choose('full')
  await until(async () => await width(dayWidth()) > 1152, 'Full width daily columns')
  await go(`${base}/calendar?view=day&date=2031-04-13`)
  await page.getByRole('textbox', { name: 'Daily note', exact: true }).waitFor()
  await choose('standard')
  await expectWidth(dayWidth(), 768)
  await go(`${base}/calendar?view=day&date=${day}`)
  await page.locator('.vasta-doc').getByText('Left column', { exact: true }).waitFor()
  await expectWidth(dayWidth(), 1152)
  await put(`/api/objects/${daily.id}`, { ...daily, content: { ...daily.content, body: proseDoc } })
  await page.locator('.vasta-doc').getByText('After columns', { exact: true }).waitFor({ state: 'detached' })
  await expectWidth(dayWidth(), 768)
  console.log('✓ empty and saved daily notes, live column updates, day navigation')

  await go(`${base}/o/${prose.id}?pane=${columns.id}`)
  const pane = page.locator('[data-side-pane]')
  await pane.waitFor()
  const paneWidth = await width(pane)
  for (const choice of ['wide', 'full', 'standard']) {
    await choose(choice)
    await expectWidth(pane, paneWidth)
    assert(await pane.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'pane overflow')
  }
  await go(`${base}/o/${board.id}`)
  await page.getByRole('button', { name: 'Board menu', exact: true }).waitFor()
  const boardSize = await page.locator('article').boundingBox()
  await choose('full')
  assert.deepEqual(await page.locator('article').boundingBox(), boardSize, 'whiteboard layout changed')
  for (const url of ['/inbox', '/trash', '/nutrition', `/t/${type.id}`, '/calendar?view=month&date=2031-04-12']) {
    await go(`${base}${url}`)
    await page.locator('main').waitFor()
    await choose('standard')
    const original = await page.locator('main').boundingBox()
    await choose('full')
    assert.deepEqual(await page.locator('main').boundingBox(), original, `${url} layout changed`)
  }
  console.log('✓ side pane, whiteboard and other screens retain their widths')

  // Leave the calendar before resizing: its responsive view change can replace the route.
  await openObject(prose.id)
  await page.setViewportSize({ width: 390, height: 844 })
  for (const id of [prose.id, columns.id]) {
    await openObject(id)
    for (const choice of ['standard', 'wide', 'full']) { await choose(choice); await contained() }
  }
  await go(`${base}/calendar?view=day&date=${day}`)
  await page.locator('.vasta-doc').first().waitFor()
  for (const choice of ['standard', 'wide', 'full']) { await choose(choice); await contained() }
  if (process.env.SETTINGS !== '0') {
    await go(`${base}/settings#appearance`)
    await page.getByRole('radiogroup', { name: 'Page width', exact: true }).waitFor()
    await contained()
  }
  console.log('✓ all widths fit a phone viewport')
  assert.deepEqual(problems, [])
} finally {
  await context.close()
  await launched?.close()
}
