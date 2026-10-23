// The bundled start page: choose where the notes live (a Vasta server, or one the app runs on this
// computer), then hand over to it. Once a server's web app has loaded here, it opens even when the
// server does not answer (its service worker starts it offline); before that, a server that does not
// answer gets a message and Try again. The server on this computer is started from here on every
// launch (use_local).
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
  $('status-text').textContent = text
  show('status', Boolean(text))
}

function showChoose(start) {
  status('')
  show('unreachable', false)
  show('choose')
  show('cancel', Boolean(start.server || start.local))
  $('server').value = start.server ? new URL(start.server).host : ''
}

function unreachable(text, change) {
  status('')
  $('unreachable-text').textContent = text
  $('change').textContent = change
  show('unreachable')
}

async function open(start) {
  show('choose', false)
  show('unreachable', false)
  const host = new URL(start.server).host
  status(`Connecting to ${host}…`)
  if (start.visited || (await reachable(start.server))) return invoke('open_server')
  unreachable(`${host} does not answer. Check the connection, or the address.`, 'Change server')
}

async function openLocal() {
  show('choose', false)
  show('unreachable', false)
  status('Starting Vasta…')
  try {
    await invoke('use_local')
    await invoke('open_server')
  } catch (error) {
    unreachable(String(error?.message ?? error), 'Use a server instead')
  }
}

const start = await invoke('startup')
$('version').textContent = `Vasta ${start.version}`
if (start.dataDir) {
  $('data-dir').textContent = start.dataDir
  show('data-dir-wrap')
}

$('use-local').addEventListener('click', () => {
  start.local = true
  openLocal()
})
$('setup').addEventListener('submit', async (event) => {
  event.preventDefault()
  const button = event.submitter
  show('error', false)
  button.disabled = true
  try {
    const server = await invoke('connect', { server: $('server').value })
    if (!(await reachable(server))) throw new Error(`No server answered at ${new URL(server).host}.`)
    Object.assign(start, { server, local: false, visited: false })
    await invoke('open_server')
  } catch (error) {
    $('error').textContent = String(error?.message ?? error)
    show('error')
  } finally {
    button.disabled = false
  }
})
$('cancel').addEventListener('click', () => (start.local ? openLocal() : open(start)))
$('change').addEventListener('click', () => showChoose(start))
$('retry').addEventListener('click', () => (start.local ? openLocal() : open({ ...start, visited: false })))

if (new URLSearchParams(location.search).has('setup') || !(start.server || start.local)) showChoose(start)
else if (start.local) openLocal()
else open(start)
