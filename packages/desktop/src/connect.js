// The bundled start page: choose the Vasta server, then hand over to it. Once the server's web app
// has loaded here, it opens even when the server does not answer (its service worker starts it
// offline); before that, a server that does not answer gets a message and Try again.
const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args)
const $ = (id) => document.getElementById(id)
const show = (id, visible = true) => ($(id).hidden = !visible)

/** Anything answering at the address (no-cors: the reply itself cannot be read from here). */
async function reachable(server) {
  try {
    await fetch(new URL('api/health', server), { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(6000) })
    return true
  } catch {
    return false
  }
}

function status(text) {
  $('status').textContent = text
  show('status', Boolean(text))
}

function showSetup(start) {
  status('')
  show('unreachable', false)
  show('setup')
  show('cancel', Boolean(start.server))
  $('server').value = start.server ? new URL(start.server).host : ''
  $('server').focus()
}

async function open(start) {
  show('setup', false)
  show('unreachable', false)
  const host = new URL(start.server).host
  status(`Connecting to ${host}…`)
  if (start.visited || (await reachable(start.server))) return invoke('open_server')
  status('')
  $('unreachable-text').textContent = `${host} does not answer. Check the connection, or the address.`
  show('unreachable')
}

const start = await invoke('startup')
$('version').textContent = `Vasta ${start.version}`

$('setup').addEventListener('submit', async (event) => {
  event.preventDefault()
  const button = event.submitter
  show('error', false)
  button.disabled = true
  try {
    const server = await invoke('connect', { server: $('server').value })
    if (!(await reachable(server))) throw new Error(`No server answered at ${new URL(server).host}.`)
    Object.assign(start, { server, visited: false })
    await invoke('open_server')
  } catch (error) {
    $('error').textContent = String(error?.message ?? error)
    show('error')
  } finally {
    button.disabled = false
  }
})
$('cancel').addEventListener('click', () => open(start))
$('change').addEventListener('click', () => showSetup(start))
$('retry').addEventListener('click', () => open({ ...start, visited: false }))

if (!start.server || new URLSearchParams(location.search).has('setup')) showSetup(start)
else open(start)
