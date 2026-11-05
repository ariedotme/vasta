# Whiteboards

A whiteboard is an object of the built-in type **Whiteboard**: it has a title, tags, properties,
comments and backlinks like any other object, and its page holds an endless canvas instead of a
text: object cards, text, shapes, sticky notes, pen and highlighter strokes, frames and arrows. Read with [data-model.md](data-model.md) and [sync.md](sync.md).

## Using a board

- **Add objects** as cards: drag a link to an object onto the board (from the sidebar, a list,
  another page), or press **@** (or **O**, or the Object button) and pick one; typing a title that
  does not exist makes a new page. Double-click a card to open its object.
- **Write**: double-click empty space, or pick the text tool (**T**) and click. Esc or a click
  elsewhere finishes; text left empty is removed.
- **Shapes**: **R** rectangle, **O** ellipse, **D** diamond, or the shape tool; click for the
  usual size or drag a box. The selection bar switches between rectangle, ellipse, diamond,
  triangle, parallelogram, star and heart. Double-click to write inside.
- **Sticky notes** (**S**): click or drag; you type straight away.
- **Pen** (**P**) and **highlighter** (**M**): draw freehand; the pen has colors and three widths.
  A pen's pressure shapes the line; a mouse or finger uses speed instead. The **eraser** (**E**,
  or a pen's eraser end) removes the strokes it passes over.
- **Frames** (**F**): drag a box to make a named region; it sits under everything. Moving a frame
  (by its title or its edge) moves what lies wholly inside it. Double-click the title, or select
  it and press Enter, to rename it.
- **Arrows**: select an element and drag the dot on its right edge to another element, or pick
  the arrow tool (**L**) and drag from one element to another. Double-click an arrow (or select
  it and press Enter) to give it a label.
- **Select** with a click, Shift-click to add, or drag a box over empty space (a frame is taken
  when the box holds it whole). Drag to move: the selection lines up with other elements' edges
  and middles, with red guides; hold Alt, Ctrl or ⌘ to move freely. The corner handle resizes
  (Shift keeps the proportions; strokes always do), arrow keys nudge (Shift for 10). Delete or
  Backspace deletes; an element's arrows go with it.
- The **selection bar** above the selection: color, shape, open a card, label an arrow, rename a
  frame, bring to front (**]**), send to back (**[**), duplicate (**⌘D**), delete.
- **Copy, cut and paste** (⌘C, ⌘X, ⌘V) work within a board and between boards, frames with what
  they hold and arrows between copied elements. Pasting a link to an object adds its card;
  pasting other text adds a text.
- **Move around**: two fingers or the wheel pan, pinch or Ctrl/⌘ with the wheel zooms, Space or
  the hand tool (**H**) drags the view, and on a touch screen one finger on empty space pans.
  **Shift+1** fits everything, **Shift+2** the selection, **Shift+0** or **⌘0** is 100%. When
  nothing is in view, "Back to content" brings it back.
- **Undo and redo**: ⌘Z and ⇧⌘Z (or ⌘Y), or tap with two fingers to undo and three to redo;
  they cover this device's changes on the board, not other people's.
- **With a pen** (Apple Pencil and the like): once a pen has touched the board, fingers only move
  and zoom the view, and touches are ignored while the pen is down, so a resting hand draws
  nothing.
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
| `card`   | `objectId` |
| `text`   | `text` |
| `shape`  | `shape` (rectangle, ellipse, diamond, triangle, parallelogram, star, heart; anything else reads as a rectangle), `text` |
| `sticky` | `text` |
| `stroke` | `points` (x, y, pressure in turn, relative to the box's corner, simplified), `size`, `sw`, `sh` (the box the points were drawn in, so a resized stroke scales them), `highlight` (optional) |
| `frame`  | `title` (optional) |
| `arrow`  | `from`, `to` (element ids), `label` (optional), `color` (optional), `rank` |

Every kind but arrows also has `x`, `y`, `w`, `h`, `rank` and an optional `color` (a color name;
left out, the kind's own: ink, a yellow note).

`rank` is a fractional key ([`rank.ts`](../packages/core/src/rank.ts)): elements are drawn in its
order (frames always first), so bringing one to the front or sending it back writes only that one. Because each element is its own map,
two devices that move different elements, or change different fields of one (one moves a card,
the other resizes it), both keep their change; the same field ends as Yjs resolves it. An element
deleted on one device is gone on both, even if the other moved it meanwhile. Arrows whose ends are
gone are not drawn, and an element of a kind this version does not know (a newer device's) is
skipped, not destroyed.

The rich-text helpers leave `whiteboard` out (`textFields`, `writeContent` in
`packages/editor-schema/src/yjs.ts`): it is never a text fragment. Instead the object's
`content.whiteboard` is **derived** from the map whenever the document changes (`contentOfText`):
the board as blocks in reading order (top to bottom, then left to right): each frame's title as a
heading followed by what lies in it, then what is outside frames; each card an object embed, the
text of texts, shapes and notes as paragraphs (strokes have none), arrow labels last. So without anything else:

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

[`WhiteboardCanvas.vue`](../packages/web/src/components/whiteboard/WhiteboardCanvas.vue) holds the
gestures; [`BoardItem.vue`](../packages/web/src/components/whiteboard/BoardItem.vue) draws one
element and [`SelectionBar.vue`](../packages/web/src/components/whiteboard/SelectionBar.vue) the
bar. Elements are HTML in one layer, moved and scaled by the camera (a CSS transform), so cards
are the same `ObjectCard` the views use; shapes and strokes are SVG inside their element. Arrows,
snapping guides, the selection box and the arrow being drawn are SVG in screen space, so that
layer stays the size of the view at any zoom. Only elements in view (with a margin) and selected
ones are drawn. A drag previews locally and writes once, when it ends.

[`lib/whiteboard.ts`](../packages/web/src/lib/whiteboard.ts) has what needs no page: colors,
shape outlines, strokes (outlines by [perfect-freehand](https://github.com/steveruizok/perfect-freehand),
MIT; points simplified with Ramer–Douglas–Peucker before they are stored, coalesced pointer events
read so a fast pen loses nothing), snapping, and the clipboard format (`vasta-board:` followed by
JSON of the elements).

## Not yet

Scenes (frames embedded in notes), card views (small, embed, media), arrows that bend, end in
empty space or make relations, live queries on a board, frames in a table of contents, MCP and
CLI tools for editing boards, JSON Canvas export, Mermaid to board. The plan is in issue #38.
