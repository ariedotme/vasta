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
  usual size or drag a box. The shape tool's settings give new shapes a color, a fill (a tint,
  none, white or solid), an outline width and a dashed or dotted outline. The selection bar switches between rectangle, ellipse, diamond,
  triangle, parallelogram, star and heart. Double-click to write inside.
- **Sticky notes** (**S**): click or drag; you type straight away. The tool's row picks the
  color of new notes, its settings the text size.
- **The toolbar**: the tools at the bottom (select, lasso, hand; pen, eraser; text, sticky note,
  shape, frame, arrow; an object). The pen, shapes, sticky notes and arrows get a row above it:
  the pen's presets, the shapes, the notes' colors, the arrows' courses, and a settings button
  (or a second click on the tool) for the rest. What they make is kept on each device; to change
  what is already on the board, select it.
- **Pen** (**P**) and **highlighter** (**M**): draw freehand. The pen tool has four presets, each a
  pen or a highlighter with its own color, width (measured on screen, so a zoomed-out board still
  gets the line chosen) and, for a pen, a solid, dashed or dotted line. **M** picks the first
  highlighter preset, **P** the first pen. A pen's
  pressure shapes the line, eased so a light touch never breaks it; a mouse or finger uses speed
  instead.
- **Draw on an element**: select a card, note, shape or frame and pick the pen in the selection
  bar. What you draw then belongs to that element: it is cut at its edges, moves and scales when
  the element does, is copied with it and deleted with it. **Done** (or Esc, or another tool)
  goes back to drawing on the board. The **eraser** (**E**,
  or a pen's eraser end) removes the strokes it passes over.
- **Frames** (**F**): drag a box to make a named region; it sits under everything. Moving a frame
  (by its title or its edge) moves what lies wholly inside it. Double-click the title, or select
  it and press Enter, to rename it.
- **Card views**: a card's view (in the selection bar) is its **card**, **one line**, or its
  **contents**: a query's live results, a picture, or the text of anything else. The wheel scrolls
  the contents (the board pans again once they reach an end); double-click the card to open the
  object.
- **An arrow let go over empty space** offers what to put there, joined to where it started: a
  sticky note, a text, a shape (typed into right away) or an object (the object picker).
- **Arrows**: select an element and drag the dot on its right edge to another element, or pick
  the arrow tool (**L**) and drag from one element to another. Double-click an arrow (or select
  it and press Enter) to give it a label.
- **Arrow styles** (the line button in the selection bar): straight, curved or at right angles
  (leaving from the sides that face each other), an arrowhead at the end, at both ends or none,
  and dashed.
- **Arrows that link objects**: select an arrow between two cards and pick the link in the
  selection bar: it lists the relation properties of the first card's type that take the second's
  type ("Add to “Source”"). The second object is written into that property, so the link shows in
  backlinks, on the object's page and in queries; the arrow shows the property's name. The same
  menu unlinks. Deleting the arrow keeps the relation (it is the objects' own data now). For any two
  objects whose first has a text field, **Mention it in …'s text** adds a line with a mention of
  the second at the end of the first's text instead: a backlink, and the arrow shows "Mentioned".
- **Select** with a click, Shift-click to add, or drag a box over empty space (a frame is taken
  when the box holds it whole). Drag to move: the selection lines up with other elements' edges
  and middles, with red guides; hold Alt, Ctrl or ⌘ to move freely. The corner handle resizes
  (Shift keeps the proportions; strokes always do; the right and bottom edges line up with other
  elements the same way), arrow keys nudge (Shift for 10). Delete or
  Backspace deletes; an element's arrows go with it.
- **Lasso** (**Q**): draw a loop to select what it encloses (an element whose middle is inside it;
  a stroke when most of it is), Shift to add to the selection. Handy with a pen around scattered
  strokes.
- **Turn** an element (not a frame) by the knob above it; it snaps upright and to every 45° when
  near, Shift turns in steps of 15°. A turned element resizes along its own sides, from its top
  left corner, and arrows meet its turned edges; strokes drawn on it turn with it.
- **Several selected** show their box and a corner handle that scales them together (what lies in
  a selected frame too), lining up with other elements as a resize does; Shift keeps the
  proportions, as strokes and turned elements always do.
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
- **With a pen** (Apple Pencil and the like): once a pen has touched the board, the pen draws
  whatever the tool (with Select or Hand it draws with the pen's settings; on a handle it resizes or
  connects), and fingers move and zoom the view: a tap selects, and a finger drags only what is
  already selected. Touches are ignored while the pen is down, for a moment after it lifts, and
  when as wide as a palm, so a resting hand does nothing. **Pen and fingers** in the board menu
  changes this on each device: Auto (as above, from the first touch of a pen), Pen draws (the
  same from the start) or Fingers draw (fingers draw with the pen tool, as before). The board cancels the Pencil's touches so iPadOS Scribble and text selection do
  not take them mid-line; if the system still breaks a line (a cancelled pointer, the pen lifted
  and put back within 180 ms where it left off), the line goes on as one stroke. Pressure readings
  are smoothed as they arrive, and a pen's points are only thinned by distance, so the width
  never jumps.
- **Scenes**: when a board has frames, a menu stays at its top left: pick a frame to show it
  whole, or step through them with **‹ ›** (top to bottom, left to right), like slides. Moving
  the view by hand leaves the scene.
- **In a note**: embed a whiteboard as any object (@ or `/`). The embed shows the board, live; when
  the board has frames, a menu in its header picks one, a **scene**, and the embed shows just it.
  What lies outside the scene's frame fades into the background. The scene is the embed's `blockId`, so Markdown keeps it: `![Board](vasta://o/<board>#b-<frame>)`.
  Double-click the embed to open the board.
- On its own page the board fills the page under a thin bar with its title. **Details** (in the
  bar) opens a panel beside it with the tags, properties, comments, backlinks and the rest
  (over the board on a phone); it stays open or closed on each device. In the side pane, and as a
  template, the board sits below the title and properties instead.
  The **full screen** button (top right) gives it the whole window; Esc leaves it once nothing is
  selected.

Where the view was is kept per board on each device.

## Flowcharts, JSON Canvas, agents

- **Mermaid**: paste a flowchart (`graph` or `flowchart`, any direction) on a board, or use the
  board menu (**⋯** top right) › Add a Mermaid flowchart. A Mermaid diagram in a note has
  **Turn into whiteboard** (on hover) to make a new board of it. Nodes become shapes (`[ ]`
  rectangle, `(( ))` ellipse, `{ }` diamond, `{{ }}` and `[/ /]` parallelogram, `> ]` triangle)
  laid out in layers in the chart's direction, edges become arrows with their labels, and a node
  named exactly like an object of the space becomes its card. Subgraphs and styles are skipped.
- **JSON Canvas** ([jsoncanvas.org](https://jsoncanvas.org), Obsidian's `.canvas`): the board menu
  exports the board as one (cards as links to their objects, frames as groups, arrows as edges;
  pen strokes have no place in the format and stay out) and imports one (groups become frames,
  text, file and link nodes sticky notes, links to this app's objects their cards). Pasting a
  canvas's JSON on a board adds it too.
- Pasted or imported content goes to the right of what the board holds, selected and in view.
- **Agents** read a board with `get_board` and change it with `edit_board` over MCP, or with
  `vasta board` in the terminal ([agents.md](agents.md)): elements and arrows by id, new ones
  named by a `ref` within one call, positions laid out when left out, a flowchart or a canvas
  added the same way. The conversions live in [`core/src/board-graph.ts`](../packages/core/src/board-graph.ts).

## How it is stored

The elements live in the board object's **Y.Doc**, the same document that holds the rich text of
other objects, in a `Y.Map` named `whiteboard` (`BOARD_FIELD`): one entry per element id, each a
`Y.Map` of its fields. [`packages/core/src/board.ts`](../packages/core/src/board.ts) reads and
writes it.

| kind    | fields |
|---------|--------|
| `card`   | `objectId`, `view` (optional: `compact`, `embed`) |
| `text`   | `text` |
| `shape`  | `shape` (rectangle, ellipse, diamond, triangle, parallelogram, star, heart; anything else reads as a rectangle), `text` |
| `sticky` | `text` |
| `stroke` | `points` (x, y, pressure in turn, relative to the box's corner, simplified), `size`, `sw`, `sh` (the box the points were drawn in, so a resized stroke scales them), `highlight` (optional), `parent` (optional: the element it is drawn on; then `x`, `y`, `w`, `h` are fractions of that element's box) |
| `frame`  | `title` (optional) |
| `arrow`  | `from`, `to` (element ids), `label` (optional), `color` (optional), `relation` (optional: the relation property of the "from" card's object it wrote the "to" object into), `mentioned` (optional: the "to" object was mentioned in the "from" object's text), `path` (`curved`, `elbow`; straight when left out), `heads` (`both`, `none`; the end when left out), `dashed`, `rank` |

Every kind but arrows also has `x`, `y`, `w`, `h`, `rank` and an optional `color` (a color name;
left out, the kind's own: ink, a yellow note).

`rank` is a fractional key ([`rank.ts`](../packages/core/src/rank.ts)): elements are drawn in its
order (frames always first), so bringing one to the front or sending it back writes only that one. Because each element is its own map,
two devices that move different elements, or change different fields of one (one moves a card,
the other resizes it), both keep their change; the same field ends as Yjs resolves it. An element
deleted on one device is gone on both, even if the other moved it meanwhile; strokes drawn on it
go with it (and a stroke whose element is gone is not drawn). Arrows whose ends are
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

Others' cursors on a shared board: they come with live collaboration in notes
([#22](https://github.com/ariedotme/vasta/issues/22)), which boards will share. Rotating shapes,
a lasso, resizing several elements at once ([#51](https://github.com/ariedotme/vasta/issues/51)). The plan is in issue #38.
