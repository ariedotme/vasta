# Local-first sync: plan

Status: steps 1, 2 and 4 built (2026-10-19, see "Step 1 as built", "Step 2 as built", "Step 4a
as built", "Steps 4b and 4c as built"); steps 3 and 5 planned. Written 2026-10-18
after accounts, Docker and the PWA (Phase 6, steps 1–3). Read with `docs/data-model.md` and
`docs/accounts.md`.

**Order decided by Arie (2026-10-19): offline editing on the iPhone matters more than two people
in the same note at once.** So after steps 1 and 2 (the base either way) comes step 4, the local
replica, and only then step 3, collaborative editing online: 1 → 2 → 4 → 3 → 5.
**Step 3 is deferred (Arie, 2026-10-19):** after step 4 come a faster first sync and showing
refused changes, then step 5; live collaboration stays noted for later.

**Step 4 in two deliveries (Arie, 2026-10-19):** 4a, the store refactor (invisible, shipped on its
own), then 4b and 4c together: the replica in the browser with reads *and* offline edits, shipped
as one, rather than a read-only replica first. **Subscribed calendars work offline too:** the
replica keeps their iCalendar data, so the calendar shows subscribed events without a network.

## Goal

Every client (the web app/PWA now, Tauri later) keeps a full replica of the spaces its user is a
member of, reads and writes it locally, works offline, and syncs with the server when it can. Two
people editing the same note in a shared space see each other's changes merge, never overwrite.

What stays on the server only: accounts, sessions and membership; capture channels (Telegram,
capture API); fetching link previews, readable text and calendars; the media store. The server is
also a regular sync peer: when it captures into a daily note or enriches a weblink, that change
reaches clients the same way an edit from another device does.

## Today

- The UI reads and writes through `packages/web/src/lib/api.ts` (HTTP), which was always meant to
  be the seam: the same functions can be answered by a local store.
- Records are saved whole (`PUT /api/objects/:id`). Concurrent edits are last-writer-wins on the
  whole object, except for capture blocks, which `mergeCaptures` re-appends when an older copy is
  saved over a daily note.
- `@vasta/core` already holds what a client needs: the model, the SQLite schema (`SCHEMA_SQL`,
  idempotent `ADDED_COLUMNS`), `runQuery`, calendar expansion, `objectLinks`/`docToPlainText`.
  `NodeStore` is bound to `node:sqlite`.
- The editor schema (TipTap extensions: callout, group, columns, objectEmbed, mention…) lives in
  `packages/web/src/editor/extensions.ts`; the server only sees ProseMirror JSON.

## Design

### Two kinds of data, two merge rules

1. **Rich text** (`ObjectRecord.content[field]`): one **Yjs** document per object, with one
   `Y.XmlFragment` per rich-text field, edited through TipTap's collaboration extension
   (y-prosemirror). Concurrent edits merge character by character, and the server appending a
   capture block is just another Yjs transaction, so `mergeCaptures` goes away.
2. **Everything else** (object title, props, tags, date, icon, deletedAt; types; space name and
   sidebar; calendar sources): **field-level last-writer-wins** with a hybrid logical clock (HLC)
   per field. Two people changing different properties of the same object both win; the same
   property, the later change wins. Arrays that are edited as a whole (a type's properties, the
   sidebar) are one field each in this first version.

Deletes stay soft (`deletedAt` is an LWW field), so a delete racing an edit resolves like any
other field and can be undone from a trash view later.

### Server

- New columns: `rev INTEGER` on `spaces`, `types`, `objects`, `calendar_sources`, assigned from one
  global counter on every change (a change log in disguise: "everything with rev > N"), and
  `clock TEXT` (JSON: field → HLC). New table `object_docs (object_id, ydoc BLOB)` holding the
  merged Yjs state; `objects.content` stays as derived JSON for search (FTS), backlinks, previews,
  queries and the export.
- `GET /api/sync/pull?space=…&since=<rev>`: rows with a higher rev (with their clocks), plus, for
  objects whose text changed, the Yjs updates the client lacks (it sends its state vectors).
- `POST /api/sync/push`: a batch of field changes with HLCs and Yjs updates per object. The server
  checks membership per row, merges (LWW per field, `Y.applyUpdate` for text), re-derives
  content/FTS/links, bumps revs, and announces the new rev on `/api/events` so other clients pull.
- The capture service and weblink enrichment write through the same merge functions, with the
  server's own HLC.
- The editor schema moves to a shared package (`packages/editor-schema`, plain TipTap/ProseMirror
  extensions without Vue views) so the server can turn Yjs into JSON and JSON (captures, imports)
  into Yjs.

### Client

- `@sqlite.org/sqlite-wasm` in a dedicated worker with the OPFS "SAH pool" VFS (works in Safari
  16.4+ and Chromium, no cross-origin isolation needed). It runs the same `SCHEMA_SQL`.
- `NodeStore`'s queries move into core behind a tiny database interface (`prepare/all/get/run`),
  so the node store and the wasm store share one implementation.
- `api.ts` keeps its function list and answers from the local store. Writes go to the local store
  and to an **outbox** table; a sync loop pushes the outbox and pulls when online or when
  `/api/events` says the rev moved.
- Things only the server can do (save a weblink and fetch its page, subscribe a calendar, upload a
  file, log in) stay HTTP calls and simply fail or wait while offline.
- On logout, the local database is deleted along with the service worker caches.
- When a user loses access to a space, the next pull says so and the client drops that space.

### Upgrades

Clients keep using the idempotent schema pattern. Each sync request carries a protocol version;
when the server no longer speaks the client's version, the client keeps its outbox, wipes the
replica and pulls everything again (the replica is a cache of the server plus unsent changes).

## Steps (each one shippable)

1. **Revs and clocks on the server**: columns, global counter, HLC helpers in core, `pull`/`push`
   for metadata with LWW, tests with two simulated clients. The app keeps working as today.
2. **Shared editor schema** package; server-side JSON ↔ Yjs; convert every stored document to Yjs
   once (keeping the JSON); captures and weblinks write Yjs; `mergeCaptures` retires.
3. **Collaborative editing online**: TipTap collaboration in the editor, text synced through the
   push/pull endpoints (a WebSocket for live typing and presence can come later).
4. **Local replica**: store refactor, wasm store in a worker, `api.ts` on top of it, outbox and
   sync loop, offline indicator.
5. Cleanup: remove the old whole-object `PUT`, update the export and importer to the new columns.

Step 1–2 are invisible to the user, step 3 already gives "two people in the same note", step 4
gives offline editing. Built in the order 1 → 2 → 4 → 3 → 5 (see the top).

## Step 1 as built

Code: `packages/core/src/sync.ts` (HLC, fields, merge; unit-tested in `core/test/sync.test.ts`),
`NodeStore` (revs, clocks, tombstones, `syncChanges`), `packages/server/src/sync.ts` (pull and
push), routes in `app.ts`; two simulated clients in `server/test/sync.test.ts`.

**Revisions.** `rev` and `clock` columns on `spaces`, `types`, `objects`, `calendar_sources`; one
global counter in `meta` (`sync.rev`). Every write through `NodeStore` (`putSpace`, `putType`,
`putObject`, `putCalendarSource`, `setSpaceDeleted`, the deletes and restores that call them, a
`recordCalendarSync` that changes the visible status) takes the next rev in the same transaction,
so the ~30 write sites of the server got revs without changes. After the transaction commits the
store announces the newest rev per space (`NodeStore.onRev`); the app sends it on `/api/events`
as an SSE event named `rev` (`{ kind: 'rev', spaceId, rev }`), apart from the `change` events the
web app listens to. Rows from before sync (or written by an older version after a rollback) are
backfilled on open: every field stamped at the row's `updatedAt` (or `createdAt`).

**Tombstones.** `sync_tombstones (kind, id, space_id, rev)`: written by `purgeObject`, `purgeType`
(and so the 30-day trash purge) and `deleteCalendarSource`. Writing a row again removes its
tombstone. Purging a whole space drops its tombstones: nobody is a member any more, so the space
just leaves every client's `spaces` list. Soft deletes (`deletedAt`) are ordinary fields.

**HLC.** `<ISO time>-<counter, 4 hex>-<node id>`, e.g. `2026-10-19T03:12:45.120Z-0002-server-1a2b3c4d`;
sorts as text. `HybridClock.tick(now)` for local writes, `receive(remote, now)` for remote ones
(refuses HLCs more than 24 h ahead: `MAX_CLOCK_DRIFT_MS`), `observe(stored)` to move past values
already stored. The server's node id is `server-<8 hex>`, kept in `meta` (`sync.node`).

**Fields** (`PLAIN_FIELDS`, `MAP_FIELDS`): objects `typeId`, `title`, `description`, `icon`,
`coverUrl`, `aliases`, `tagIds`, `collectionIds`, `date`, `query`, `media`, `deletedAt`, and each
`props.<id>` and `content.<id>` on its own (rich text whole until step 2); types `name`,
`pluralName`, `description`, `icon`, `color`, `properties`, `views`, `deletedAt`; spaces `name`,
`icon`, `sidebar`, `nutrition` (food tracking and meals, 2026-10-20), `deletedAt`; calendar sources `name`, `url`, `color`, `username`, `enabled`
(the password and the fetched data stay on the server). `typeId` is a field because `PUT
/api/objects/:id` may change it within the space. Ids, `spaceId`, a type's `system` and
`createdAt` never change; `updatedAt` follows the writes. Values are JSON, `null` = absent.
Whole-record writes (the app's PUTs, captures, imports) stamp the fields that differ from the
stored row (`stampChanges`, comparing canonical JSON).

**`GET /api/sync/pull?protocol=1&since=<rev>&limit=<n>[&space=<id>][&count=1]`** (limit 1–1000,
default 500; `count=1` adds `remaining`, the rows and tombstones left after the page, for the
progress of a first sync) →

```json
{ "protocol": 1, "rev": 318, "more": false,
  "rows": [{ "table": "objects", "id": "…", "spaceId": "…", "rev": 317,
             "clock": { "title": "<hlc>", "props.status": "<hlc>" }, "record": { "…": "…" } }],
  "tombstones": [{ "table": "objects", "id": "…", "spaceId": "…", "rev": 318 }],
  "spaces": ["…"] }
```

Rows and tombstones together, ordered by rev. With `more`, `rev` is the last one returned and
the client pulls again from it; otherwise `rev` is the server's current rev. `record` is the model
type (`ObjectRecord` with `content`, `ObjectType`, `Space`, `CalendarSource` without the password).
`spaces` lists what the user can see now: a space that disappears was left or deleted (drop it);
a space that appears (just shared, or restored from the trash) has rows older than `since`, so the
client pulls it once with `space=<id>&since=0` and keeps its own cursor.

**`POST /api/sync/push`** `{ "protocol": 1, "changes": [{ "table", "id", "spaceId"?, "createdAt"?,
"fields": { "<name>": { "value", "hlc" } } }] }` (at most 1000 changes) →
`{ "protocol": 1, "rev", "changes": [{ "table", "id", "lost": ["title"], "error"? }] }`.
Each change is checked on its own and refused whole with an `error` (nothing of it kept) when:
the table or a field is unknown, the field is not the client's to change (objects' `media`;
spaces' `deletedAt`; calendars' `url` and `username` — those go through their HTTP routes), a
value has the wrong shape, an HLC is invalid or too far ahead, the row is in a space the user is
not a member of (`not found`), it would move to another space, it was purged (`deleted for good`),
or it is new and not an object or a type (spaces and calendar subscriptions are created over
HTTP). New objects need a `typeId` of their space; new types a `name`. Otherwise every field
whose HLC is newer than the stored one is taken (same HLC: the same write again, ignored);
`lost` names the others, whose newer values the client gets on its next pull. The server
receives every HLC into its clock, so its own later writes sort after them. Pushes re-derive
search and links (`putObject`), bump the rev and announce the rows on `/api/events` like any
other write. A push applies exactly what it carries: cascades (a type's objects going to the
trash with it, an object's type coming back with it) are the client's job, as the shared store
will do them locally in step 4.

An unknown `protocol` (or none) answers 409 with `{ protocol: 1 }`: the client resets its replica
("Upgrades").

Measured: backfilling 5,000 objects takes 0.2 s on open, a full pull of them 0.1 s (11 pages);
writes are ~10% slower than before.

## Step 2 as built

Code: `packages/editor-schema` (`src/index.ts`: the schema's TipTap extensions, `vastaSchema()`;
`src/yjs.ts`: JSON ↔ Yjs), `NodeStore.putObject` and `convertText`, `packages/server/src/sync.ts`
(text in push, `textVector` in pull, `textUpdates`), tests in `editor-schema/test/schema.test.ts`,
`core/test/sync.test.ts` and `server/test/sync.test.ts` ("sync of rich text").

**Shared schema.** `@vasta/editor-schema` holds the nodes and marks without Vue views or app state
(StarterKit as configured, task lists, tables, details, highlight, callout, group, columns,
objectEmbed, unsupported, mention). The web editor extends them (`CalloutView`, `ObjectEmbedView`,
`MentionView`, the `@` suggestion, palette classes on groups and highlights) and adds its plugins.
A test builds the web editor's extensions (views stubbed) and checks that both schemas have the
same nodes, marks, attributes with defaults and content expressions. The package's root entry has
no Yjs, so the web bundle did not grow; `./yjs` is for the server (and the client store of step 4).

**Storage.** `object_docs (object_id, ydoc, vector, rev)`: one Y.Doc per object, one
`Y.XmlFragment` per rich-text field named by the property id (`body`, `article`…), the layout
TipTap's collaboration extension reads. `objects.content` is derived from it: the JSON as the
editor would save it (every attribute with its default; empty documents are absent). `vector` is
the Y.Doc's state vector, so pulls hand it out without decoding documents. Yjs runs with garbage
collection on (the server keeps no history). A change that only deletes (text, or a mark's
formatting) does not advance a state vector, so devices would not see they lack it: when a save
leaves the vector as it was but the delete set changed, the server bumps a counter in the Y.Doc's
`vasta` map (`markDeletions`, not a text field), and devices fetch the update with its deletions
(fixed 2026-10-19; before, a word deleted on one device stayed on the others until the next
insertion).

**Writes.** Every `putObject` goes through the Y.Doc, so the ~30 write sites did not change: the
fields whose JSON changed are diffed into their fragment (`updateYFragment` from `@tiptap/y-tiptap`,
the y-prosemirror fork TipTap 3's collaboration uses), so unchanged blocks and text keep their
Yjs items and concurrent edits elsewhere still merge; the stored JSON is read back from the Y.Doc,
and `putObject` returns the object as stored. Captures, weblink readable text and the inbox's
done flag are diffs from the current text, so they are exact.

**The app's whole-object `PUT` keeps `mergeCaptures`.** A three-way merge (the client's base
version against the current text) would need the base's content, and the app's save loop resends
an older base after a save it made itself while the user kept typing, which a three-way merge
would apply twice (duplicated text). So the PUT stays what it was — the client's document wins,
with items captured meanwhile re-appended — and is then diffed into the Y.Doc. It retires with the
PUT in step 5; Yjs clients (steps 3–4) never go through it.

**Conversion.** On open, objects whose Y.Doc is missing or whose `object_docs.rev` differs from
the object's rev (written by a version without Yjs, e.g. after a rollback) get one from their
JSON; the JSON is rewritten normalized and the clock loses its `content.<field>` entries; revs do
not move. Rows whose JSON the schema cannot read (an unknown node type) are logged and left as
they are. Checked on copies of `data/` (283 objects: 0 errors; 41 documents normalized, all of
them by defaults filled in, text nodes joined or marks reordered — no text, attribute or mark
lost; Yjs → JSON gave back the normalized JSON for every one) and `data-prod/`. 5,000 objects
convert in 0.6 s; a write is ~0.15 ms slower; saving a 300-paragraph note takes ~11 ms.

**Protocol 2.** `content.<field>` is no longer a field (pushing one is refused: `content.body
cannot be changed by a client`). Pulled object rows carry `textVector` (base64 state vector of
the object's text). A push change may carry `text`: a base64 Yjs update made on top of what the
client pulled, alone or with `fields` (an object can be created with both); it is refused when it
does not decode, is larger than 8 MB, or builds on changes the server never received (`pull
first`). A text change sets `updatedAt` to the server's time, bumps the rev, re-derives content,
search and links.

**`POST /api/sync/text`** `{ "protocol": 2, "objects": { "<id>": "<state vector, base64; empty
for all of it>" } }` (at most 1000) → `{ "protocol": 2, "objects": { "<id>": "<update, base64>" } }`:
what the client lacks. Objects outside the user's spaces or unknown are left out. A client asks
for the objects whose pulled `textVector` holds changes its own Y.Doc lacks.

## Step 4a as built

Code: `packages/core/src/store.ts` (`Store`, `SqlDatabase`), `store-node.ts` (`NodeStore`),
`sql-wasm.ts` (`wasmDatabase`), test `core/test/store.test.ts`.

**One store on any SQLite.** `Store` holds everything the replica needs: spaces, types, objects,
calendar sources, the trash, revs, clocks, tombstones, `syncChanges` and the Yjs documents
(`putObject`'s diffing into `object_docs`, `loadText`, `textVectors`). It talks to SQLite through
`SqlDatabase` (`exec`, `prepare` → `all/get/run`, `close`), which node:sqlite's `DatabaseSync`
satisfies as it is. Its constructor opens the schema (`SCHEMA_SQL`, `ADDED_COLUMNS`, indexes,
foreign keys) and the HLC node id (`<node>-<8 hex>`, from `crypto.getRandomValues`; the server's
stays `server-…`). No Node imports, so it runs in a browser worker.

`NodeStore extends Store`: opens node:sqlite with WAL, runs the server's one-time migrations
(`backfillSync`, `convertText`, `fixTaskStatuses`, now `protected` in `Store`) and adds accounts
(users, members, sessions, login failures, tokens), which never sync. The server and its tests
did not change; `store.db` is still the `DatabaseSync` there.

**sqlite-wasm.** `wasmDatabase(db)` adapts an oo1 `Database` of `@sqlite.org/sqlite-wasm`
(3.53.4-build2, a dev dependency of core for now; the web app adds it in 4b). The test runs the
same scenarios on node:sqlite and on sqlite-wasm in Node (in memory): FTS5 search, `LIKE …
ESCAPE`, `json_each`/`json_extract`, blobs (Yjs documents, state vectors), sync paging,
tombstones, the trash with a type and its objects, a rolled-back transaction. Both behave the
same.

## Steps 4b and 4c as built

Code: `packages/core/src/client-store.ts` (`ClientStore`), `sync-client.ts` (`SyncClient`,
`httpTransport`), `operations.ts` (what routes and replica share), `packages/web/src/replica/`
(`worker.ts`, `protocol.ts`), `packages/web/src/lib/replica.ts` (the app's side), `lib/api.ts`
(local or HTTP per call), `editor/DocEditor.vue` + `extensions.ts` (Collaboration),
`views/ObjectPage.vue`. Tests: `server/test/replica.test.ts` (two devices on sqlite-wasm against
the real app).

**Worker.** A dedicated module worker opens sqlite-wasm on OPFS with the "SAH pool" VFS (directory
`.vasta`, file `/replica.db`) and a `ClientStore` on it, and runs the sync loop. It first takes a
Web Lock (`vasta-replica`) for its lifetime: a second tab does not touch OPFS and works over HTTP
as before (sqlite-wasm deletes the pool's directory when installing fails, which could take
another tab's replica with it). The replica belongs to one user (`meta` `replica.user`); another
user logging in wipes it, logging out wipes it. Where it cannot run (no OPFS: private browsing,
Playwright's ephemeral WebKit) the app talks to the server as before. Two switches turn it off:
`localStorage['vasta.replica'] = 'off'` on one browser, `VASTA_REPLICA=0` on the server (header
`x-vasta-replica: off` on `/api/auth/me`) for every app.

**Client store.** `ClientStore extends Store`, so local writes are the store's ordinary methods,
stamped with the device's HLC (node `web-<hex>`). Two hooks in `Store` (`stamped`, `textSaved`)
fill `sync_outbox` with the pushable fields that changed and `#text` for text; values are read from
the row when pushing, so a field edited ten times goes once. A pulled row merges field by field
like the server's push (newer HLC wins), so a local change not pushed yet survives; `updatedAt`
follows the newest, a calendar's status follows the server. Rich text: the replica keeps the
server's state vector per object (`sync_text`); a push sends the Yjs update beyond it, a pull asks
`/sync/text` for objects whose `textVector` has what the local document lacks. A text push the
server refuses as "pull first" resets the vector and goes again in full. Other refusals drop the
change (reported in the status as `refused`). Pull pages apply in one transaction each, in
revision order with tombstones; spaces missing from `spaces` are dropped; a space joined later is
pulled whole (`space=` from 0). The store also does what the HTTP routes do (`createObject`,
`saveObject`, `trashType`, `dailyNote`, `markCaptureDone`, `inbox`, `query`, `calendar`…), with the
shared rules in `operations.ts` (the server's routes use them too).

**Saving fields.** `saveObject(object, at, base)` writes only the fields that differ from `base`,
the copy the page started from, so a change pulled while the page was open is not undone. Rich
text and media are never written by it.

**Editors on the Y.Doc.** The object page opens a text session (`openText`): a Y.Doc in the main
thread, started from the replica's document, which the worker keeps in memory while open. The
editor uses TipTap's Collaboration extension on it (undo follows Yjs: this device's edits only).
Its updates go to the worker, which writes them in batches of 200 ms (and at once when the page is
hidden: iOS may suspend it); every other change to that document (a pull, a capture marked done)
comes back as a Yjs update. So text pulled while typing merges instead of being overwritten.
Without a replica the editor works on JSON as before. Yjs loads with the first editor.

**api.ts.** Same functions. With the replica ready: reads and the writes above are local; what only
the server can do (save or refresh a weblink, upload, delete for good, empty the trash, spaces,
members, calendar subscriptions) syncs first (the server may need this device's changes), calls
the server, and syncs again so the result is in the replica. Offline those fail with "This needs a
connection to the server." A record missing locally (a capture a moment ago) pulls once and looks
again.

**Sync loop.** On start (the first time in the background while the app works with the server:
see "Big spaces" below), shortly after local writes, on the server's `rev` event (SSE), on `online` and when the page
becomes visible, every 10 s while the offline banner shows, and on failure with backoff up to a
minute. With the replica the app's views take their change events from the worker (local writes
and pulls), not from the server's `change` events. The offline banner says changes are kept on
the device (with how many rows wait). A 409 (the server speaks a newer protocol) does **not** wipe
the replica: syncing stops and the app asks to reload, keeping the outbox for the new version (the
plan said "wipe and keep the outbox"; the outbox only names rows, so it survives as it is).

**Subscribed calendars.** Rows carry `dataVersion` (a hash of the iCalendar data, bumped with the
rev when the data changes); the replica downloads `GET /api/sync/calendars/:id` when its copy is
older and expands events itself (`ClientStore.calendar`), so the calendar works offline.

**Daily notes.** New daily notes get the id `daily-<spaceId>-<day>` (`dailyNoteId`); two devices
opening the same day offline create the same row, and their texts merge. If that id is taken by a
note in the trash, a new one gets a random id, as before. A push may recreate a purged daily note.

**Service worker.** `/api/sync/` is never cached (the replica must not take an old answer for a new
one). The worker script and the `.wasm` are assets cached on first use, so the installed app starts
offline: the shell from the cache, `/api/auth/me` from the API cache, data from the replica.

**Measured.** Test data (283 objects): first login with the full pull 2.9 s, reload 0.2 s, in
Chromium on the Mac. 5,000 objects in Node on sqlite-wasm (in memory): first sync 9.9 s, a sync
with nothing new 1 ms. Bundles: worker 857 kB + wasm 869 kB (loaded only by the worker), main
chunk +6 kB, object page +27 kB (Collaboration).

**Checked in browsers** (test env, Playwright 1.64.1): Chromium (dev and built) and WebKit with
the iPhone 15 profile (persistent context, built app with the service worker): reads without the
server, typing reaches the server, offline edits of title and text, reload offline, back online
everything arrives, a capture arriving while typing in the daily note shows live and both survive,
a title changed elsewhere shows on the open page; every screen, search, trash and Undo, a second
tab (over HTTP) and the first see each other's edits, logout and login; slash menu, mention, undo,
moving a block, image upload; a weblink created locally and fetched by the server. The same tours
pass with the replica off.

## Replica polish as built (2026-10-19)

**Faster first sync.** Measured with `packages/server/test/firstsync.bench.test.ts`
(`VASTA_BENCH=1 pnpm vitest run firstsync`; 5,000 objects of 5 paragraphs, sqlite-wasm in memory)
and `scripts/browser-checks/firstsync.mjs` (the test env with 5,000 extra objects). Where the
time went, and what changed:

- `objects_fts` was looked up by `object_id`, a column FTS5 does not index: every write of an
  object scanned the whole index, and so did the join that reads previews in lists (listing 2,000
  objects took 400 ms on the server). `search_rows` now gives each object's index row a fixed rowid
  (`docs/data-model.md`, "Derived data"). This was most of it, and it helps the server as much.
- A pulled object was written twice, first with an empty Y.Doc, then again with its text. Now a
  pulled row is written without touching the text (`Store.putObjectRow`: the JSON stays what the
  local document gives, an empty document for a new object), and the JSON, search and links are
  derived once, when the text arrives. A Y.Doc is never built from the pulled JSON.
- A `/sync/text` batch is applied in one transaction instead of one per object (on OPFS every
  commit is a sync write); state vectors are read from `object_docs.vector` instead of loading
  documents.
- `wasmDatabase` keeps prepared statements (the 256 most recently used): preparing every call
  was a good share of the time in wasm.
- `loadYDoc` passes a guid: Yjs's default draws a UUID with 31 calls to `getRandomValues`.

First sync of 5,000 objects: Node 10.4 s → 1.3 s; Chromium 25.6 s → 2.0–2.5 s; WebKit (iPhone 15
profile) 12.0 s → 2.0 s. Test data (283 objects) in Chromium: 2.9 s → 0.8 s. Reload 0.2 s as before.
The first pull still fetches text in separate requests (`withText` on `/sync/pull` was not needed).

**Refused changes.** A change the server refuses still leaves the outbox (sending it again would
fail again), but it is kept in `sync_refused` with the row's title and the reason, listed in
Settings › This device until dismissed (one by one or all), and the sync that met it tells the app
(`refused` worker event), which shows a toast once with a link to Settings. The device keeps its
own value: a later pull does not overwrite a field whose local HLC is newer, so the row stays
different from the server's until either side changes that field again (the list says so).
Checked with `scripts/browser-checks/refused.mjs` (the push answered with refusals by Playwright).

## Big spaces (2026-10-22)

Measured with `pnpm load-test 50000 --keep` and `scripts/browser-checks/scale.mjs` (51,112 rows,
183 MB; Chromium on the Mac).

**The app does not wait for the first sync.** It used to: the first login showed nothing for 113 s.
Now the worker opens the replica and fills it in the background while every call goes to the
server (`useReplica()` is false until the replica is `ready`); when the fill is done, calls move to
the replica as when a tab takes it over from another (a page already open keeps saving its text
to the server). The app shows 1 s after login. A quiet strip at the top says a copy is being made
("4,000 of 21,112"; `count=1` on the first page of the pull), once the fill has run 2 s, so a
small space never flashes it; Settings › This device says the same, and that it is paused while
offline. A fill brings no change events: the app showed the server's data meanwhile.

**A fill can stop and go on.** The replica is `ready` once a fill finished (`meta` `sync.filled`;
replicas filled before have none and count as filled), not as soon as one page is in. A fill that
stopped halfway (offline, the tab reloaded) goes on from its cursor in the next sync. The spaces of
a pull from 0 are marked complete with its first page, not at its end: before, a fill that went
on in a later sync pulled every space again from 0 as if it had been joined later.

**Each object written once.** The text of a page's objects is fetched before the page is written
(`SyncClient.applyPage`, `ClientStore.textToFetch`) and written with the rows in the same
transaction (`putObject` with the merged clock and the Y.Doc); before, every row was written, and
then again with its text in a later phase. If the text does not come, the rows go in without it
and a later sync fetches it, as before. Pages are 1,000 rows (the server's most): on OPFS every
commit costs. A write nobody made (the replica applying pulled rows) keeps the authors the row
carries (`withAuthors`).

Fill of 51,112 rows: 113 s (blocking the app) → 42 s in the background; in Node on sqlite-wasm in
memory 19.6 s → 12.9 s. The rest is OPFS writes
([#4](https://github.com/ariedotme/vasta/issues/4)).

**Reads that do not touch the rows.** On the replica, a query that reads the `objects` table
whole costs 1–2 s at 50,000 objects (72 MB of rows with their JSON, read a page at a time from
OPFS; the server's page cache hides it). Two indexes keep the common ones off the table:
`objects_updated` (⌘K with nothing typed: the most recent) and `objects_titles` (space, trash,
type, title, aliases: the title search finds its matches in the index and reads only the rows
shown; counts per type and the trash's count for the sidebar). ⌘K's search 930 ms / 823 ms → 4 ms /
72 ms; `spaceBundle` on every start 1.2–2.8 s → 70 ms.

**Reading only what can match.** The calendar reads the objects that may have a date in the range
(`calendarObjects`: their own date within it, a couple of days wider for time zones, or repeating;
and every object of a type with a date property), not the whole space; a query whose filter says
when objects were made or changed (`createdAt`/`updatedAt` is, before or after a day, joined by
"and" at the top: the day view's "created today") reads the objects around then (`timeBounds`).
The filters still decide in JS, so the answers are the same (tests compare them with reading
everything). On the replica a month of the calendar 1.8 s → 1.0 s (it still reads every task),
"created today" 1.8 s → 11 ms; on the server the calendar 394 → 100 ms.

**Long lists.** A view draws 200 objects per group and more as the page scrolls to the end
(ObjectCollection; the board draws all); sorting, grouping and filters see every object. The
Pages type page with 30,000 objects 3.4 s → 1.4 s; what is left is reading them (1.3 s on the
replica).

**Compression.** JSON answers of `/api/*` are gzipped for clients that ask (browsers do): a pull
page 1.5 MB → 220 KB (a full sync of 50,000 objects 79 MB → about 11 MB), a type's 30,000 objects
18.8 MB → 3.5 MB, a month of the calendar 4.2 MB → 290 KB. The event streams stay as they are.

## Step 5 as built (2026-10-19)

The plan said "remove the old whole-object `PUT` and `mergeCaptures`", but the app keeps working
without a replica where it cannot run (a private window, `VASTA_REPLICA=0`, a moment in a second
tab), and that mode saves with the `PUT`. Of the two ways weighed, Arie chose (a), the small one:

- **`PUT /api/objects/:id` with a base.** The app sends `base`, the copy the page started from,
  with the object (`api.saveObject(object, base)`); the server writes only what differs from it:
  fields as on the replica (`applyEdit` in `operations.ts`, which `ClientStore.saveObject` uses
  too), rich-text fields whole when their JSON changed (still through `mergeCaptures`, so items
  captured meanwhile are kept). A rename made on another device while a page is open is no longer
  undone by that page's next save. Without `base` (an app from before it) the body replaces the
  object as before. The other option, (b) editors on Yjs in HTTP mode too (so `mergeCaptures` could
  go), waits for step 3, which needs that anyway.
- **A second tab takes the replica over.** A tab that finds the replica held by another (Web Lock
  `vasta-replica`) works over HTTP and keeps its worker waiting for the lock; when the other tab
  closes, it opens the replica and the app's calls move to it. Before installing the pool, the
  worker opens each of the pool's files itself and waits while one is still taken: sqlite-wasm
  deletes the pool's directory when installing fails (`removeVfs`), and the closing tab may let go
  of its files a moment after the lock. An object page opened before the takeover edits its text as
  JSON, so it keeps saving through the server (`serverApi`) until it is left. `pauseVfs` was not
  needed: a tab gives the replica up only by closing (or reloading).
- **Export and importer.** Vasta has no export (only `vasta backup`). The Capacities importer still
  writes through `putObject` (fields stamped at the import time); Arie does not expect to import
  again and may remove the importer, so it was left as it is.

Checked with `scripts/browser-checks/httpsave.mjs` and `handover.mjs`.

## Alternatives considered

- **Automerge for everything**: one CRDT for rows and text, but a heavier runtime and a weaker
  ProseMirror integration than Yjs.
- **cr-sqlite** (CRDT extension for SQLite): elegant row merging inside SQLite, but rich text
  still needs Yjs, and the project's maintenance is uncertain.
- **ElectricSQL, PowerSync, Zero**: built around Postgres on the server; Vasta's server is one
  SQLite file, which suits a homelab.
- **Replicache**: mature client/sync model, but brings its own storage instead of SQLite and its
  own server protocol to implement anyway.

## Risks

- Yjs documents grow with history; keep GC on and compact the stored state on the server.
- The editor schema must stay identical on server and clients; unknown node types already map to
  `unsupported`, which keeps old clients from destroying newer content.
- OPFS storage can be evicted on iOS if the PWA is not installed; the server stays the source of
  truth, so eviction costs a re-download, not data (except an unsent outbox).
- Bundle size: sqlite-wasm adds ~1 MB; the icon set (5 MB) should be split first.

## Convergence test as built (2026-10-19)

Code: `packages/server/test/convergence.test.ts` (with `helpers.ts`'s `Device`, now able to
restart, and `seeded-random.ts`). The real app, two or three devices with a replica (editors on
their Y.Docs, pages as `ObjectPage.vue` keeps them) and a browser tab in HTTP mode take a seeded
random sequence of steps: offline and back, text edits (insert, delete, replace, marks and quote
highlights, split, join, move, colors, block ids, headings, new and removed blocks, with the
editor's block id fixes), field edits saved with a `base`, trash and restore, objects and captures
made offline, syncs awaited or left running, an app closed halfway through a sync, the server
capturing, the agent's `updateObject`, quotes made and deleted. Then everyone syncs until quiet,
and: every replica's rows, clocks and Yjs text equal the server's, open editors and pages show it,
outboxes are empty, nothing was refused, and every field holds the value with the newest HLC a
user or the agent gave it (a write nobody made, such as an old value saved back, fails it).
Everything random comes from the seed (Yjs client ids, UUIDs, HLC nodes, time is faked), so a
failure replays exactly. `pnpm test` runs 6 seeds of 150 steps (~0.6 s);
`VASTA_SEEDS=1000 pnpm vitest run convergence` runs a thousand (~70 s), `VASTA_SEED=n VASTA_LOG=1`
replays one with its steps, `VASTA_STEPS` makes runs longer. Checked: 1,000 seeds of 150 steps and
300 of 400.

What it found, each fixed with its own test:

- **The object page saved old values back** (`ObjectPage.vue`, both modes). After a save, the page
  kept its own copy of the fields and took the saved one as `base`; a field changed elsewhere
  meanwhile then differed between the two, so the next save wrote the old value back. Now the page
  takes the saved copy, keeping only what was typed during the save (`afterSave` in
  `operations.ts`), and reloads on a change whose `updatedAt` is not newer too (a merged offline
  edit may leave it as it was), in place. `scripts/browser-checks/httpsave.mjs` checks it.
- **A PUT read the row before its body** (`/objects/:id`, `/spaces/:id`, `/calendar-sources/:id`):
  a push landing while the body arrived was overwritten with the copy read before it. They read
  the body first now.
- **Text a sync did not get to was never fetched**: a pull applied the rows and moved its cursor
  before asking for their text; offline halfway, those objects were not pulled again, so their
  text stayed behind until they changed. The objects to fetch are kept in `meta` `sync.text` until
  their text arrives.
- **An edit that only deletes, made while a push was on its way, was dropped**: the push's answer
  compared state vectors to see whether the text changed meanwhile, and deletions do not move
  them. It compares Yjs snapshots (vector and deletions) now.
- **A day's note made on a second device overruled changes made to it**: opening (or capturing
  into) a day offline makes the note with that day's id, stamping every field anew, so when it
  synced its empty title and tags beat a title or tag set elsewhere earlier. A new daily note's
  fields are stamped at the epoch now (`hlcAt(undefined, node)`), older than any change.
- **Small differences**: a row made on two devices (a daily note) kept each device's `createdAt`
  (it follows the server now); a device kept HLCs of empty fields it never pushes (`media`), as a
  new row stamped every field (empty fields of a new row get none now).

Left as it is: a device's change that turns out to change nothing on the server (a block deleted
on two devices) keeps that device's `updatedAt` newer than the server's until the row changes
again; the test allows it.

