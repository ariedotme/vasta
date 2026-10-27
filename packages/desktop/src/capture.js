// The floating quick capture panel (main.rs, open_capture): the text goes to the web app in the
// main window, hidden or not, which captures it as its own Quick capture dialog does (capture
// space, offline through the replica) and reports back; the app then hides this panel. Esc hides
// it and keeps the draft; Ctrl+Enter (on macOS too) saves and opens what it made in the main window. While typing, the web app also says what to offer at the cursor ("/"
// lists the types, a relation's `name:` its objects; suggest_capture → capture_suggestions) and
// what a "/Type …" line will make; the panel grows to show the list. When quick capture asks a
// template's questions (Settings › Desktop app), the web app answers a submit with them
// (capture_questions → vasta:capture-asks): the panel shows them in place of the text and submits
// again with the answers; Esc goes back to the text.
const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args)
const field = document.getElementById('text')
const error = document.getElementById('error')
const list = document.getElementById('list')
const preview = document.getElementById('preview')
const hint = document.getElementById('hint')
const openHint = document.getElementById('open-hint')
const questions = document.getElementById('questions')
const footer = document.querySelector('footer')
const BASE_HEIGHT = 168
let waiting = null
let items = []
let active = 0
let seq = 0
let asked = { text: null, cursor: null }
let height = BASE_HEIGHT
/** The questions shown, and their answers by question; null while typing the text. */
let asking = null
let answers = {}

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
  // The body's padding and the card's border around the questions and the footer.
  const wanted = asking ? Math.ceil(questions.offsetHeight + footer.offsetHeight + 38) : Math.ceil(BASE_HEIGHT + (items.length ? list.offsetHeight + 4 : 0))
  if (wanted === height) return
  height = wanted
  invoke('fit_capture', { height }).catch(() => {})
}

function showPreview(text, problem) {
  preview.textContent = problem || text || ''
  preview.className = problem ? 'problem' : ''
  preview.hidden = !preview.textContent
  hint.hidden = !preview.hidden
  openHint.hidden = preview.hidden
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
  if (asking) questions.querySelector('input, button[aria-checked="true"]')?.focus()
  else field.focus()
}

/** Show the template's questions in place of the text, the first answer of each choice picked. */
function ask(asks) {
  done()
  asking = asks
  answers = Object.fromEntries(asks.map((a) => [a.label, a.options?.[0] ?? '']))
  const line = document.createElement('p')
  line.className = 'line'
  line.textContent = field.value.split('\n')[0]
  questions.replaceChildren(
    line,
    ...asks.map((a) => {
      const row = document.createElement('div')
      row.className = 'ask'
      const label = document.createElement('span')
      label.className = 'label'
      label.textContent = a.label
      row.append(label)
      if (a.options?.length) {
        const options = document.createElement('div')
        options.className = 'options'
        options.setAttribute('role', 'radiogroup')
        options.setAttribute('aria-label', a.label)
        const buttons = a.options.map((option) => {
          const button = document.createElement('button')
          button.type = 'button'
          button.setAttribute('role', 'radio')
          button.textContent = option
          button.addEventListener('click', () => choose(option))
          return button
        })
        const choose = (option) => {
          answers[a.label] = option
          for (const b of buttons) b.setAttribute('aria-checked', String(b.textContent === option))
        }
        // Left and right move between the answers, as a radio group does.
        options.addEventListener('keydown', (event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          const at = buttons.indexOf(document.activeElement)
          const next = buttons[(at + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]
          next.focus()
          choose(next.textContent)
        })
        choose(answers[a.label])
        options.append(...buttons)
        row.append(options)
      } else {
        const input = document.createElement('input')
        input.addEventListener('input', () => (answers[a.label] = input.value))
        row.append(input)
      }
      return row
    })
  )
  field.hidden = true
  items = []
  list.hidden = true
  questions.hidden = false
  showPreview('Enter saves · Esc goes back to the text', null)
  fit()
  questions.querySelector('input, button[aria-checked="true"]')?.focus()
}

function backToText() {
  asking = null
  answers = {}
  questions.hidden = true
  questions.replaceChildren()
  field.hidden = false
  showPreview(null, null)
  fit()
  field.focus()
}

async function save(open = false) {
  const text = field.value
  if (!text.trim() || waiting) return
  error.hidden = true
  field.disabled = true
  waiting = setTimeout(() => fail('Vasta did not answer. Open it and try again.'), 8000)
  try {
    await invoke('submit_capture', { text, open, answers: asking ? answers : null })
  } catch (failure) {
    fail(String(failure?.message ?? failure))
  }
}

field.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.ctrlKey && !event.isComposing) {
    event.preventDefault()
    void save(true)
    return
  }
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

questions.addEventListener('keydown', (event) => {
  if (event.isComposing) return
  if (event.key === 'Enter') {
    event.preventDefault()
    void save(event.ctrlKey)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    backToText()
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
  if (asking) return questions.querySelector('input, button[aria-checked="true"]')?.focus()
  field.focus()
  field.setSelectionRange(field.value.length, field.value.length)
})
window.addEventListener('vasta:capture-saved', () => {
  done()
  if (asking) backToText()
  field.value = ''
  clearSuggestions()
})
window.addEventListener('vasta:capture-asks', (event) => event.detail?.length && ask(event.detail))
window.addEventListener('vasta:capture-failed', (event) => fail(event.detail || 'The capture failed.'))
