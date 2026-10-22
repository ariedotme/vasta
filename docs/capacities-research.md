# Capacities: observed behavior

Notes on how the Capacities desktop app (macOS, versions 1.67–1.71, October 2026) works, gathered
by inspecting the installed app, its local database and the running UI. This is a functional
reference for Vasta's design and for the importer. No Capacities code is reused in this
repository.

## Architecture

- Electron app; the UI is a Vue 3 single-page app also shipped to iOS/Android via Capacitor.
- **Local-first cache:** a SQLite database (sqlite-wasm, `opfs-sahpool` VFS) inside Chromium's
  Origin Private File System holds every object as JSON, plus an FTS5 index for search and
  key-value caches (backlink index, related content). Media files are not stored locally.
- **Sync:** REST over HTTPS. The client polls for changes using `lastUpdated` timestamps and
  sends edits through a local action queue. No CRDT or real-time channel was observed, so
  concurrent offline edits to the same object resolve per object (last writer wins).
- Background web workers handle the database and heavy processing.
- Plans are enforced client-side from a signed token; queries, AI and some views are paid.

## Data shapes (as stored locally)

- Every object is a "component" with `id`, `structureId` (its type), `properties`
  (`{ <propertyId>: { val } }`), `data.blocks` (rich text, keyed by the property that owns it),
  `databases` (collections it belongs to; every type also has a hidden default collection) and
  `createdAt` / `lastUpdated`.
- Types ("structures") store `propertyDefinitions` with kinds: entity (relation, with allowed
  types), label (select, with colored options), blocks/textBlock (rich text), datetime, number,
  boolean, plus system fields (title, tags, aliases, description, icon).
- Date properties do not store dates inline: they link to separate date objects.
- Daily notes are dated by their `createdAt` (midnight UTC of the day).
- Rich text is a tree of blocks. A text block carries tokens (text with bold/italic/background
  color, links to URLs, links to objects) and flags: heading level, bullet/numbered list, todo,
  quote, toggle, icon. Other blocks: object embed (with a display mode), group (colored), grid
  (columns with percentage dividers), simple table (stored column by column), horizontal line.
- Queries store `structures` (types), a nested `filterGroup` (`and`/`or`; operators such as
  contains, is, isChecked; values that are literals, label ids or the variable "parent"),
  `groupBy`, and a view layout.
- The space record stores the sidebar: ordered sections ("pinned" and named groups with icons),
  each listing type or object ids.

## Capture

- External channels (WhatsApp, Telegram, email, browser extension, API) append to **today's daily
  note**. A captured WhatsApp message becomes a block with the channel's icon and the time
  (e.g. "08:59"), followed by the message content.
- The desktop app also runs a local REST API (localhost, bearer token) with endpoints to list
  spaces, read a space's types, search, save a weblink, save to the daily note and save a task;
  it is used by launchers such as Raycast. Deep links (`capacities://`) support x-callback-url.
- Tasks can be pushed to Things (URL scheme) and Apple Reminders (AppleScript).

## UI layout (desktop)

- **Left sidebar:** space switcher; "+ New"; search; Calendar, Tasks, Explore; then sidebar
  sections (Pinned, user groups) listing types and objects with icons; footer with account,
  settings, theme and command palette.
- **Top bar:** back/forward, the open tab's title, "+" for a new tab; tabs can be split.
- **Calendar section:** Month / Week / Three days / Day switcher with Today navigation. The day
  view shows the date, quick-create chips for frequently used types, tabs (All, Daily note,
  Tasks, Created today) and a mini month calendar on the right.
- **Type page:** title and icon, view tabs (Overview, All, plus saved views), toolbar with count,
  filter, sort, group, layout picker, settings and "+ Query"; objects grouped (e.g. by a select
  property) and shown as cards with type badge, title and tags.
- **Object page:** optional cover image and icon, type badge and collections, title, tags,
  property table (only non-empty properties when set to hide empty ones), then the rich-text
  body. Media objects use a split layout (media on one side, notes on the other).
- Dashboards are ordinary pages built from columns, colored groups and embedded queries.

## Server features (for reference)

Weblink analysis (metadata scraping, readable text), image/PDF/audio analysis and transcription,
import/export, Readwise and calendar integrations, AI chat and commands, embeddings search,
public API and webhooks. All of these sit behind the hosted backend.
