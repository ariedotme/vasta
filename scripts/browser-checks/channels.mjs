// Settings › Capture channels and Telegram's chats (test env only). The test env runs no bot, so the
// channel state is faked here (the server side is in capture.test.ts): a chat the bot ignored is
// allowed with a click, one is removed, one is added by id, and "Listen in any chat" empties the
// list. SHOTS=<dir> saves screenshots.
import { chromium } from 'playwright'
const base = process.argv[2] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error('test env only (5183/5184)')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 900, height: 1000 } })
const state = {
  telegram: { running: true, bot: 'vasta_test_bot', linked: true, linkedAccounts: 1, manage: true, allowedChats: [{ id: 42, title: 'Arie' }], ignoredChats: [{ id: -500, title: 'Família', at: '2026-10-19T20:00:00.000Z' }] },
  tokens: 2,
}
const puts = []
await page.route('**/api/auth/channels**', async (route) => {
  if (route.request().method() === 'PUT') {
    const { allowedChats } = route.request().postDataJSON()
    puts.push(allowedChats)
    state.telegram.allowedChats = allowedChats
    state.telegram.ignoredChats = state.telegram.ignoredChats.filter((c) => !allowedChats.some((a) => a.id === c.id))
  }
  await route.fulfill({ json: state })
})
await page.goto(base)
await page.fill('#login-username', 'tester')
await page.fill('#login-password', 'test-password')
await page.click('button[type=submit]')
await page.waitForSelector('nav', { state: 'attached', timeout: 30000 })
await page.goto(`${base}/settings`)
await page.waitForSelector('#channels li')
const clean = (text) => text.replace(/\s+/g, ' ').trim()
console.log('channels:', (await page.locator('#channels li').allTextContents()).map(clean))
const chats = page.locator('[data-testid=telegram-chats]')
await chats.waitFor()
if (process.env.SHOTS) await page.locator('#channels').screenshot({ path: `${process.env.SHOTS}/channels.png` })
if (process.env.SHOTS) await chats.screenshot({ path: `${process.env.SHOTS}/chats.png` })
await chats.getByRole('button', { name: 'Allow' }).click()
await page.waitForTimeout(300)
console.log('after Allow:', (await chats.locator('li').allTextContents()).map(clean))
await chats.locator('li', { hasText: 'Arie' }).getByRole('button', { name: 'Remove' }).click()
await page.waitForTimeout(300)
await chats.getByLabel('Chat id').fill('-100777')
await chats.getByRole('button', { name: 'Add chat' }).click()
await page.waitForTimeout(300)
console.log('after Remove and Add:', (await chats.locator('li').allTextContents()).map(clean))
await chats.getByRole('button', { name: 'Listen in any chat' }).click()
await page.getByRole('button', { name: 'Listen in any chat' }).last().click()
await page.waitForTimeout(300)
console.log('after any chat:', clean(await chats.textContent()))
console.log('sent:', JSON.stringify(puts))
if (JSON.stringify(puts.at(-1)) !== '[]' || puts.length !== 4) throw new Error('the chats were not saved as expected')
await browser.close()
