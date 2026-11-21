import { describe, expect, it } from 'vitest'
import { builtinTypeId, createBuiltinTypes, type ObjectType } from '@vasta/core'
import { METRICS_VIEW, firstOpenItem, parseViewItem, pinnedView, resolveView, viewItem } from './view-pins.ts'

const at = '2026-10-19T12:00:00.000Z'
const book: ObjectType = {
  id: 'book', spaceId: 's', name: 'Book', pluralName: 'Books', createdAt: at, updatedAt: at, properties: [],
  views: [{ id: 'all', name: 'All', layout: 'list' }, { id: 'week', name: 'This week', layout: 'table' }],
}
const task = createBuiltinTypes('s', at).find((t) => t.id === builtinTypeId('s', 'task'))!
const types = new Map([[book.id, book], [task.id, task]])

describe('pinned views', () => {
  it('writes and reads the item of a view, whatever its id holds', () => {
    expect(parseViewItem(viewItem('book', 'a b?c'))).toEqual({ typeId: 'book', viewId: 'a b?c' })
    expect(parseViewItem('book')).toBeNull()
  })

  it('finds the type and view of a pin, and nothing once either is gone', () => {
    expect(pinnedView(types, viewItem('book', 'week'))?.view.name).toBe('This week')
    expect(pinnedView(types, viewItem('book', 'gone'))).toBeNull()
    expect(pinnedView(types, viewItem('deleted', 'week'))).toBeNull()
    expect(pinnedView(types, 'book')).toBeNull()
  })

  it('opens on the first item that opens something', () => {
    expect(firstOpenItem(types, [viewItem('deleted', 'x'), viewItem('book', 'gone'), viewItem('book', 'week'), 'book'])).toBe(viewItem('book', 'week'))
    expect(firstOpenItem(types, ['book', viewItem('book', 'week')])).toBe('book')
    expect(firstOpenItem(types, [viewItem('deleted', 'x'), viewItem('book', 'gone')])).toBeUndefined()
    expect(firstOpenItem(types, [])).toBeUndefined()
  })
})

describe('the view a type opens on', () => {
  it('keeps a view the type has', () => {
    expect(resolveView(book, 'week')).toBe('week')
  })

  it('falls back to the first view for one that is gone or empty', () => {
    expect(resolveView(book, 'gone')).toBe('all')
    expect(resolveView(book, '')).toBe('all')
    expect(resolveView({ ...book, views: [] }, 'gone')).toBe('')
  })

  it('keeps a fixed view, and Metrics only where there are metrics', () => {
    expect(resolveView(book, '__tree', '__tree')).toBe('__tree')
    expect(resolveView(task, METRICS_VIEW)).toBe(METRICS_VIEW)
    expect(resolveView(book, METRICS_VIEW)).toBe('all')
  })
})
