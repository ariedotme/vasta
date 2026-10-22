// The calendar's repeating dates in the test env: drag and resize with the mouse, the "This event /
// This and following / All events" question, the occurrence popover, multi-day bars in the month,
// and on a phone profile a long press that drags (a quick swipe still scrolls).
//   node calendar.mjs [chromium|webkit] [base] [phone]
// The phone run needs Chromium (touch moves go through CDP).
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
// WebKit has OPFS (the replica) only in a persistent profile.
const launched = engine === 'webkit' ? undefined : await chromium.launch()
const context = launched ? await launched.newContext(options) : await webkit.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'vasta-calendar-')), options)
const browser = launched ?? context
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
      for (const object of [weekly, dentist, trip]) console.log(JSON.stringify((await get(`/api/objects/${object.id}`)).props.due ?? (await get(`/api/objects/${object.id}`)).date))
      await page.screenshot({ path: path.join(tmpdir(), `vasta-calendar-${engine}.png`) })
      console.log('screenshot:', path.join(tmpdir(), `vasta-calendar-${engine}.png`))
      throw new Error(`timed out: ${what}`)
    }
    await sleep(200)
  }
}
const headers = { 'x-requested-with': 'vasta' }
const get = async (url) => (await page.request.get(`${base}${url}`)).json()
const post = async (url, data) => (await page.request.post(`${base}${url}`, { headers, data })).json()
const dueOf = (object) => object.props.due?.value

await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector(phone ? 'main' : 'nav', { timeout: 30000 })
const space = (await get('/api/spaces'))[0]
const bundle = await get(`/api/spaces/${space.id}`)
const task = bundle.types.find((t) => t.system === 'task')
const pageType = bundle.types.find((t) => t.system === 'page')

// Objects left by an earlier run that failed.
for (const prefix of ['Sync', 'Dentist', 'Trip', 'Popme', 'Touchme']) {
  for (const object of await get(`/api/spaces/${space.id}/search?q=${prefix}&limit=100`)) {
    if (new RegExp(`^${prefix}( (chromium|webkit)|$)`).test(object.title)) await page.request.delete(`${base}/api/objects/${object.id}`, { headers })
  }
}

// A week of its own, far from the test data: Monday 2027-03-01 (São Paulo has no DST then).
const tag = `${engine}${phone ? '-phone' : ''}-${Date.now() % 100000}`
const at = (day, time) => new Date(`${day}T${time}:00-03:00`).toISOString()
const weekly = await post('/api/objects', {
  typeId: task.id,
  title: `Sync ${tag}`,
  props: { due: { kind: 'date', value: { start: at('2027-03-01', '10:00'), end: at('2027-03-01', '11:00'), resolution: 'time', rrule: 'FREQ=WEEKLY;COUNT=6', timeZone: 'America/Sao_Paulo' } } },
  content: { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Agenda' }] }] } },
})
const dentist = await post('/api/objects', {
  typeId: task.id,
  title: `Dentist ${tag}`,
  props: { due: { kind: 'date', value: { start: at('2027-03-02', '14:00'), end: at('2027-03-02', '15:00'), resolution: 'time' } } },
})
const trip = await post('/api/objects', { typeId: pageType.id, title: `Trip ${tag}`, date: { start: '2027-03-03T00:00:00.000Z', end: '2027-03-05T00:00:00.000Z', resolution: 'day' } })
await sleep(1500) // the replica pulls them

const entry = (title) => page.locator('.vasta-entry', { hasText: title }).first()
const column = (day) => page.locator(`[data-timed][data-day="${day}"]`)
const HOUR = 48

/** Drag with the mouse from a point to another, in steps. */
async function mouseDrag(from, to) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8)
  await page.mouse.up()
}

/** A finger: press, hold (`hold` ms), move in steps, lift. Through CDP, so the browser scrolls or not as it would. */
async function touchDrag(from, to, hold) {
  const cdp = await context.newCDPSession(page)
  const point = (p) => [{ x: p.x, y: p.y, id: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(from) })
  await sleep(hold)
  for (let i = 1; i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: point({ x: from.x + ((to.x - from.x) * i) / 10, y: from.y + ((to.y - from.y) * i) / 10 }) })
    await sleep(16)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

async function slotPoint(day, minutes, offsetY = 6) {
  const box = await column(day).boundingBox()
  return { x: box.x + box.width / 2, y: box.y + (minutes / 60) * HOUR + offsetY }
}

async function choose(label) {
  await page.locator('button', { hasText: new RegExp(`^\\s*${label}\\s*$`) }).waitFor()
  await page.locator('button', { hasText: new RegExp(`^\\s*${label}\\s*$`) }).click()
}

const view = phone ? 'three-days' : 'week'
await page.goto(`${base}/calendar?view=${view}&date=2027-03-01`)
await entry(`Sync ${tag}`).waitFor()

if (!phone) {
  step('drag a single date to another day and time')
  const dentistBox = await entry(`Dentist ${tag}`).boundingBox()
  await mouseDrag({ x: dentistBox.x + dentistBox.width / 2, y: dentistBox.y + 6 }, await slotPoint('2027-03-04', 9 * 60))
  await until(async () => dueOf(await get(`/api/objects/${dentist.id}`)).start === at('2027-03-04', '09:00'), 'Dentist moved to Thursday 9:00')
  if (dueOf(await get(`/api/objects/${dentist.id}`)).end !== at('2027-03-04', '10:00')) throw new Error('the move changed the length')

  step('resize it by its bottom edge')
  await until(async () => (await entry(`Dentist ${tag}`).boundingBox())?.y > (await column('2027-03-04').boundingBox()).y + 8 * HOUR, 'Dentist shows on Thursday')
  const moved = await entry(`Dentist ${tag}`).boundingBox()
  await mouseDrag({ x: moved.x + moved.width / 2, y: moved.y + moved.height - 2 }, { x: moved.x + moved.width / 2, y: moved.y + moved.height - 2 + 1.5 * HOUR })
  await until(async () => dueOf(await get(`/api/objects/${dentist.id}`)).end === at('2027-03-04', '11:30'), 'Dentist ends at 11:30')

  step('drag one occurrence: This event')
  const first = await entry(`Sync ${tag}`).boundingBox()
  await mouseDrag({ x: first.x + first.width / 2, y: first.y + 6 }, await slotPoint('2027-03-02', 16 * 60))
  await choose('This event')
  await until(async () => dueOf(await get(`/api/objects/${weekly.id}`)).exceptions?.[at('2027-03-01', '10:00')]?.start === at('2027-03-02', '16:00'), 'an exception for March 1')
} else {
  step('a quick swipe on an entry scrolls; it does not move it')
  const box = await entry(`Sync ${tag}`).boundingBox()
  await touchDrag({ x: box.x + box.width / 2, y: box.y + 8 }, { x: box.x + box.width / 2, y: box.y + 8 + 3 * HOUR }, 30)
  await sleep(800)
  if (dueOf(await get(`/api/objects/${weekly.id}`)).exceptions) throw new Error('a swipe moved the entry')
  if (await page.locator('[role=dialog], form h2', { hasText: 'repeating' }).count()) throw new Error('a swipe asked the question')

  step('a long press drags an occurrence to another day: This event')
  await page.goto(`${base}/calendar?view=${view}&date=2027-03-01`)
  await entry(`Sync ${tag}`).waitFor()
  const start = await entry(`Sync ${tag}`).boundingBox()
  await touchDrag({ x: start.x + start.width / 2, y: start.y + 8 }, await slotPoint('2027-03-02', 16 * 60, 8), 600)
  await choose('This event')
  await until(async () => dueOf(await get(`/api/objects/${weekly.id}`)).exceptions?.[at('2027-03-01', '10:00')]?.start === at('2027-03-02', '16:00'), 'an exception for March 1')

  step('a long press on the bottom edge resizes')
  await page.goto(`${base}/calendar?view=${view}&date=2027-03-02`)
  const dentistBox = await entry(`Dentist ${tag}`).boundingBox()
  const edge = { x: dentistBox.x + dentistBox.width / 2, y: dentistBox.y + dentistBox.height - 4 }
  await touchDrag(edge, { x: edge.x, y: edge.y + HOUR }, 600)
  await until(async () => dueOf(await get(`/api/objects/${dentist.id}`)).end === at('2027-03-02', '16:00'), 'Dentist ends at 16:00')
}

step('drag the next occurrence: This and following (a copy with the text)')
await page.goto(`${base}/calendar?view=${view}&date=2027-03-08`)
const second = await entry(`Sync ${tag}`).boundingBox()
const secondTo = await slotPoint('2027-03-08', 12 * 60, phone ? 8 : 6)
if (phone) await touchDrag({ x: second.x + second.width / 2, y: second.y + 8 }, secondTo, 600)
else await mouseDrag({ x: second.x + second.width / 2, y: second.y + 6 }, secondTo)
await choose('This and following events')
const copies = await until(async () => {
  const found = (await get(`/api/spaces/${space.id}/search?q=${encodeURIComponent(`Sync ${tag}`)}`)).filter((o) => o.title === `Sync ${tag}`)
  return found.length === 2 && found
}, 'a second object for the rest of the series')
const copy = await get(`/api/objects/${copies.find((o) => o.id !== weekly.id).id}`)
if (dueOf(copy).start !== at('2027-03-08', '12:00') || dueOf(copy).rrule !== 'FREQ=WEEKLY;COUNT=5') throw new Error(`the copy's date: ${JSON.stringify(dueOf(copy))}`)
if (copy.content.body.content[0].content[0].text !== 'Agenda') throw new Error('the copy lacks the text')
if (!/UNTIL=20270301T100000/.test(dueOf(await get(`/api/objects/${weekly.id}`)).rrule)) throw new Error('the series did not end')

step('the occurrence popover: change the time, then delete all events')
await page.goto(`${base}/calendar?view=${view}&date=2027-03-15`)
await entry(`Sync ${tag}`).click()
await page.locator('button', { hasText: 'Change time' }).click()
await page.fill('input[aria-label="Start time"]', '13:00')
await page.fill('input[aria-label="End time"]', '13:45')
await page.locator('button[type=submit]', { hasText: 'Save' }).click()
await choose('This event')
await until(async () => dueOf(await get(`/api/objects/${copy.id}`)).exceptions?.[at('2027-03-15', '12:00')]?.end === at('2027-03-15', '13:45'), 'March 15 retimed')
await until(async () => (await entry(`Sync ${tag}`).textContent()).includes('1:00'), 'the calendar shows 1:00')
await entry(`Sync ${tag}`).click()
await page.locator('button', { hasText: 'Delete' }).click()
await choose('All events')
await until(async () => (await get(`/api/objects/${copy.id}`)).deletedAt, 'the copy is in the trash')

if (!phone) {
  step('month view: a three-day trip is one bar over three days, and moves as one')
  await page.goto(`${base}/calendar?view=month&date=2027-03-01`)
  const bar = page.locator('.vasta-bar', { hasText: `Trip ${tag}` })
  await bar.waitFor()
  const cell = await page.locator('[data-day="2027-03-03"]').boundingBox()
  const barBox = await bar.boundingBox()
  if (Math.abs(barBox.width - cell.width * 3) > 12) throw new Error(`the bar is ${barBox.width}px for cells of ${cell.width}px`)
  if (await page.locator('.vasta-entry', { hasText: `Trip ${tag}` }).count() !== 1) throw new Error('the trip shows more than once')
  // Grab it on its second day and drop that on the 11th: it starts on the 10th.
  const target = await page.locator('[data-day="2027-03-11"]').boundingBox()
  await mouseDrag({ x: barBox.x + barBox.width / 2, y: barBox.y + barBox.height / 2 }, { x: target.x + target.width / 2, y: target.y + target.height / 2 })
  await until(async () => (await get(`/api/objects/${trip.id}`)).date.start === '2027-03-10T00:00:00.000Z', 'the trip starts on the 10th')
  if ((await get(`/api/objects/${trip.id}`)).date.end !== '2027-03-12T00:00:00.000Z') throw new Error('the trip changed length')
}

for (const id of [weekly.id, dentist.id, trip.id]) await page.request.delete(`${base}/api/objects/${id}`, { headers })
if (problems.length) {
  console.log(problems.join('\n'))
  throw new Error('console errors')
}
console.log('ok')
await browser.close()
