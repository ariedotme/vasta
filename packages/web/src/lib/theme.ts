// Light, dark, or the OS setting (the default): `.dark` on <html>, and the browser's toolbar color
// to match; and how type icons look. The choices are per device (localStorage), like the sidebar's.
import { ref, watch } from 'vue'

export type Theme = 'system' | 'light' | 'dark'

const THEME_KEY = 'vasta.theme'
const COLORS = { light: '#f7f6f3', dark: '#16181b' }

function stored(): Theme {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

export const theme = ref<Theme>(stored())

const osDark = window.matchMedia('(prefers-color-scheme: dark)')

function apply() {
  const dark = theme.value === 'dark' || (theme.value === 'system' && osDark.matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  // One meta tag for the chosen theme instead of index.html's pair, which follows the OS.
  for (const meta of document.querySelectorAll('meta[name=theme-color]')) {
    meta.removeAttribute('media')
    meta.setAttribute('content', dark ? COLORS.dark : COLORS.light)
  }
}

export function installTheme() {
  apply()
  osDark.addEventListener('change', apply)
  watch(theme, (value) => {
    try {
      if (value === 'system') localStorage.removeItem(THEME_KEY)
      else localStorage.setItem(THEME_KEY, value)
    } catch {}
    apply()
  })
}

/** System → light → dark → system. */
export function cycleTheme() {
  theme.value = theme.value === 'system' ? 'light' : theme.value === 'light' ? 'dark' : 'system'
}

// Type icons: in a rounded square tinted with the type's color (the default, as in Capacities), or
// bare in that color.
export type IconStyle = 'boxed' | 'plain'
const ICON_STYLE_KEY = 'vasta.type-icons'

function storedIconStyle(): IconStyle {
  try {
    return localStorage.getItem(ICON_STYLE_KEY) === 'plain' ? 'plain' : 'boxed'
  } catch {
    return 'boxed'
  }
}

export const iconStyle = ref<IconStyle>(storedIconStyle())
watch(iconStyle, (value) => {
  try {
    if (value === 'boxed') localStorage.removeItem(ICON_STYLE_KEY)
    else localStorage.setItem(ICON_STYLE_KEY, value)
  } catch {}
})

export const THEME_LABELS: Record<Theme, string> = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' }
export const THEME_ICONS: Record<Theme, string> = { system: 'ph:circle-half', light: 'ph:sun', dark: 'ph:moon' }
