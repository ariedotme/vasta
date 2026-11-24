import { describe, expect, it } from 'vitest'
import type { BoardSettings } from '@vasta/core'
import { cardFieldRows, patchCardSettings, resolveCard, toggleCardFieldId, type CardFieldOption } from './cards.ts'

const choices: CardFieldOption[] = [
  { id: 'due', label: 'Due', icon: 'ph:calendar' },
  { id: 'priority', label: 'Priority', icon: 'ph:tag' },
  { id: 'tags', label: 'Tags', icon: 'ph:tag' },
]

describe('resolveCard', () => {
  it('uses per-variant defaults when settings are unset', () => {
    expect(resolveCard('kanban')).toEqual({ cover: false, fit: false, preview: true, labels: false, size: 'md' })
    expect(resolveCard('gallery')).toEqual({ cover: true, fit: false, preview: false, labels: false, size: 'md' })
    expect(resolveCard('grid')).toEqual({ cover: true, fit: false, preview: true, labels: false, size: 'md' })
    expect(resolveCard('wall')).toEqual({ cover: true, fit: false, preview: true, labels: false, size: 'md' })
  })

  it('respects explicit overrides independently of variant defaults', () => {
    expect(resolveCard('kanban', { cardCover: true, cardFit: true, cardPreview: false, cardLabels: true, cardSize: 'lg' })).toEqual({
      cover: true,
      fit: true,
      preview: false,
      labels: true,
      size: 'lg',
    })
    expect(resolveCard('gallery', { cardCover: false, cardPreview: true, cardSize: 'sm' })).toEqual({
      cover: false,
      fit: false,
      preview: true,
      labels: false,
      size: 'sm',
    })
  })
})

describe('cardFieldRows and toggleCardFieldId', () => {
  it('lists all fields unchecked in automatic mode', () => {
    expect(cardFieldRows(choices, undefined).map((r) => [r.id, r.on])).toEqual([
      ['due', false],
      ['priority', false],
      ['tags', false],
    ])
  })

  it('puts ticked fields first in saved order, ignores stale ids, and follows with unticked ones', () => {
    expect(cardFieldRows(choices, ['gone', 'tags', 'due', 'tags']).map((r) => [r.id, r.on])).toEqual([
      ['tags', true],
      ['due', true],
      ['priority', false],
    ])
  })

  it('toggles fields on and off while filtering stale ids', () => {
    expect(toggleCardFieldId(choices, undefined, 'tags')).toEqual(['tags'])
    expect(toggleCardFieldId(choices, ['gone', 'tags'], 'due')).toEqual(['tags', 'due'])
    expect(toggleCardFieldId(choices, ['tags', 'due'], 'tags')).toEqual(['due'])
    expect(toggleCardFieldId(choices, ['due'], 'due')).toEqual([])
  })
})

describe('patchCardSettings', () => {
  it('omits values that match the variant default and returns undefined when nothing remains', () => {
    const enabled = patchCardSettings<BoardSettings>(undefined, { cardCover: true }, 'kanban')
    expect(enabled).toEqual({ cardCover: true })
    expect(patchCardSettings(enabled, { cardCover: false }, 'kanban')).toBeUndefined()

    // For gallery, cardCover: true is the default, so turning it off stores false and turning it back on clears it.
    const hidden = patchCardSettings(undefined, { cardCover: false }, 'gallery')
    expect(hidden).toEqual({ cardCover: false })
    expect(patchCardSettings(hidden, { cardCover: true }, 'gallery')).toBeUndefined()
  })

  it('preserves unrelated board fields such as swimlanes and order', () => {
    const board: BoardSettings = { swimlanes: 'tags', columnOrder: ['a', 'b'] }
    expect(patchCardSettings(board, { cardCover: true, cardSize: 'lg' }, 'kanban')).toEqual({
      swimlanes: 'tags',
      columnOrder: ['a', 'b'],
      cardCover: true,
      cardSize: 'lg',
    })
  })
})
