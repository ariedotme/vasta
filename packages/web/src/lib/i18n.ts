// Internationalization (handoffs/handoff-i18n.md): per-device language choice (`localStorage`,
// defaulting to the browser/OS language with fallback to English), lazy-loaded locale catalogs,
// and display-only translation of built-in types, properties and select options when still using
// their English default names.
import { computed, ref, shallowRef, watch } from 'vue'
import type { ObjectType, PropertyDef, SystemTypeKey } from '@vasta/core'
import { en, type MessageKey, type Messages } from '../locales/en.ts'

export type { MessageKey, Messages }

/** Supported locales of Vasta. */
export type Locale = 'en' | 'pt-BR' | 'es' | 'zh-CN' | 'ja'
export type LanguageChoice = 'auto' | Locale

export const LANGUAGE_KEY = 'vasta.language'

/** Native display names (always shown in their own script so anyone can find their language). */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  'pt-BR': 'Português',
  es: 'Español',
  'zh-CN': '简体中文',
  ja: '日本語',
}

/** Lazy loaders for non-English catalogs that are ready to use. */
const LOADERS: Partial<Record<Locale, () => Promise<Messages>>> = {
  'pt-BR': () => import('../locales/pt-BR.ts').then((m) => m.ptBR),
  es: () => import('../locales/es.ts').then((m) => m.es),
  'zh-CN': () => import('../locales/zh-CN.ts').then((m) => m.zhCN),
  ja: () => import('../locales/ja.ts').then((m) => m.ja),
}

/** Locales currently available in the UI (English + every locale with a catalog). */
export const AVAILABLE_LOCALES: Locale[] = ['en', ...(Object.keys(LOADERS) as Locale[])]

/** Map browser language preferences to the best matching supported locale. */
export function detectLocale(languages?: readonly string[]): Locale {
  const list = languages ?? (typeof navigator !== 'undefined' ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [])
  for (const raw of list) {
    const tag = raw.toLowerCase().trim()
    if (!tag) continue
    const match: Locale | undefined =
      tag === 'pt' || tag.startsWith('pt-') ? 'pt-BR'
      : tag === 'es' || tag.startsWith('es-') ? 'es'
      : tag === 'zh' || tag.startsWith('zh-') ? 'zh-CN'
      : tag === 'ja' || tag.startsWith('ja-') ? 'ja'
      : tag === 'en' || tag.startsWith('en-') ? 'en'
      : undefined
    if (match && AVAILABLE_LOCALES.includes(match)) return match
  }
  return 'en'
}

function storedChoice(): LanguageChoice {
  try {
    const value = localStorage.getItem(LANGUAGE_KEY) as Locale | null
    return value && AVAILABLE_LOCALES.includes(value) ? value : 'auto'
  } catch {
    return 'auto'
  }
}

export const detectedLocale = ref<Locale>(detectLocale())
export const language = ref<LanguageChoice>(storedChoice())
export const locale = computed<Locale>(() => (language.value === 'auto' ? detectedLocale.value : language.value))

const cache = new Map<Locale, Messages>([['en', en]])
const loaded = shallowRef<Messages>(en)
let loadSeq = 0

async function loadLocale(target: Locale): Promise<void> {
  const seq = ++loadSeq
  const cached = cache.get(target)
  if (cached) {
    loaded.value = cached
    return
  }
  const loader = LOADERS[target]
  if (!loader) {
    loaded.value = en
    return
  }
  try {
    const messages = await loader()
    cache.set(target, messages)
    if (seq === loadSeq) loaded.value = messages
  } catch {
    if (seq === loadSeq) loaded.value = en
  }
}

watch(language, (value) => {
  try {
    if (value === 'auto') localStorage.removeItem(LANGUAGE_KEY)
    else localStorage.setItem(LANGUAGE_KEY, value)
  } catch {}
})

watch(
  locale,
  (target) => {
    if (typeof document !== 'undefined') document.documentElement.lang = target
    void loadLocale(target)
  },
  { immediate: true }
)

/** Call at app startup so `<html lang>` and the active catalog initialize immediately. */
export function installI18n(): Promise<void> {
  detectedLocale.value = detectLocale()
  if (typeof document !== 'undefined') document.documentElement.lang = locale.value
  return loadLocale(locale.value)
}

/** Translate `key` in the active locale, interpolating `{name}` placeholders. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = loaded.value[key] ?? en[key]
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
}

/** Singular / plural translation helper. */
export function tc(count: number, one: MessageKey, other: MessageKey, params?: Record<string, string | number>): string {
  return t(count === 1 ? one : other, { count, ...params })
}

// ---------------------------------------------------------------------------
// Display-only translation for built-in types, properties and select options.
// Translates ONLY when the stored string still equals the English built-in
// default, so any user rename is always preserved untouched.

const BUILTIN_TYPE_KEYS: Record<SystemTypeKey, { one: MessageKey; other: MessageKey }> = {
  page: { one: 'builtin.type.page.one', other: 'builtin.type.page.other' },
  'daily-note': { one: 'builtin.type.daily-note.one', other: 'builtin.type.daily-note.other' },
  tag: { one: 'builtin.type.tag.one', other: 'builtin.type.tag.other' },
  collection: { one: 'builtin.type.collection.one', other: 'builtin.type.collection.other' },
  query: { one: 'builtin.type.query.one', other: 'builtin.type.query.other' },
  task: { one: 'builtin.type.task.one', other: 'builtin.type.task.other' },
  weblink: { one: 'builtin.type.weblink.one', other: 'builtin.type.weblink.other' },
  date: { one: 'builtin.type.date.one', other: 'builtin.type.date.other' },
  image: { one: 'builtin.type.image.one', other: 'builtin.type.image.other' },
  pdf: { one: 'builtin.type.pdf.one', other: 'builtin.type.pdf.other' },
  audio: { one: 'builtin.type.audio.one', other: 'builtin.type.audio.other' },
  video: { one: 'builtin.type.video.one', other: 'builtin.type.video.other' },
  file: { one: 'builtin.type.file.one', other: 'builtin.type.file.other' },
  habit: { one: 'builtin.type.habit.one', other: 'builtin.type.habit.other' },
  whiteboard: { one: 'builtin.type.whiteboard.one', other: 'builtin.type.whiteboard.other' },
  quote: { one: 'builtin.type.quote.one', other: 'builtin.type.quote.other' },
  food: { one: 'builtin.type.food.one', other: 'builtin.type.food.other' },
  recipe: { one: 'builtin.type.recipe.one', other: 'builtin.type.recipe.other' },
  sprint: { one: 'builtin.type.sprint.one', other: 'builtin.type.sprint.other' },
  'nutrition-goal': { one: 'builtin.type.nutrition-goal.one', other: 'builtin.type.nutrition-goal.other' },
}

const BUILTIN_PROP_KEYS: Record<string, MessageKey> = {
  body: 'builtin.prop.body',
  status: 'builtin.prop.status',
  due: 'builtin.prop.due',
  assignee: 'builtin.prop.assignee',
  priority: 'builtin.prop.priority',
  blocked: 'builtin.prop.blocked',
  article: 'builtin.prop.article',
  days: 'builtin.prop.days',
  target: 'builtin.prop.target',
  unit: 'builtin.prop.unit',
  remind: 'builtin.prop.remind',
  paused: 'builtin.prop.paused',
  source: 'builtin.prop.source',
  kcal: 'builtin.prop.kcal',
  protein: 'builtin.prop.protein',
  carbs: 'builtin.prop.carbs',
  fat: 'builtin.prop.fat',
  fiber: 'builtin.prop.fiber',
  brand: 'builtin.prop.brand',
  yield: 'builtin.prop.yield',
  servings: 'builtin.prop.servings',
  dates: 'builtin.prop.dates',
  goal: 'builtin.prop.goal',
  'protein-pct': 'builtin.prop.protein-pct',
  'carbs-pct': 'builtin.prop.carbs-pct',
  'fat-pct': 'builtin.prop.fat-pct',
  weekly: 'builtin.prop.weekly',
}

const BUILTIN_OPT_KEYS: Record<string, MessageKey> = {
  'status:todo': 'builtin.opt.status.todo',
  'status:doing': 'builtin.opt.status.doing',
  'status:done': 'builtin.opt.status.done',
  'priority:high': 'builtin.opt.priority.high',
  'priority:medium': 'builtin.opt.priority.medium',
  'priority:low': 'builtin.opt.priority.low',
  'days:mon': 'builtin.opt.days.mon',
  'days:tue': 'builtin.opt.days.tue',
  'days:wed': 'builtin.opt.days.wed',
  'days:thu': 'builtin.opt.days.thu',
  'days:fri': 'builtin.opt.days.fri',
  'days:sat': 'builtin.opt.days.sat',
  'days:sun': 'builtin.opt.days.sun',
}

/** Display name (singular) of a type: translated only if it is a built-in still using its English default. */
export function typeName(type: Pick<ObjectType, 'system' | 'name'> | undefined): string {
  if (!type) return ''
  const key = type.system ? BUILTIN_TYPE_KEYS[type.system]?.one : undefined
  return key && type.name === en[key] ? t(key) : type.name
}

/** Display name (plural) of a type: translated only if it is a built-in still using its English default. */
export function typePluralName(type: Pick<ObjectType, 'system' | 'pluralName'> | undefined): string {
  if (!type) return ''
  const key = type.system ? BUILTIN_TYPE_KEYS[type.system]?.other : undefined
  return key && type.pluralName === en[key] ? t(key) : type.pluralName
}

/** Display name of a property: translated only if it still uses its English built-in default. */
export function propName(def: Pick<PropertyDef, 'id' | 'name'> | undefined): string {
  if (!def) return ''
  const key = BUILTIN_PROP_KEYS[def.id]
  return key && def.name === en[key] ? t(key) : def.name
}

/** Display label of a select option: translated only if it still uses its English built-in default. */
export function optionLabel(propId: string, opt: { id: string; label: string }): string {
  const key = BUILTIN_OPT_KEYS[`${propId}:${opt.id}`]
  return key && opt.label === en[key] ? t(key) : opt.label
}
