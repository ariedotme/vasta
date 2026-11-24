// The Back rule. On a phone Back (the browser's button, the iPhone's edge swipe) must close what is
// open over the page, not change the page under it. Dialogs, menus, the command palette and the side
// drawer are not in the address: each says here while it is open with closesOnBack(), and router.ts
// asks on Back and cancels the navigation when one closed, so the page and history stay where they
// were. (The side pane lives in the address, so Back already closes it.) On a desktop Back is plain
// history.
import { onScopeDispose, watch, type WatchSource } from 'vue'

/** What is open, the last opened on top: each closes its own (or steps back inside itself). */
const layers: (() => void)[] = []

const remove = (layer: () => void) => {
  const at = layers.indexOf(layer)
  if (at >= 0) layers.splice(at, 1)
}

/** While `open` holds, Back calls `close` instead of leaving the page. Call it in a component's setup. */
export function closesOnBack(open: WatchSource<boolean>, close: () => void) {
  const layer = () => close()
  watch(
    open,
    (value) => {
      remove(layer)
      if (value) layers.push(layer)
    },
    { immediate: true }
  )
  onScopeDispose(() => remove(layer))
}

/**
 * Close the top layer for a Back. True when one was open: the navigation is then cancelled. `later`
 * decides when the close runs (router.ts: once the history entry is back).
 */
export function closeTopLayer(later: (close: () => void) => void = (close) => close()): boolean {
  const layer = layers.at(-1)
  if (!layer) return false
  later(layer)
  return true
}
