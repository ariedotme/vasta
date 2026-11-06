import { createECDH, createPublicKey, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { NodeStore } from '@vasta/core/node'
import { encrypt, PushService } from '../src/push.ts'

const b64 = (text: string) => Buffer.from(text, 'base64url')

/** A browser's subscription with fresh keys. */
function browser(endpoint = 'https://push.example/send/abc') {
  const keys = createECDH('prime256v1')
  keys.generateKeys()
  return { endpoint, keys: { p256dh: keys.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') } }
}

function setup(status = 201) {
  const store = new NodeStore(':memory:')
  const posts: { url: string; init: RequestInit }[] = []
  const push = new PushService({
    store,
    subject: 'https://notes.example/',
    now: () => Date.parse('2026-11-05T12:00:00.000Z'),
    fetch: async (url, init = {}) => {
      posts.push({ url, init })
      return new Response(null, { status })
    },
  })
  return { store, push, posts }
}

describe('web push', () => {
  it('encrypts as RFC 8291 says (its example in section 5)', () => {
    const server = createECDH('prime256v1')
    server.setPrivateKey(b64('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'))
    const body = encrypt(
      Buffer.from('When I grow up, I want to be a watermelon'),
      b64('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
      b64('BTBZMqHH6r4Tts7J_aSIgg'),
      b64('DGv6ra1nlYgDCS1FRnbzlw'),
      server
    )
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
    )
  })

  it('keeps one key pair, and signs for the endpoint’s origin with it (VAPID)', async () => {
    const { store, push, posts } = setup()
    const key = push.publicKey()
    expect(b64(key)).toHaveLength(65)
    expect(new PushService({ store }).publicKey()).toBe(key)
    push.subscribe('u', browser(), 'iPhone')
    await push.send('u', 'test', { title: 'Hi', body: 'There' })
    const headers = posts[0]!.init.headers as Record<string, string>
    expect(headers['content-encoding']).toBe('aes128gcm')
    const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(headers.authorization!)!
    expect(k).toBe(key)
    const [header, claims, signature] = token!.split('.')
    expect(JSON.parse(b64(claims!).toString())).toEqual({ aud: 'https://push.example', exp: Math.floor(Date.parse('2026-11-05T12:00:00.000Z') / 1000) + 43200, sub: 'https://notes.example' })
    const pub = b64(key)
    const jwk = { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, b64(signature!))).toBe(true)
  })

  it('sends each device what it chose, and forgets one whose subscription is gone', async () => {
    const { push, posts } = setup()
    const phone = push.subscribe('u', browser('https://push.example/phone'), 'Phone')
    push.subscribe('u', browser('https://push.example/laptop'), 'Laptop')
    // Subscribing again refreshes the device, it does not add one.
    expect(push.subscribe('u', browser('https://push.example/phone'), 'Other name')).toMatchObject({ id: phone.id, name: 'Phone' })
    push.update('u', phone.id, { kinds: { food: false } })
    await push.send('u', 'food', { title: 'Lunch', body: 'Nothing logged' })
    expect(posts.map((p) => p.url)).toEqual(['https://push.example/laptop'])
    await push.send('u', 'test', { title: 'Test', body: '' })
    expect(posts).toHaveLength(3)

    const gone = setup(410)
    gone.push.subscribe('u', browser(), 'Old phone')
    expect(await gone.push.send('u', 'habits', { title: 'Read', body: '' })).toEqual([{ device: 'Old phone', ok: false, error: 'no longer subscribed (removed)' }])
    expect(gone.push.devices('u')).toEqual([])
  })

  it('takes the address devices subscribed from as its contact when no web address is set', async () => {
    const store = new NodeStore(':memory:')
    const posts: RequestInit[] = []
    const push = new PushService({ store, fetch: async (_url, init = {}) => (posts.push(init), new Response(null, { status: 201 })) })
    push.subscribe('u', browser(), 'Phone', 'https://vasta.example')
    await push.send('u', 'test', { title: 'Hi', body: '' })
    const token = /t=([^,]+)/.exec((posts[0]!.headers as Record<string, string>).authorization!)![1]!
    expect(JSON.parse(b64(token.split('.')[1]!).toString()).sub).toBe('https://vasta.example')
  })

  it('refuses an endpoint that is not https and keys that are not a browser’s', () => {
    const { push } = setup()
    expect(() => push.subscribe('u', browser('http://10.0.0.1/x'), 'x')).toThrow('https')
    expect(() => push.subscribe('u', { endpoint: 'https://push.example/x', keys: { p256dh: 'AAAA', auth: 'AAAA' } }, 'x')).toThrow('keys')
  })
})
