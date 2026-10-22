// Settings and the desktop app (test env only): in a browser, This device's download links from
// /desktop/latest.json (write one into the test env's data dir: <dir>/desktop/latest.json with a
// `downloads` key); as the desktop app (its globals and set_shortcut faked), the Desktop app
// section: recording a shortcut, one refused, the default, and ⌘, opening Settings.
// SHOTS=<dir> saves screenshots of the sections.
import { chromium } from 'playwright'
const base = process.argv[2] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error('test env only (5183/5184)')
const browser = await chromium.launch()
const clean = (text) => text.replace(/\s+/g, ' ').trim()

async function open(init) {
  const context = await browser.newContext()
  if (init) await context.addInitScript(init)
  const page = await context.newPage()
  await page.goto(base)
  await page.fill('#login-username', 'tester')
  await page.fill('#login-password', 'test-password')
  await page.click('button[type=submit]')
  await page.waitForSelector('nav', { state: 'attached', timeout: 30000 })
  return { context, page }
}
const shot = (page, selector, name) => process.env.SHOTS && page.locator(selector).screenshot({ path: `${process.env.SHOTS}/${name}.png` })

{
  const { context, page } = await open()
  await page.goto(`${base}/settings`)
  await page.waitForSelector('#device')
  await page.waitForTimeout(1000)
  console.log('browser:', clean(await page.textContent('#device')))
  console.log('links:', await page.$$eval('#device a[download]', (as) => as.map((a) => a.getAttribute('href'))))
  console.log('desktop section in a browser:', await page.isVisible('#desktop'))
  await shot(page, '#device', 'device-browser')
  await context.close()
}

{
  const { context, page } = await open(() => {
    const info = { version: '0.1.3', shortcut: 'CommandOrControl+Shift+Space', updates: 'http://127.0.0.1:5184/desktop/latest.json', setShortcut: true }
    window.__VASTA_DESKTOP__ = info
    window.calls = []
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        window.calls.push([command, args])
        if (args.shortcut.endsWith('KeyT')) throw 'Another app or the system uses this shortcut. Choose another.'
        info.shortcut = args.shortcut || 'CommandOrControl+Shift+Space'
        window.dispatchEvent(new CustomEvent('vasta:desktop'))
        return info.shortcut
      },
    }
  })
  // ⌘, / Ctrl+, opens Settings (in the app on macOS its menu takes it first).
  await page.keyboard.press('ControlOrMeta+Comma')
  await page.waitForSelector('#desktop')
  console.log('⌘, →', new URL(page.url()).pathname)
  const input = page.locator('#desktop input')
  await input.click()
  await page.keyboard.down('Control')
  await page.keyboard.down('Alt')
  console.log('holding:', await input.inputValue())
  await page.keyboard.press('KeyN')
  await page.keyboard.up('Alt')
  await page.keyboard.up('Control')
  await page.waitForTimeout(200)
  console.log('recorded:', await input.inputValue())
  await page.keyboard.press('KeyX')
  console.log('a key alone:', clean(await page.textContent('#desktop label')))
  await page.keyboard.press('Control+KeyT')
  await page.waitForTimeout(200)
  console.log('refused:', clean(await page.textContent('#desktop')))
  await shot(page, '#desktop', 'desktop-section')
  await page.click('#desktop button')
  await page.waitForTimeout(200)
  console.log('default:', await input.inputValue(), JSON.stringify(await page.evaluate(() => window.calls)))
  await context.close()
}

{
  const { context, page } = await open(() => {
    window.__TAURI_INTERNALS__ = {}
    window.__VASTA_DESKTOP__ = { version: '0.1.2', shortcut: 'CommandOrControl+Shift+Space', updates: null }
  })
  await page.goto(`${base}/settings`)
  await page.waitForSelector('#desktop')
  console.log('0.1.2:', clean(await page.textContent('#desktop')))
  await context.close()
}
await browser.close()
