// How wide a page's text column may grow: Standard (the default), Wide or Full width. The choice is
// per device (localStorage), like the theme, and read by object pages and the calendar's day.
import { ref, watch } from 'vue'

export type PageWidth = 'standard' | 'wide' | 'full'

const PAGE_WIDTH_KEY = 'vasta.page-width'

function stored(): PageWidth {
  try {
    const value = localStorage.getItem(PAGE_WIDTH_KEY)
    return value === 'wide' || value === 'full' ? value : 'standard'
  } catch {
    return 'standard'
  }
}

export const pageWidth = ref<PageWidth>(stored())

watch(pageWidth, (value) => {
  try {
    if (value === 'standard') localStorage.removeItem(PAGE_WIDTH_KEY)
    else localStorage.setItem(PAGE_WIDTH_KEY, value)
  } catch {}
})

/** The max-width class per choice: text pages, and pages built with columns, which need room. */
export const PAGE_WIDTH_CLASSES: Record<PageWidth, { prose: string; columns: string }> = {
  standard: { prose: 'max-w-3xl', columns: 'max-w-6xl' },
  wide: { prose: 'max-w-6xl', columns: 'max-w-6xl' },
  full: { prose: 'max-w-none', columns: 'max-w-none' },
}

export function pageWidthClass(columns: boolean): string {
  return PAGE_WIDTH_CLASSES[pageWidth.value][columns ? 'columns' : 'prose']
}

export const PAGE_WIDTH_OPTIONS: { value: PageWidth; label: string }[] = [
  { value: 'standard', label: 'Standard' },
  { value: 'wide', label: 'Wide' },
  { value: 'full', label: 'Full width' },
]
