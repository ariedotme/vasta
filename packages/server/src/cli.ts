#!/usr/bin/env node
// Manage Vasta accounts from the terminal (`pnpm vasta …`). Works while the server runs.
//
//   user add <username> [--name "Full name"] [--tz America/Sao_Paulo]
//   user list
//   user passwd <username>
//   user set <username> [--name …] [--tz …|none] [--capture-space <space>|none]
//   user telegram <username> <telegram user id|none>
//   user remove <username>
//   space list
//   space create <name> --owner <username>
//   space rename <space> <new name>
//   space share <space>|--all <username> [--role editor|owner]
//   space unshare <space> <username>
//   space restore <space>  bring back a space deleted from the app (within 30 days)
//   token add <username> <name> [--scope capture|api]
//   token list [username]
//   token revoke <token id>
//   backup <file>          consistent copy of the database (safe while the server runs)
//   media check            every file objects point at is in the media store
//   media push [folder]    copy a media folder (default <data>/media) into the S3 bucket
//   media keys             list the files objects point at
//   media cat <key>        write a stored file to stdout
//
// <space> is a space id or name. Passwords are asked for on the terminal, or read from the first
// line of stdin when it is not a terminal (scripts). Data: $VASTA_DATA or ./data.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { isValidTimeZone, type Space, type SpaceRole, type TokenScope, type User } from '@vasta/core'
import { S3MediaStore } from '@vasta/core/media-s3'
import { NodeStore } from '@vasta/core/node'
import { AccountError, AccountService } from './accounts.ts'
import { createMediaStore, describeMediaStore, pushMediaFolder, referencedMediaKeys } from './media.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const dataDir = path.resolve(process.env.VASTA_DATA ?? path.join(root, 'data'))

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    tz: { type: 'string' },
    'capture-space': { type: 'string' },
    owner: { type: 'string' },
    role: { type: 'string', default: 'editor' },
    scope: { type: 'string', default: 'capture' },
    all: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

const store = new NodeStore(path.join(dataDir, 'vasta.db'))
const accounts = new AccountService({ store })

class UsageError extends Error {}

const USAGE = `
pnpm vasta user add <username> [--name "Full name"] [--tz America/Sao_Paulo]
pnpm vasta user list
pnpm vasta user passwd <username>
pnpm vasta user set <username> [--name …] [--tz …|none] [--capture-space <space>|none]
pnpm vasta user telegram <username> <telegram user id|none>
pnpm vasta user remove <username>
pnpm vasta space list
pnpm vasta space create <name> --owner <username>
pnpm vasta space rename <space> <new name>
pnpm vasta space share <space>|--all <username> [--role editor|owner]
pnpm vasta space unshare <space> <username>
pnpm vasta space restore <space>
pnpm vasta token add <username> <name> [--scope capture|api]
pnpm vasta token list [username]
pnpm vasta token revoke <token id>
pnpm vasta backup <file>
pnpm vasta media check
pnpm vasta media push [folder]
pnpm vasta media keys
pnpm vasta media cat <key>
`

const arg = (index: number, what: string): string => {
  const value = positionals[index]
  if (!value) throw new UsageError(`missing ${what}`)
  return value
}

function findUser(username: string): User {
  const user = store.findUserByUsername(username)
  if (!user) throw new UsageError(`no user called ${username}`)
  return user
}

function findSpace(idOrName: string): Space {
  const spaces = store.listSpaces()
  const byId = spaces.find((s) => s.id === idOrName)
  if (byId) return byId
  const byName = spaces.filter((s) => s.name.toLowerCase() === idOrName.toLowerCase())
  if (byName.length === 1) return byName[0]!
  throw new UsageError(byName.length ? `several spaces are called ${idOrName}; use its id (pnpm vasta space list)` : `no space ${idOrName}`)
}

/** Read a password without echoing it, or the first line of stdin in scripts. */
async function readPassword(prompt: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) {
    let text = ''
    for await (const chunk of stdin) text += chunk
    return text.split(/\r?\n/)[0] ?? ''
  }
  process.stdout.write(prompt)
  stdin.setRawMode(true)
  stdin.setEncoding('utf8')
  return new Promise((resolve) => {
    let value = ''
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false)
          stdin.off('data', onData)
          stdin.pause()
          process.stdout.write('\n')
          resolve(value)
          return
        }
        if (char === '\u0003') process.exit(130) // Ctrl+C
        if (char === '\u007f') value = value.slice(0, -1)
        else value += char
      }
    }
    stdin.on('data', onData)
    stdin.resume()
  })
}

async function newPassword(): Promise<string> {
  const password = await readPassword('Password: ')
  if (process.stdin.isTTY && (await readPassword('Repeat it: ')) !== password) throw new UsageError('the passwords differ')
  return password
}

function describeUser(user: User): string {
  const spaces = store.listUserSpaces(user.id).map((s) => `${s.name} (${store.memberRole(s.id, user.id)})`)
  const extras = [user.timeZone && `tz ${user.timeZone}`, user.telegramUserId !== undefined && `telegram ${user.telegramUserId}`].filter(Boolean)
  return `${user.username}  "${user.name}"${extras.length ? `  ${extras.join(', ')}` : ''}\n    spaces: ${spaces.join(', ') || 'none'}`
}

async function run() {
  const [group, command] = positionals
  if (values.help || !group) return console.info(USAGE.trim())

  if (group === 'user' && command === 'add') {
    const username = arg(2, 'username')
    const claimed = accounts.hasUsers() ? [] : store.spacesWithoutMembers()
    const user = await accounts.createUser({ username, password: await newPassword(), ...(values.name ? { name: values.name } : {}), ...(values.tz ? { timeZone: values.tz } : {}) })
    console.info(`Created ${describeUser(user)}`)
    if (claimed.length) console.info(`As the first user, they own the existing spaces: ${claimed.map((s) => s.name).join(', ')}.`)
    return
  }
  if (group === 'user' && command === 'list') {
    const users = store.listUsers()
    console.info(users.length ? users.map(describeUser).join('\n') : 'No users yet.')
    return
  }
  if (group === 'user' && command === 'passwd') {
    const user = findUser(arg(2, 'username'))
    await accounts.setPassword(user.id, await newPassword())
    console.info(`Changed the password of ${user.username}; their sessions were logged out.`)
    return
  }
  if (group === 'user' && command === 'set') {
    const user = findUser(arg(2, 'username'))
    const next: User = { ...user }
    if (values.name) next.name = values.name
    if (values.tz === 'none') delete next.timeZone
    else if (values.tz) {
      if (!isValidTimeZone(values.tz)) throw new UsageError(`unknown time zone ${values.tz}`)
      next.timeZone = values.tz
    }
    const captureSpace = values['capture-space']
    if (captureSpace === 'none') delete next.captureSpaceId
    else if (captureSpace) {
      const space = findSpace(captureSpace)
      if (!accounts.canUse(user.id, space.id)) throw new UsageError(`${user.username} is not a member of ${space.name}`)
      next.captureSpaceId = space.id
    }
    store.putUser(next)
    console.info(`Updated ${describeUser(next)}`)
    return
  }
  if (group === 'user' && command === 'telegram') {
    const user = findUser(arg(2, 'username'))
    const value = arg(3, 'telegram user id (send /id to the bot to see it)')
    const next: User = { ...user }
    if (value === 'none') delete next.telegramUserId
    else {
      const id = Number(value)
      if (!Number.isInteger(id) || id <= 0) throw new UsageError('a Telegram user id is a positive number')
      const other = store.findUserByTelegram(id)
      if (other && other.id !== user.id) throw new UsageError(`that Telegram account is linked to ${other.username}`)
      next.telegramUserId = id
    }
    store.putUser(next)
    console.info(value === 'none' ? `Unlinked Telegram from ${user.username}.` : `Telegram user ${value} now captures as ${user.username}.`)
    return
  }
  if (group === 'user' && command === 'remove') {
    const user = findUser(arg(2, 'username'))
    for (const space of store.listUserSpaces(user.id)) {
      const owners = store.listMembers(space.id).filter((m) => m.role === 'owner')
      if (owners.length === 1 && owners[0]!.userId === user.id) throw new UsageError(`${user.username} is the only owner of ${space.name}; make someone else an owner first`)
    }
    store.deleteUser(user.id)
    console.info(`Removed ${user.username}. Their spaces stay with the other members.`)
    return
  }

  if (group === 'space' && command === 'list') {
    const users = new Map(store.listUsers().map((u) => [u.id, u.username]))
    for (const space of store.listSpaces()) {
      const members = store.listMembers(space.id).map((m) => `${users.get(m.userId)} (${m.role})`)
      console.info(`${space.id}  ${space.name}\n    members: ${members.join(', ') || 'none'}`)
    }
    const deleted = store.listDeletedSpaces()
    if (deleted.length) console.info('\nDeleted (purged 30 days after deletion; `space restore` brings one back):')
    for (const space of deleted) console.info(`${space.id}  ${space.name}  deleted ${space.deletedAt.slice(0, 10)}`)
    return
  }
  if (group === 'space' && command === 'restore') {
    const wanted = arg(2, 'space')
    const matches = store.listDeletedSpaces().filter((s) => s.id === wanted || s.name.toLowerCase() === wanted.toLowerCase())
    if (!matches.length) throw new UsageError(`no deleted space ${wanted} (see \`space list\`)`)
    if (matches.length > 1) throw new UsageError(`several deleted spaces are called ${wanted}; use the id`)
    accounts.restoreSpace(matches[0]!.id)
    console.info(`Restored ${matches[0]!.name}`)
    return
  }
  if (group === 'space' && command === 'create') {
    if (!values.owner) throw new UsageError('pass --owner <username>')
    const space = accounts.createSpace(arg(2, 'name'), findUser(values.owner).id)
    console.info(`Created space ${space.name} (${space.id})`)
    return
  }
  if (group === 'space' && command === 'rename') {
    const space = findSpace(arg(2, 'space'))
    const name = positionals.slice(3).join(' ').trim()
    if (!name) throw new UsageError('missing new name')
    store.putSpace({ ...space, name })
    console.info(`Renamed ${space.name} to ${name}`)
    return
  }
  if (group === 'space' && command === 'share') {
    const role = values.role as SpaceRole
    if (role !== 'editor' && role !== 'owner') throw new UsageError('--role is editor or owner')
    const spaces = values.all ? store.listSpaces() : [findSpace(arg(2, 'space'))]
    const user = findUser(arg(values.all ? 2 : 3, 'username'))
    for (const space of spaces) accounts.share(space.id, user.id, role)
    console.info(`${user.username} is now ${role === 'owner' ? 'an owner' : 'an editor'} of ${spaces.map((s) => s.name).join(', ')}`)
    return
  }
  if (group === 'space' && command === 'unshare') {
    const space = findSpace(arg(2, 'space'))
    const user = findUser(arg(3, 'username'))
    accounts.unshare(space.id, user.id)
    console.info(`${user.username} no longer has access to ${space.name}`)
    return
  }

  if (group === 'token' && command === 'add') {
    const user = findUser(arg(2, 'username'))
    const scope = values.scope as TokenScope
    if (scope !== 'capture' && scope !== 'api') throw new UsageError('--scope is capture or api')
    const { secret, token } = accounts.createToken(user.id, arg(3, 'token name (e.g. "browser")'), scope)
    console.info(`Token ${token.name} (${token.id}) for ${user.username}, scope ${scope}. It is shown only once:\n\n${secret}\n`)
    return
  }
  if (group === 'token' && command === 'list') {
    const user = positionals[2] ? findUser(positionals[2]) : undefined
    const names = new Map(store.listUsers().map((u) => [u.id, u.username]))
    const tokens = store.listTokens(user?.id)
    for (const t of tokens) console.info(`${t.id}  ${names.get(t.userId)}  ${t.name}  ${t.scope}  last used ${t.lastUsedAt ?? 'never'}`)
    if (!tokens.length) console.info('No tokens.')
    return
  }
  if (group === 'token' && command === 'revoke') {
    const id = arg(2, 'token id')
    if (!store.listTokens().some((t) => t.id === id)) throw new UsageError(`no token ${id}`)
    store.deleteToken(id)
    console.info(`Revoked ${id}`)
    return
  }
  if (group === 'backup') {
    const file = path.resolve(arg(1, 'backup file'))
    if (existsSync(file)) throw new UsageError(`${file} exists`)
    store.db.prepare('VACUUM INTO ?').run(file)
    console.info(`Backed up the database to ${file}`)
    return
  }
  if (group === 'media' && command === 'keys') {
    for (const key of referencedMediaKeys(store)) console.info(key)
    return
  }
  if (group === 'media' && command === 'cat') {
    const file = await createMediaStore(process.env, dataDir).get(arg(2, 'media key'))
    if (!file) throw new UsageError('no such file in the media store')
    await pipeline(Readable.fromWeb(file.body as NodeReadableStream), process.stdout)
    return
  }
  if (group === 'media' && command === 'check') {
    const media = createMediaStore(process.env, dataDir)
    const keys = referencedMediaKeys(store)
    const missing: string[] = []
    for (const key of keys) if (!(await media.has(key))) missing.push(key)
    console.info(`${keys.length} files referenced, ${missing.length} missing from ${describeMediaStore(media)}`)
    for (const key of missing) console.info(`  missing ${key}`)
    if (missing.length) process.exitCode = 1
    return
  }
  if (group === 'media' && command === 'push') {
    const media = createMediaStore(process.env, dataDir)
    if (!(media instanceof S3MediaStore)) throw new UsageError('set VASTA_S3_BUCKET and the other VASTA_S3_* settings first (docs/deploy.md)')
    const folder = path.resolve(positionals[2] ?? path.join(dataDir, 'media'))
    if (!existsSync(folder)) throw new UsageError(`no folder ${folder}`)
    const { copied, skipped } = await pushMediaFolder(folder, media, (key, copied) => copied && console.info(`  ${key}`))
    console.info(`Copied ${copied} files to ${describeMediaStore(media)} (${skipped} were there already)`)
    return
  }
  throw new UsageError(`unknown command: ${positionals.join(' ')}`)
}

try {
  await run()
} catch (error) {
  if (!(error instanceof UsageError || error instanceof AccountError)) throw error
  console.error(`${error.message}\n${error instanceof UsageError ? USAGE : ''}`)
  process.exitCode = 1
} finally {
  store.close()
}
