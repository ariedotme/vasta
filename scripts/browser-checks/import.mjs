// Settings › Import (test env only): imports a Capacities full export into a new space, prints the
// report, then opens the new space's types and one imported object. The export is yours to give:
//   node import.mjs <export.zip> [base]   (SHOTS=<dir> saves screenshots)
import { chromium } from 'playwright'
const zip = process.argv[2]
if (!zip) throw new Error('usage: node import.mjs <export.zip> [base]')
const base = process.argv[3] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error('test env only (5183/5184)')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } })
page.on('pageerror', (error) => console.log('page error:', error.message))
page.on('console', (message) => message.type() === 'error' && console.log('console:', message.text()))
await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav', { state: 'attached', timeout: 30000 })
const spacesBefore = await page.evaluate(async () => (await fetch('/api/spaces')).json())

await page.goto(`${base}/settings#import`)
const section = page.locator('#import')
await section.locator('input[type=file]').setInputFiles(zip)
await section.getByRole('button', { name: 'Import' }).waitFor()
console.log('chosen:', (await section.textContent()).replace(/\s+/g, ' ').trim().slice(0, 400))
const started = Date.now()
await section.getByRole('button', { name: 'Import' }).click()
await section.getByText(/^Imported \d+ objects?\./).or(section.locator('p.text-red-600')).waitFor({ timeout: 120000 }).catch(() => {})
if (!(await section.getByText(/^Imported \d+ objects?\./).count())) {
  console.log('not imported:', (await section.textContent()).replace(/\s+/g, ' ').trim())
  if (process.env.SHOTS) await section.screenshot({ path: `${process.env.SHOTS}/import-failed.png` })
  process.exit(1)
}
console.log(`imported in ${Date.now() - started} ms`)
for (const details of await section.locator('details').all()) await details.locator('summary').click()
console.log('report:', (await section.locator('.rounded-lg.bg-hover\\/60').textContent()).replace(/\s+/g, ' ').trim())
if (process.env.SHOTS) await section.screenshot({ path: `${process.env.SHOTS}/import-report.png` })

const spacesAfter = await page.evaluate(async () => (await fetch('/api/spaces')).json())
const created = spacesAfter.find((s) => !spacesBefore.some((b) => b.id === s.id))
console.log('new space:', created?.name)
const bundle = await page.evaluate(async (id) => (await fetch(`/api/spaces/${id}`)).json(), created.id)
const custom = bundle.types.filter((t) => !t.system && bundle.counts[t.id])
console.log('types with objects:', custom.map((t) => `${t.name} (${bundle.counts[t.id]})`).join(', '))
// The type with the most objects, and its first one.
const type = custom.sort((a, b) => bundle.counts[b.id] - bundle.counts[a.id])[0]
await page.goto(`${base}/t/${type.id}`)
await page.waitForTimeout(1500)
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/import-type.png` })
const objects = await page.evaluate(async (id) => (await fetch(`/api/types/${id}/objects`)).json(), type.id)
await page.goto(`${base}/o/${objects[0].id}`)
await page.waitForTimeout(1500)
console.log('object page:', (await page.locator('main').textContent()).replace(/\s+/g, ' ').trim().slice(0, 300))
if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/import-object.png` })
await browser.close()
