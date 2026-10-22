// Sprints in the test env: turned on and named in Settings, the Tasks page's "Current …" board and
// Backlog, a sprint's panel (progress, days left), finishing it into the next one, and planning the
// next one.
//   node sprints.mjs [chromium|webkit] [base]   (MODE=json: the replica turned off)
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, webkit } from 'playwright'

const engine = process.argv[2] ?? 'chromium'
const base = process.argv[3] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)

const options = { viewport: { width: 1400, height: 900 }, locale: 'en-US', timezoneId: 'America/Sao_Paulo' }
const launched = engine === 'webkit' ? undefined : await chromium.launch()
const context = launched ? await launched.newContext(options) : await webkit.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'vasta-sprints-')), options)
const browser = launched ?? context
if (process.env.MODE === 'json') await context.addInitScript(() => localStorage.setItem('vasta.replica', 'off'))
const page = context.pages()[0] ?? (await context.newPage())
const problems = []
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !/401|404|TextSelection endpoint|due to access control checks|SQLITE_CORRUPT|Importing a module script failed|VUE_ROUTER_R0010|router.onError/.test(m.text()) && problems.push(`${m.type()}: ${m.text()}`))
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
      const shot = path.join(tmpdir(), `vasta-sprints-${engine}.png`)
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
const day = (offset) => {
  const date = new Date()
  date.setDate(date.getDate() + offset)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
const range = (from, to) => ({ dates: { kind: 'date', value: { start: `${day(from)}T00:00:00.000Z`, end: `${day(to)}T00:00:00.000Z`, resolution: 'day' } } })

await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav', { state: 'attached', timeout: 30000 })

const tag = `${engine}-${Date.now() % 100000}`
const space = await post('/api/spaces', { name: `Sprints ${tag}` })
await page.evaluate((id) => localStorage.setItem('vasta.space', id), space.id)
await page.reload()
await page.waitForSelector('nav', { state: 'attached' })
await until(async () => {
  if (await page.locator('aside').getByText(`Sprints ${tag}`).count()) return true
  await page.locator('aside button[title="Spaces and account"]').click()
  const item = page.locator('[role=menu]').getByText(`Sprints ${tag}`)
  if (await item.count()) await item.click()
  else await page.keyboard.press('Escape')
  await sleep(500)
  return false
}, 'the space open', 30000)

step('turn sprints on in Settings, called Rodada')
await page.goto(`${base}/settings#sprints`)
const section = page.locator('#sprints')
await section.getByRole('checkbox').check()
await until(async () => (await get(`/api/spaces/${space.id}`)).space.sprints?.enabled, 'sprints on')
await section.getByLabel('Called').fill('Rodada')
await until(async () => (await section.getByLabel('Plural').inputValue()) === 'Rodadas', 'the plural follows')
await section.getByRole('button', { name: 'Rename' }).click()
await until(async () => (await get(`/api/spaces/${space.id}`)).space.sprints?.name === 'Rodada', 'renamed')

const types = (await get(`/api/spaces/${space.id}`)).types
const task = types.find((t) => t.system === 'task')
const sprint = types.find((t) => t.system === 'sprint')
if (sprint?.name !== 'Rodada') throw new Error(`the type is ${sprint?.name}`)
const one = await post('/api/objects', { typeId: sprint.id, title: 'Rodada 1', props: range(-3, 10) })
const two = await post('/api/objects', { typeId: sprint.id, title: 'Rodada 2', props: range(11, 24) })
const inSprint = (id) => ({ sprint: { kind: 'relation', value: [id] } })
await post('/api/objects', { typeId: task.id, title: 'Done thing', props: { status: { kind: 'select', value: ['done'] }, ...inSprint(one.id) } })
await post('/api/objects', { typeId: task.id, title: 'Open thing', props: { status: { kind: 'select', value: ['doing'] }, ...inSprint(one.id) } })
await post('/api/objects', { typeId: task.id, title: 'Someday', props: { status: { kind: 'select', value: ['todo'] } } })

step('the Tasks page: Current rodada (a board) and Backlog')
await page.goto(`${base}/t/${task.id}`)
await page.getByRole('button', { name: 'Current rodada' }).click()
await until(async () => (await page.locator('[data-board-card]', { hasText: 'Open thing' }).count()) && !(await page.locator('[data-board-card]', { hasText: 'Someday' }).count()), 'the current sprint’s board')
await page.getByRole('button', { name: 'Backlog' }).click()
await until(async () => (await page.locator('main').getByText('Someday').count()) && !(await page.locator('main').getByText('Open thing').count()), 'the backlog')

step('the sprint’s page: progress and finishing it into the next one')
await page.goto(`${base}/o/${one.id}`)
await until(async () => /2 tasks/.test(await page.locator('main').textContent()) && /1 done · 1 in progress/.test(await page.locator('main').textContent()), 'the counts')
await until(async () => /days left/.test(await page.locator('main').textContent()), 'days left')
await page.getByRole('button', { name: /Finish rodada/ }).click()
await page.getByRole('button', { name: 'Move 1 task' }).click()
await until(async () => {
  const rows = await post(`/api/spaces/${space.id}/query`, { query: { typeIds: [task.id] } })
  return rows.find((o) => o.title === 'Open thing')?.props.sprint?.value?.[0] === two.id && rows.find((o) => o.title === 'Done thing')?.props.sprint?.value?.[0] === one.id
}, 'the open task in Rodada 2, the done one kept')

step('plan the next one from the last')
await page.goto(`${base}/o/${two.id}`)
await page.getByRole('button', { name: /Next rodada/ }).click()
await until(async () => (await post(`/api/spaces/${space.id}/query`, { query: { typeIds: [sprint.id] } })).some((o) => o.title === 'Rodada 3'), 'Rodada 3', 15000)
const three = (await post(`/api/spaces/${space.id}/query`, { query: { typeIds: [sprint.id] } })).find((o) => o.title === 'Rodada 3')
if (three?.props.dates?.value.start.slice(0, 10) !== day(25) || three.props.dates.value.end.slice(0, 10) !== day(38)) throw new Error(`Rodada 3 dates: ${JSON.stringify(three?.props.dates)}`)

if (problems.length) {
  console.log(problems.join('\n'))
  throw new Error('console problems')
}
console.log('ok')
await browser.close()
