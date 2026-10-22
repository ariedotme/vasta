import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NodeMediaStore } from '@vasta/core/media-node'
import { NodeStore } from '@vasta/core/node'
import { createApp } from '../src/app.ts'

describe('OpenAPI document', () => {
  const app = createApp({ store: new NodeStore(':memory:'), media: new NodeMediaStore(mkdtempSync(path.join(tmpdir(), 'vasta-openapi-'))) })

  it('is served without a login', async () => {
    const response = await app.request('/api/openapi.json')
    expect(response.status).toBe(200)
    expect(((await response.json()) as { openapi: string }).openapi).toBe('3.1.0')
  })

  it('describes every capture route', async () => {
    const { paths } = (await (await app.request('/api/openapi.json')).json()) as { paths: Record<string, Record<string, unknown>> }
    const routes = app.routes.filter((r) => r.path.startsWith('/api/capture/') && r.method !== 'ALL').map((r) => `${r.method.toLowerCase()} ${r.path}`)
    const described = Object.entries(paths).flatMap(([route, methods]) => Object.keys(methods).map((method) => `${method} ${route}`))
    expect(routes.length).toBeGreaterThan(5)
    expect(described.sort()).toEqual([...new Set(routes)].sort())
  })
})
