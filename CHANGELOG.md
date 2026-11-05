# Changelog

What changed in each release, for the people who use Vasta. New entries go under **Unreleased**;
`scripts/release.sh` names that section after the version, and the release workflow puts it on the
GitHub release page.

## Unreleased

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
- **Agents edit whiteboards**: `get_board` and `edit_board` over MCP, and `vasta board` in the
  terminal, read a board and add, move, change and connect its elements, flowcharts and canvases
  included.
- Tag objects and set their icon and color from MCP and the CLI: `tags` (with `tagsMode` add,
  remove or replace), `icon` (an emoji or `ph:<name>`) and `color` on `create_object` and
  `update_object`; `--tag`, `--remove-tag`, `--set-tags`, `--icon` and `--color` on `vasta new`
  and `vasta set`. Missing tags are created, nested ones by path (`recipe/breakfast`).

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
