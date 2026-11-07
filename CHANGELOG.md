# Changelog

What changed in each release, for the people who use Vasta. New entries go under **Unreleased**;
`scripts/release.sh` names that section after the version, and the release workflow puts it on the
GitHub release page.

## Unreleased

### Added

- **Side pane.** Type settings have **Open in side pane** (off unless turned on): a click on one of
  the type's objects in a list, table, board, gallery or query opens it in a pane next to the page,
  where it can be edited without losing your place; another click switches it. A view's layout
  menu and a query's settings can choose otherwise (Side pane or Full page).
  The pane has Open full page and Close (Esc), is made wider or narrower by its left edge (kept on
  this device), and is part of the address, so back, forward, reload and copied links keep it.
  Comments and activity stay on the full page. Mentions in text still open the page, ⌘-click
  still opens a new tab, and phones open the page as before.
- **Whiteboard styles for agents.** `edit_board` sets an element's rotation, a shape's fill,
  border and dashes, a sticky note's text size, an arrow's tips (arrow, dot or none at each end),
  sides, dashes and width, a card's properties view, and the board's default scene (a frame as the
  cover); `get_board` returns them.

## 0.6.2 (2026-11-06)

### Added

- Reminders as notifications on your phone and in browsers (Web Push): turn them on in Settings › Reminders on each device, and pick what each one reminds you of. On iPhone and iPad, in Vasta added to the Home Screen (iOS 16.4 or later); on Android and computers, in the browser too. Nothing to set up on the server.

### Fixed

- A blank white window after an update (desktop app, Safari, the installed web app). The browser could keep opening the previous version's page, whose files the new version no longer has; now the page is always checked with the server, the files of the current version stay saved for offline use, and a page that still comes up broken reloads itself once.

## 0.6.1 (2026-11-06)

### Added

- Name the other side of a relation: in a type's settings, a relation's "Name on the other side" is what the objects it links to show, e.g. "Wrote" on a person instead of "Books · Author". Agents see it too.

### Fixed

- Reminders reach the desktop app again after it reconnects (after an update, a restart or a network hiccup). Before, the server could lose track of the new connection and say "no desktop app open".
- Desktop (macOS): reminders show as a banner while Vasta is the app in front, not only in Notification Center.

## 0.6.0 (2026-11-06)

### Added

- **Whiteboards** (first version): a new built-in type whose page is an endless canvas. Put
  objects on it as cards (drag them in, or press @), write text anywhere, and link elements with
  arrows that can have a label. Pan, zoom and pinch with a mouse, a trackpad or a touch screen;
  undo and redo; a full-screen mode. Boards sync and merge across devices, offline too, and cards
  show up in their objects' backlinks. [Whiteboards →](docs/whiteboards.md)
- **Drawing on whiteboards**: shapes, sticky notes, a pen with pressure and a highlighter, an
  eraser, and frames that carry what is inside them. A bar over the selection sets colors and
  shapes, brings things forward or back, duplicates and deletes; moving lines things up with
  their neighbors; copy and paste work across boards. With an Apple Pencil, fingers only move the
  view, a resting hand draws nothing, and two- and three-finger taps undo and redo.
- **Draw on a card, note or frame**: pick the pen in the selection bar and what you draw sticks to
  that element, moving and resizing with it.
- A whiteboard's page fits the board to the screen, so it opens without scrolling.
- **Flowcharts and JSON Canvas on whiteboards**: paste a Mermaid flowchart on a board, or turn a
  Mermaid diagram in a note into a whiteboard, and it becomes shapes and arrows you can move, with
  nodes named like your objects becoming their cards. Export a board as a JSON Canvas (Obsidian's
  `.canvas`) and import one, from the board's menu.
- **Whiteboards in notes, live cards, linking arrows**: embed a whiteboard in a note, whole or
  one of its frames; show a card as one line or with its contents (a query's live results, a
  page's text); turn an arrow between two cards into a relation, so it shows in backlinks and
  queries. The board menu lists its frames to jump to.
- **Scenes on whiteboards**: a menu at the board's top left goes to each frame, with ‹ › to step
  through them like slides; an embedded scene fades out what lies outside its frame. Letting an
  arrow go over empty space offers a new note, text, shape or object at its end, and cards
  showing their contents scroll with the wheel.
- **Arrow styles and mentions on whiteboards**: arrows can curve or turn at right angles, have
  heads at either end or none, and be dashed; an arrow between two cards can mention one object
  in the other's text. Resizing lines edges up with neighbors, and cards showing their contents
  scroll by touch.
- **Agents edit whiteboards**: `get_board` and `edit_board` over MCP, and `vasta board` in the
  terminal, read a board and add, move, change and connect its elements, flowcharts and canvases
  included.
- Tag objects and set their icon and color from MCP and the CLI: `tags` (with `tagsMode` add,
  remove or replace), `icon` (an emoji or `ph:<name>`) and `color` on `create_object` and
  `update_object`; `--tag`, `--remove-tag`, `--set-tags`, `--icon` and `--color` on `vasta new`
  and `vasta set`. Missing tags are created, nested ones by path (`recipe/breakfast`).
- **Edit in tables.** Click a property's cell in a table view, or in a query shown as a table (also
  one embedded in a page), to change it right there: pick from a select, a person or a related
  object, set a date, type a text, number or link, and a checkbox toggles with one click. With the
  keyboard, Tab moves between cells, Enter or Space opens one, Enter saves what you typed and
  Escape puts it back. Formulas and long text stay read-only; the title still opens the object.
  Thanks to @bokehsec (#50).
- **Export a space** (Settings › Space › Export…, or `pnpm vasta space export` on the server):
  a ZIP with a Markdown file per object (properties in front matter, links between objects as
  links between files, so Obsidian and other apps read it), whiteboards as JSON Canvas, the files
  objects use, and everything as JSON with nothing left out. [Export →](docs/export.md)

### Changed

- **A new logo**: a soft tile with a V cut from its top, Vasta's own mark instead of a planet icon.
  It is the app icon (installed web app, desktop app, browser extension), the favicon (light and
  dark tabs), and the logo on the login screen and in the README. The files, colours and usage
  are in `design/logo/`.

### Fixed

- **Files are only served to the spaces that use them.** A picture, PDF, cover or link preview
  opens for members of a space whose objects use it; before, anyone logged in who knew a file's
  name could fetch it (#2).
- **No blur over the top of the app on iOS and iPadOS 27** when it is installed on the home screen
  (#45). The fix works around a system effect and may need another look after iOS updates.

## 0.5.1 (2026-11-04)

### Fixed

- **Vasta at a plain-http address** (e.g. `http://192.168.1.10:3000` on your network) can add
  properties, select options, views and the other things that get a new id again; browsers only
  offer `crypto.randomUUID` over HTTPS or localhost. Thanks to @natedwhite for finding the cause
  (#43).
- **Mentions with Markdown characters in their title**, such as an underscore, no longer gain
  backslashes each time an agent rewrites the page. Thanks to @bokehsec (#46).

## 0.5.0 (2026-11-03)

### Added

- Set, inspect or remove object covers by URL and pin or unpin objects from MCP and the CLI.
- Choose editor block spacing in Appearance settings, with a roomier default.
- Independently opt into logging desktop quick captures in the daily note or showing them in the inbox.

### Fixed

- Opening a calendar day or reading it through MCP and the CLI no longer creates an empty daily note.
- Markdown object links open their targets from headings and table cells, and imported task lists
  can be checked as soon as the editor opens.
- Instagram Reel weblinks use short titles and skip automatic readable-text extraction.
- The Tags tree displays custom tag icons.

### Changed

- **The toggle's arrow** is bigger and sits centered on the title's line; the lines inside line up
  with the title.

## 0.4.1 (2026-10-27)

### Added

- **Quick capture asks a template's questions.** With Settings › Desktop app › "Ask a template’s
  questions in quick capture" (off by default), a `/Type …` line whose template asks something
  shows those questions before it saves, in the dialog and in the desktop app's floating panel
  (after updating the desktop app). Questions the line already answers (`body:yes`) are not asked.
- **Tab nests lines in toggles, as in Capacities.** Tab on a line puts it inside the toggle above
  it, or turns the line above into a toggle holding it; Shift+Tab takes it back out (a toggle left
  empty is a plain line again). Lists keep their own Tab.

### Fixed

- **/Toggle on a line you already wrote** makes that line the toggle's title, instead of an empty
  title with the line inside. "Turn into" in the block menu offers Toggle too.
- **Templates: a formula with `{{…}}` or braces inside it** no longer lands in the new object as raw
  text. It is read as one formula, and a formula that does not work leaves nothing.

## 0.4.0 (2026-10-26)

### Added

- **Mermaid diagrams.** `/Diagram` (or typing ```` ```mermaid ````) adds one; it is drawn on the
  page, in your colors and in dark mode, and its code shows when you click it. Agents read and
  write diagrams as Mermaid code blocks.
- **Import from Capacities in the app.** Settings › Import takes a Capacities full export (the ZIP
  of Markdown files), on Windows, Linux and macOS and without the Capacities app, into a new
  space or one you have. Types, properties, tags, links, daily notes and media come over, and a
  report says what did not (queries need their filters again). [Import →](https://github.com/ariedotme/vasta/blob/main/docs/import.md)

### Fixed

- **Inbox:** objects you moved to the trash or deleted for good no longer show up there, as
  empty items that could not be opened.

## 0.3.3 (2026-10-25)

### Added

- **Templates: `ask()` with answers.** `ask("Body", "Yes", "No")` in a condition or a formula
  asks with buttons to pick from, so a choice can decide what a template adds without printing
  anything.

### Fixed

- macOS: **On this computer** starts again. Its server stopped right away ("signal: 5
  (SIGTRAP)") because the bundled Node.js was not allowed the memory it compiles JavaScript into.

## 0.3.2 (2026-10-23)

### Added

- **Ctrl+Enter in Quick Capture** (on macOS too) saves and opens what it made: the new object
  for a `/Type …` line, else today's note. Both the desktop app's floating panel and the app's
  own Quick capture dialog say so under the text.

### Fixed

- macOS: Quick Capture from another app no longer brings Vasta's window to the front from its
  second use on.

## 0.3.1 (2026-10-23)

### Added

- **The desktop app works without a server.** On first start, choose **Start on this computer**:
  the app runs Vasta itself, with nothing to install or set up, and your notes stay on that
  computer. The start page says what you give up (your phone, Telegram captures, backups are
  yours to make). The menu-bar item's **Open Notes Folder** shows where the notes are.
- **Move to a server**, from Settings › Server in the desktop app: paste a server's setup code or
  an invite link, choose a username and password, and your notes, their history and your files
  move into a new account there. Then the app switches to that server.
- Servers take notes moved from another Vasta (needed for the above): update your server before
  moving notes to it.

### Changed

- On the desktop app's own server, the account menu has no Log out or Change password, and
  Settings › Server accounts explains why there are no other accounts.

## 0.3.0 (2026-10-22)

### Added

- **Templates**: start a type's objects or each day's note from a template, with placeholders
  (`{{date:+7d}}`, `{{ask:With whom?}}`) and blocks shown only when a condition holds.
- **Snippets**: save a piece of text and insert it with `/`.
- Agents can list and use templates and snippets.

### Changed

- Typed lines (`/Task Ask Lena due:fri`) take English words only.

## 0.2.0 (2026-10-22)

The first public version.
