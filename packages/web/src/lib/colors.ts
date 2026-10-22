import type { ColorName } from '@vasta/core'

// Static class strings so Tailwind can see them. Chips: soft background, readable text and a hairline
// border in the same color.
export const chipClasses: Record<ColorName, string> = {
  gray: 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-200 ring-1 ring-inset ring-stone-200 dark:ring-stone-700',
  red: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200 ring-1 ring-inset ring-red-200 dark:ring-red-900',
  orange: 'bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200 ring-1 ring-inset ring-orange-200 dark:ring-orange-900',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200 ring-1 ring-inset ring-amber-200 dark:ring-amber-900',
  yellow: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-200 ring-1 ring-inset ring-yellow-200 dark:ring-yellow-900',
  lime: 'bg-lime-100 text-lime-800 dark:bg-lime-950 dark:text-lime-200 ring-1 ring-inset ring-lime-200 dark:ring-lime-900',
  green: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200 ring-1 ring-inset ring-green-200 dark:ring-green-900',
  emerald: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200 ring-1 ring-inset ring-emerald-200 dark:ring-emerald-900',
  teal: 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200 ring-1 ring-inset ring-teal-200 dark:ring-teal-900',
  cyan: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200 ring-1 ring-inset ring-cyan-200 dark:ring-cyan-900',
  sky: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200 ring-1 ring-inset ring-sky-200 dark:ring-sky-900',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200 ring-1 ring-inset ring-blue-200 dark:ring-blue-900',
  indigo: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200 ring-1 ring-inset ring-indigo-200 dark:ring-indigo-900',
  violet: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200 ring-1 ring-inset ring-violet-200 dark:ring-violet-900',
  purple: 'bg-purple-100 text-purple-800 dark:bg-purple-950 dark:text-purple-200 ring-1 ring-inset ring-purple-200 dark:ring-purple-900',
  fuchsia: 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-950 dark:text-fuchsia-200 ring-1 ring-inset ring-fuchsia-200 dark:ring-fuchsia-900',
  pink: 'bg-pink-100 text-pink-800 dark:bg-pink-950 dark:text-pink-200 ring-1 ring-inset ring-pink-200 dark:ring-pink-900',
  rose: 'bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200 ring-1 ring-inset ring-rose-200 dark:ring-rose-900',
}

/** Background tint for colored groups in documents. */
export const groupClasses: Record<ColorName, string> = {
  gray: 'bg-stone-100/70 dark:bg-stone-800/50',
  red: 'bg-red-50 dark:bg-red-950/40',
  orange: 'bg-orange-50 dark:bg-orange-950/40',
  amber: 'bg-amber-50 dark:bg-amber-950/40',
  yellow: 'bg-yellow-50 dark:bg-yellow-950/40',
  lime: 'bg-lime-50 dark:bg-lime-950/40',
  green: 'bg-green-50 dark:bg-green-950/40',
  emerald: 'bg-emerald-50 dark:bg-emerald-950/40',
  teal: 'bg-teal-50 dark:bg-teal-950/40',
  cyan: 'bg-cyan-50 dark:bg-cyan-950/40',
  sky: 'bg-sky-50 dark:bg-sky-950/40',
  blue: 'bg-blue-50 dark:bg-blue-950/40',
  indigo: 'bg-indigo-50 dark:bg-indigo-950/40',
  violet: 'bg-violet-50 dark:bg-violet-950/40',
  purple: 'bg-purple-50 dark:bg-purple-950/40',
  fuchsia: 'bg-fuchsia-50 dark:bg-fuchsia-950/40',
  pink: 'bg-pink-50 dark:bg-pink-950/40',
  rose: 'bg-rose-50 dark:bg-rose-950/40',
}

/** Text highlight marks. */
export const highlightClasses: Record<ColorName, string> = {
  gray: 'bg-stone-200 dark:bg-stone-700',
  red: 'bg-red-200 dark:bg-red-900',
  orange: 'bg-orange-200 dark:bg-orange-900',
  amber: 'bg-amber-200 dark:bg-amber-900',
  yellow: 'bg-yellow-200 dark:bg-yellow-900',
  lime: 'bg-lime-200 dark:bg-lime-900',
  green: 'bg-green-200 dark:bg-green-900',
  emerald: 'bg-emerald-200 dark:bg-emerald-900',
  teal: 'bg-teal-200 dark:bg-teal-900',
  cyan: 'bg-cyan-200 dark:bg-cyan-900',
  sky: 'bg-sky-200 dark:bg-sky-900',
  blue: 'bg-blue-200 dark:bg-blue-900',
  indigo: 'bg-indigo-200 dark:bg-indigo-900',
  violet: 'bg-violet-200 dark:bg-violet-900',
  purple: 'bg-purple-200 dark:bg-purple-900',
  fuchsia: 'bg-fuchsia-200 dark:bg-fuchsia-900',
  pink: 'bg-pink-200 dark:bg-pink-900',
  rose: 'bg-rose-200 dark:bg-rose-900',
}

/** Text color of blocks in documents (the block menu's Color). */
export const blockTextClasses: Record<ColorName, string> = {
  gray: 'text-stone-500 dark:text-stone-400', red: 'text-red-600 dark:text-red-400', orange: 'text-orange-600 dark:text-orange-400',
  amber: 'text-amber-600 dark:text-amber-400', yellow: 'text-yellow-600 dark:text-yellow-400', lime: 'text-lime-600 dark:text-lime-400',
  green: 'text-green-600 dark:text-green-400', emerald: 'text-emerald-600 dark:text-emerald-400', teal: 'text-teal-600 dark:text-teal-400',
  cyan: 'text-cyan-600 dark:text-cyan-400', sky: 'text-sky-600 dark:text-sky-400', blue: 'text-blue-600 dark:text-blue-400',
  indigo: 'text-indigo-600 dark:text-indigo-400', violet: 'text-violet-600 dark:text-violet-400', purple: 'text-purple-600 dark:text-purple-400',
  fuchsia: 'text-fuchsia-600 dark:text-fuchsia-400', pink: 'text-pink-600 dark:text-pink-400', rose: 'text-rose-600 dark:text-rose-400',
}

/** Background of blocks in documents (the block menu's Color): a little stronger than groups, for a single line. */
export const blockBackgroundClasses: Record<ColorName, string> = {
  gray: 'bg-stone-100 dark:bg-stone-900/40', red: 'bg-red-100 dark:bg-red-900/40', orange: 'bg-orange-100 dark:bg-orange-900/40',
  amber: 'bg-amber-100 dark:bg-amber-900/40', yellow: 'bg-yellow-100 dark:bg-yellow-900/40', lime: 'bg-lime-100 dark:bg-lime-900/40',
  green: 'bg-green-100 dark:bg-green-900/40', emerald: 'bg-emerald-100 dark:bg-emerald-900/40', teal: 'bg-teal-100 dark:bg-teal-900/40',
  cyan: 'bg-cyan-100 dark:bg-cyan-900/40', sky: 'bg-sky-100 dark:bg-sky-900/40', blue: 'bg-blue-100 dark:bg-blue-900/40',
  indigo: 'bg-indigo-100 dark:bg-indigo-900/40', violet: 'bg-violet-100 dark:bg-violet-900/40', purple: 'bg-purple-100 dark:bg-purple-900/40',
  fuchsia: 'bg-fuchsia-100 dark:bg-fuchsia-900/40', pink: 'bg-pink-100 dark:bg-pink-900/40', rose: 'bg-rose-100 dark:bg-rose-900/40',
}

/** Icon tint used for type icons. */
export const iconTextClasses: Record<ColorName, string> = {
  gray: 'text-stone-500', red: 'text-red-500', orange: 'text-orange-500', amber: 'text-amber-500',
  yellow: 'text-yellow-500', lime: 'text-lime-600', green: 'text-green-600', emerald: 'text-emerald-600',
  teal: 'text-teal-600', cyan: 'text-cyan-600', sky: 'text-sky-500', blue: 'text-blue-500',
  indigo: 'text-indigo-500', violet: 'text-violet-500', purple: 'text-purple-500', fuchsia: 'text-fuchsia-500',
  pink: 'text-pink-500', rose: 'text-rose-500',
}

/** Type icons in a tinted square (Settings › Appearance). */
export const iconBoxClasses: Record<ColorName, string> = {
  gray: 'bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-300',
  red: 'bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400',
  orange: 'bg-orange-100 text-orange-600 dark:bg-orange-950 dark:text-orange-400',
  amber: 'bg-amber-100 text-amber-600 dark:bg-amber-950 dark:text-amber-400',
  yellow: 'bg-yellow-100 text-yellow-600 dark:bg-yellow-950 dark:text-yellow-400',
  lime: 'bg-lime-100 text-lime-600 dark:bg-lime-950 dark:text-lime-400',
  green: 'bg-green-100 text-green-600 dark:bg-green-950 dark:text-green-400',
  emerald: 'bg-emerald-100 text-emerald-600 dark:bg-emerald-950 dark:text-emerald-400',
  teal: 'bg-teal-100 text-teal-600 dark:bg-teal-950 dark:text-teal-400',
  cyan: 'bg-cyan-100 text-cyan-600 dark:bg-cyan-950 dark:text-cyan-400',
  sky: 'bg-sky-100 text-sky-600 dark:bg-sky-950 dark:text-sky-400',
  blue: 'bg-blue-100 text-blue-600 dark:bg-blue-950 dark:text-blue-400',
  indigo: 'bg-indigo-100 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400',
  violet: 'bg-violet-100 text-violet-600 dark:bg-violet-950 dark:text-violet-400',
  purple: 'bg-purple-100 text-purple-600 dark:bg-purple-950 dark:text-purple-400',
  fuchsia: 'bg-fuchsia-100 text-fuchsia-600 dark:bg-fuchsia-950 dark:text-fuchsia-400',
  pink: 'bg-pink-100 text-pink-600 dark:bg-pink-950 dark:text-pink-400',
  rose: 'bg-rose-100 text-rose-600 dark:bg-rose-950 dark:text-rose-400',
}

/** Solid swatches for color pickers. */
export const swatchClasses: Record<ColorName, string> = {
  gray: 'bg-stone-400', red: 'bg-red-400', orange: 'bg-orange-400', amber: 'bg-amber-400', yellow: 'bg-yellow-400',
  lime: 'bg-lime-400', green: 'bg-green-400', emerald: 'bg-emerald-400', teal: 'bg-teal-400', cyan: 'bg-cyan-400',
  sky: 'bg-sky-400', blue: 'bg-blue-400', indigo: 'bg-indigo-400', violet: 'bg-violet-400', purple: 'bg-purple-400',
  fuchsia: 'bg-fuchsia-400', pink: 'bg-pink-400', rose: 'bg-rose-400',
}

export const colorNames = Object.keys(chipClasses) as ColorName[]

export const chip = (color: ColorName | undefined) => chipClasses[color ?? 'gray']
