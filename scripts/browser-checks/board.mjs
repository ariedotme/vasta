// Boards in the test env: dragging a card to another column and within one (the manual order), "+"
// at the bottom of a column, a WIP limit, folding a column, swimlanes, the fields cards show and
// the Blocked flag; on a phone profile, a long press that drags (a quick swipe still scrolls).
//   node board.mjs [chromium|webkit] [base] [phone]   (MODE=json: the replica turned off; phone needs chromium)
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, devices, webkit } from 'playwright'

const engine = process.argv[2] ?? 'chromium'
const base = process.argv[3] ?? 'http://127.0.0.1:5183'
const phone = process.argv[4] === 'phone'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)
if (phone && engine !== 'chromium') throw new Error('the phone run needs chromium')

const options = { ...(phone ? devices['Pixel 7'] : { viewport: { width: 1400, height: 900 } }), locale: 'en-US', timezoneId: 'America/Sao_Paulo' }
const launched = engine === 'webkit' ? undefined : await chromium.launch()
const context = launched ? await launched.newContext(options) : await webkit.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'vasta-board-')), options)
const browser = launched ?? context
if (process.env.MODE === 'json') await context.addInitScript(() => localStorage.setItem('vasta.replica', 'off'))
const page = context.pages()[0] ?? (await context.newPage())
const problems = []
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !/401|404|TextSelection endpoint|due to access control checks|SQLITE_CORRUPT|Importing a module script failed|VUE_ROUTER_R0010|router.onError/.test(m.text()) && problems.push(`${m.type()}: ${m.text()}`))
// A reload cancels modules the dev server was still sending; WebKit reports that as an error.
page.on('pageerror', (e) => !/Importing a module script failed/.test(e.message) && problems.push(`pageerror: ${e.message}`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (name) => console.log(`• ${name}`)
async function until(check, what, timeout = 10000) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeout) {
      console.log(problems.join('\n'))
      const shot = path.join(tmpdir(), `vasta-board-${engine}${phone ? '-phone' : ''}.png`)
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

await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav', { state: 'attached', timeout: 30000 })

const tag = `${engine}${phone ? '-phone' : ''}-${Date.now() % 100000}`
const space = await post('/api/spaces', { name: `Board ${tag}` })
const task = (await get(`/api/spaces/${space.id}`)).types.find((t) => t.system === 'task')
if (!task.properties.some((p) => p.id === 'blocked')) throw new Error('Task has no Blocked (restart the test env)')
const status = (value) => ({ status: { kind: 'select', value: [value] } })
const made = {}
for (const [title, value, extra] of [
  ['Alpha', 'todo', { priority: { kind: 'select', value: ['high'] } }],
  ['Bravo', 'todo', { priority: { kind: 'select', value: ['low'] } }],
  ['Charlie', 'todo', { blocked: { kind: 'checkbox', value: true } }],
  ['Delta', 'doing', {}],
]) made[title] = await post('/api/objects', { typeId: task.id, title, props: { ...status(value), ...extra } })
await put(`/api/types/${task.id}`, { ...(await get(`/api/types/${task.id}`)), views: [{ id: `${task.id}:all`, name: 'All', layout: 'kanban', groupBy: [{ field: 'status' }] }] })

// Open the space (the app starts in the last one opened; else from the space menu once it knows it).
await page.evaluate((id) => localStorage.setItem('vasta.space', id), space.id)
await page.reload()
await page.waitForSelector('nav', { state: 'attached' })
await until(async () => {
  if ((await page.title()).includes(`Board ${tag}`) || (await page.locator('aside').getByText(`Board ${tag}`).count())) return true
  if (phone) {
    // No sidebar on a phone: open the board and see whether it shows.
    await page.evaluate((id) => localStorage.setItem('vasta.space', id), space.id)
    await page.goto(`${base}/t/${task.id}`)
    await sleep(2000)
    return (await page.locator('[data-board-card]').count()) > 0
  }
  await page.locator('aside button[title="Spaces and account"]').click()
  const item = page.locator('[role=menu]').getByText(`Board ${tag}`)
  if (await item.count()) await item.click()
  else await page.keyboard.press('Escape')
  await sleep(500)
  return false
}, 'the space open', 30000)
await page.goto(`${base}/t/${task.id}`)
const cellOf = (key) => page.locator(`[data-board-cell="${key}|"]`)
const card = (title) => page.locator('[data-board-card]', { hasText: title })
const titlesIn = async (key) => (await cellOf(key).locator('[data-board-card] .line-clamp-3').allTextContents()).map((t) => t.trim())
const statusOf = async (title) => (await get(`/api/objects/${made[title].id}`)).props.status?.value?.[0]
const rankOf = async (title) => (await get(`/api/objects/${made[title].id}`)).props.rank?.value
await until(() => card('Alpha').count(), 'the board', 20000)

// The middle of what shows of it: a column may stick out of a phone's screen.
const center = async (locator) => {
  const box = await locator.boundingBox()
  const width = page.viewportSize().width
  const left = Math.max(box.x, 0)
  const right = Math.min(box.x + box.width, width)
  return { x: (left + right) / 2, y: box.y + Math.min(box.height, 120) / 2 }
}
async function mouseDrag(from, to) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10)
  await sleep(100)
  await page.mouse.up()
}
async function touchDrag(from, to, hold) {
  const cdp = await context.newCDPSession(page)
  const point = (p) => [{ x: p.x, y: p.y, id: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from) })
  await sleep(hold)
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point({ x: from.x + ((to.x - from.x) * i) / 10, y: from.y + ((to.y - from.y) * i) / 10 }) })
    await sleep(16)
  }
  await sleep(100)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}
const drag = (from, to) => (phone ? touchDrag(from, to, 600) : mouseDrag(from, to))

step('the Blocked flag, and the status left off the cards (it is the column)')
if (!/Blocked/.test(await card('Charlie').textContent())) throw new Error('no Blocked flag')
if (/To do/.test(await card('Alpha').textContent())) throw new Error('the card repeats its column')

step('drag a card to another column')
await card('Bravo').scrollIntoViewIfNeeded()
await drag(await center(card('Bravo')), await center(cellOf('doing')))
await until(async () => (await statusOf('Bravo')) === 'doing', 'Bravo in progress')
await until(async () => (await titlesIn('doing')).includes('Bravo'), 'Bravo in its new column')

step('drag a card above another in its column (manual order)')
// Cards without a place yet come newest first: Charlie, then Alpha.
await until(async () => JSON.stringify(await titlesIn('todo')) === JSON.stringify(['Charlie', 'Alpha']), 'newest first')
if (phone) {
  // A quick swipe on a card scrolls rather than drags.
  await touchDrag(await center(card('Alpha')), { x: (await center(card('Alpha'))).x, y: (await center(card('Charlie'))).y - 30 }, 0)
  await sleep(500)
  if ((await titlesIn('todo'))[0] !== 'Charlie') throw new Error('a swipe moved a card')
}
const charlie = await card('Charlie').boundingBox()
await drag(await center(card('Alpha')), { x: (await center(card('Charlie'))).x, y: charlie.y + 6 })
await until(async () => JSON.stringify(await titlesIn('todo')) === JSON.stringify(['Alpha', 'Charlie']), 'Alpha first')
await until(async () => (await rankOf('Charlie')) && (await rankOf('Alpha')) && (await rankOf('Alpha')) < (await rankOf('Charlie')), 'ranks saved in order')
await page.reload()
await until(async () => JSON.stringify(await titlesIn('todo')) === JSON.stringify(['Alpha', 'Charlie']), 'the order kept after a reload', 20000)

step('"+" at the bottom of a column')
await cellOf('done').getByText('New').click()
await page.keyboard.type('Echo')
await page.keyboard.press('Enter')
await until(async () => (await titlesIn('done')).includes('Echo'), 'Echo in Done')
await until(async () => (await post(`/api/spaces/${space.id}/query`, { query: { typeIds: [task.id] } })).find((o) => o.title === 'Echo')?.props.status?.value?.[0] === 'done', 'Echo saved as done')
await page.keyboard.press('Escape')

step('a WIP limit turns the count red; a column folds')
await cellOf('doing').locator('xpath=..').locator('button[title="Column options"]').click()
await page.getByText('Set a WIP limit…').click()
await page.locator('input').last().fill('1')
await page.keyboard.press('Enter')
await until(async () => (await cellOf('doing').locator('xpath=..').locator('header').textContent()).includes('2/1'), '2/1 in the header')
const overClass = await cellOf('doing').locator('xpath=..').locator('header span.tabular-nums').getAttribute('class')
if (!/red/.test(overClass)) throw new Error('the count is not red')
await cellOf('done').locator('xpath=..').locator('button[title="Column options"]').click()
await page.getByText('Fold column').click()
await until(async () => !(await cellOf('done').count()), 'Done folded')
await until(async () => (await get(`/api/types/${task.id}`)).views[0].board?.collapsed?.includes('done'), 'folded saved')

step('card fields and swimlanes')
await page.getByRole('button', { name: 'Cards' }).click()
await page.locator('select[aria-label="Swimlanes"]').selectOption({ label: 'Priority' })
await until(() => page.locator('[data-board-cell="todo|high"]').count(), 'a High lane')
await page.locator('button', { hasText: /^\s*Blocked\s*$/ }).last().click()
await until(async () => JSON.stringify((await get(`/api/types/${task.id}`)).views[0].board?.cardFields) === JSON.stringify(['blocked']), 'card fields saved')
await page.keyboard.press('Escape')
// Dragging into another lane changes that field too.
await until(() => page.locator('[data-board-cell="doing|low"]').count(), 'a Low lane in progress')
await page.locator('[data-drag-scroll]').evaluate((board) => board.scrollTo({ left: 0 }))
await drag(await center(card('Alpha')), await center(page.locator('[data-board-cell="doing|low"]')))
await until(async () => {
  const o = await get(`/api/objects/${made.Alpha.id}`)
  return o.props.status?.value?.[0] === 'doing' && o.props.priority?.value?.[0] === 'low'
}, 'Alpha in progress, low')

if (problems.length) {
  console.log(problems.join('\n'))
  throw new Error('console problems')
}
console.log('ok')
await browser.close()
