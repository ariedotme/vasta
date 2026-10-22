// Turns plain text from a capture channel into rich-text blocks. Blank lines separate
// paragraphs, single newlines become line breaks, and URLs become links.
import type { DocMark, DocNode } from './model.ts'

/** Formatting over a range of the text, in UTF-16 code units (the unit Telegram uses). */
export interface TextSpan {
  offset: number
  length: number
  mark: DocMark
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'()]*[^\s<>"'().,;:!?]/gi

export function findUrls(text: string): string[] {
  return [...new Set(text.match(URL_PATTERN) ?? [])]
}

function urlSpans(text: string): TextSpan[] {
  return [...text.matchAll(URL_PATTERN)].map((m) => ({ offset: m.index, length: m[0].length, mark: { type: 'link', attrs: { href: m[0] } } }))
}

const markKey = (mark: DocMark) => JSON.stringify(mark)

/**
 * Paragraph blocks for a text. Without spans, URLs are detected and linked; with spans (e.g.
 * Telegram entities) only the given formatting is applied.
 */
export function textToBlocks(text: string, spans?: TextSpan[]): DocNode[] {
  const trimmedEnd = text.replace(/\s+$/, '')
  const marks = spans ?? urlSpans(trimmedEnd)
  // Cut the text at every span boundary and at every newline.
  const cuts = new Set<number>([0, trimmedEnd.length])
  for (const span of marks) {
    cuts.add(Math.max(0, Math.min(span.offset, trimmedEnd.length)))
    cuts.add(Math.max(0, Math.min(span.offset + span.length, trimmedEnd.length)))
  }
  for (let i = 0; i < trimmedEnd.length; i++) if (trimmedEnd[i] === '\n') (cuts.add(i), cuts.add(i + 1))
  const points = [...cuts].sort((a, b) => a - b)

  const paragraphs: DocNode[][] = [[]]
  let newlines = 0
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]!
    const piece = trimmedEnd.slice(from, points[i + 1])
    if (piece === '\n') {
      newlines++
      continue
    }
    if (newlines) {
      if (newlines === 1 && paragraphs.at(-1)!.length) paragraphs.at(-1)!.push({ type: 'hardBreak' })
      else if (paragraphs.at(-1)!.length) paragraphs.push([])
      newlines = 0
    }
    const active = new Map<string, DocMark>()
    for (const span of marks) if (span.offset <= from && from < span.offset + span.length) active.set(markKey(span.mark), span.mark)
    const node: DocNode = { type: 'text', text: piece }
    if (active.size) node.marks = [...active.values()]
    paragraphs.at(-1)!.push(node)
  }
  return paragraphs
    .filter((content) => content.length)
    .map((content) => ({ type: 'paragraph', content }))
}
