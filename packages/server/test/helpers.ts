// Test helpers: a user with a whole-API token, so tests can call the authenticated API; devices
// with a local replica, as the web app's worker keeps one.
import { randomUUID } from 'node:crypto'
import sqliteWasm from '@sqlite.org/sqlite-wasm'
import { BODY_PROPERTY_ID, type Doc, type Id, type TokenScope, type User } from '@vasta/core'
import { ClientStore } from '@vasta/core/client'
import type { NodeStore } from '@vasta/core/node'
import { wasmDatabase } from '@vasta/core/sql-wasm'
import { SyncClient, httpTransport } from '@vasta/core/sync-client'
import { Y, readContent, writeContent, type JsonDoc } from '@vasta/editor-schema/yjs'
import { AccountService } from '../src/accounts.ts'

type Requester = { request: (input: string, init?: RequestInit) => Response | Promise<Response> }
export type Request = (input: string, init?: RequestInit) => Response | Promise<Response>

/** A hash no password matches; tests that log in use AccountService.createUser instead. */
const NO_PASSWORD = 'scrypt$1024$8$1$AA==$AA=='

/** Add a user who is a member of `spaces` (default: all) and return a request function acting as them. */
export function asUser(app: Requester, store: NodeStore, options: { username?: string; spaces?: Id[]; scope?: TokenScope } = {}) {
  const at = new Date().toISOString()
  const username = options.username ?? `user-${store.listUsers().length + 1}`
  const user: User = { id: randomUUID(), username, name: username, createdAt: at }
  store.putUser(user, NO_PASSWORD)
  for (const spaceId of options.spaces ?? store.listSpaces().map((s) => s.id)) store.putMember({ spaceId, userId: user.id, role: 'owner', createdAt: at })
  const { secret } = new AccountService({ store }).createToken(user.id, 'test', options.scope ?? 'api')
  const request = (input: string, init: RequestInit = {}) =>
    app.request(input, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${secret}` } })
  return { user, secret, request }
}

export const now = () => new Date().toISOString()
export const paragraphs = (...texts: string[]): JsonDoc => ({ type: 'doc', content: texts.map((text) => ({ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] })) })
type Node = { text?: string; content?: Node[] }
const deepText = (node: Node): string => node.text ?? (node.content ?? []).map(deepText).join('')
/** The text of each top-level block. */
export const texts = (doc: Doc | JsonDoc | undefined) => ((doc?.content ?? []) as Node[]).map(deepText)

const sqlite3 = await sqliteWasm()

/** A device: its replica, its sync loop, and a switch for the network. */
export class Device {
  store!: ClientStore
  sync!: SyncClient
  online = true
  private readonly name: string
  private readonly db = wasmDatabase(new sqlite3.oo1.DB(':memory:'))
  private readonly request: Request
  private runs = 0

  constructor(name: string, request: Request) {
    this.name = name
    this.request = request
    this.start()
  }

  private start() {
    const run = ++this.runs
    this.store = new ClientStore(this.db, this.name)
    this.sync = new SyncClient(
      this.store,
      httpTransport(async (url, init) => {
        if (!this.online) throw new TypeError('Failed to fetch')
        const response = await this.request(url, init)
        // The app was closed meanwhile: the server did the work, the answer is lost.
        if (run !== this.runs) throw new TypeError('Failed to fetch')
        return response
      })
    )
  }

  /** Close the app and open it again on the same replica, cutting off a sync on its way (close editors first). */
  restart() {
    this.start()
  }

  /**
   * An editor on this device: a Y.Doc of its own (the app's main thread) bound to the replica's
   * open document, as the web app's text sessions are.
   */
  edit(id: string) {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, this.store.openText(id), 'replica')
    const stop = this.store.onTextUpdate((objectId, update, origin) => {
      if (objectId === id && origin !== 'editor') Y.applyUpdate(doc, update, 'replica')
    })
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'replica') this.store.applyLocalText(id, update, now(), 'editor')
    })
    return {
      doc,
      type: (...lines: string[]) => writeContent(doc, { [BODY_PROPERTY_ID]: paragraphs(...lines) }, undefined, [BODY_PROPERTY_ID]),
      text: () => texts(readContent(doc)[BODY_PROPERTY_ID]),
      close: () => {
        stop()
        this.store.closeText(id)
      },
    }
  }
}
