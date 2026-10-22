// Talks to the Vasta capture API with the address and token saved in the options page.

/** @returns {Promise<{ server: string, token: string, app: string }>} */
export async function settings() {
  const { server = '', token = '', app = '' } = await chrome.storage.local.get(['server', 'token', 'app'])
  return { server, token, app: app || server }
}

/**
 * Save a URL as a weblink; it also lands in today's daily note, marked as captured from the browser.
 * @returns {Promise<{ id: string, title: string, openUrl: string }>}
 */
export async function saveWeblink({ url, title, note }) {
  const { server, token, app } = await settings()
  if (!server || !token) throw new Error('Set the Vasta address and capture token in the options first.')
  const response = await fetch(new URL('/api/capture/weblink', server), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ url, channel: 'browser', ...(title ? { title } : {}), ...(note ? { note } : {}) }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error ?? `Vasta answered ${response.status}`)
  const object = data.objects?.[0]
  return { id: object?.id, title: object?.title ?? title ?? url, openUrl: new URL(`/o/${object?.id}`, app).toString() }
}

export const isWebPage = (url) => /^https?:\/\//i.test(url ?? '')
