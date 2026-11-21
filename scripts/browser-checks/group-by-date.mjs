// Group by Due in a list and a board in the test env: ordered day buckets, no dragging or adding
// cards in date columns or swimlanes. MODE=json turns the replica off.
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)
const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'en-US', timezoneId: 'America/Toronto' })
if (process.env.MODE === 'json') await context.addInitScript(() => localStorage.setItem('vasta.replica', 'off'))
const page = await context.newPage()
const problems = []
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !/401|TextSelection endpoint/.test(m.text()) && problems.push(`${m.type()}: ${m.text()}`))
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const step = (name) => console.log(`• ${name}`)
async function until(check, what, timeout = 15000) {
  const start = Date.now()
  for (;;) {
    if (await check()) return
    if (Date.now() - start > timeout) {
      console.log(problems.join('\n'))
      throw new Error(`timed out: ${what}`)
    }
    await sleep(200)
  }
}
const headers = { 'x-requested-with': 'vasta' }
const get = async (url) => (await page.request.get(`${base}${url}`)).json()
const post = async (url, data) => (await page.request.post(`${base}${url}`, { headers, data })).json()
const put = async (url, data) => (await page.request.put(`${base}${url}`, { headers, data })).json()

try {
  await page.goto(base)
  await page.fill('#login-username', 'tester')
  await page.fill('#login-password', 'test-password')
  await page.click('button[type=submit]')
  await page.waitForSelector('nav', { state: 'attached', timeout: 30000 })

  const space = await post('/api/spaces', { name: `Date groups ${Date.now() % 100000}` })
  const task = (await get(`/api/spaces/${space.id}`)).types.find((type) => type.system === 'task')
  const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA').format(new Date()))
  const shifted = (offset) => new Date(Date.parse(`${today}T00:00:00.000Z`) + offset * 86400000).toISOString()
  const made = {}
  for (const [title, offset] of [['Tomorrow task', 1], ['No date task', undefined], ['Earlier task', -1], ['Today task', 0]]) {
    made[title] = await post('/api/objects', {
      typeId: task.id, title,
      props: { status: { kind: 'select', value: ['todo'] }, ...(offset === undefined ? {} : { due: { kind: 'date', value: { start: shifted(offset), resolution: 'day' } } }) },
    })
  }
  await put(`/api/types/${task.id}`, { ...task, views: [{ id: `${task.id}:dates`, name: 'Dates', layout: 'list' }] })
  // Open the space (the app starts in the last one opened; else from the space menu once it knows it).
  await page.evaluate((id) => localStorage.setItem('vasta.space', id), space.id)
  await page.reload()
  await page.waitForSelector('nav', { state: 'attached' })
  await until(async () => {
    if ((await page.title()).includes(space.name) || (await page.locator('aside').getByText(space.name).count())) return true
    await page.locator('aside button[title="Spaces and account"]').click()
    const item = page.locator('[role=menu]').getByText(space.name)
    if (await item.count()) await item.click()
    else await page.keyboard.press('Escape')
    await sleep(500)
    return false
  }, 'the space open', 30000)
  await page.goto(`${base}/t/${task.id}`)
  await until(() => page.getByRole('link', { name: /Today task/ }).count(), 'the list in the new space', 30000)

  step('Due is offered in Group, and the list headers follow time rather than object order')
  await page.getByRole('button', { name: 'Group', exact: true }).click()
  await page.locator('[data-overlay]').getByRole('button', { name: 'Due', exact: true }).click()
  const listHeaders = page.locator('main section > header > span:first-child')
  await until(async () => JSON.stringify(await listHeaders.allTextContents()) === JSON.stringify(['Earlier', 'Today', 'Tomorrow', 'No date']), 'ordered list groups')
  await until(async () => (await get(`/api/types/${task.id}`)).views[0].groupBy?.[0]?.field === 'due', 'Due grouping saved')

  step('a board keeps the empty date columns, without an add button')
  await page.getByRole('button', { name: 'List', exact: true }).click()
  await page.locator('[data-overlay]').getByRole('button', { name: 'Board', exact: true }).click()
  const keys = ['past', 'today', 'tomorrow', 'this-week', 'next-week', 'later', '__none']
  const labels = ['Earlier', 'Today', 'Tomorrow', 'This week', 'Next week', 'Later', 'No date']
  await until(async () => (await page.locator('[data-board-cell]').count()) === 7, 'seven date columns')
  const columnHeaders = page.locator('[data-drag-scroll] section > header > span:first-child')
  if (JSON.stringify(await columnHeaders.allTextContents()) !== JSON.stringify(labels)) throw new Error('wrong board headers')
  for (const [index, key] of keys.entries()) {
    const cell = page.locator(`[data-board-cell="${key}|"]`)
    if ((await cell.count()) !== 1) throw new Error(`no ${key} column`)
    const title = { past: 'Earlier task', today: 'Today task', tomorrow: 'Tomorrow task', __none: 'No date task' }[key]
    if (title && !(await cell.getByText(title, { exact: true }).count())) throw new Error(`${title} is not in ${labels[index]}`)
  }
  // A date column does not say the day, so the card still shows its Due.
  const tomorrowCard = page.locator(`[data-board-card="${made['Tomorrow task'].id}"]`)
  if ((await tomorrowCard.innerText()).trim() === 'Tomorrow task') throw new Error('a card in a date column hides its date')

  async function cannotMove(target) {
    if (await page.locator('[data-board-cell]').getByRole('button', { name: 'New', exact: true }).count()) throw new Error('date groups offer New')
    const card = page.locator(`[data-board-card="${made['Today task'].id}"]`)
    const before = (await get(`/api/objects/${made['Today task'].id}`)).props
    if (await card.evaluate((element) => element.draggable)) throw new Error('date card is draggable')
    await card.scrollIntoViewIfNeeded()
    const from = await card.boundingBox()
    const to = await target.boundingBox()
    await page.mouse.move(from.x + from.width / 2, from.y + 12)
    await page.mouse.down()
    await page.mouse.move(to.x + to.width / 2, to.y + 12, { steps: 10 })
    if (await page.locator('html').evaluate((element) => element.classList.contains('vasta-dragging'))) throw new Error('a date card started dragging')
    await page.mouse.up()
    await sleep(500)
    if (!(await card.count())) throw new Error('a date card disappeared')
    if (JSON.stringify((await get(`/api/objects/${made['Today task'].id}`)).props) !== JSON.stringify(before)) throw new Error('a date card changed after a drag')
  }
  await cannotMove(page.locator('[data-board-cell="tomorrow|"]'))

  step('date swimlanes also block dragging and adding, even with select columns')
  await page.getByRole('button', { name: 'Due', exact: true }).click()
  await page.locator('[data-overlay]').getByRole('button', { name: 'Status', exact: true }).click()
  await page.getByRole('button', { name: 'Cards', exact: true }).click()
  await page.locator('select[aria-label="Swimlanes"]').selectOption({ label: 'Due' })
  await page.keyboard.press('Escape')
  await until(() => page.locator('[data-board-cell="todo|today"]').count(), 'date swimlanes')
  await cannotMove(page.locator('[data-board-cell="doing|tomorrow"]'))

  if (problems.length) {
    console.log(problems.join('\n'))
    throw new Error('console problems')
  }
  console.log('ok')
} finally {
  await browser.close()
}
