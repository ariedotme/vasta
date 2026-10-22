// People in a shared space, in the test env: a task's Assignee picked from the members, "Edited … by",
// the type page's "Mine", a filter on "Me", a board grouped by assignee, `assignee:` in ⌘K, the
// task's activity and the space's retention, and comments.
// Needs a second account in the test env's copy:
//   echo test-password | VASTA_DATA=<dir> node packages/server/src/cli.ts user add anatest --name "Ana Teste"
//   node people.mjs [chromium|webkit] [base]   (MODE=json: the replica turned off)
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, webkit } from 'playwright'

const engine = process.argv[2] ?? 'chromium'
const base = process.argv[3] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)

const options = { viewport: { width: 1400, height: 900 }, locale: 'en-US', timezoneId: 'America/Sao_Paulo' }
const launched = engine === 'webkit' ? undefined : await chromium.launch()
const context = launched ? await launched.newContext(options) : await webkit.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'vasta-people-')), options)
const browser = launched ?? context
if (process.env.MODE === 'json') await context.addInitScript(() => localStorage.setItem('vasta.replica', 'off'))
const page = context.pages()[0] ?? (await context.newPage())
const problems = []
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !/401|404|TextSelection endpoint|due to access control checks|SQLITE_CORRUPT|Importing a module script failed|VUE_ROUTER_R0010|router.onError/.test(m.text()) && problems.push(`${m.type()}: ${m.text()}`))
page.on('pageerror', (e) => !/Importing a module script failed/.test(e.message) && problems.push(`pageerror: ${e.message}`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (name) => console.log(`• ${name}`)
const clean = (text) => (text ?? '').replace(/\s+/g, ' ').trim()
async function until(check, what, timeout = 10000) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeout) {
      console.log(problems.join('\n'))
      const shot = path.join(tmpdir(), `vasta-people-${engine}.png`)
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
await page.waitForSelector('nav', { timeout: 30000 })
const me = await get('/api/auth/me')

// A space shared with Ana, so the checks start from a known state.
const tag = `${engine}-${Date.now() % 100000}`
const space = await post('/api/spaces', { name: `People ${tag}` })
const added = await post(`/api/spaces/${space.id}/members`, { username: 'anatest', role: 'editor' })
const ana = added.find((m) => m.username === 'anatest')
if (!ana) throw new Error('add the anatest account first (see the header)')
const types = (await get(`/api/spaces/${space.id}`)).types
const task = types.find((t) => t.system === 'task')
if (!task.properties.some((p) => p.id === 'assignee' && p.kind === 'person')) throw new Error('Task has no Assignee')
const first = await post('/api/objects', { typeId: task.id, title: 'Paint the fence' })
await post('/api/objects', { typeId: task.id, title: 'Mine already', props: { assignee: { kind: 'person', value: [me.id] } } })

// Open it: the app starts in the space last opened, else from the space menu once it knows it
// (the replica pulls it first).
await page.evaluate((id) => localStorage.setItem('vasta.space', id), space.id)
await page.reload()
await page.waitForSelector('nav')
await until(async () => {
  if (await page.locator('aside').getByText(`People ${tag}`).count()) return true
  await page.locator('aside button[title="Spaces and account"]').click()
  const item = page.locator('[role=menu]').getByText(`People ${tag}`)
  if (await item.count()) await item.click()
  else await page.keyboard.press('Escape')
  await sleep(500)
  return false
}, 'the space open', 20000)

step('assign a task to Ana on its page')
await page.goto(`${base}/o/${first.id}`)
const row = page.locator('.vasta-prop-row', { hasText: 'Assignee' })
await until(() => row.count(), 'the Assignee row', 20000)
await row.getByText('Empty').click()
const picker = page.locator('button', { hasText: 'Ana Teste' })
await until(() => picker.count(), 'Ana in the picker')
const offered = clean(await page.locator('body').textContent())
if (!offered.includes('me')) throw new Error('the user is not marked as me')
await picker.first().click()
await until(async () => (await get(`/api/objects/${first.id}`)).props.assignee?.value?.[0] === ana.userId, 'saved as Ana')
await until(async () => clean(await row.textContent()).includes('Ana Teste'), 'Ana on the page')
await until(async () => clean(await page.locator('body').textContent()).includes('by tester'), '"Edited … by tester"')

step('"Mine" on the Tasks page')
await page.goto(`${base}/t/${task.id}`)
await page.getByText('Paint the fence').waitFor()
const mine = page.locator('button', { hasText: /^\s*Mine\s*$/ })
await mine.click()
await until(async () => !(await page.getByText('Paint the fence').count()) && (await page.getByText('Mine already').count()), 'only my task')
await mine.click()
await page.getByText('Paint the fence').waitFor()

step('a filter on Assignee offers Me and the members')
await page.locator('button', { hasText: /^\s*Filter/ }).click()
await page.getByText(/Add filter/).first().click()
const fieldSelect = page.locator('select').filter({ has: page.locator('option', { hasText: 'Assignee' }) }).first()
await fieldSelect.selectOption({ label: 'Assignee' })
await until(() => page.locator('button', { hasText: /^\s*Me\s*$/ }).count(), 'a Me button')
await page.locator('button', { hasText: /^\s*Me\s*$/ }).click()
await until(async () => !(await page.locator('main').getByText('Paint the fence').count()), 'filtered to me')
const view = await until(async () => {
  const saved = (await get(`/api/types/${task.id}`)).views[0]
  return JSON.stringify(saved.filter?.items?.[0]?.value) === JSON.stringify({ kind: 'variable', name: 'me' }) && saved
}, 'the filter saved as "me"')
await put(`/api/types/${task.id}`, { ...(await get(`/api/types/${task.id}`)), views: [{ ...view, filter: undefined, layout: 'kanban', groupBy: [{ field: 'assignee' }] }] })

step('a board grouped by Assignee')
await page.reload()
await until(async () => (await page.locator('header', { hasText: 'Ana Teste' }).count()) && (await page.locator('header', { hasText: 'tester' }).count()), 'columns per person')

step('assignee: in ⌘K')
await page.keyboard.press('ControlOrMeta+k')
const input = page.locator('input[placeholder="Search or create…"]')
await input.waitFor()
await input.pressSequentially('/Task Water the plants assignee:an')
const activeRow = page.locator('.max-w-xl .bg-hover').first()
await until(async () => clean(await activeRow.textContent()).startsWith('Ana Teste'), 'Ana offered first')
await page.keyboard.press('Enter')
await until(async () => (await input.inputValue()).includes('assignee:anatest'), 'username written')
await until(async () => clean(await page.locator('body').textContent()).includes('assignee Ana Teste'), 'preview names Ana')

step('comments: one with an @mention, edited, deleted')
await page.keyboard.press('Escape')
await page.goto(`${base}/o/${first.id}`)
const box = page.getByLabel('Write a comment')
await box.click()
await box.pressSequentially('Can you do it @an')
await until(() => page.locator('[role=listbox][aria-label=People] [role=option]').count(), 'people offered')
await page.keyboard.press('Enter')
await until(async () => (await box.inputValue()).endsWith('@anatest '), 'the username written')
await box.pressSequentially('by Friday?')
await page.keyboard.press('ControlOrMeta+Enter')
const commentsNow = async () => Object.entries((await get(`/api/objects/${first.id}`)).props).filter(([key]) => key.startsWith('comment:')).map(([, v]) => v.value)
await until(async () => (await commentsNow())[0]?.text === 'Can you do it @anatest by Friday?', 'the comment saved')
await until(() => page.locator('span', { hasText: /^@anatest$/ }).count(), 'the mention highlighted')
await page.getByRole('button', { name: 'Edit' }).click({ force: true })
await page.getByLabel('Edit comment').fill('Can you do it @anatest by Monday?')
await page.getByRole('button', { name: 'Save' }).click()
await until(async () => (await commentsNow())[0]?.editedAt && (await commentsNow())[0].text.includes('Monday'), 'the edit saved')
await page.getByRole('button', { name: 'Delete' }).click({ force: true })
await until(async () => !(await commentsNow()).length, 'the comment deleted')

step('the bell: Ana assigns the tester and mentions them')
const anaContext = launched ? await launched.newContext(options) : context
const anaPage = launched ? await anaContext.newPage() : page
if (launched) {
  await anaPage.request.post(`${base}/api/auth/login`, { headers, data: { username: 'anatest', password: 'test-password' } })
  const unreadBefore = (await get('/api/notices')).unread
  const unreadIs = async (n) => new RegExp(`\\(${n} unread`).test((await page.locator('button[title^="Notifications"]').first().getAttribute('title')) ?? '')
  const asAna = async (method, url, data) => (await anaPage.request.fetch(`${base}${url}`, { method, headers, ...(data ? { data } : {}) })).json()
  const forMe = await asAna('POST', '/api/objects', { typeId: task.id, title: 'Water the plants', props: { assignee: { kind: 'person', value: [me.id] } } })
  const fence = await asAna('GET', `/api/objects/${first.id}`)
  fence.props['comment:from-ana'] = { kind: 'comment', value: { author: ana.userId, at: new Date().toISOString(), text: 'Done soon, @tester?' } }
  await asAna('PUT', `/api/objects/${first.id}`, fence)
  await page.goto(`${base}/t/${task.id}`)
  const bell = page.locator('button[title^="Notifications"]').first()
  await until(() => unreadIs(unreadBefore + 2), 'two more unread', 20000)
  await bell.click()
  await until(async () => /Ana Teste mentioned you in Paint the fence/.test(clean(await page.locator('body').textContent())) && /Ana Teste assigned you Water the plants/.test(clean(await page.locator('body').textContent())), 'both listed')
  await page.locator('button', { hasText: 'assigned you Water the plants' }).first().click()
  await page.waitForURL(new RegExp(`/o/${forMe.id}`))
  await until(() => unreadIs(unreadBefore + 1), 'one of them left unread')
  await anaContext.close()
}

step('the task’s activity, and the space’s retention')
await page.keyboard.press('Escape')
await page.goto(`${base}/o/${first.id}`)
const activity = page.locator('button', { hasText: /^\s*Activity/ })
await until(() => activity.count(), 'an Activity section')
await activity.click()
await until(async () => /tester changed Assignee/.test(clean(await page.locator('section', { has: activity }).textContent())), 'the assignee change listed')
await page.goto(`${base}/settings#space`)
const keep = page.locator('select[aria-label="Keep activity for"]')
await until(() => keep.count(), 'the retention choice')
if ((await keep.inputValue()) !== '90') throw new Error(`retention shows ${await keep.inputValue()}`)

if (problems.length) {
  console.log(problems.join('\n'))
  throw new Error('console problems')
}
console.log('ok')
await browser.close()
