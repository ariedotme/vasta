# Sync

Every device keeps a copy (a replica) of the spaces its user is a member of, reads and writes it
locally, works offline, and syncs with the server when it can. Edits made on two devices merge;
they do not overwrite each other. Read with [data-model.md](data-model.md) and
[accounts.md](accounts.md).

What stays on the server only: accounts, sessions and membership; capture channels (Telegram, the
capture API); fetching link previews, readable text and calendars; the media store. The server is
also a regular sync peer: when it captures into a daily note or fills in a weblink, that change
reaches devices the same way an edit from another device does.

## Two kinds of data, two merge rules

1. **Rich text** (an object's text fields): one **Yjs** document per object, with one
   `Y.XmlFragment` per text field, edited through TipTap's Collaboration extension. Concurrent
   edits merge character by character. The server appending a capture is just another Yjs
   transaction.
2. **Everything else** (an object's title, properties, tags, date, icon, trash; types; a space's
   name and sidebar; calendar subscriptions): **last writer wins per field**, with a hybrid
   logical clock (HLC) per field. Two people changing different properties of the same object both
   win; for the same property, the later change wins. Arrays edited as a whole (a type's
   properties, the sidebar) are one field each.

Deletes are soft (`deletedAt` is a field like any other), so a delete racing an edit resolves like
any other field and can be undone from the trash.

## Server

Code: `packages/core/src/sync.ts` (HLC, fields, merge), `packages/core/src/store.ts` (revisions,
clocks, tombstones, the Yjs documents), `packages/server/src/sync.ts` (pull, push, text), routes in
`packages/server/src/app.ts`.

### Revisions

`spaces`, `types`, `objects` and `calendar_sources` have a `rev` and a `clock` column. `rev` comes
from one global counter in `meta` (`sync.rev`): every write through the store takes the next one in
the same transaction, so "everything with rev > N" is what changed since N. After the transaction
commits, the store announces the newest rev per space (`Store.onRev`), and the server sends it on
`/api/events` as an SSE event named `rev` (`{ kind: 'rev', spaceId, rev }`). Rows written by a
version without sync (after a rollback) are stamped on open at their `updatedAt`.

**Tombstones.** `sync_tombstones (kind, id, space_id, rev)` remembers rows deleted for good
(`purgeObject`, `purgeType` and so the 30-day trash purge, `deleteCalendarSource`), so devices
learn they are gone. Writing a row again removes its tombstone. Purging a whole space drops its
tombstones: nobody is a member any more, and the space leaves every device's list.

### Clocks

An HLC is `<ISO time>-<counter, 4 hex>-<node id>`, e.g.
`2026-10-19T03:12:45.120Z-0002-server-1a2b3c4d`, and sorts as text. `HybridClock.tick(now)` stamps
local writes, `receive(remote, now)` takes remote ones (refusing HLCs more than 24 h ahead:
`MAX_CLOCK_DRIFT_MS`). The server's node id is `server-<8 hex>` (`meta` `sync.node`); a browser's is
`web-<8 hex>`.

### Fields

`PLAIN_FIELDS` and `MAP_FIELDS` in `packages/core/src/sync.ts` list them. Each of an object's
`props.<id>` is a field of its own. Ids, `spaceId`, a type's `system` and `createdAt` never change;
`updatedAt` follows the writes. Values are JSON, `null` = absent. Whole-record writes (captures,
imports, the HTTP routes) stamp only the fields that differ from the stored row (`stampChanges`).

Some fields are written by the server only (`isPushable`): an object's `media` (files, a weblink's
page data), a space's trash, a calendar's address and login. Those go through their HTTP routes,
which check ownership or fetch the feed.

### Rich text storage

`object_docs (object_id, ydoc, vector, rev)` holds one Y.Doc per object, one fragment per text
field named by the property id (`body`, `article`…). `objects.content` is derived from it (the JSON
the editor would save) and kept for search, links, previews, queries and the agents' Markdown.
`vector` is the document's state vector, so pulls hand it out without decoding documents. Yjs runs
with garbage collection on: the server keeps no history.

Every `putObject` goes through the Y.Doc: the fields whose JSON changed are diffed into their
fragment (`updateYFragment`), so unchanged blocks keep their Yjs items and concurrent edits
elsewhere still merge. A change that only deletes does not advance a state vector, so devices
would not notice it; when that happens the server bumps a counter in the document's `vasta` map
(`markDeletions`).

The editor schema is shared: `packages/editor-schema` holds the nodes and marks without Vue views,
so the server can turn JSON (captures, imports, agents) into Yjs and back. The web editor extends
them with its views, and a test checks that both schemas match. Unknown node types become
`unsupported`, so an older device never destroys newer content.

### Protocol

Every sync request carries `protocol` (`SYNC_PROTOCOL`, now 2). A server that speaks another one
answers 409 with its own; the app then stops syncing and asks to reload, keeping its unsent
changes for the new version.

**`GET /api/sync/pull?protocol=2&since=<rev>&limit=<n>[&space=<id>][&count=1]`** (limit 1–1000;
`count=1` adds `remaining`, for the progress of a first sync):

```json
{ "protocol": 2, "rev": 318, "more": false,
  "rows": [{ "table": "objects", "id": "…", "spaceId": "…", "rev": 317, "textVector": "…",
             "clock": { "title": "<hlc>", "props.status": "<hlc>" }, "record": { "…": "…" } }],
  "tombstones": [{ "table": "objects", "id": "…", "spaceId": "…", "rev": 318 }],
  "spaces": ["…"] }
```

Rows and tombstones together, in rev order. With `more`, `rev` is the last one returned and the
device pulls again from it. `spaces` lists what the user can see now: a space that disappears was
left or deleted (drop it); one that appears (just shared, or restored) is pulled once whole with
`space=<id>&since=0`. `textVector` is the object's text state vector (base64).

**`POST /api/sync/push`** `{ "protocol": 2, "changes": [{ "table", "id", "spaceId"?, "createdAt"?,
"fields"?: { "<name>": { "value", "hlc" } }, "text"?: "<Yjs update, base64>" }] }` (at most 1000)
→ `{ "protocol": 2, "rev", "changes": [{ "table", "id", "lost": ["title"], "error"? }] }`.

Each change is checked on its own and refused whole, with an `error`, when: the table or a field is
unknown or not the device's to change, a value has the wrong shape, an HLC is invalid or too far
ahead, the row is in a space the user is not a member of, it would move to another space, it was
purged, or it is new and not an object or a type (spaces and calendar subscriptions are created
over HTTP). A text update is refused when it does not decode, is larger than 8 MB, or builds on
changes the server never received (`pull first`). Otherwise every field whose HLC is newer than
the stored one is taken; `lost` names the others, whose newer values come with the next pull. A
push applies exactly what it carries: cascades (a type's objects going to the trash with it) are
the device's job, and its store does them locally.

**`POST /api/sync/text`** `{ "protocol": 2, "objects": { "<id>": "<state vector, base64; empty for
all of it>" } }` (at most 1000) → `{ "protocol": 2, "objects": { "<id>": "<update, base64>" } }`:
the text a device lacks. Objects outside the user's spaces are left out.

**`GET /api/sync/calendars/:id`**: a subscribed calendar's iCalendar data. Rows carry
`dataVersion` (a hash of the data), so a device downloads it only when its copy is older and
expands the events itself, and the calendar works offline.

JSON answers are gzipped for clients that ask: a pull page of 1.5 MB is about 220 KB.

## Device

Code: `packages/core/src/client-store.ts` (`ClientStore`), `sync-client.ts` (`SyncClient`),
`operations.ts` (rules the server's routes and the replica share), `packages/web/src/replica/`
(the worker), `packages/web/src/lib/replica.ts` and `lib/api.ts` (the app's side).

### The replica

A dedicated worker opens SQLite (`@sqlite.org/sqlite-wasm`) on OPFS with the "SAH pool" VFS
(directory `.vasta`, file `/replica.db`), with the same schema as the server: `Store` talks to any
SQLite through a small interface (`SqlDatabase`), so the server (node:sqlite) and the browser share
one implementation. The worker takes a Web Lock (`vasta-replica`) for its lifetime: a second tab
works over HTTP and waits for the lock, and takes the replica over when the first tab closes.

The replica belongs to one user (`meta` `replica.user`): another user logging in wipes it, and so
does logging out. Where it cannot run (no OPFS: a private window) the app talks to the server.
`localStorage['vasta.replica'] = 'off'` turns it off in one browser; `VASTA_REPLICA=0` on the
server turns it off for everyone.

### Writes and the outbox

`ClientStore` is the same `Store`, so local writes are its ordinary methods, stamped with the
device's HLC. They fill `sync_outbox` with the fields that changed (values are read from the row
when pushing, so a field edited ten times goes once). A pulled row merges field by field like the
server's push (newer HLC wins), so a local change not pushed yet survives.

**Saving a page.** `saveObject(object, at, base)` writes only the fields that differ from `base`,
the copy the page started from, so a change pulled while the page was open is not undone. The app
over HTTP does the same: it sends `base` with `PUT /api/objects/:id`, and the server writes only
what differs (`applyEdit`).

**Editors on the Y.Doc.** An object page opens a text session: a Y.Doc in the main thread, started
from the replica's document, with TipTap's Collaboration extension on it (undo covers this
device's edits only). Its updates go to the worker, which writes them in batches of 200 ms (at
once when the page is hidden: iOS may suspend it); every other change to that document (a pull, a
capture) comes back as a Yjs update. So text pulled while typing merges. Over HTTP the editor
saves JSON, and the server keeps items captured meanwhile (`mergeCaptures`).

**Daily notes.** A day's note has the id `daily-<spaceId>-<day>`, so two devices opening the same
day offline make the same row and their texts merge. Its fields are stamped at the epoch, older
than any change, so an empty note made offline never beats a title set elsewhere.

### The sync loop

It runs on start, shortly after local writes, on the server's `rev` event, when the device comes
online or the page becomes visible, every 10 s while offline, and with backoff up to a minute
after a failure. It pushes the outbox, then pulls: each page of rows is written in one
transaction, with the text of its objects fetched first (`/sync/text`) and written with them.

**`api.ts`** keeps one list of functions. With the replica ready, reads and most writes are
local. What only the server can do (save or refresh a weblink, upload a file, delete for good,
manage spaces, members and calendar subscriptions) syncs first, calls the server, and syncs again
so the result is in the replica. Offline those say "This needs a connection to the server."

**Refused changes** leave the outbox but are kept in `sync_refused`, listed in Settings › This
device with the reason until dismissed, and announced once with a toast.

### The first sync

The app does not wait for it. The worker fills the replica in the background while every call
goes to the server; when the fill is done, calls move to the replica. A strip at the top shows the
progress ("4,000 of 21,112") once the fill has run 2 s. A fill that stops halfway (offline, a
reload) goes on from its cursor; the replica counts as ready only once a fill finished (`meta`
`sync.filled`).

The service worker never caches `/api/sync/`. The worker script and the `.wasm` are cached on
first use, so an installed app starts offline: the shell from the cache, `/api/auth/me` from the
API cache, the data from the replica.

## Big spaces

Measured with `pnpm load-test 50000 --keep` and `scripts/browser-checks/scale.mjs` (51,112 rows,
183 MB, Chromium on a Mac), and `packages/server/test/firstsync.bench.test.ts`
(`VASTA_BENCH=1 pnpm vitest run firstsync`):

- First sync of 5,000 objects: about 2 s in Chromium and WebKit; 51,112 rows: 42 s in the
  background, the app usable after 1 s. The rest is OPFS writes
  ([#4](https://github.com/ariedotme/vasta/issues/4)).
- Reads that would scan the whole `objects` table on the replica (1–2 s at 50,000 objects) use
  indexes instead: `objects_updated` (⌘K with nothing typed) and `objects_listing` (title search,
  counts per type, the trash). ⌘K's search takes 4–72 ms.
- The calendar reads only the objects that may fall in its range (`calendarObjects`), and a query
  filtered by when objects were made or changed reads only those around then (`timeBounds`).
- Views draw 200 objects per group and more as the page scrolls.

## Testing

`packages/server/test/convergence.test.ts`: the real server, two or three devices with a replica
and a tab over HTTP take a seeded random sequence of steps: going offline and back, text and field
edits, trash and restore, objects and captures made offline, an app closed halfway through a sync,
the server capturing, an agent's edits. Then everyone syncs until quiet, and every replica's rows,
clocks and text must equal the server's, outboxes must be empty, nothing refused, and every field
must hold the newest value a user gave it. Everything random comes from the seed, so a failure
replays exactly.

```sh
pnpm test                                       # 6 seeds of 150 steps
VASTA_SEEDS=1000 pnpm vitest run convergence    # a thousand (~70 s)
VASTA_SEED=<n> VASTA_LOG=1 pnpm vitest run convergence   # replay one, with its steps
```

Also: `packages/core/test/sync.test.ts` and `store.test.ts` (the store on node:sqlite and on
sqlite-wasm), `packages/server/test/sync.test.ts` and `replica.test.ts` (two devices against the
real server), and `scripts/browser-checks/` for flows in real browsers.

## Not yet

- **Live collaboration**: two people typing in one note see each other only after a sync, not
  keystroke by keystroke, and there is no presence
  ([#22](https://github.com/ariedotme/vasta/issues/22)).
- Over HTTP (no replica) the editor saves JSON, not Yjs, so `mergeCaptures` stays.

## Choices

- **Yjs for text, per-field clocks for the rest**, rather than **Automerge** for everything: a
  lighter runtime and a better ProseMirror integration.
- **Not cr-sqlite**: row merging inside SQLite is elegant, but text still needs Yjs, and the
  project's maintenance is uncertain.
- **Not ElectricSQL, PowerSync or Zero**: they are built around Postgres; Vasta's server is one
  SQLite file, which suits a homelab.
- **Not Replicache**: its own storage instead of SQLite, and its server protocol to implement
  anyway.

Known risks: OPFS storage can be evicted on iOS when the web app is not installed; the server
stays the source of truth, so that costs a download again, not data (except unsent changes).
