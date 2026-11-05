// An object's Y.Doc edited over the sync routes, for when this tab has no replica (a private
// window, a second tab, the first sync still filling it): a whiteboard needs its document to work
// at all, where a page can fall back to saving JSON. Local updates are pushed in batches; the
// server's are fetched by state vector when the page asks and every few seconds while visible.
import { fromBase64, toBase64, type Id } from '@vasta/core'
import { syncApi } from './api.ts'
import type { TextSession } from './replica.ts'

const FROM_SERVER = 'server'
const POLL_MS = 4000

export async function openRemoteText(objectId: Id): Promise<TextSession> {
  const Y = await import('yjs')
  const doc = new Y.Doc()
  const pull = async () => {
    const update = (await syncApi.text({ [objectId]: toBase64(Y.encodeStateVector(doc)) }))[objectId]
    if (update) Y.applyUpdate(doc, fromBase64(update), FROM_SERVER)
  }
  await pull()

  let pending: Uint8Array[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let pushing: Promise<void> = Promise.resolve()
  const flush = () =>
    (pushing = pushing.then(async () => {
      clearTimeout(timer)
      if (!pending.length) return
      const update = Y.mergeUpdates(pending)
      pending = []
      try {
        const result = await syncApi.pushText(objectId, toBase64(update))
        if (result?.error) throw new Error(result.error)
      } catch {
        // Offline or refused: keep it, fetch what the server has, and try again shortly.
        pending.unshift(update)
        timer = setTimeout(() => void pull().catch(() => {}).then(flush), POLL_MS)
      }
    }))

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === FROM_SERVER) return
    pending.push(update)
    clearTimeout(timer)
    timer = setTimeout(flush, 300)
  })
  const poll = setInterval(() => {
    if (document.visibilityState === 'visible' && !pending.length) void pull().catch(() => {})
  }, POLL_MS)
  const onHide = () => document.visibilityState === 'hidden' && void flush()
  document.addEventListener('visibilitychange', onHide)

  let released = false
  return {
    doc,
    release: () => {
      if (released) return
      released = true
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onHide)
      void flush().finally(() => doc.destroy())
    },
  }
}
