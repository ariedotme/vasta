# Whiteboards

A whiteboard is an object of the built-in type **Whiteboard**: it has a title, tags, properties,
comments and backlinks like any other object, and its page holds an endless canvas instead of a
text. Read with [data-model.md](data-model.md) and [sync.md](sync.md).

## Using a board

- **Add objects** as cards: drag a link to an object onto the board (from the sidebar, a list,
  another page), or press **@** (or **O**, or the Object button) and pick one; typing a title that
  does not exist makes a new page. Double-click a card to open its object.
- **Write**: double-click empty space, or pick the text tool (**T**) and click. Esc or a click
  elsewhere finishes; text left empty is removed.
- **Arrows**: select an element and drag the dot on its right edge to another element, or pick
  the arrow tool (**L**) and drag from one element to another. Double-click an arrow (or select
  it and press Enter) to give it a label.
- **Select** with a click, Shift-click to add, or drag a box over empty space. Drag to move, the
  corner handle to resize, arrow keys to nudge (Shift for 10). Delete or Backspace deletes; an
  element's arrows go with it.
- **Move around**: two fingers or the wheel pan, pinch or Ctrl/⌘ with the wheel zooms, Space or
  the hand tool (**H**) drags the view, and on a touch screen one finger on empty space pans.
  **Shift+1** fits everything, **Shift+2** the selection, **Shift+0** or **⌘0** is 100%. When
  nothing is in view, "Back to content" brings it back.
- **Undo and redo**: ⌘Z and ⇧⌘Z (or ⌘Y) undo this device's changes on the board, not other
  people's.
- The **full screen** button (top right) gives the board the whole window; Esc leaves it once
  nothing is selected.

Where the view was is kept per board on each device.

## How it is stored

The elements live in the board object's **Y.Doc**, the same document that holds the rich text of
other objects, in a `Y.Map` named `whiteboard` (`BOARD_FIELD`): one entry per element id, each a
`Y.Map` of its fields. [`packages/core/src/board.ts`](../packages/core/src/board.ts) reads and
writes it.

| kind    | fields |
|---------|--------|
| `card`  | `objectId`, `x`, `y`, `w`, `h`, `rank` |
| `text`  | `text`, `x`, `y`, `w`, `h`, `rank` |
| `arrow` | `from`, `to` (element ids), `label` (optional), `rank` |

`rank` is a fractional key ([`rank.ts`](../packages/core/src/rank.ts)): elements are drawn in its
order, so bringing one to the front writes only that one. Because each element is its own map,
two devices that move different elements, or change different fields of one (one moves a card,
the other resizes it), both keep their change; the same field ends as Yjs resolves it. An element
deleted on one device is gone on both, even if the other moved it meanwhile. Arrows whose ends are
gone are not drawn, and an element of a kind this version does not know (a newer device's) is
skipped, not destroyed.

The rich-text helpers leave `whiteboard` out (`textFields`, `writeContent` in
`packages/editor-schema/src/yjs.ts`): it is never a text fragment. Instead the object's
`content.whiteboard` is **derived** from the map whenever the document changes (`contentOfText`):
the board as blocks in reading order (top to bottom, then left to right), each card an object
embed and each text a paragraph, arrow labels last. So without anything else:

- a card makes a **backlink** on its object ("Board test" embeds it);
- the board's text and arrow labels are in **full-text search**;
- **agents** read a board through `get_object` as Markdown, the cards as embeds.

## Sync

A board syncs as text does: Yjs updates through `/api/sync/push` and `/api/sync/text`, merged on
the server and on every device. With the local replica, the page edits the replica's open copy of
the document (`openText`), so changes pulled from other devices show while the board is open.
Without one (a private window, a second tab, the first sync still filling the replica), the page
edits a Y.Doc over the sync routes directly
([`lib/remote-text.ts`](../packages/web/src/lib/remote-text.ts)): local changes go up in batches,
the server's come down by state vector every few seconds while the page is visible. Without a
connection either, the board says it needs one.

## Drawing

[`WhiteboardCanvas.vue`](../packages/web/src/components/whiteboard/WhiteboardCanvas.vue). Cards
and text are HTML in one layer, moved and scaled by the camera (a CSS transform), so cards are the
same `ObjectCard` the views use. Arrows, the selection box and the arrow being drawn are SVG in
screen space, so that layer stays the size of the view at any zoom. Only elements in view (with a
margin) and selected ones are drawn. A drag previews locally and writes once, when it ends.

## Not yet

Shapes, sticky notes, frames and scenes, freehand drawing and the Pencil, snapping, the selection
bar, arrows that make relations, live queries on a board, board embeds in notes, MCP and CLI
tools for editing boards, JSON Canvas export, Mermaid to board. The plan is in issue #38.
