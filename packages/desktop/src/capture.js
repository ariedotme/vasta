// The floating quick capture panel (main.rs, open_capture): the text goes to the web app in the
// main window, hidden or not, which captures it as its own Quick capture dialog does (capture
// space, offline through the replica) and reports back; the app then hides this panel. Esc hides
// it and keeps the draft. While typing, the web app also says what to offer at the cursor ("/"
// lists the types, a relation's `name:` its objects; suggest_capture → capture_suggestions) and
// what a "/Type …" line will make; the panel grows to show the list.
const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args)
const field = document.getElementById('text')
const error = document.getElementById('error')
const list = document.getElementById('list')
const preview = document.getElementById('preview')
const hint = document.getElementById('hint')
const BASE_HEIGHT = 168
let waiting = null
let items = []
let active = 0
let seq = 0
let asked = { text: null, cursor: null }
let height = BASE_HEIGHT

/** Ask the web app what to offer, once per text and cursor position. */
function suggest() {
  const text = field.value
  const cursor = field.selectionStart
  if (asked.text === text && asked.cursor === cursor) return
  asked = { text, cursor }
  invoke('suggest_capture', { text, cursor, seq: ++seq }).catch(() => {})
}

function render() {
  list.replaceChildren(
    ...items.map((item, i) => {
      const row = document.createElement('li')
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(i === active))
      const emoji = document.createElement('span')
      emoji.className = 'emoji'
      emoji.textContent = item.emoji ?? ''
      const label = document.createElement('span')
      label.className = 'label'
      label.textContent = item.label
      row.append(emoji, label)
      if (item.detail) {
        const detail = document.createElement('span')
        detail.className = 'detail'
        detail.textContent = item.detail
        row.append(detail)
      }
      row.addEventListener('mousedown', (event) => {
        event.preventDefault()
        pick(item)
      })
      row.addEventListener('mouseenter', () => {
        active = i
        render()
      })
      return row
    })
  )
  list.hidden = !items.length
  fit()
}

/** Grow to show the list (the card fills the window), or go back. */
function fit() {
  const wanted = Math.ceil(BASE_HEIGHT + (items.length ? list.offsetHeight + 4 : 0))
  if (wanted === height) return
  height = wanted
  invoke('fit_capture', { height }).catch(() => {})
}

function showPreview(text, problem) {
  preview.textContent = problem || text || ''
  preview.className = problem ? 'problem' : ''
  preview.hidden = !preview.textContent
  hint.hidden = !preview.hidden
}

function pick(item) {
  field.value = item.text
  field.focus()
  field.setSelectionRange(item.cursor, item.cursor)
  items = []
  render()
  suggest()
}

function clearSuggestions() {
  items = []
  render()
  showPreview(null, null)
  asked = { text: null, cursor: null }
}

function done() {
  clearTimeout(waiting)
  waiting = null
  field.disabled = false
}

function fail(message) {
  done()
  error.textContent = message
  error.hidden = false
  field.focus()
}

async function save() {
  const text = field.value
  if (!text.trim() || waiting) return
  error.hidden = true
  field.disabled = true
  waiting = setTimeout(() => fail('Vasta did not answer. Open it and try again.'), 8000)
  try {
    await invoke('submit_capture', { text })
  } catch (failure) {
    fail(String(failure?.message ?? failure))
  }
}

field.addEventListener('keydown', (event) => {
  if (items.length && !event.isComposing) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      active = (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      render()
      return
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
      event.preventDefault()
      pick(items[active])
      return
    }
    if (event.key === 'Escape') {
      // Puts the list away; the next Esc closes the panel.
      event.preventDefault()
      items = []
      render()
      return
    }
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void save()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    void invoke('close_capture')
  }
})

field.addEventListener('input', suggest)
field.addEventListener('keyup', suggest)
field.addEventListener('click', suggest)

// From the app: suggestions, shown again, saved, or refused by the web app.
window.addEventListener('vasta:capture-suggestions', (event) => {
  const answer = event.detail
  if (answer.seq !== seq) return
  items = answer.items ?? []
  active = 0
  render()
  showPreview(answer.preview, answer.problem)
})
window.addEventListener('vasta:open', () => {
  error.hidden = true
  field.focus()
  field.setSelectionRange(field.value.length, field.value.length)
})
window.addEventListener('vasta:capture-saved', () => {
  done()
  field.value = ''
  clearSuggestions()
})
window.addEventListener('vasta:capture-failed', (event) => fail(event.detail || 'The capture failed.'))
