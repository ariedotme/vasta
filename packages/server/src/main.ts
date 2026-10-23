// Starts the Vasta server. `pnpm dev` also reads a `.env` file at the repository root.
//   VASTA_DATA            directory holding vasta.db and media/ (default: ./data at the repository root)
//   PORT                  default 5174
//   VASTA_WEB_DIR         built web app to serve (default: packages/web/dist when it exists)
//   HOST                  default 127.0.0.1 (only this machine can connect)
//   VASTA_TIMEZONE        IANA zone deciding which day captures land on, for users without one
//                         of their own (default: the system's)
//   VASTA_SPACE           space id captures go to, for users who can use it and chose none
//   VASTA_CAPTURE_TOKEN   legacy capture token, acting as the oldest user; prefer per-user tokens
//                         (`pnpm vasta token add`)
//   VASTA_WEB_URL         address of the web app, for links in channel replies and agents' results
//   VASTA_FETCH_LINK_META set to 0 to stop fetching pages of saved links (titles, preview images,
//                         readable text)
//   VASTA_CAPTURE_READABLE set to 0 to stop saving a readable copy of every captured link's page
//   VASTA_REPLICA         set to 0 to keep web apps off their local replica (they talk to the server
//                         directly, as before offline editing); a way out if the replica misbehaves
//   VASTA_ALLOW_PRIVATE_FETCH  local-network hosts links and calendars may be fetched from
//                         (comma-separated), or 1 for all; refused by default (safe-fetch.ts)
//   VASTA_S3_BUCKET       keep media in this S3-compatible bucket instead of <data>/media, with
//                         VASTA_S3_ENDPOINT, VASTA_S3_ACCESS_KEY_ID, VASTA_S3_SECRET_ACCESS_KEY,
//                         VASTA_S3_REGION (default us-east-1), VASTA_S3_PATH_STYLE (0 puts the
//                         bucket in the host name) and VASTA_S3_PREFIX (optional key prefix)
//   VASTA_LOCAL_KEY       set by the desktop app running this server for its own user: the key it
//                         logs in with (/api/auth/local); the server also stops when its stdin closes,
//                         so it never outlives the app (docs/desktop.md)
//   TELEGRAM_BOT_TOKEN    enables the Telegram channel (token from @BotFather)
//   TELEGRAM_ALLOWED_CHAT_IDS  comma-separated chats the bot listens in (optional; only the first
//                              value: Settings › Telegram changes the list, kept in the database)
//   TELEGRAM_ALLOWED_USER_IDS  legacy: senders who capture as the oldest user. Prefer linking each
//                              user (`pnpm vasta user telegram`). With nothing linked or listed, the
//                              bot only replies with the sender's ids.
// Accounts are managed with `pnpm vasta` (packages/server/src/cli.ts); see docs/accounts.md.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { ensureBuiltinTypes } from '@vasta/core'
import { NodeStore } from '@vasta/core/node'
import { AccountService } from './accounts.ts'
import { createApp } from './app.ts'
import { CalendarService } from './calendars.ts'
import { CaptureService } from './capture.ts'
import { ChangeFeed, DesktopListeners } from './events.ts'
import { createMediaStore, describeMediaStore } from './media.ts'
import { ChannelSettings } from './channels.ts'
import { ReminderService } from './reminders.ts'
import { TelegramBot, telegramAccess } from './telegram.ts'
import { purgeNotifications } from './notifications.ts'
import { purgeExpiredTrash } from './trash.ts'
import { fetchPage, fetchPageMeta } from './web-meta.ts'
import { fetchImage, WeblinkService } from './weblinks.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const env = process.env
const dataDir = path.resolve(env.VASTA_DATA ?? path.join(root, 'data'))
const port = Number(env.PORT ?? 5174)
const hostname = env.HOST ?? '127.0.0.1'
const builtWeb = path.join(root, 'packages/web/dist')
const webDir = env.VASTA_WEB_DIR ? path.resolve(env.VASTA_WEB_DIR) : existsSync(builtWeb) ? builtWeb : undefined
// The image sets VASTA_WEB_DIR=/app/web; /.dockerenv covers other containers.
const inDocker = existsSync('/.dockerenv') || env.VASTA_WEB_DIR === '/app/web'
const timeZone = env.VASTA_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone

const store = new NodeStore(path.join(dataDir, 'vasta.db'))
// Spaces made before a built-in type existed get it now.
for (const type of ensureBuiltinTypes(store, new Date().toISOString())) console.info(`Added the built-in type ${type.name} to space ${type.spaceId}`)
const media = createMediaStore(env, dataDir)
const feed = new ChangeFeed()
const fetchLinks = env.VASTA_FETCH_LINK_META !== '0'
const weblinks = new WeblinkService({ store, media, feed, ...(fetchLinks ? { fetchMeta: fetchPageMeta, fetchPage, fetchImage } : {}) })
const capture = new CaptureService({
  store,
  media,
  feed,
  timeZone,
  weblinks,
  saveReadable: fetchLinks && env.VASTA_CAPTURE_READABLE !== '0',
  ...(env.VASTA_SPACE ? { defaultSpaceId: env.VASTA_SPACE } : {}),
})
const captureToken = env.VASTA_CAPTURE_TOKEN?.trim() || undefined
const localKey = env.VASTA_LOCAL_KEY?.trim() || undefined
const accounts = new AccountService({
  store,
  capture,
  ...(env.VASTA_SPACE ? { defaultCaptureSpaceId: env.VASTA_SPACE } : {}),
  ...(captureToken ? { legacyCaptureToken: captureToken } : {}),
})
const calendars = new CalendarService({ store, feed, now: () => new Date().toISOString() })
calendars.start()

// Spaces, types and objects deleted more than 30 days ago, and activity older than each space
// keeps it, are purged at start and then every few hours.
const purgeTrash = () => {
  for (const space of accounts.purgeDeletedSpaces()) console.info(`Purged the deleted space ${space.name} (${space.id})`)
  const purged = purgeExpiredTrash(store, new Date().toISOString())
  if (purged.types || purged.objects) console.info(`Purged ${purged.types} types and ${purged.objects} objects from the trash`)
  purgeNotifications(store, new Date().toISOString())
  const activity = store.purgeActivity(new Date().toISOString())
  if (activity) console.info(`Deleted ${activity} activity entries past their spaces' retention`)
}
purgeTrash()
const purgeTimer = setInterval(purgeTrash, 6 * 3_600_000)

let bot: TelegramBot | undefined
const channels = new ChannelSettings(store)
if (env.TELEGRAM_BOT_TOKEN) {
  const idList = (value: string | undefined) => (value ?? '').split(',').map((id) => Number(id.trim())).filter((id) => Number.isInteger(id) && id !== 0)
  const access = telegramAccess({ store, accounts, channels, allowedChatIds: idList(env.TELEGRAM_ALLOWED_CHAT_IDS), allowedUserIds: idList(env.TELEGRAM_ALLOWED_USER_IDS) })
  if (access.setupMode()) console.warn('Telegram: no linked users yet; the bot replies to every message with its ids and saves nothing')
  bot = new TelegramBot({
    token: env.TELEGRAM_BOT_TOKEN,
    ...access,
    store,
    ...(env.VASTA_WEB_URL ? { webUrl: env.VASTA_WEB_URL } : {}),
  })
  void bot.start()
}

// Habit, event and food reminders through ntfy, the bot and the desktop app (Settings › Reminders).
// VASTA_REMINDERS=0 turns them off.
const desktop = new DesktopListeners()
const reminders =
  env.VASTA_REMINDERS === '0'
    ? undefined
    : new ReminderService({ store, accounts, calendars, desktop, ...(env.VASTA_WEB_URL ? { webUrl: env.VASTA_WEB_URL } : {}), ...(bot ? { telegram: (chat: number, text: string) => bot!.send(chat, text) } : {}) })
reminders?.start()

const server = serve({ fetch: createApp({ store, media, feed, capture, accounts, calendars, weblinks, reminders, desktop, telegram: { username: () => bot?.username, running: !!bot, channels }, replica: process.env.VASTA_REPLICA !== '0', ...(env.VASTA_WEB_URL ? { webUrl: env.VASTA_WEB_URL } : {}), ...(webDir ? { webDir } : {}), ...(localKey ? { localKey } : {}) }).fetch, port, hostname }, () => {
  console.info(`Vasta server on http://${hostname}:${port} (data: ${dataDir}, time zone: ${timeZone})`)
  console.info(`Media: ${describeMediaStore(media)}`)
  if (webDir) console.info(`Serving the web app from ${webDir}`)
  const setupCode = accounts.setupCode()
  if (setupCode && !localKey) console.warn(`No accounts yet: open ${env.VASTA_WEB_URL ?? 'the web app'} and create the first one with the setup code ${setupCode} (or \`${inDocker ? 'docker exec -it vasta vasta' : 'pnpm vasta'} user add <username>\`)`)
  if (captureToken) console.info('VASTA_CAPTURE_TOKEN is set: it captures as the oldest user (per-user tokens: `pnpm vasta token add`)')
})

// In Docker the server is PID 1, which gets no default signal handling: stop on SIGTERM ourselves,
// closing the database so its write-ahead log is checkpointed.
const stop = () => {
  bot?.stop()
  calendars.stop()
  clearInterval(purgeTimer)
  reminders?.stop()
  server.close()
  store.close()
  process.exit(0)
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, stop)
// The desktop app holds the other end of stdin: when it quits (or crashes), stop with it.
if (localKey) {
  process.stdin.once('end', stop).once('close', stop).resume()
}
