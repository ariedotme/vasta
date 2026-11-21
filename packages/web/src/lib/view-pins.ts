import { statusProperty, type Id, type ObjectType, type ViewDef } from '@vasta/core'

/** A type with a status (tasks) also has its flow metrics, after its views. */
export const METRICS_VIEW = '__metrics'

/** A view pinned in the sidebar is the item `<typeId>?view=<viewId>`, which is also its page's path after /t/. */
export const viewItem = (typeId: Id, viewId: string) => `${typeId}?view=${encodeURIComponent(viewId)}`

export function parseViewItem(item: string): { typeId: Id; viewId: string } | null {
  const at = item.indexOf('?view=')
  return at < 0 ? null : { typeId: item.slice(0, at), viewId: decodeURIComponent(item.slice(at + 6)) }
}

/** The type and view a pinned view item opens, or null once either is gone. */
export function pinnedView(types: ReadonlyMap<Id, ObjectType>, item: string): { type: ObjectType; view: ViewDef } | null {
  const parsed = parseViewItem(item)
  const type = parsed && types.get(parsed.typeId)
  const view = type?.views.find((v) => v.id === parsed!.viewId)
  return type && view ? { type, view } : null
}

/** The first item that opens something: a pinned view needs its type and view to be there still. */
export const firstOpenItem = (types: ReadonlyMap<Id, ObjectType>, items: string[]) => items.find((item) => !parseViewItem(item) || pinnedView(types, item))

/** `id` when the type has that view (its fixed one, its Metrics or one of its own); the type's first view otherwise. */
export function resolveView(type: ObjectType, id: string, fixedId?: string) {
  const metrics = id === METRICS_VIEW && !!statusProperty(type)
  return id === fixedId || metrics || type.views.some((v) => v.id === id) ? id : (type.views[0]?.id ?? '')
}
