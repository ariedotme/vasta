// The desktop app's capture panel page (packages/desktop/src/capture.html) in a browser, with the
// app's commands faked: typing asks for suggestions, the answer shows as a list and a preview,
// arrows and Enter pick one, Esc puts the list away, the panel asks to grow and shrink back, and
// Ctrl+Enter saves asking to open what it made.
// No server needed; the web app's side of it is in capture.mjs.
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 680, height: 400 } })
await page.addInitScript(() => {
  window.calls = []
  const answer = (detail) => setTimeout(() => window.dispatchEvent(new CustomEvent('vasta:capture-suggestions', { detail })), 10)
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      window.calls.push([command, args])
      if (command !== 'suggest_capture') return null
      const { text, seq } = args
      if (text === '/li') answer({ seq, items: [{ label: 'Livro', detail: null, emoji: '📚', text: '/Livro ', cursor: 7 }, { label: 'Lista', detail: null, emoji: null, text: '/Lista ', cursor: 7 }], preview: null, problem: null })
      else if (text.endsWith('autor:fr')) answer({ seq, items: [{ label: 'Frank Herbert', detail: 'Pessoa', emoji: null, text: '/Livro Duna autor:"Frank Herbert" ', cursor: 34 }], preview: 'New Livro “Duna”, in today’s note in Meu Espaço.', problem: null })
      else if (text.startsWith('/Livro')) answer({ seq, items: [], preview: `New Livro “${text.slice(7).trim()}”, in today’s note in Meu Espaço.`, problem: null })
      else answer({ seq, items: [], preview: null, problem: null })
      return null
    },
  }
})
// Module scripts do not load from file://: serve the folder under a made-up origin.
await page.route('http://panel.test/**', async (route) => {
  const name = new URL(route.request().url()).pathname.slice(1)
  const type = { html: 'text/html', js: 'text/javascript', css: 'text/css' }[name.split('.').pop()]
  await route.fulfill({ body: await readFile(new URL(`../../packages/desktop/src/${name}`, import.meta.url)), contentType: type })
})
await page.goto('http://panel.test/capture.html')
const field = page.locator('#text')
const shown = async () => (await page.locator('#list').isVisible()) ? await page.locator('#list li').allTextContents() : []
const fits = async () => (await page.evaluate(() => window.calls.filter(([c]) => c === 'fit_capture').map(([, a]) => a.height)))

await field.pressSequentially('/li')
await page.waitForTimeout(100)
console.log('after /li:', await shown(), 'fit:', await fits())
await page.keyboard.press('ArrowDown')
console.log('selected:', await page.locator('#list li[aria-selected=true]').textContent())
await page.keyboard.press('ArrowUp')
await page.keyboard.press('Enter')
await page.waitForTimeout(100)
console.log('picked:', JSON.stringify(await field.inputValue()), 'list:', await shown(), 'preview:', await page.locator('#preview').textContent())
await field.pressSequentially('Duna autor:fr')
await page.waitForTimeout(100)
console.log('relation:', await shown())
if (process.env.SHOTS) {
  // As the app sizes the window.
  await page.setViewportSize({ width: 680, height: (await fits()).at(-1) })
  await page.screenshot({ path: `${process.env.SHOTS}/panel.png` })
  await page.setViewportSize({ width: 680, height: 400 })
}
await page.keyboard.press('Escape')
console.log('after Esc:', await shown(), 'closed:', (await page.evaluate(() => window.calls.some(([c]) => c === 'close_capture'))))
await page.keyboard.press('Backspace')
await page.keyboard.type('r')
await page.waitForTimeout(100)
await page.keyboard.press('Tab')
await page.waitForTimeout(100)
const value = await field.inputValue()
console.log('tab picked:', JSON.stringify(value), 'cursor:', await field.evaluate((f) => f.selectionStart), 'fit:', await fits())
if (value !== '/Livro Duna autor:"Frank Herbert" ') throw new Error('the pick did not land')
await page.keyboard.press('Enter')
const submitted = await page.evaluate(() => window.calls.find(([c]) => c === 'submit_capture')?.[1])
console.log('submitted:', JSON.stringify(submitted))
if (submitted?.open !== false) throw new Error('Enter asked to open')

// Ctrl+Enter (on macOS too) saves and asks to open; a line with a preview says so.
await page.evaluate(() => window.dispatchEvent(new Event('vasta:capture-saved')))
console.log('hint:', await page.locator('#hint').textContent())
await field.pressSequentially('/Livro Hyperion')
await page.waitForTimeout(100)
const openHint = await page.locator('#open-hint').isVisible()
console.log('preview:', await page.locator('#preview').textContent(), '| open hint shown:', openHint)
if (!openHint) throw new Error('no Ctrl+Enter hint beside the preview')
await page.keyboard.press('Control+Enter')
const opened = await page.evaluate(() => window.calls.filter(([c]) => c === 'submit_capture').at(-1)?.[1])
console.log('Ctrl+Enter submitted:', JSON.stringify(opened))
if (opened?.open !== true || opened.text !== '/Livro Hyperion') throw new Error('Ctrl+Enter did not ask to open')
await browser.close()
