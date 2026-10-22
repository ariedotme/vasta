// Invites in the test env (on the seed data, where tester is the server's first account): Settings ›
// Server accounts makes a link; someone new opens it, sees what it is, makes an account with it and
// lands in the app, in the shared space; the link then stops working, and the new account appears
// in tester's list.
//   node invites.mjs [base]
import { chromium } from 'playwright'

const base = process.argv[2] ?? 'http://127.0.0.1:5183'
if (!/^http:\/\/127\.0\.0\.1:518[34]$/.test(base)) throw new Error('test env only (5183/5184)')
const browser = await chromium.launch()
setTimeout(() => (console.log('timed out'), process.exit(1)), 90000).unref()
const step = (name) => console.log(`• ${name}`)

const admin = await (await browser.newContext()).newPage()
await admin.goto(base)
await admin.fill('#login-username', 'tester')
await admin.fill('#login-password', 'test-password')
await admin.click('button[type=submit]')
await admin.waitForSelector('nav', { state: 'attached', timeout: 30000 })

step('make an invite link that joins the first space as editor')
await admin.goto(`${base}/settings`)
const section = admin.locator('#server')
await section.getByRole('button', { name: 'Create invite link' }).waitFor()
const spaceName = (await section.locator('select').first().locator('option').nth(1).textContent()).replace(/^Join “|”$/g, '')
await section.locator('select').first().selectOption({ index: 1 })
await section.getByRole('button', { name: 'Create invite link' }).click()
const link = (await section.locator('[data-invite-link]').textContent()).trim()
if (!link.includes('?invite=')) throw new Error(`no link: ${link}`)
await section.getByText(`Joins “${spaceName}” as editor`).waitFor()

step('someone new opens it and makes an account')
const username = `guest${Date.now() % 100000}`
const guest = await (await browser.newContext()).newPage()
await guest.goto(link)
await guest.getByText(`invited you to this Vasta server, to the space “${spaceName}”`).waitFor()
await guest.fill('#setup-name', 'Guest Person')
await guest.fill('#login-username', username)
await guest.fill('#login-password', 'guest-password')
await guest.getByRole('button', { name: 'Create account' }).click()
await guest.waitForSelector('nav', { state: 'attached', timeout: 30000 })
if (guest.url().includes('invite=')) throw new Error('the invite stayed in the address')
const me = await (await guest.request.get(`${base}/api/auth/me`)).json()
if (me.username !== username) throw new Error(`logged in as ${me.username}`)
const spaces = await (await guest.request.get(`${base}/api/spaces`)).json()
if (!spaces.some((s) => s.name === spaceName)) throw new Error(`not in ${spaceName}: ${spaces.map((s) => s.name)}`)

step('the link is used up, and the new account is listed')
const again = await (await browser.newContext()).newPage()
await again.goto(link)
await again.getByText('this invite is not valid any more').waitFor()
await admin.reload()
await admin.locator('#server').getByText(`@${username}`).waitFor()
console.log('ok')
await browser.close()
