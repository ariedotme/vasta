// fetch() for addresses users type in (saved links, their preview images, subscribed calendars)
// that refuses private networks: otherwise anyone with an account could make the server read the
// homelab's own services (the router, a NAS, cloud metadata endpoints). Every hop of a redirect
// is checked after resolving its host name.
//   VASTA_ALLOW_PRIVATE_FETCH=1                 allow everything (a single-user homelab)
//   VASTA_ALLOW_PRIVATE_FETCH=cloud.lan,10.0.0.5  allow these hosts (e.g. a Nextcloud calendar on the LAN)
// Limit: the name is resolved once for the check and again by fetch, so a DNS server that answers
// differently the second time (DNS rebinding) is not caught. Good enough against typed addresses.
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

const MAX_REDIRECTS = 5

export class PrivateAddressError extends Error {
  constructor(host: string) {
    super(`${host} is on a private network; set VASTA_ALLOW_PRIVATE_FETCH to allow it`)
    this.name = 'PrivateAddressError'
  }
}

const blocked = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT, Tailscale
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
] as const)
  blocked.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const)
  blocked.addSubnet(network, prefix, 'ipv6')

/** Whether an IP address is loopback, private, link-local or otherwise not on the internet. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return blocked.check(address, 'ipv4')
  if (family !== 6) return true
  const lower = address.toLowerCase()
  // IPv4 inside IPv6 (::ffff:10.0.0.1, NAT64 64:ff9b::10.0.0.1): judge the IPv4 part.
  const embedded = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1]
  if (embedded) return blocked.check(embedded, 'ipv4')
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower)
  if (hex) {
    const n = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16)
    return blocked.check([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'), 'ipv4')
  }
  return blocked.check(address, 'ipv6')
}

function allowList(): { all: boolean; hosts: Set<string> } {
  const value = (process.env.VASTA_ALLOW_PRIVATE_FETCH ?? '').trim()
  if (value === '1' || value === 'true') return { all: true, hosts: new Set() }
  return { all: false, hosts: new Set(value.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)) }
}

/** Throws unless the URL is http(s) on a public address (or allowed by VASTA_ALLOW_PRIVATE_FETCH). */
export async function assertPublicUrl(url: URL, resolve: typeof lookup = lookup) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`unsupported address ${url.protocol}`)
  const allowed = allowList()
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (allowed.all || allowed.hosts.has(host)) return
  const addresses = isIP(host) ? [host] : (await resolve(host, { all: true, verbatim: true })).map((a) => a.address)
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new PrivateAddressError(host)
}

/**
 * fetch() with redirects followed by hand, checking each address. The response's `url` is the
 * final address, as with `redirect: 'follow'`. Credentials are dropped when a redirect leaves the
 * origin, like browsers do.
 */
export async function safeFetch(input: string | URL, init: RequestInit = {}, resolve: typeof lookup = lookup): Promise<Response> {
  let url = new URL(input)
  let headers = new Headers(init.headers)
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(url, resolve)
    const response = await fetch(url, { ...init, headers, redirect: 'manual' })
    const location = response.headers.get('location')
    if (response.status < 300 || response.status >= 400 || !location) {
      Object.defineProperty(response, 'url', { value: url.href })
      return response
    }
    await response.body?.cancel().catch(() => {})
    if (hop >= MAX_REDIRECTS) throw new Error('too many redirects')
    const next = new URL(location, url)
    if (next.origin !== url.origin) {
      headers = new Headers(headers)
      headers.delete('authorization')
      headers.delete('cookie')
    }
    url = next
  }
}
