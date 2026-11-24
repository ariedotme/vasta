// Typing low in a note on a phone with the on-screen keyboard up (390×844): the line being typed
// stays above the keyboard. The page scrolls in <main>, where iOS Safari does not bring the caret
// above the keyboard by itself. The keyboard is faked by shrinking window.visualViewport, as iOS
// does (the browsers here have no on-screen keyboard); without the fix the caret ends up under it.
//   node phone-keyboard.mjs [chromium|webkit] [base]
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium, webkit } from 'playwright'

const engine = process.argv[2] ?? 'chromium'
const base = process.argv[3] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error(`not the test env: ${base}`)

const options = { viewport: { width: 390, height: 844 }, hasTouch: true, ...(engine === 'webkit' ? {} : { isMobile: true }), locale: 'en-US', timezoneId: 'America/Toronto' }
const launched = engine === 'webkit' ? undefined : await chromium.launch()
const context = launched ? await launched.newContext(options) : await webkit.launchPersistentContext(mkdtempSync(path.join(tmpdir(), 'vasta-phone-keyboard-')), options)
const browser = launched ?? context
const page = context.pages()[0] ?? (await context.newPage())
const problems = []
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const headers = { 'x-requested-with': 'vasta' }
/** The keyboard's top edge in the fake: what iOS leaves of an 844px screen with the keyboard up. */
const KEYBOARD_TOP = 420

let note
try {
  await page.goto(base)
  await page.fill('#login-username', 'tester')
  await page.fill('#login-password', 'test-password')
  await page.click('button[type=submit]')
  await page.waitForSelector('main', { timeout: 30000 })
  const space = (await (await page.request.get(`${base}/api/spaces`)).json())[0]
  const pageType = (await (await page.request.get(`${base}/api/spaces/${space.id}`)).json()).types.find((t) => t.system === 'page')
  note = await (await page.request.post(`${base}/api/objects`, { headers, data: { typeId: pageType.id, title: `Keyboard ${engine}` } })).json()
  await sleep(1500)
  await page.goto(`${base}/o/${note.id}`)
  const editor = page.locator('main [contenteditable=true]').first()
  await editor.waitFor({ timeout: 20000 })
  await editor.click()

  /** The keyboard up to `top` (the visual viewport shrinks, as on an iPhone), or down (null). */
  const keyboard = (top) =>
    page.evaluate((top) => {
      const viewport = window.visualViewport
      if (top === null) {
        delete viewport.height
        delete viewport.offsetTop
      } else {
        Object.defineProperty(viewport, 'height', { get: () => top, configurable: true })
        Object.defineProperty(viewport, 'offsetTop', { get: () => 0, configurable: true })
      }
      viewport.dispatchEvent(new Event('resize'))
    }, top)
  const caretBottom = () => page.evaluate(() => getSelection().getRangeAt(0).getBoundingClientRect().bottom)

  console.log('• a short note: the first lines typed with a tall keyboard stay above it')
  await keyboard(220)
  await page.keyboard.type('one\ntwo\nthree')
  await sleep(300)
  if ((await caretBottom()) > 220) throw new Error(`a short note's line is under the keyboard: at ${Math.round(await caretBottom())}`)

  console.log('• the keyboard goes down: the room made for it goes too')
  await keyboard(null)
  await sleep(300)
  if (await page.evaluate(() => document.querySelector('main').style.paddingBottom)) throw new Error('main kept the room made for the keyboard')

  console.log('• the keyboard comes up again')
  await keyboard(KEYBOARD_TOP)

  console.log('• typing line after line keeps the line being typed above it')
  for (let i = 1; i <= 24; i++) await page.keyboard.type(`line ${i}\n`, { delay: 5 })
  await page.keyboard.type('the line being typed')
  await sleep(300)
  const caret = await caretBottom()
  if (caret > KEYBOARD_TOP) throw new Error(`the line being typed is under the keyboard: its bottom at ${Math.round(caret)}, the keyboard from ${KEYBOARD_TOP}`)
  if (caret < KEYBOARD_TOP - 120) throw new Error(`the page scrolled too far: the caret at ${Math.round(caret)}`)

  if (problems.length) throw new Error(problems.join('\n'))
  console.log(`\nAll phone-keyboard checks passed for ${engine}.`)
} finally {
  if (note) await page.request.delete(`${base}/api/objects/${note.id}`, { headers }).catch(() => {})
  await browser.close()
}
