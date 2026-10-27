// Toggles after the line is written (test env only): Tab under a line makes it a toggle holding the
// block, Tab under a toggle goes into it, ⇧Tab takes a block back out (a toggle left empty is a line
// again), /Toggle on a written line makes it the title, and Tab in a list still nests the item.
//   node toggles.mjs [base]      MODE=json: with the replica turned off (HTTP mode)
import { chromium } from 'playwright'
const base = process.argv[2] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)
const browser = await chromium.launch()
const context = await browser.newContext()
if (process.env.MODE === 'json') await context.addInitScript(() => localStorage.setItem('vasta.replica', 'off'))
const page = await context.newPage()
const problems = []
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav', { timeout: 30000 })
const spaces = await (await page.request.get(`${base}/api/spaces`)).json()
const bundle = await (await page.request.get(`${base}/api/spaces/${spaces[0].id}`)).json()
const pageType = bundle.types.find((t) => t.system === 'page')
const created = await (await page.request.post(`${base}/api/objects`, { headers: { 'x-requested-with': 'vasta' }, data: { typeId: pageType.id, title: 'Toggle check' } })).json()
await sleep(1000)
await page.goto(`${base}/o/${created.id}`)
await page.waitForSelector('.vasta-doc')
await page.click('.vasta-doc')
await sleep(150)

// The document as the editor has it, in short: "Line", "▸Title[child, child]", "• item[…]".
const shape = () =>
  page.evaluate(() => {
    const text = (n) => (n.content ?? []).map((c) => c.text ?? '').join('')
    const show = (n) => {
      if (n.type === 'details') return `▸${text(n.content[0])}[${n.content[1].content.map(show).join(', ')}]`
      if (n.type === 'bulletList') return n.content.map((item) => `•${text(item.content[0])}${item.content.length > 1 ? `[${item.content.slice(1).map(show).join(', ')}]` : ''}`).join(' ')
      return text(n)
    }
    const editor = [...document.querySelectorAll('.ProseMirror')].map((el) => el.editor).find(Boolean)
    return editor.getJSON().content.map(show).filter(Boolean)
  })
const check = async (what, expected) => {
  await sleep(150)
  const got = await shape()
  console.log(`${what}:`, JSON.stringify(got))
  if (JSON.stringify(got) !== JSON.stringify(expected)) throw new Error(`${what}: expected ${JSON.stringify(expected)}`)
}
const lineEnd = async (text) => {
  await page.locator('.ProseMirror p', { hasText: text }).last().click()
  await sleep(150)
  await page.keyboard.press('End')
}

await page.keyboard.type('Groceries')
await page.keyboard.press('Enter')
await page.keyboard.type('milk')
await page.keyboard.press('Enter')
await page.keyboard.type('eggs')
await lineEnd('milk')
await page.keyboard.press('Tab')
await check('Tab under a line', ['▸Groceries[milk]', 'eggs'])
await page.keyboard.type(' 2l')
await check('the cursor stays on the line', ['▸Groceries[milk 2l]', 'eggs'])
await lineEnd('eggs')
await page.keyboard.press('Tab')
await check('Tab under a toggle', ['▸Groceries[milk 2l, eggs]'])
await page.keyboard.press('Shift+Tab')
await check('⇧Tab out of it', ['▸Groceries[milk 2l]', 'eggs'])
await lineEnd('milk')
await page.keyboard.press('Shift+Tab')
await check('⇧Tab on the last one inside', ['Groceries', 'milk 2l', 'eggs'])

// /Toggle on a written line: the line is the title.
await lineEnd('eggs')
await page.keyboard.press('Enter')
await page.keyboard.type('Ideas ')
await page.keyboard.type('/toggle')
await sleep(300)
await page.keyboard.press('Enter')
await page.keyboard.press('Enter')
await page.keyboard.type('one')
await check('/Toggle after the line', ['Groceries', 'milk 2l', 'eggs', '▸Ideas [one]'])

// Lists keep their Tab.
await page.keyboard.press('Shift+Tab')
await page.keyboard.press('Enter')
await page.keyboard.type('- a')
await page.keyboard.press('Enter')
await page.keyboard.type('b')
await page.keyboard.press('Tab')
await check('Tab in a list', ['Groceries', 'milk 2l', 'eggs', 'Ideas ', 'one', '•a[•b]'])
if (problems.length) throw new Error(problems.join('\n'))
await browser.close()
