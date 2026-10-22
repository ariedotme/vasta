const $ = (id) => document.getElementById(id)
const stored = await chrome.storage.local.get(['server', 'token', 'app'])
for (const key of ['server', 'token', 'app']) $(key).value = stored[key] ?? ''

$('form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const server = new URL($('server').value).origin
  // The extension may only talk to the server the user named.
  const granted = await chrome.permissions.request({ origins: [`${server}/*`] })
  if (!granted) {
    $('status').textContent = 'Permission to reach the server was not given.'
    return
  }
  const app = $('app').value.trim() ? new URL($('app').value).origin : ''
  await chrome.storage.local.set({ server, token: $('token').value.trim(), app })
  $('status').textContent = 'Saved.'
})
