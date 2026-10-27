# Changelog

What changed in each release, for the people who use Vasta. New entries go under **Unreleased**;
`scripts/release.sh` names that section after the version, and the release workflow puts it on the
GitHub release page.

## Unreleased

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
