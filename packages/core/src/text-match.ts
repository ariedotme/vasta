// Text typed or said back, compared with the text it should be (insistent reminders answered by
// typing or saying their text: server/src/insistent.ts, and the page that listens, web RemindView).

/** Text compared loosely: case, accents, punctuation and spacing do not count. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** How much of `expected` the `heard` text has, word by word in order (0 to 1). Speech recognition gets words wrong; typing gets letters wrong. */
export function textMatch(expected: string, heard: string): number {
  const a = normalizeText(expected).split(' ').filter(Boolean)
  const b = normalizeText(heard).split(' ').filter(Boolean)
  if (!a.length) return 1
  // Longest common subsequence of words.
  const row = new Array<number>(b.length + 1).fill(0)
  for (const word of a) {
    let previous = 0
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!
      row[j] = word === b[j - 1] || near(word, b[j - 1]!) ? previous + 1 : Math.max(row[j]!, row[j - 1]!)
      previous = current
    }
  }
  return row[b.length]! / a.length
}

/** One letter wrong, missing or extra, in a word of four letters or more. */
function near(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 4) return false
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  return a.slice(i + 1) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i) || a.slice(i) === b.slice(i + 1)
}

/** Typed text has to be the text; heard text most of it (speech recognition gets words wrong). */
export const TYPED_MATCH = 0.9
export const SAID_MATCH = 0.7
