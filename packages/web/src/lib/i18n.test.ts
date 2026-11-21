import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { en } from '../locales/en.ts'
import { es } from '../locales/es.ts'
import { ja } from '../locales/ja.ts'
import { ptBR } from '../locales/pt-BR.ts'
import { zhCN } from '../locales/zh-CN.ts'

const key = 'vasta.language'

function storage(value?: string) {
  const data = new Map(value === undefined ? [] : [[key, value]])
  return {
    getItem: (name: string) => data.get(name) ?? null,
    setItem: (name: string, text: string) => { data.set(name, text) },
    removeItem: (name: string) => { data.delete(name) },
    data,
  }
}

async function load(saved: unknown, languages: string[] = ['en-US']) {
  vi.resetModules()
  vi.stubGlobal('localStorage', saved)
  vi.stubGlobal('navigator', { language: languages[0] ?? 'en', languages })
  return import('./i18n.ts')
}

afterEach(() => vi.unstubAllGlobals())

describe('i18n catalog parity', () => {
  const catalogs = [
    ['pt-BR', ptBR],
    ['es', es],
    ['zh-CN', zhCN],
    ['ja', ja],
  ] as const
  const enKeys = Object.keys(en).sort()
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort()

  it.each(catalogs)('%s has the exact same keys, non-empty strings, and matching placeholders as en', (_name, messages) => {
    expect(Object.keys(messages).sort()).toEqual(enKeys)
    for (const k of enKeys as (keyof typeof en)[]) {
      expect(messages[k].trim(), `${k} should not be empty`).not.toBe('')
      expect(placeholders(messages[k]), `placeholders of ${k}`).toEqual(placeholders(en[k]))
    }
  })
})

describe('i18n runtime', () => {
  it('detects browser locale and falls back to English for unsupported languages', async () => {
    const mod = await load(storage(), ['pt-BR'])
    expect(mod.detectLocale(['pt-BR'])).toBe('pt-BR')
    expect(mod.detectLocale(['pt-PT'])).toBe('pt-BR')
    expect(mod.detectLocale(['es-AR'])).toBe('es')
    expect(mod.detectLocale(['zh-Hans-CN'])).toBe('zh-CN')
    expect(mod.detectLocale(['ja-JP'])).toBe('ja')
    expect(mod.detectLocale(['fr-FR', 'pt'])).toBe('pt-BR')
    expect(mod.detectLocale(['de-DE'])).toBe('en')
    expect(mod.locale.value).toBe('pt-BR')
  })

  it('defaults to Auto for missing or invalid storage, persists explicit choices, and clears on Auto', async () => {
    const saved = storage('bogus')
    const mod = await load(saved, ['en-US'])
    expect(mod.language.value).toBe('auto')
    expect(mod.locale.value).toBe('en')

    mod.language.value = 'pt-BR'
    await nextTick()
    expect(saved.data.get(key)).toBe('pt-BR')
    expect(mod.locale.value).toBe('pt-BR')

    mod.language.value = 'auto'
    await nextTick()
    expect(saved.data.has(key)).toBe(false)
    expect(mod.locale.value).toBe('en')
  })

  it('works when storage throws', async () => {
    const denied = () => { throw new Error('storage denied') }
    const mod = await load({ getItem: denied, setItem: denied, removeItem: denied }, ['en-US'])
    expect(mod.language.value).toBe('auto')
    mod.language.value = 'pt-BR'
    await nextTick()
    expect(mod.locale.value).toBe('pt-BR')
  })

  it('interpolates parameters and handles singular/plural', async () => {
    const mod = await load(storage('pt-BR'), ['en-US'])
    await mod.installI18n()
    expect(mod.t('nav.searchShortcut', { keys: '⌘K' })).toBe('Buscar (⌘K)')
    expect(mod.tc(1, 'trash.emptyMessage.one', 'trash.emptyMessage.other')).toBe('1 item será apagado para sempre. Isso não pode ser desfeito.')
    expect(mod.tc(4, 'trash.emptyMessage.one', 'trash.emptyMessage.other')).toBe('4 itens serão apagados para sempre. Isso não pode ser desfeito.')
  })

  it('translates built-in types, properties and options only when still using their English default', async () => {
    const mod = await load(storage('pt-BR'), ['en-US'])
    await mod.installI18n()
    expect(mod.typeName({ system: 'task', name: 'Task' })).toBe('Tarefa')
    expect(mod.typePluralName({ system: 'task', pluralName: 'Tasks' })).toBe('Tarefas')
    // User renamed Sprint to Rodada -> preserved untouched!
    expect(mod.typeName({ system: 'sprint', name: 'Rodada' })).toBe('Rodada')
    expect(mod.typePluralName({ system: 'sprint', pluralName: 'Rodadas' })).toBe('Rodadas')
    // Custom type -> preserved untouched!
    expect(mod.typeName({ name: 'Book' })).toBe('Book')

    expect(mod.propName({ id: 'due', name: 'Due' })).toBe('Prazo')
    expect(mod.propName({ id: 'due', name: 'Entrega' })).toBe('Entrega')
    expect(mod.optionLabel('status', { id: 'doing', label: 'In progress' })).toBe('Em andamento')
    expect(mod.optionLabel('status', { id: 'doing', label: 'Fazendo' })).toBe('Fazendo')
  })
})
