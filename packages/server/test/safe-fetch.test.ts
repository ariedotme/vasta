import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { assertPublicUrl, isPrivateAddress, PrivateAddressError, safeFetch } from '../src/safe-fetch.ts'

const servers: Server[] = []
afterEach(() => {
  delete process.env.VASTA_ALLOW_PRIVATE_FETCH
  for (const server of servers.splice(0)) server.close()
})

async function serve(handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

/** A resolver answering from a fixed table, instead of real DNS. */
const fakeDns = (table: Record<string, string[]>) =>
  (async (host: string) => (table[host] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))) as never

describe('safe fetch', () => {
  it('knows private and public addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.20', '169.254.169.254', '100.100.1.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:192.168.0.1', '::ffff:c0a8:1', '64:ff9b::10.0.0.1'])
      expect(isPrivateAddress(address), address).toBe(true)
    for (const address of ['1.1.1.1', '142.250.78.14', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPrivateAddress(address), address).toBe(false)
  })

  it('checks names after resolving them, and honours the allow list', async () => {
    const dns = fakeDns({ 'example.com': ['93.184.216.34'], 'router.lan': ['192.168.1.1'], 'sneaky.example': ['93.184.216.34', '10.0.0.8'] })
    await expect(assertPublicUrl(new URL('https://example.com/a'), dns)).resolves.toBeUndefined()
    await expect(assertPublicUrl(new URL('http://router.lan/'), dns)).rejects.toThrow(PrivateAddressError)
    await expect(assertPublicUrl(new URL('http://sneaky.example/'), dns)).rejects.toThrow(PrivateAddressError)
    await expect(assertPublicUrl(new URL('http://[::1]:8080/'), dns)).rejects.toThrow(PrivateAddressError)
    await expect(assertPublicUrl(new URL('file:///etc/passwd'), dns)).rejects.toThrow('unsupported')
    process.env.VASTA_ALLOW_PRIVATE_FETCH = 'router.lan'
    await expect(assertPublicUrl(new URL('http://router.lan/'), dns)).resolves.toBeUndefined()
    await expect(assertPublicUrl(new URL('http://10.0.0.8/'), dns)).rejects.toThrow(PrivateAddressError)
    process.env.VASTA_ALLOW_PRIVATE_FETCH = '1'
    await expect(assertPublicUrl(new URL('http://10.0.0.8/'), dns)).resolves.toBeUndefined()
  })

  it('checks every redirect and drops credentials when leaving the origin', async () => {
    let seenAuth: string | undefined = 'unset'
    const target = await serve((req, res) => {
      seenAuth = req.headers.authorization
      res.end('calendar')
    })
    const start = await serve((req, res) => {
      const to = req.url === '/private' ? 'http://10.0.0.1/' : `http://localhost:${target}/feed`
      res.writeHead(302, { location: to }).end()
    })
    process.env.VASTA_ALLOW_PRIVATE_FETCH = '127.0.0.1,localhost'
    await expect(safeFetch(`http://127.0.0.1:${start}/private`)).rejects.toThrow(PrivateAddressError)
    const response = await safeFetch(`http://127.0.0.1:${start}/ok`, { headers: { authorization: 'Basic c2VjcmV0' } })
    expect(await response.text()).toBe('calendar')
    expect(response.url).toBe(`http://localhost:${target}/feed`)
    expect(seenAuth).toBeUndefined()
    delete process.env.VASTA_ALLOW_PRIVATE_FETCH
    await expect(safeFetch(`http://127.0.0.1:${start}/ok`)).rejects.toThrow(PrivateAddressError)
  })
})
