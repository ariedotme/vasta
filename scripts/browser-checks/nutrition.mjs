// Food tracking in the test env: turn it on in Settings, set a weekly goal, log on a past day's page
// (a day of its own each run, picked at random)
// (a new food made in the picker with a portion, then logged by portion and by grams), change an
// amount, move an entry to another meal, not count the day, add a portion on the food's page, and
// save a meal as a recipe whose page works its numbers out; then /food in ⌘K (a food offered at the
// cursor, what the line will log, the toast) logs on today; the Nutrition page (the week, the last
// days, a new goal) and today's kcal in the calendar's month; a habit done from food; kcal alone
// (a quick entry) in the picker, edited, and by /food in ⌘K; the food reminders in Settings.
//   node nutrition.mjs [chromium|webkit] [base] [phone]     MODE=json: the replica turned off (HTTP mode)
//   SHOTS=<dir>: screenshots of the day, the picker, the food and the recipe
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, devices, webkit } from 'playwright'

const engine = process.argv[2] ?? 'chromium'
const base = process.argv[3] ?? 'http://127.0.0.1:5183'
const phone = process.argv[4] === 'phone'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)

const options = phone ? { ...devices['iPhone 15'], locale: 'en-US' } : { viewport: { width: 1300, height: 900 }, locale: 'en-US' }
if (phone && engine === 'chromium') delete options.defaultBrowserType
const launched = engine === 'webkit' ? undefined : await chromium.launch()
const context = launched ? await launched.newContext(options) : await webkit.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'vasta-nutrition-')), options)
const browser = launched ?? context
if (process.env.MODE === 'json') await context.addInitScript(() => localStorage.setItem('vasta.replica', 'off'))
const page = context.pages()[0] ?? (await context.newPage())
const problems = []
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && !/401|TextSelection endpoint|due to access control checks|Failed to load resource/.test(m.text()) && problems.push(`${m.type()}: ${m.text()}`))
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
// The test env has no desktop app builds (Settings asks for them).
page.on('response', (r) => r.status() >= 400 && r.status() !== 401 && !r.url().includes('/desktop/') && problems.push(`${r.status()} ${r.url()}`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (name) => console.log(`• ${name}`)
async function until(check, what, timeout = 10000) {
  const start = Date.now()
  for (;;) {
    const value = await check().catch(() => undefined)
    if (value) return value
    if (Date.now() - start > timeout) {
      console.log(problems.join('\n'))
      const shot = path.join(tmpdir(), `vasta-nutrition-${engine}${phone ? '-phone' : ''}.png`)
      await page.screenshot({ path: shot, fullPage: true })
      console.log('screenshot:', shot)
      throw new Error(`timed out: ${what}`)
    }
    await sleep(200)
  }
}
const headers = { 'x-requested-with': 'vasta' }
const get = async (url) => (await page.request.get(`${base}${url}`)).json()
const post = async (url, data) => (await page.request.post(`${base}${url}`, { headers, data })).json()
const pad = (n) => String(n).padStart(2, '0')
const dayOf = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
const now = new Date()
now.setDate(now.getDate() - 30 - Math.floor(Math.random() * 3000))
const day = dayOf(now)
const tag = `${engine}${phone ? 'p' : ''}${Date.now() % 100000}`
const shot = async (name, target = page) => process.env.SHOTS && (await target.screenshot({ path: path.join(process.env.SHOTS, `nutrition-${engine}${phone ? '-phone' : ''}-${name}.png`) }))

await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector(phone ? 'header' : 'nav', { timeout: 30000 })
const space = (await get('/api/spaces'))[0]

step('turn food tracking on in Settings')
await page.goto(`${base}/settings#nutrition`)
const toggle = page.locator('section#nutrition input[type=checkbox]').first()
await toggle.waitFor()
if (!(await toggle.isChecked())) await toggle.click()
await until(async () => (await get(`/api/spaces/${space.id}`)).types.some((t) => t.system === 'food'), 'the Food type on the server')
await until(async () => (await page.locator('section#nutrition input[type=time]').count()) === 4, 'the four default meals')

step('a weekly goal from the start of the week')
const monday = new Date(now)
monday.setDate(now.getDate() - ((now.getDay() + 6) % 7))
const mondayDay = dayOf(monday)
const number = (value) => ({ kind: 'number', value })
await post('/api/objects', {
  typeId: `nutrition-goal:${space.id}`,
  title: `Goal ${tag}`,
  date: { start: `${mondayDay}T00:00:00.000Z`, resolution: 'day' },
  props: { kcal: number(2000), 'protein-pct': number(30), 'carbs-pct': number(40), 'fat-pct': number(30), weekly: { kind: 'checkbox', value: true } },
})

step(`${day}’s page shows the Food block, folded, then the week`)
await sleep(1000)
await page.goto(`${base}/calendar?view=day&date=${day}`)
const block = page.locator('[data-food-day]')
await block.waitFor({ timeout: 15000 })
await block.locator('button:has-text("Log food")').click()
await until(async () => (await block.locator('[data-food-week]').count()) === 1, 'the week’s budget')

step('make a food in the picker and log it by portion')
const name = `Bread ${tag}`
await block.locator('button[title="Log into Breakfast"]').click()
const dialog = page.locator('[role=dialog]')
await dialog.locator('input[aria-label="Search foods and recipes"]').fill(name)
await dialog.locator(`button:has-text("Create food")`).click()
await dialog.locator('label:has-text("kcal") input').fill('250')
await dialog.locator('label:has-text("Protein") input').fill('9')
await dialog.locator('label:has-text("Carbs") input').fill('48')
await dialog.locator('label:has-text("Fat") input').fill('3')
await dialog.locator('input[aria-label="Portion name"]').fill('slice')
await dialog.locator('input[aria-label="Portion grams"]').fill('25')
await dialog.locator('button:has-text("Create food")').click()
const amount = dialog.locator('input[aria-label="Amount"]')
await amount.waitFor()
await amount.fill('2 slices')
await until(async () => (await dialog.textContent()).includes('50 g · 125 kcal'), 'the preview of 2 slices')
await shot('picker')
await amount.press('Enter')
await until(async () => (await dialog.textContent()).includes('Added'), 'the first item added')

step('and again by grams, then close')
await dialog.locator('input[aria-label="Search foods and recipes"]').fill(tag)
await dialog.locator(`button:has-text("${name}")`).first().click()
await amount.fill('2 cups')
await until(async () => /not a portion/.test(await dialog.textContent()), 'an unknown unit refused')
await amount.fill('50')
await amount.press('Enter')
await until(async () => (await dialog.locator('text=Added').locator('..').locator('div.flex').count()) === 2, 'two items added')
await page.keyboard.press('Escape')
await until(async () => (await page.locator('[role=dialog]').count()) === 0, 'the picker closed')
const breakfast = block.locator('[data-food-meal]').first()
await until(async () => (await breakfast.locator('[data-food-entry]').count()) === 2, 'two entries in Breakfast')
await until(async () => (await block.textContent()).includes('250 / 2 000 kcal'), 'the day’s 250 kcal against the goal')

step('change an amount')
await breakfast.locator('[data-food-entry]').first().click()
const edit = page.locator('[role=dialog]')
await edit.locator('input').first().fill('3 slices')
await edit.locator('button:has-text("Save")').click()
await until(async () => (await block.textContent()).includes('313 / 2 000 kcal'), 'the new total (3 slices + 50 g)')

step('move an entry to lunch (right click)')
await breakfast.locator('[data-food-entry]').nth(1).click({ button: 'right' })
await page.locator('text=Move to Lunch').click()
const lunch = block.locator('[data-food-meal]').nth(1)
await until(async () => (await lunch.locator('[data-food-entry]').count()) === 1, 'one entry in Lunch')

step('do not count the day')
await block.locator('button[title="More"]').click()
await page.locator("text=Don't count this day").click()
await until(async () => (await block.textContent()).includes('not counted'), 'the day marked not counted')
await block.locator('button[title="More"]').click()
await page.locator('text=Count this day again').click()
await until(async () => !(await block.textContent()).includes('not counted'), 'counted again')

await shot('day', block)

step('save breakfast as a recipe')
await breakfast.locator('button[title="More for Breakfast"]').click()
await page.locator('text=Save as recipe').click()
const prompt = page.locator('form:has(h2:has-text("Save as recipe"))')
await prompt.locator('input').fill(`Usual ${tag}`)
await prompt.locator('button:has-text("Save recipe")').click()
const recipe = await until(async () => (await get(`/api/types/recipe:${space.id}/objects`)).find((o) => o.title === `Usual ${tag}`), 'the recipe on the server')
if (recipe.props.ingredients?.value?.[0]?.grams !== 75) throw new Error(`ingredients: ${JSON.stringify(recipe.props.ingredients)}`)

step('the recipe’s page works out its numbers')
await page.goto(`${base}/o/${recipe.id}`)
await until(async () => (await page.locator('[data-recipe-facts]').textContent()).includes('188 kcal'), 'per serving: 75 g of bread')
await shot('recipe')

step('add a portion on the food’s page')
const food = (await get(`/api/types/food:${space.id}/objects`)).find((o) => o.title === name)
await page.goto(`${base}/o/${food.id}`)
await page.locator('input[aria-label="New portion name"]').fill('unidade')
await page.locator('input[aria-label="New portion grams"]').fill('50')
await page.locator('button[title="Add portion"]').click()
await until(async () => (await get(`/api/objects/${food.id}`)).props.portions?.value?.length === 2, 'two portions on the server')
await until(async () => (await page.locator('[data-food-panel]').textContent()).includes(`In Usual ${tag}`), 'the recipe it is in')
await shot('food')

step('/food in ⌘K offers the food at the cursor and logs on today')
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
const palette = page.locator('input[placeholder="Search or create…"]')
await palette.waitFor()
await palette.fill(`/food 1 slice of bread ${tag.slice(0, -1)}`)
await until(async () => (await page.locator(`button:has-text("${name}")`).count()) > 0, 'the food offered')
await page.keyboard.press('Enter')
await until(async () => (await palette.inputValue()) === `/food 1 slice of ${name} `, 'the name written')
await palette.pressSequentially('at dinner')
await until(async () => (await page.locator('text=Logs in Dinner').count()) > 0, 'what it will log')
await page.keyboard.press('Enter')
await until(async () => (await page.locator('text=Logged in Dinner').count()) > 0, 'the toast')
const todayDay = dayOf(new Date())
// On the server once the device has pushed it.
await until(async () => {
  const notes = await post(`/api/spaces/${space.id}/query`, { query: { typeIds: [`daily-note:${space.id}`] }, today: todayDay, timeZone: 'UTC' })
  return notes.some((n) => n.date?.start.startsWith(todayDay) && Object.values(n.props).some((p) => p.kind === 'food-entry' && p.value.sourceId === food.id && p.value.meal === 'dinner'))
}, 'the entry on today’s note on the server')

step('the Nutrition page: the week, the last days, a new goal')
await page.goto(`${base}/nutrition`)
await page.locator('[data-nutrition-week] svg').first().waitFor()
await until(async () => (await page.locator('[data-nutrition-range] svg rect[tabindex="0"]').count()) === 30 || (await page.locator('[data-nutrition-range] svg rect[tabindex="0"]').count()) > 0, 'the last days’ columns')
await page.locator('button:has-text("7 days")').click()
await until(async () => (await page.locator('[data-nutrition-range] svg rect[tabindex="0"]').count()) === 7, 'seven columns')
await shot('page')
await page.locator('button:has-text("New goal")').click()
await page.locator('#goal-kcal').fill('2100')
await page.locator('input[aria-label="Protein %"]').fill('40')
await page.locator('input[aria-label="Carbs %"]').fill('35')
await page.locator('input[aria-label="Fat %"]').fill('30')
await until(async () => (await page.locator('[data-nutrition-goals]').textContent()).includes('add up to 105%'), 'the split checked')
await page.locator('input[aria-label="Carbs %"]').fill('30')
await page.locator('button:has-text("Save goal")').click()
await until(async () => /2 100 kcal · protein 40% · carbs 30% · fat 30%[^]*current/.test(await page.locator('[data-nutrition-goals]').textContent()), 'the new goal, current')
await shot('goals', page.locator('[data-nutrition-goals]'))

step('today’s kcal in the calendar’s month')
await page.goto(`${base}/calendar?view=month&date=${dayOf(new Date())}`)
await until(async () => (await page.locator(`[data-day="${dayOf(new Date())}"] [data-day-kcal]`).count()) === 1, 'the kcal on today')

step('a habit done from food fills from what was logged, and is not checked by hand')
const habit = await post('/api/objects', {
  typeId: `habit:${space.id}`,
  title: `Protein ${tag}`,
  props: { food: { kind: 'select', value: ['protein-min'] }, target: { kind: 'number', value: 100 }, unit: { kind: 'text', value: 'g' } },
})
await sleep(1000)
await page.goto(`${base}/o/${habit.id}`)
await page.locator('[data-habit-from-food]').waitFor()
const check = page.locator('section button[aria-pressed]').first()
await until(async () => /from what you log in Food/.test((await check.getAttribute('title')) ?? ''), 'the check says it comes from food')
await check.click()
await until(async () => (await page.locator('text=is done from what you log in Food').count()) > 0, 'the notice')

step('kcal alone in the picker: a quick entry, without a food, edited')
await page.goto(`${base}/calendar?view=day&date=${day}`)
await block.waitFor({ timeout: 15000 })
const before = Number((/([\d ]+) \/ [\d ]+ kcal/.exec(await block.textContent()) ?? [])[1]?.replace(/ /g, ''))
await block.locator('button[title="Log into Snack"]').click()
await dialog.locator('input[aria-label="Search foods and recipes"]').fill(`Muffin ${tag} ~350 kcal 12g protein`)
await until(async () => (await dialog.locator('[data-quick-entry]').textContent()).includes('350 kcal · 12 g protein'), 'the quick entry offered')
await page.keyboard.press('Enter')
await until(async () => (await dialog.textContent()).includes('Added'), 'the quick entry added')
await page.keyboard.press('Escape')
const snack = block.locator('[data-food-meal]').nth(2)
await until(async () => (await snack.textContent()).includes(`Muffin ${tag}`), 'the muffin in Snack')
await until(async () => (await block.textContent()).includes(`${(before + 350).toLocaleString('en-US').replace(/,/g, ' ')} / `), 'its 350 kcal in the day')
await snack.locator('[data-food-entry]').first().click()
await page.locator('[role=dialog] label:has-text("kcal") input').fill('400')
await page.locator('[role=dialog] button:has-text("Save")').click()
await until(async () => (await block.textContent()).includes(`${(before + 400).toLocaleString('en-US').replace(/,/g, ' ')} / `), 'the new 400 kcal')
const foods = await get(`/api/types/food:${space.id}/objects`).catch(() => [])
if (Array.isArray(foods) && foods.some((f) => f.title?.includes('Muffin'))) throw new Error('a quick entry made a food')

step('/food 300 kcal at snack in ⌘K')
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
await palette.waitFor()
await palette.fill('/food 300 kcal at snack')
await until(async () => (await page.locator('text=Logs in Snack: 300 kcal').count()) > 0, 'what it will log')
await palette.press('Enter')
await until(async () => (await page.locator('text=Logged in Snack: 300 kcal').count()) > 0, 'the toast')

step('food reminders in Settings')
// Let the day page settle: WebKit reports imports cut short by leaving the page as errors.
await sleep(1500)
await page.goto(`${base}/settings#reminders`)
const foodReminders = page.locator('[data-food-reminders]')
await foodReminders.waitFor()
// A minute of its own each run, so the form always has a change to save.
const dayLeftAt = `17:${pad(Math.floor(Math.random() * 60))}`
const dayLeftInput = foodReminders.locator('input[aria-label="Time for what is left of the day"]')
if ((await dayLeftInput.count()) === 0) await foodReminders.locator('input[type=checkbox]').first().check()
await dayLeftInput.fill(dayLeftAt)
await foodReminders.locator('select').last().selectOption({ label: '1 hour after its time' })
await page.locator('section#reminders button:has-text("Save")').click()
await until(async () => {
  const saved = await get('/api/auth/reminders')
  return saved.food?.dayLeft === dayLeftAt && saved.food.mealsAfter === 60
}, 'the food reminders saved')
await shot('reminders', page.locator('section#reminders'))

if (problems.length) {
  console.log(problems.join('\n'))
  throw new Error('console problems')
}
console.log('ok')
await browser.close()
