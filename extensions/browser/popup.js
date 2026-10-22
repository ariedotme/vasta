import { isWebPage, saveWeblink, settings } from './vasta.js'

const $ = (id) => document.getElementById(id)
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
const status = (text, kind = '') => Object.assign($('status'), { textContent: text, className: kind })

$('title').textContent = tab?.title ?? ''
$('url').textContent = tab?.url ?? ''
$('options').addEventListener('click', (event) => (event.preventDefault(), chrome.runtime.openOptionsPage()))

const { server, token } = await settings()
if (!server || !token) {
  $('save').disabled = true
  status('Set the Vasta address and capture token in the options first.', 'error')
} else if (!isWebPage(tab?.url)) {
  $('save').disabled = true
  status('Only web pages can be saved.')
} else {
  $('note').focus()
}

$('form').addEventListener('submit', async (event) => {
  event.preventDefault()
  $('save').disabled = true
  status('Saving…')
  try {
    const saved = await saveWeblink({ url: tab.url, title: tab.title, note: $('note').value.trim() })
    status('')
    const link = Object.assign(document.createElement('a'), { href: saved.openUrl, target: '_blank', textContent: 'Open in Vasta' })
    $('status').append('Saved. ', link)
    $('status').className = 'ok'
  } catch (error) {
    status(error.message, 'error')
    $('save').disabled = false
  }
})

// ⌘/Ctrl+Enter saves from the note field.
$('note').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) $('form').requestSubmit()
})
