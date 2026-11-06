// Web Push: reminders as notifications of the web app, on phones (an installed PWA on iOS 16.4+,
// Chrome, Firefox and others on Android) and in desktop browsers, with the app closed. Each
// device subscribes from Settings › Reminders and keeps its own choice of what reminds it.
//
// The server's keys (VAPID, RFC 8292) are made on first use and kept in the database's meta, so
// there is nothing to configure. Messages are encrypted for each device (aes128gcm, RFC 8291)
// with node:crypto. Devices live in meta too (`push.devices.<userId>`); one the push service says
// is gone (404, 410) is forgotten.
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign, type ECDH, type KeyObject } from 'node:crypto'
import type { Id, IsoDateTime } from '@vasta/core'
import type { NodeStore } from '@vasta/core/node'
import { safeFetch } from './safe-fetch.ts'

/** What a device is reminded of; the user's settings decide what is sent at all. */
export interface PushKinds {
  habits: boolean
  events: boolean
  food: boolean
  /** Assigned, mentioned, comments (as chosen under Others' work). */
  work: boolean
}

export type PushKind = keyof PushKinds

/** A browser's subscription, as PushSubscription.toJSON() gives it. */
export interface PushSubscriptionJson {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

interface StoredDevice {
  id: string
  name: string
  endpoint: string
  keys: { p256dh: string; auth: string }
  kinds: PushKinds
  createdAt: IsoDateTime
}

/** A device as the app sees it: the endpoint lets a page know which one it is. */
export interface PushDevice {
  id: string
  name: string
  endpoint: string
  kinds: PushKinds
  createdAt: IsoDateTime
}

export interface PushMessage {
  title: string
  body: string
  /** The page a tap opens (an address of the web app). */
  url?: string
  /** One notification per tag on a device: a reminder sent again replaces itself. */
  tag?: string
}

export class PushError extends Error {}

const ALL_KINDS: PushKinds = { habits: true, events: true, food: true, work: true }
const VAPID_KEY = 'push.vapid'
/** The web app's https address devices subscribed from, when VASTA_WEB_URL is not set. */
const SUBJECT_KEY = 'push.subject'
const devicesKey = (userId: Id) => `push.devices.${userId}`

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')
const fromB64url = (text: string) => Buffer.from(text, 'base64url')

export interface PushOptions {
  store: NodeStore
  /** Who runs the server, for the push services (VAPID's `sub`): the web app's address. */
  subject?: string
  /** Defaults to safeFetch: an endpoint is an address a browser handed over. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  now?: () => number
}

export class PushService {
  private readonly options: PushOptions
  private vapid: { publicKey: Buffer; privateKey: KeyObject } | undefined

  constructor(options: PushOptions) {
    this.options = options
  }

  private now() {
    return this.options.now?.() ?? Date.now()
  }

  /** The server's public key (base64url), for PushManager.subscribe's applicationServerKey. */
  publicKey(): string {
    return b64url(this.keys().publicKey)
  }

  private keys() {
    if (this.vapid) return this.vapid
    let saved = this.options.store.getMeta(VAPID_KEY)
    if (!saved) {
      const ecdh = createECDH('prime256v1')
      ecdh.generateKeys()
      saved = JSON.stringify({ publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) })
      this.options.store.setMeta(VAPID_KEY, saved)
    }
    const { publicKey, privateKey } = JSON.parse(saved) as { publicKey: string; privateKey: string }
    const pub = fromB64url(publicKey)
    const key = createPrivateKey({
      key: { kty: 'EC', crv: 'P-256', d: privateKey, x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) },
      format: 'jwk',
    })
    return (this.vapid = { publicKey: pub, privateKey: key })
  }

  private stored(userId: Id): StoredDevice[] {
    try {
      const devices = JSON.parse(this.options.store.getMeta(devicesKey(userId)) ?? '[]') as StoredDevice[]
      return devices.map((d) => ({ ...d, kinds: { ...ALL_KINDS, ...d.kinds } }))
    } catch {
      return []
    }
  }

  private write(userId: Id, devices: StoredDevice[]) {
    this.options.store.setMeta(devicesKey(userId), JSON.stringify(devices))
  }

  devices(userId: Id): PushDevice[] {
    return this.stored(userId).map(({ keys: _keys, ...device }) => device)
  }

  /**
   * Add this device, or refresh it (same endpoint): its name and choices stay. `origin` is the web
   * app's address it subscribed from, the contact for push services when no subject is set.
   */
  subscribe(userId: Id, subscription: PushSubscriptionJson, name: string, origin?: string): PushDevice {
    const endpoint = String(subscription?.endpoint ?? '')
    const p256dh = String(subscription?.keys?.p256dh ?? '')
    const auth = String(subscription?.keys?.auth ?? '')
    let url: URL
    try {
      url = new URL(endpoint)
    } catch {
      throw new PushError('the subscription has no endpoint')
    }
    if (url.protocol !== 'https:') throw new PushError('the endpoint must be https')
    if (fromB64url(p256dh).length !== 65 || fromB64url(auth).length < 16) throw new PushError("the subscription's keys are not valid")
    if (origin && /^https:\/\//.test(origin) && !this.options.store.getMeta(SUBJECT_KEY)) this.options.store.setMeta(SUBJECT_KEY, origin)
    const devices = this.stored(userId)
    const label = name.replace(/\s+/g, ' ').trim().slice(0, 60) || 'A device'
    const known = devices.find((d) => d.endpoint === endpoint)
    if (known) {
      known.keys = { p256dh, auth }
      this.write(userId, devices)
      return this.devices(userId).find((d) => d.id === known.id)!
    }
    const device: StoredDevice = { id: randomBytes(8).toString('hex'), name: label, endpoint, keys: { p256dh, auth }, kinds: { ...ALL_KINDS }, createdAt: new Date(this.now()).toISOString() }
    this.write(userId, [...devices, device].slice(-20))
    return this.devices(userId).find((d) => d.id === device.id)!
  }

  update(userId: Id, id: string, changes: { name?: string; kinds?: Partial<PushKinds> }): PushDevice {
    const devices = this.stored(userId)
    const device = devices.find((d) => d.id === id)
    if (!device) throw new PushError('no such device')
    if (typeof changes.name === 'string' && changes.name.trim()) device.name = changes.name.replace(/\s+/g, ' ').trim().slice(0, 60)
    for (const kind of Object.keys(ALL_KINDS) as PushKind[]) if (typeof changes.kinds?.[kind] === 'boolean') device.kinds[kind] = changes.kinds[kind]
    this.write(userId, devices)
    return this.devices(userId).find((d) => d.id === id)!
  }

  remove(userId: Id, id: string) {
    this.write(
      userId,
      this.stored(userId).filter((d) => d.id !== id)
    )
  }

  /**
   * Send to the user's devices that want this kind (all of them for a test). What each answered;
   * a device whose subscription is gone is forgotten.
   */
  async send(userId: Id, kind: PushKind | 'test', message: PushMessage): Promise<{ device: string; ok: boolean; error?: string }[]> {
    const devices = this.stored(userId).filter((d) => kind === 'test' || d.kinds[kind])
    const gone = new Set<string>()
    const results = await Promise.all(
      devices.map(async (device) => {
        try {
          const response = await this.post(device, message)
          if (response.status === 404 || response.status === 410) {
            gone.add(device.id)
            return { device: device.name, ok: false, error: 'no longer subscribed (removed)' }
          }
          if (!response.ok) return { device: device.name, ok: false, error: `the push service answered ${response.status}` }
          return { device: device.name, ok: true }
        } catch (error) {
          return { device: device.name, ok: false, error: (error as Error).message }
        }
      })
    )
    if (gone.size) this.write(userId, this.stored(userId).filter((d) => !gone.has(d.id)))
    return results
  }

  private post(device: StoredDevice, message: PushMessage) {
    const body = encrypt(Buffer.from(JSON.stringify(message)), fromB64url(device.keys.p256dh), fromB64url(device.keys.auth))
    return (this.options.fetch ?? safeFetch)(device.endpoint, {
      method: 'POST',
      headers: {
        authorization: this.authorization(device.endpoint),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(24 * 60 * 60),
        urgency: 'high',
        ...(message.tag ? { topic: topicOf(message.tag) } : {}),
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(10_000),
    })
  }

  /** VAPID (RFC 8292): a JWT signed with the server's key, for the endpoint's origin, 12 hours. */
  private authorization(endpoint: string) {
    const { publicKey, privateKey } = this.keys()
    const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
    const claims = b64url(
      Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(this.now() / 1000) + 12 * 3600, sub: subjectOf(this.options.subject, this.options.store.getMeta(SUBJECT_KEY)) }))
    )
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKey, dsaEncoding: 'ieee-p1363' })
    return `vapid t=${header}.${claims}.${b64url(signature)}, k=${b64url(publicKey)}`
  }
}

/**
 * VAPID's contact: the web app's https address (Apple's push service refuses a JWT without a
 * real one), else the address devices subscribed from, else a mailto Google and Mozilla take.
 */
function subjectOf(webUrl: string | undefined, seen: string | undefined) {
  const https = [webUrl, seen].find((url) => url && /^https:\/\//.test(url))
  return https ? https.replace(/\/$/, '') : 'mailto:vasta@localhost'
}

/** A push Topic header: up to 32 URL-safe characters. */
function topicOf(tag: string) {
  return Buffer.from(tag).toString('base64url').slice(0, 32)
}

/**
 * Encrypt a message for one device (RFC 8291, aes128gcm with a single record). `salt` and
 * `serverKeys` are only given by tests.
 */
export function encrypt(plain: Buffer, uaPublic: Buffer, authSecret: Buffer, salt = randomBytes(16), serverKeys?: ECDH): Buffer {
  if (!serverKeys) {
    serverKeys = createECDH('prime256v1')
    serverKeys.generateKeys()
  }
  const asPublic = serverKeys.getPublicKey()
  const secret = serverKeys.computeSecret(uaPublic)
  const ikm = Buffer.from(hkdfSync('sha256', secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32))
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const cipher = createCipheriv('aes-128-gcm', key, nonce)
  // The last (and only) record ends with the padding delimiter 2.
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const recordSize = Buffer.alloc(4)
  recordSize.writeUInt32BE(4096)
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, encrypted])
}
