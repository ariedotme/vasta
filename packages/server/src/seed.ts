#!/usr/bin/env node
// A small made-up data directory for development and the browser checks: the accounts tester and
// anatest (password test-password), and in tester's space a few pages, tasks and a Book type with
// books. scripts/test-env.sh uses it when there is no data/ to copy.
//
//   node packages/server/src/seed.ts <data dir>      (refuses a directory that has a database)
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BODY_PROPERTY_ID, builtinTypeId, newObject, newType, textToBlocks, type ObjectRecord, type ObjectType } from '@vasta/core'
import { NodeStore } from '@vasta/core/node'
import { AccountService } from './accounts.ts'

const PASSWORD = 'test-password'

const dir = process.argv[2]
if (!dir) throw new Error('usage: node packages/server/src/seed.ts <data dir>')
const file = path.join(dir, 'vasta.db')
if (existsSync(file)) throw new Error(`${file} exists; seed an empty directory`)
mkdirSync(path.join(dir, 'media'), { recursive: true })

const store = new NodeStore(file)
const accounts = new AccountService({ store })
const tester = await accounts.createUser({ username: 'tester', password: PASSWORD, timeZone: 'UTC' })
await accounts.createUser({ username: 'anatest', name: 'Ana Teste', password: PASSWORD, timeZone: 'UTC' })
const space = store.listUserSpaces(tester.id)[0]!
const at = new Date().toISOString()

const add = (type: ObjectType, title: string, data: Partial<ObjectRecord> = {}, text?: string) =>
  store.putObject(newObject(type, { title, ...data, ...(text ? { content: { [BODY_PROPERTY_ID]: { type: 'doc', content: textToBlocks(text) } } } : {}) }, randomUUID(), at))

const page = store.getType(builtinTypeId(space.id, 'page'))!
add(page, 'Welcome to Vasta', {}, 'This space was made by the seed script.\nEverything here is made up.')
add(page, 'Daggerheart', {}, 'A tabletop role-playing game. Session notes link here.')
add(page, 'Garden plans', {}, 'Tomatoes by the fence, herbs near the kitchen door.')
add(page, 'Reading list', {}, 'Books to read next.')

const task = store.getType(builtinTypeId(space.id, 'task'))!
add(task, 'Water the plants')
add(task, 'Prepare the next session')

const bookType = newType(space.id, { name: 'Book', pluralName: 'Books', icon: { kind: 'icon', value: 'ph:book-open' } }, randomUUID(), at)
const book: ObjectType = {
  ...bookType,
  properties: [
    ...bookType.properties,
    { id: 'author', kind: 'text', name: 'Author' },
    { id: 'pages', kind: 'number', name: 'Pages' },
  ],
}
store.putType(book)
for (const [title, author, pages] of [
  ['Dune', 'Frank Herbert', 412],
  ['The Left Hand of Darkness', 'Ursula K. Le Guin', 304],
  ['Piranesi', 'Susanna Clarke', 272],
] as const)
  add(book, title, { props: { author: { kind: 'text', value: author }, pages: { kind: 'number', value: pages } } })

console.log(`Seeded ${dir}: log in as tester or anatest, password ${PASSWORD}`)
