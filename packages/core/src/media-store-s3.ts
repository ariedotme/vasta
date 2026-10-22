// Content-addressed media store in an S3-compatible bucket (Garage, MinIO, R2, B2, AWS S3), on
// plain fetch with SigV4 signing.
import { AwsClient } from 'aws4fetch'
import { checkMediaKey, mediaKey, RangeNotSatisfiableError, storedFile, type MediaBody, type MediaStore } from './media-store.ts'
import type { StoredFile } from './model.ts'

export interface S3Settings {
  /** e.g. http://garage:3900 or https://<account>.r2.cloudflarestorage.com */
  endpoint: string
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  /** Bucket in the path (endpoint/bucket/key) rather than in the host name (bucket.endpoint/key). */
  pathStyle: boolean
  /** Prepended to every key, to share a bucket (e.g. "vasta/"). */
  prefix?: string
}

/** S3 settings from VASTA_S3_* variables, or undefined when VASTA_S3_BUCKET is not set. */
export function s3SettingsFromEnv(env: Record<string, string | undefined>): S3Settings | undefined {
  const bucket = env.VASTA_S3_BUCKET?.trim()
  if (!bucket) return undefined
  const required = (name: string) => {
    const value = env[name]?.trim()
    if (!value) throw new Error(`${name} must be set when VASTA_S3_BUCKET is`)
    return value
  }
  return {
    endpoint: required('VASTA_S3_ENDPOINT'),
    bucket,
    region: env.VASTA_S3_REGION?.trim() || 'us-east-1',
    accessKeyId: required('VASTA_S3_ACCESS_KEY_ID'),
    secretAccessKey: required('VASTA_S3_SECRET_ACCESS_KEY'),
    pathStyle: env.VASTA_S3_PATH_STYLE !== '0',
    ...(env.VASTA_S3_PREFIX?.trim() ? { prefix: env.VASTA_S3_PREFIX.trim() } : {}),
  }
}

export class S3MediaStore implements MediaStore {
  readonly settings: S3Settings
  private readonly client: AwsClient
  private readonly base: string

  constructor(settings: S3Settings) {
    this.settings = settings
    this.client = new AwsClient({ accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey, service: 's3', region: settings.region })
    const endpoint = new URL(settings.endpoint)
    const root = endpoint.pathname.replace(/\/+$/, '')
    this.base = settings.pathStyle
      ? `${endpoint.origin}${root}/${settings.bucket}/`
      : `${endpoint.protocol}//${settings.bucket}.${endpoint.host}${root}/`
  }

  /** Where the store keeps its files, for messages. */
  get location(): string {
    return `${this.base}${this.settings.prefix ?? ''}`
  }

  async put(data: Uint8Array, name: string, mimeType?: string): Promise<StoredFile> {
    const key = mediaKey(data, name)
    if (!(await this.has(key))) {
      const response = await this.client.fetch(this.url(key), {
        method: 'PUT',
        body: data as Uint8Array<ArrayBuffer>,
        headers: { 'content-type': mimeType || 'application/octet-stream', 'content-length': String(data.byteLength) },
      })
      if (!response.ok) throw await s3Error('PUT', key, response)
      await response.body?.cancel()
    }
    return storedFile(key, data, name, mimeType)
  }

  async get(key: string, range?: string): Promise<MediaBody | undefined> {
    const response = await this.client.fetch(this.url(key), range ? { headers: { range } } : {})
    if (response.status === 404) {
      await response.body?.cancel()
      return undefined
    }
    if (response.status === 416) {
      await response.body?.cancel()
      throw new RangeNotSatisfiableError(Number(response.headers.get('content-range')?.split('/')[1]) || 0)
    }
    if (!response.ok || !response.body) throw await s3Error('GET', key, response)
    const length = Number(response.headers.get('content-length'))
    const partial = response.status === 206 && response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/)
    if (partial) {
      return { body: response.body, length, size: Number(partial[3]), range: { start: Number(partial[1]), end: Number(partial[2]) } }
    }
    return { body: response.body, length, size: length }
  }

  async has(key: string): Promise<boolean> {
    const response = await this.client.fetch(this.url(key), { method: 'HEAD' })
    if (response.status === 404) return false
    if (!response.ok) throw await s3Error('HEAD', key, response)
    return true
  }

  private url(key: string): string {
    return `${this.base}${this.settings.prefix ?? ''}${checkMediaKey(key)}`
  }
}

async function s3Error(method: string, key: string, response: Response): Promise<Error> {
  const text = await response.text().catch(() => '')
  const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1]
  return new Error(`S3 ${method} ${key}: ${response.status}${code ? ` ${code}` : ''}`)
}
