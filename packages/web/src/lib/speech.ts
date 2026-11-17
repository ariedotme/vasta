// Listening to the user say a text out loud (insistent reminders answered by saying their text,
// views/RemindView.vue), with the browser's speech recognition: Chrome, Edge and Safari (macOS and
// iOS) have it, Firefox does not. The desktop app offers it only when it says it can (its
// window needs the microphone and speech recognition permissions declared, or macOS stops it).

interface Recognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

type RecognitionClass = new () => Recognition

function recognitionClass(): RecognitionClass | undefined {
  if (typeof window === 'undefined') return undefined
  const w = window as unknown as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

/** Why the user cannot answer by speaking here; undefined when they can. */
export function speechUnavailable(): string | undefined {
  if (!recognitionClass()) return 'This browser does not recognize speech: type it instead.'
  const desktop = window.__VASTA_DESKTOP__
  if (desktop && !desktop.speech) return 'This version of the desktop app does not listen yet: type it instead.'
  return undefined
}

/** The language to listen in: the text's, guessed from its letters, else the browser's. */
export function speechLanguage(text: string): string {
  const browser = navigator.language || 'en-US'
  // Portuguese and Spanish phrases are common in Vasta; their accents give them away.
  if (/[ãõç]|ção\b|\bvocê\b|\bnão\b/i.test(text)) return browser.startsWith('pt') ? browser : 'pt-BR'
  if (/[ñ¿¡]/.test(text)) return browser.startsWith('es') ? browser : 'es-ES'
  return browser
}

export interface Listening {
  stop(): void
}

/**
 * Listen until stopped: `heard` gets what was recognized so far (final and interim words), `ended`
 * when it stops by itself (silence, an error), with the error if any.
 */
export function listen(lang: string, heard: (text: string) => void, ended: (error?: string) => void): Listening {
  const Class = recognitionClass()
  if (!Class) {
    ended('no speech recognition')
    return { stop() {} }
  }
  const recognition = new Class()
  recognition.lang = lang
  recognition.continuous = true
  recognition.interimResults = true
  recognition.maxAlternatives = 1
  let final = ''
  let stopped = false
  recognition.onresult = (event) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]!
      const text = result[0]?.transcript ?? ''
      if (result.isFinal) final += ` ${text}`
      else interim += ` ${text}`
    }
    heard(`${final} ${interim}`.replace(/\s+/g, ' ').trim())
  }
  recognition.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return
    stopped = true
    ended(event.error === 'not-allowed' || event.error === 'service-not-allowed' ? 'The microphone is not allowed here: allow it, or type it instead.' : `Speech recognition failed (${event.error}).`)
  }
  recognition.onend = () => {
    if (!stopped) ended()
    stopped = true
  }
  try {
    recognition.start()
  } catch (error) {
    stopped = true
    ended((error as Error).message)
  }
  return {
    stop() {
      if (stopped) return
      stopped = true
      recognition.stop()
    },
  }
}
