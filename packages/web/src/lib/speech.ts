// Listening to the user say a text out loud (insistent reminders answered by saying their text,
// views/RemindView.vue), with the browser's speech recognition: Chrome, Edge and Safari (macOS and
// iOS) have it, Firefox does not. The desktop app offers it only when it says it can (its
// window needs the microphone and speech recognition permissions declared, or macOS stops it).
import { locale, t } from './i18n.ts'

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
  if (!recognitionClass()) return t('reminders.speech.noBrowser')
  const desktop = window.__VASTA_DESKTOP__
  if (desktop && !desktop.speech) return t('reminders.speech.noDesktop')
  return undefined
}

/** The language to listen in: the text's, guessed from its letters, else the app/browser locale. */
export function speechLanguage(text: string): string {
  const fallback = locale.value || navigator.language || 'en-US'
  if (/[\u3040-\u30ff]/.test(text)) return 'ja-JP'
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh-CN'
  if (/[ãõç]|ção\b|\bvocê\b|\bnão\b/i.test(text)) return fallback.startsWith('pt') ? fallback : 'pt-BR'
  if (/[ñ¿¡]/.test(text)) return fallback.startsWith('es') ? fallback : 'es-ES'
  return fallback
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
    ended(t('reminders.speech.unavailable'))
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
    ended(event.error === 'not-allowed' || event.error === 'service-not-allowed' ? t('reminders.speech.micDenied') : t('reminders.speech.failed', { error: event.error }))
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
