# Data model

Source of truth: [`packages/core/src/model.ts`](../packages/core/src/model.ts) (types) and
[`packages/core/src/schema.ts`](../packages/core/src/schema.ts) (SQLite tables).

## Concepts

**Space** — a separate knowledge base. Holds its own types, objects and sidebar. The sidebar is a
list of sections ("Pinned", user-made groups such as "Reading"), each an ordered list of type or
object ids; one id may sit in several sections, as in Capacities. A space is also the unit of access: users reach the spaces they are members of
(owner or editor), so a space is either private or shared as a whole (see accounts.md).

**User** — someone who logs in. Has a username, display name, password hash, and optionally a
time zone, a capture space and a linked Telegram user id. Not part of the synced note data.

**Type** — what kind of thing an object is (Book, Person, Meeting…). A type has a name, plural
name, icon, color, custom property definitions and saved views. Built-in types carry a `system`
key because the app gives them special behavior:

| system key   | behavior |
|--------------|----------|
| `daily-note` | one per day, opened from the calendar; capture channels append to it. New ones get the id `daily-<spaceId>-<day>`, so devices offline create the same one |
| `page`       | free-form document |
| `tag`        | lightweight label; every object has `tagIds`. Tags nest: a tag's `parentId` is the tag it sits under (#recipe/breakfast under #recipe; typing `recipe/breakfast` in the tag picker finds or makes each level), and a query filter "tags contains #recipe" takes objects tagged with any of its sub-tags too (`QueryContext.tagParent`; a cycle stops the walk). A tag's `color` colors its chips; one without takes its nearest parent's, else violet |
| `collection` | manual grouping; every object has `collectionIds` |
| `query`      | saved query (`ObjectRecord.query`) that renders as a live list |
| `task`       | status, due date and priority properties; feeds the task views |
| `weblink`    | saved URL with scraped metadata (`ObjectRecord.media`: `url`, `host`, `meta`, `previewImageUrl` and its local copy `previewImageFile`); the page's readable text lives in the rich-text field `article` ("Readable text", hidden while empty), apart from the user's notes in `body` |
| `date`       | a point or range in time that can be linked and has notes |
| `image`, `pdf`, `audio`, `video`, `file` | media objects (`ObjectRecord.media`) |
| `habit`      | something to do regularly. Built-in properties: `days` (select, "Repeat on": weekday ids `mon`…`sun`; none means every day), `target` (number, "Daily goal") with `unit` (text), `remind` (text, "Remind at", read loosely: "8h", "21:30") and `paused` (checkbox); `color` its color. A check-in is a prop of the habit itself, `done:<YYYY-MM-DD>` = checkbox true (a number, the amount reached, for a habit with a daily goal; the day is done once it reaches the goal), so each day is its own synced field and devices never overwrite each other's days. Streaks and rates (core `habits.ts`) count only the days it repeats on; today not done yet does not break a streak. Checked off beside Today, in daily notes, on the habit's page (a year of days) and in the Habits page's Tracker |
| `food`, `recipe`, `nutrition-goal` | food tracking, made in a space only when it turns it on (see [Nutrition](#nutrition)) |
| `sprint`     | a time box for tasks, made when a space turns sprints on (see [Sprints](#sprints)): `dates` (a date range), `goal` (text), named as the space calls them |
| `quote`      | a passage saved from an object's text ("Save as quote" on a selection): the passage is the title, `source` (relation, "Source") the object it came from, `body` an optional note. The passage keeps a highlight mark with the quote's id (`attrs.quoteId`); deleting the quote removes it (`Store.deleteObject`), and re-saving a weblink's readable text finds it again by its text |

Built-in type ids are `<system>:<spaceId>`; custom type ids are UUIDs. Types added to Vasta later
(Quote, 2026-10-19; Habit, 2026-10-20) reach older spaces when the server starts (`ensureBuiltinTypes`),
and so do properties added to a built-in type later (`ADDED_BUILTIN_PROPERTIES`), once each: one the
user deletes stays deleted. Optional built-in types (`OPTIONAL_TYPE_KEYS`: the nutrition ones) are
left out of both: a space gets them when it turns on what they are for. A type's `system` is not a
sync field; a built-in type a device makes offline and pushes is known by its id (`builtinTypeKey`).

**Property definitions** — `text`, `rich-text`, `number`, `checkbox`, `url`, `date`,
`relation` (links to objects of allowed types, single or multiple), `select`
(options with colors; an option with a `status` category drives task and kanban behavior),
`person` (members of the space by user id, single or multiple: see [People](#people)) and
`formula` (a value computed from the object's other fields, see [Formulas](#formulas)).
The built-in Task has `status`, `due`, `assignee` (a single person, added to older spaces once,
after Due) and `priority`.
Title, description, icon, cover, color, parent, aliases, tags and collections are fixed fields on
every object, not property definitions (`color` and `parentId` are only used by tags so far).

**Object** — one row in `objects`. Simple property values live in `props`; rich text lives in
`content`, keyed by the id of a `rich-text` property (built-in types use `body`). Objects that
belong on the calendar have a `date` (start, optional end, `day` or `time` resolution).

## People

Work tracked with others needs to say who: a `person` property holds members of the space
(`{ kind: 'person', value: [userId…] }`), shown by name and initials (`PersonChip`), picked from the
members (`PersonPicker`), set in a typed line by username or name (`assignee:ana`, `me`). Someone
who leaves the space keeps their place in the values; the app shows the name it last saw, else
"Former member". Queries compare person fields as ids; the `me` variable is the user looking
(`QueryContext.me`; the server's query route and the replica fill it in), so "Assignee contains
Me" is each member's own list. Sorting by a person sorts by name (`QueryContext.personName`);
formulas read people as their names.

Objects record **who made them and who changed them last**: `createdBy` and `updatedBy` (user ids,
columns `created_by` and `updated_by`), like `createdAt`/`updatedAt` not fields of their own and not
pushable. They are set where a user's write is applied: `Store.actor` names that user (the server:
the request's user through an `AsyncLocalStorage`, `server/src/actor.ts`, set by the auth
middleware, Telegram and scoped capture services; a replica: its user, for its own writes, not for
pulled ones). A write that changes nothing keeps the last editor, and a new object's `createdBy` is
always the actor's, whatever the client sent; the server's own jobs (purges, calendar syncs) record
nobody. A replica takes them from the server's rows on pull. Queries offer them as built-in fields
`createdBy` and `updatedBy`, formulas as "Created by" and "Last edited by". In a shared space the
object page says "Edited … by Ana", type pages have a **Mine** toggle (only what a person field of
the type names the user in; per type, kept on the device), and boards group by a person. In a
space with one member, empty person fields stay hidden on the object page.

## Comments

A discussion on an object, apart from its text ([`comments.ts`](../packages/core/src/comments.ts)):
each comment is a prop of the object, `comment:<id>` = `{ kind: 'comment', value: { author, at,
text, editedAt? } }`, without a property definition (as food entries are), so comments written on
several devices or offline all arrive and merge one by one, with no table of their own. Text is
plain; `@username` mentions a member (`mentionedPeople`), links are shown as links. **Only the
author** adds, changes or deletes a comment: the server's store refuses a user's write that does
otherwise (`commentAuthorshipProblem`, `WriteRefused`): `403` over HTTP, the change refused whole
in a push. The object page lists them under the text (`ObjectComments`; @ offers the members;
⌘ Enter sends; authors edit and delete theirs). They are not in full-text search or the activity
log. Agents read them in `get_object` and write with `add_comment`.

## Sprints

Time boxes for tasks ([`sprints.ts`](../packages/core/src/sprints.ts)), under the word a space
chooses: `Space.sprints` (`SprintSettings`: `enabled`, `name`, `pluralName`; "Sprint"/"Sprints"
when first turned on; a synced field like `nutrition`). `setSprints` (`POST /api/spaces/:id/sprints`
`{ enabled?, name?, pluralName? }`, and the replica's `ClientStore.setSprints`, offline too) makes
the optional Sprint type (or brings it back from the trash) under that name and, the first time,
gives the Task type the relation `sprint` (single, to the Sprint type, named like it) and two views:
"Current sprint" (a board by status, `sprint` contains the `current-sprint` variable) and
"Backlog" (no sprint, not done). A rename renames the type, the relation and that view when they
still carry the old name; turning it off hides it and deletes nothing, and turning it on again does
not bring back what the user deleted.

The **current sprint** is the one whose `dates` hold today (the latest to start when they overlap;
`currentSprint`): `QueryContext.currentSprint`, filled by `querySpace` and the app (`lib/sprints.ts`
keeps the space's sprints loaded), and `sprint:current` in a typed line. A sprint's
page shows its tasks by status, the days left, **Finish** (unfinished tasks move to the next sprint,
`nextSprint`, else back to the backlog; done ones stay) and **Next sprint** when there is none
(numbered after the last, the same length, starting the day after it ends: `followingSprintDays`).
Settings › Sprints turns them on and names them.

## Activity

What members did to objects ([`activity.ts`](../packages/core/src/activity.ts)): an `activity`
table (`id`, `space_id`, `object_id`, `at`, `actor`, `kind`: created, changed, trashed, restored;
`field`: title, typeId, date or a property id; `before` and `after` as JSON values). The server's
store records it inside `putObject`, for writes that have an actor (so the app, sync pushes,
captures and agents alike, and never imports or the server's jobs), with each field's time taken
from its HLC (a change made offline yesterday is dated yesterday). Rich text and formulas are not
activity, nor are props without a property definition (habit check-ins, food entries). The same
person changing the same field within 10 minutes makes one entry (typing a title), which goes away
when the value is back where it started.

**Not synced**: replicas never write it and read it over HTTP (`GET /api/objects/:id/activity`,
`GET /api/spaces/:id/activity?since&until&limit`, oldest first), so the service worker's last
answer is what shows offline. Keeping it on the server spares the sync protocol a fast-growing
append-only table with purges to replicate; a change made offline is recorded when it is pushed.

**Retention**: each space keeps activity for `activityRetention` days (meta
`activity.retention.<space>`; 90 by default; 30, 90, 180, 365 or 0 for forever), set by owners in
Settings › Space (`GET|PUT /api/spaces/:id/activity-settings`); the server deletes older entries at
start, every 6 hours and when the setting shortens. Purging an object or a space deletes its
activity. Flow metrics read the status changes, so they reach back only as far as the space keeps
activity. The object page lists it under **Activity** (folded), the values drawn as the properties
draw them.

## Flow metrics

A type with a status (a select whose options have `status` meanings: tasks) has a **Metrics** tab
on its page ([`metrics.ts`](../packages/core/src/metrics.ts), `GET /api/types/:id/metrics?from&to&timeZone`,
the last 30 days by default, at most 400). The server works them out from the activity's changes
of that select and the objects as they are: per object its status over time (where it started:
the first change's `before`, else where it is now), **cycle time** (first out of "to do" → done),
**lead time** (created → done), both as median, 85th percentile and average over what got done in
the range; **throughput** per week (Monday to Sunday); **cumulative flow** (per day, how many
were in each status category at its end); work in progress; and each open object's **age** in its
status (the oldest ten listed, past the 85th percentile cycle time marked). The charts are
`BarChart` and `FlowChart` (status categories in the reference palette's first three slots,
`--color-flow-*`, validated both modes; legend, values at the end, crosshair, table view). Metrics
reach back only as far as the space keeps activity (the page says so when the range is longer).

## Rich text

Documents are ProseMirror JSON so the editor (TipTap) and sync (Yjs via y-prosemirror) use them
directly. Besides the standard nodes (paragraph, heading, lists, task lists, blockquote,
code block, horizontal rule, table) Vasta defines the nodes below. A code block whose `language`
is `mermaid` is a diagram: the app draws it with [Pele](https://pele.run) and keeps the text.

- `mention` — inline link to an object (`objectId`, `label`)
- `objectEmbed` — an object shown as a block (`display`: inline, card, wide-card, embed)
- `callout` — block with an icon; with a `capture` attribute (`CaptureInfo`: id, channel, time) it is
  an item that arrived through a capture channel ([capture.md](capture.md))
- `details` / `detailsSummary` / `detailsContent` — toggle, optionally with an icon
- `group` — colored container
- `columns` / `column` — side-by-side layout, column width in percent
- `unsupported` — kept verbatim when an importer meets a block it cannot convert

Every block (a child of the document or of a container: paragraphs, headings, list items, callouts,
toggles…; `BLOCK_TYPES` in `@vasta/editor-schema`) has an `id`, 8 letters and digits, unique within
its document, so it can be linked to: `/o/<object>#b-<id>`. The editor gives blocks without one an
id on a local edit (old documents on their first edit, or when a link is copied); a split leaves the
id on the first half, and a duplicated or pasted copy of a block gets a new one. Blocks with text
(`COLOR_TYPES`) can have a `textColor` and a `background` (`ColorName`); a group's background is its
own `color`. Unset, these attributes are left out of the JSON (`compactDoc`).

A **mention** (`mention`: `objectId`, `label`, the object's title when it was made) can point to
one block: `blockId`, with the block's text then in `blockLabel` (its first words when it was
made); it opens `/o/<object>#b-<block>`. An **embed** (`objectEmbed`: `objectId`, `display`) with a
`blockId` shows that block only (`display: "block"`): a read-only copy that follows the original,
with Open going to it. Both are left out of the JSON while unset. Backlinks count them as a mention
or an embed of the object. A block picked to be mentioned or embedded gets its id then if it had
none (`Store.ensureBlockId`, `POST /api/objects/:id/block-ids` with `{ field, path }`; core's
`blocks.ts` lists an object's blocks and finds one by id).

## Derived data

`links` and `objects_fts` are rebuilt from an object every time it is written
(`Store.reindexObject`). `links` records every reference (mention, embed, relation, tag,
collection) and powers backlinks; `objects_fts` is the full-text index over titles and rich text.
Its `object_id` column is not indexed (FTS5 cannot), so `search_rows (id, object_id)` gives each
object's index row a fixed rowid: writes, purges and the joins that read previews go through it
instead of scanning the index (which made every write and every list O(n)). On open, the store
matches index rows to objects again when the two disagree (a database from before
`search_rows`, or written by an older version after a rollback).

## Queries and views

The engine is [`packages/core/src/query.ts`](../packages/core/src/query.ts): `runQuery` filters and
sorts object summaries, and is used by the server (`POST /api/spaces/:id/query`) and by type views.

A query selects objects by type (`typeIds`, empty = all), filters them with nested and/or groups,
and sorts and groups the result. Filter values are literals or variables resolved when rendering:
`parent` is the object the query is embedded in (optionally one of its fields), `today` is the
current date (shifted by `offsetDays`). Dates compare by day in the viewer's time zone; a daily
note's `createdAt` resolves to its date, as Capacities dates daily notes that way. Filters without
a value yet do not narrow the results. `me` is the user looking (for person fields). Views (`list`, `grid`, `wall`, `table`, `kanban`, `gallery`, `embed`) are display
settings saved on a type, or carried by a query object in `query.layout`.

A filter's `field` can go through a relation: `author.country` is the field `country` (a property
id or a built-in field) of the objects the relation property `author` points to; one level only.
When a relation points to several objects, a positive operator (`is`, `contains`, `before`,
`is-not-empty`…) matches when any of them matches, and a negative one (`is-not`, `not-contains`,
`is-empty`, `is-not-checked`) when none matches its positive form; trashed targets do not count.
`runQuery` reads the related objects through `QueryContext.related`: `querySpace` (server and
replica) loads them from the store, the type page from the app's summary cache.

The table layout's columns are `TableSettings` (`ViewDef.table`, `QueryDef.table`): an ordered list
of `{ field, width?, hidden?, wrap? }`, the field a property id or a built-in field (title, tags,
type, collections, createdAt, updatedAt, date, host). The title is always first. Fields the list
does not name (a property added later) come after the listed ones; without settings the table
shows the title, tags, the types' properties and last edited. Property cells edit their value in
place (`components/ObjectCollection.vue`, with the object page's `PropertyValueEditor`), except
formulas and rich text: a cell saves only its field (`setProperty` in `lib/actions.ts`, the fetched
object as the save's base), so a field changed elsewhere meanwhile is kept.

**Boards** (the `kanban` layout, `components/BoardView.vue`): a column per group of the view's
group field, with `ViewDef.board` / `QueryDef.board` (`BoardSettings`) for the rest:
`swimlanes` (a second grouping, in rows), `cardFields` (property ids the cards show; unset: the
first two with a value that are not the columns or lanes), `collapsed` (folded columns' group
keys) and `wip` (a column's limit by group key; its count turns red above it). Without a sort of
its own a board keeps a **manual order**: a card's place is the prop `rank`
(`{ kind: 'rank', value }`, no property definition; core `rank.ts`), a base-62 key between its
neighbours' (fractional indexing), so a move writes only that card and moves on two devices merge
(equal keys fall back to the ids); cards without a rank come after the ranked ones, newest first,
and get one when a card is dropped next to them. Dragging a card within a column of a board
sorted by a field puts the view back in the manual order. A drop writes the card's column and lane
values and its rank in one save (`lib/board.ts`); dragging uses pointer events, so a finger drags
after a long press (where phones also open a menu: not on boards) and a quick swipe scrolls. "+"
at the bottom of a column makes a card with that column's (and lane's) value. The built-in Task
also has `blocked` (checkbox, "Blocked", hidden when empty), which cards show as a red flag.

## Formulas

A `formula` property (`FormulaPropertyDef.expression`) is computed whenever it is read and never
stored in `props`: [`packages/core/src/formula.ts`](../packages/core/src/formula.ts) parses and runs
it, for the server (queries, agents) and the app (tables, cards, the object page) alike.

- Fields go in braces. The stored expression has ids (`{price} * {qty}`), so renaming a property
  keeps it working; Type settings shows and takes names (`{Price} * {Quantity}`,
  `formulaToNames`/`formulaFromNames`). Built-in fields: Title, Created, Last edited, Date, Tags.
  `{Author.Country}` reads a field of the objects a relation points to (one level, trashed ones
  skipped); `{Tasks}` alone is their titles. A formula can read other formulas; one that reads
  itself is an error.
- Values: numbers, text, true/false, dates, lists (a multiple relation or select, tags, a relation
  path) and errors. A select reads as its label. A field without a value leaves arithmetic empty,
  like a spreadsheet waiting for input; a list used as one value needs a function (`sum`, `join`…)
  unless it has a single item. Errors are values: one bad row shows "Error" in its cell.
- Operators: `+ - * / %` (`+` joins text; a date plus or minus days is a date; date minus date is
  days, by day in the viewer's zone), `= != < <= > >=` (text ignores case and accents), `and or not`.
  Functions are listed in `FORMULA_FUNCTIONS` (if, empty, round, sum, avg, count, min/max, join,
  contains, today, year…), shown in Type settings.
- Queries filter, sort and show formulas like other fields. The filter operators come from the kind
  of value read from the expression (`formulaKind`; a list compares as text). `querySpace` loads
  the related objects (and tags) that the formulas in a filter or sort read (`queryRelations`).
- Captures and agents can't set a formula; `get_object` shows its value and `list_types` its
  expression with names.

## Templates and snippets

A **template** is an object of its type kept apart from the others: `ObjectRecord.template` (a
synced field, the `template` column) holds `{ kind: 'template', name, default?, fills? }`. Making an
object from it copies its title, properties, tags, icon and rich text with placeholders replaced and
conditional blocks decided, and new block ids; editing the template later never changes what was
made from it. A **snippet** is the same for a piece of text inserted where the cursor is:
`{ kind: 'snippet', name, trigger?, scope? }`, an object of the Page type whose body is the text.
Both belong to one space. [`packages/core/src/templates.ts`](../packages/core/src/templates.ts)
resolves them, so the server (typed lines from Telegram and agents, daily notes), the replica and
the app make the same object from the same template.

- **Kept apart.** The store leaves templates and snippets out of every listing: a type's objects,
  the space's, counts, search, queries, the calendar, backlinks (they get no `links` rows and no
  search rows), the trash, activity and notifications. `Store.listTemplates` is the only way they
  are listed (`GET /api/spaces/:id/templates`, the MCP tool `list_templates`). A test runs every
  listing on a space that has some (`server/test/templates.test.ts`).
- **Placeholders**, `{{name:argument|format}}`: `date` (the object's date, a daily note's day,
  else today; `date:+7d`, `date:-1w`, `date:next monday`, `date|D MMM YYYY`), `time`, `title`
  (the title typed), `me`, `yesterday`/`tomorrow` (a mention of that day's note, whose id is
  derived, so it may not exist yet: opening it makes it), `ask:With whom?` and
  `choose:Kind|Bug|Feature` (asked when the object is made, one dialog for all; the same question
  twice is asked once), `selection`, `cursor` (where the cursor goes) and `formula:…`. In rich
  text a placeholder is a `templatePlaceholder` node (a chip, `attrs.value` is what is between the
  braces); in the title and text properties it is written as text. Properties a value cannot hold
  take one from `fills` (property id → placeholder): Due = `date:+7d`, Assignee = `me`, a select by
  an answer's label. No code runs: templates also apply on the server and in shared spaces.
- **Conditions** are formulas with the template's variables `date`, `me`, `type` and `title`, and
  `ask("…")`, `has("Due")` (the type has that property) and `prop("Status")` (a value by property
  name). `ask("Body", "Yes", "No")` asks with those answers to pick from, like `choose`, but prints
  nothing where it is a condition. Blocks: a `templateIf` node holds `templateBranch` nodes (`attrs.condition`, none for the
  Else); the first branch that holds keeps its blocks and the container goes. Inline:
  `{{formula:if(ask("Kind") = "Bug", "🐞", "✨")}}`.
- **Defaults.** One template per type may be the default: the type page's New and typed lines use
  it. The Daily note type's default fills each new day's note.
- **Snippets** apply where their scope says (`SnippetScope`): of some types, whose type has some
  properties by name and kind (optionally with a value), and when a formula holds on the object's
  values. A snippet of one paragraph goes inline; otherwise its blocks go after the current one.
  `prop()` reads the object it goes into, at insertion. Snippets never set properties.
- **Daily notes offline.** Two devices that make the same day's note offline both apply its
  template. `seededText` writes that text as Yjs items under a client id derived from the note's id
  and the update itself, so both devices make the same items and Yjs merges them into one copy; a
  daily template resolves only what is the same on every device (no time, no `me`, no answers). If
  the template differs between the two (edited offline on one), the client ids differ and both
  copies show, which is better than merging items that are not the same.

## Nutrition

A food diary inside a space ([`packages/core/src/nutrition.ts`](../packages/core/src/nutrition.ts)).
Off until a space turns it on
(`setNutritionEnabled`, `POST /api/spaces/:id/nutrition`, offline too): that makes the Food, Recipe
and Nutrition goal types (or brings them back from the trash) and sets the space's `nutrition`
field (`NutritionSettings`: `enabled` and the meals). Turning it off only sets `enabled: false`;
nothing is deleted.

- **Meals** — `Space.nutrition.meals`, ordered: `{ id, name, time? }` ("HH:MM", the usual time).
  Defaults: Breakfast 08:00, Lunch 12:30, Snack 16:00, Dinner 20:00, with fixed ids so two devices
  turning it on offline agree. Changed with `PUT /api/spaces/:id` `{ nutrition }`. One synced field.
- **Food** (`food`) — numbers per 100 g: `kcal` ("Calories"), `protein`, `carbs`, `fat`, `fiber`
  (optional); `brand` (text). Portions are a prop without a property definition,
  `portions: { kind: 'portions', value: [{ name, grams }] }` ("slice" = 30 g), edited on the food's page.
  A food without `kcal` has no nutrition data yet.
- **Recipe** (`recipe`) — `ingredients: { kind: 'ingredients', value: [{ id, grams }] }` (foods or
  other recipes, in order; no property definition), `yield` ("Cooked weight", grams once made; the
  ingredients' total when empty) and `servings`. Its nutrients are never stored: `recipeFacts`
  works them out from the ingredients as they are now (a recipe inside itself, a deleted or empty
  ingredient count as `missing`). Ingredients are `relation` links (`via: 'ingredients'`), so a
  food's backlinks list its recipes.
- **Entries** — what was eaten is a prop of the day's daily note, `food:<entry id>` =
  `{ kind: 'food-entry', value: FoodEntry }`: `sourceId` (the food or recipe), `name`, `amount` as
  typed ("2 slices"), `grams`, `meal`, `at` (when eaten) and `nutrients` for those grams, a
  snapshot (absent while the food has no data; `refreshEntry` takes it again). One prop per entry,
  so entries logged on several devices and by the server at once all arrive; deleting one clears
  its prop. Entries are not objects, not in full-text search and not links. `logFood`
  (`POST /api/spaces/:id/food`: `sourceId`, `amount`, `day`, `meal?`, `at?`, `timeZone?`) makes the
  day's note if needed; without a meal the entry goes to the one whose time is nearest when it was
  eaten. `DELETE /api/objects/:noteId/food/:entryId` removes one. The device's store has the same
  operations (`setNutrition`, `logFood`, `deleteFoodEntry`).
- **Quick entries** — an entry with `quick: true` was logged by its numbers alone ("muffin ~350
  kcal", `readQuickEntry`, `quickEntry`): no `sourceId`, `amount` empty, `grams` 0, and `nutrients`
  as given (the macros not given are 0). Its `name` may be empty ("Quick entry" where it is listed,
  `entryLabel`). Nothing to update it from, so "Update from the food" leaves it as it is.
- **Amounts** — `parseAmount`: a bare number is grams; `g`/`kg`/`ml`/`l` (millilitres count as grams)
  and their names; a portion by name ignoring case, accents and plurals ("2 slices" finds "slice";
  "2 tablespoons" finds "tablespoon"), or by the start of its name when only one portion starts that
  way; fractions ("1/2", "1 1/2", "½") and words ("a", "one", "half"). A recipe with servings has
  the portion "serving" (also "portion").
- **Days not counted** — the daily note's checkbox prop `food-not-counted` (travel, sick):
  averages and streaks skip the day; a week's budget still counts what was eaten.
- **Goals** (`nutrition-goal`) — the object's own date is the day it starts; `kcal` ("Daily kcal"),
  `protein-pct`/`carbs-pct`/`fat-pct` (percent of the kcal; grams are worked out with 4/4/9 kcal per
  gram), `kcal-mon`…`kcal-sun` (a weekday's kcal instead of the daily one) and `weekly` ("Weekly
  budget"). The goal of a day is the latest one starting on or before it (`goalForDay`), so a new
  goal never changes the days before it. A day is on target within 5% of its kcal (as Prato).
  With `weekly`, the week (Monday to Sunday) shares the sum of its days' goals (`weekBudget`): what
  is left, and what a day may take so the week ends on budget (what is left from that day on,
  shared among the days left in proportion to their goals).
- **Habits done from food** — a space that turns food tracking on gives its Habit type the select
  `food` ("From food": protein/kcal/carbs/fat at least or at most, fiber at least, "Day on target",
  "Food logged"; added once, also to spaces that had food tracking before, so a deleted one stays
  deleted). Such a habit's days are worked out from the daily notes each time it is read
  (`withFood`, `habitsWithFood`) and never stored: "at least" with a daily goal fills toward it
  with the day's total; otherwise a day is done against the habit's daily goal, else the day's
  nutrition goal. Days not counted are days off (`off:<day>`, a prop only on the worked-out copy,
  which `isHabitScheduled` reads). It can't be checked by hand (the app says so, `log_habit`
  refuses); reminders, `list_habits` and the habit's page read the worked-out days.
- **History** — `nutritionDays` (a day's totals, entries, goal and whether it counts) and
  `nutritionStats` (averages over counted days with entries, days on target, the current and best
  streak; days not counted are skipped, today not on target yet does not break a streak).
  `sourceUsage` (times logged, last day) and `frequentSources` read the daily notes' entries.

## Dates and the calendar

A `DateValue` is a day (`resolution: 'day'`, stored at midnight UTC) or an instant (`'time'`), with an
optional inclusive `end`. With `rrule` (an RFC 5545 RRULE value) it repeats; `start`/`end` describe the
first occurrence, and timed repeats follow the wall clock of `timeZone` so 09:00 stays 09:00 across DST.
Objects store their own date in `date_*` columns (including `date_rrule`, `date_tz` and
`date_exceptions`); date properties live in `props`.

Occurrences changed on their own are `exceptions`, keyed by the start the rule gives the occurrence
(an ISO instant, or midnight UTC for days; `CalendarEntry.occurrence`): `{ start, end? }` moves or
resizes it (it shows where it was moved to, even outside the range the rule was expanded for),
`{ cancelled: true }` deletes it. They are part of the date field, so they sync with it (last
writer wins on the whole date). Keys the rule no longer gives are ignored when expanding, and
dropped by the edits below; the object page's date editor keeps them while the series starts where
it did and drops them when its start changes.

The calendar edits one occurrence with `changeOccurrence` (core `calendar.ts`; the route
`POST /api/objects/:id/occurrences` and the replica's `ClientStore.changeOccurrence` both run it):
- **this**: writes an exception (moving it back where the rule puts it removes it);
- **all**: moves the series by the same days, or wall-clock time in its zone, as the occurrence
  moved, BYDAY weekdays and exceptions along with it, with the occurrence's new length; deleting
  all moves the object to the trash;
- **following**: ends the series with an UNTIL at the last occurrence it keeps (a day, or the
  floating wall-clock time) and copies the object (`copyObject`: title, type, properties, icon,
  tags and the text's content, not its history or media) with the rest of the series: starting at
  that occurrence moved like it, the same rule, a COUNT lowered by the occurrences kept. The copy's
  notes end with "Continues from @original", a mention, so the original's backlinks list it
  (splitting a copy again replaces that line). From the first occurrence it is "all".

The calendar ([`calendar.ts`](../packages/core/src/calendar.ts), `@vasta/core/calendar`) turns objects
into `CalendarEntry` occurrences for a range of days in the viewer's zone: daily notes, objects' own
dates (date objects only once they have notes, since most exist only because a date was mentioned)
and every date property. Subscribed calendars (`calendar_sources`) keep the last iCalendar text
fetched; [`ics.ts`](../packages/core/src/ics.ts) expands it (RRULE, EXDATE, moved occurrences,
cancelled events, zones without a VTIMEZONE). Both use ical.js, which is why they are separate entry
points from the package root.

## Sync columns

`spaces`, `types`, `objects` and `calendar_sources` carry `rev` (the global revision of the row's
last write, from `meta` `sync.rev`) and `clock` (JSON: field name → HLC of the write that set it;
a new row's empty fields have none, and a new daily note's fields are stamped at the epoch so a
change made to the same day's note elsewhere wins).
`sync_tombstones (kind, id, space_id, rev)` remembers synced rows deleted for good, so clients
learn they are gone. See [sync.md](sync.md#revisions).

An object's rich text lives in `object_docs (object_id, ydoc, vector, rev)`: one Yjs document
per object, one `Y.XmlFragment` per rich-text field. `objects.content` is derived from it (the
JSON the editor would save) and kept for search, links, previews, queries and the export. Rich
text is not in the `clock`: it merges through Yjs. See [sync.md](sync.md#rich-text-storage).

`calendar_sources.data_hash` is a hash of the fetched iCalendar data (`CalendarSource.dataVersion`):
replicas download the data again when it changes (`GET /api/sync/calendars/:id`).

**Device replicas** (the web app's worker) run the same schema on sqlite-wasm, with foreign keys
off (pulls arrive in revision order, an object may come before its type), plus three tables of their
own: `sync_outbox (kind, id, field, space_id)`, the fields (and `#text`) this device changed and
has not pushed yet, `sync_text (object_id, server_vector)`, the state vector of the server's
copy of an object's text, and `sync_refused (id, at, kind, row_id, title, reason)`, changes the
server refused, shown in Settings › This device until dismissed. Their `meta` holds `sync.pulled` (the server revision reached),
`sync.spaces` (spaces pulled in full), `sync.calendars` (calendars whose data is out of date),
`sync.text` (objects whose text the server has beyond the local copy, until fetched) and
`replica.user`. See [sync.md](sync.md#device).

## Import provenance

Importers store each original record in `import_sources`, so a later importer version can
re-map data without asking the user to export again.
