# Capture

Everything captured from outside the app lands in **today's daily note** as a block that shows
the channel's icon and the time it arrived, followed by the content. Links also become weblink
objects, tasks become task objects, files become image/PDF/audio/video/file objects, and the
daily-note block embeds them.

All channels go through one service, `packages/server/src/capture.ts`. A new channel (email,
iOS Shortcuts, Raycast, a browser extension) is either a small adapter calling that service in
the server process, like the Telegram bot, or an external client of the HTTP capture API.

## Settings

Set these in `.env` at the repository root (`pnpm dev` reads it; see `.env.example`):

| Variable | Meaning |
|----------|---------|
| `VASTA_TIMEZONE` | IANA zone that decides which day "today" is, for users without a zone of their own (default: the system's) |
| `VASTA_SPACE` | space id captures go to, for users who are members of it and chose no capture space |
| `VASTA_CAPTURE_TOKEN` | legacy single capture token, capturing as the oldest user; prefer per-user tokens |
| `VASTA_WEB_URL` | address of the web app, for links in bot replies |
| `VASTA_FETCH_LINK_META` | `0` stops fetching pages of saved links (titles, preview images, readable text) |
| `VASTA_CAPTURE_READABLE` | `0` stops saving a readable copy of each captured page (done in the background) |
| `VASTA_ALLOW_PRIVATE_FETCH` | hosts on the local network the server may fetch links and calendars from (comma-separated), or `1` for all; refused by default ([accounts.md](accounts.md#how-it-is-protected)) |
| `TELEGRAM_BOT_TOKEN` | enables the Telegram bot |
| `TELEGRAM_ALLOWED_USER_IDS` | legacy: Telegram users who capture as the oldest Vasta user (optional) |
| `TELEGRAM_ALLOWED_CHAT_IDS` | comma-separated chats the bot listens in (optional): only the first value; Settings › Telegram changes the list, kept in the database |

Captures belong to a Vasta user: the owner of the token, or the user a Telegram account is linked
to. They land in that user's capture space and day. See [accounts.md](accounts.md).

## Telegram

1. In Telegram, talk to **@BotFather**, send `/newbot`, and copy the token into `TELEGRAM_BOT_TOKEN`.
2. Restart `pnpm dev`.
3. In Vasta, open **Settings → Telegram → Link Telegram**. It shows a one-time code (valid for 10
   minutes): send `/link <code>` to the bot in a private chat, or tap "Open in Telegram", which
   sends it for you. Everyone who uses the bot links their own account the same way, and their
   messages go to their own daily note. From the terminal instead: send any message to the bot to
   see your Telegram id (while nobody is linked it only answers with ids), then
   `pnpm vasta user telegram arie <id>`.

Messages from senders who are not linked are ignored without a reply (and logged with their ids).
The older `TELEGRAM_ALLOWED_USER_IDS` still works and captures as the oldest Vasta user. In a
private chat the chat id equals your user id; `/id` shows both.

**Chats** (Settings › Telegram, `server/src/channels.ts`): by default the bot listens in any chat a
linked account writes in. A list of chats limits it to those; messages elsewhere are ignored, and
the bot remembers the last 10 chats it ignored (with their titles) so they can be allowed with a
click. A chat in the list never lets strangers in: only linked accounts capture there (before
2026-10-19, `TELEGRAM_ALLOWED_CHAT_IDS` let anyone in the listed chats capture as the oldest
user). The list is the server's, so only its first account changes it; everyone sees it. It is
kept in the database (`meta` keys `telegram.allowedChats` and `telegram.ignoredChats`);
`TELEGRAM_ALLOWED_CHAT_IDS` seeds it the first time and is ignored after that. API:
`GET /api/auth/channels`, `PUT /api/auth/channels/telegram` with `{ allowedChats: [{ id, title? }] }`.

**Settings › Capture channels** shows which channels are on: the bot (and whether your account is
linked and where it listens), your capture tokens (the API, the browser extension, Shortcuts), the
desktop app's quick capture, and email (not there yet).

The bot long-polls Telegram, so the server needs no public address. What it understands:

| Message | Result |
|---------|--------|
| text (bold, italic, code, links kept) | block in today's note; each URL is also saved as a weblink |
| photo, voice message, audio, video, document | media object (caption becomes its note), embedded in today's note |
| `/task Buy coffee` (more lines = notes) | task with status "To do" |
| `/new Book Dune` (more lines = body) | object of any type, matched by name, plural or built-in key |
| `/task Buy coffee due:friday 3pm priority:high` | the same, with properties (see below); the reply says what was understood |
| `/food 2 slices of bread, coffee 200 ml at breakfast` | food logged on today's note (see [Food](#food)); the reply says what was logged and the day's and week's kcal |
| `/today` | link to today's note |
| `/id` | your user id and the chat's id |
| `/link <code>` | links this Telegram account to the Vasta user who got the code in Settings |

### Properties in the first line

`/task` and `/new` (and the API's `line` field, the app's quick capture and ⌘K, see below) read
`name:value` words from the first line (`core/src/capture-line.ts`, shared by the server and the
local replica, so it works offline too):

```
/task Comprar café due:sexta 15h priority:alta
/new Livro Duna autor:"Frank Herbert" nota:4,5 lido:sim genero:ficção,clássico
```

- The name is a property of the type, ignoring case and accents; a prefix is enough when only one
  property starts with it (`prio:alta`). Task fields also answer to `prazo`, `prioridade`,
  `estado`. Words that name no property stay in the title, so `Re: meeting` or a URL is left
  alone. Quotes allow spaces in a value.
- **Dates**: `hoje`/`today`, `amanhã`/`tomorrow`, `ontem`, weekday names in Portuguese or English
  (the next one: `sexta` on a Friday is a week later), `25/10` (next year once it has passed),
  `25/10/2026`, `2026-10-25`, each with an optional time after it (`15h`, `15h30`, `9:30`, `3pm`);
  a time alone means today.
- **Select**: the option's label (`alta`, `média`, `baixa`, `feito`… also work for tasks), or a
  unique prefix; an unknown option is added to the property. Multi-selects take a comma list.
- **Relation**: object titles (comma list when multiple); an object that does not exist yet is
  created with that title, as the first allowed target type (or a page).
- **Person**: a member of the space by username (`@` optional), full name or first name, ignoring
  case and accents; `me`/`eu` is whoever captures (`assignee:ana`, `assignee:me`). Someone who is
  not a member makes the value unreadable.
- **A task's sprint**: a sprint's title, or `atual`/`current` for the sprint whose dates hold today.
- **Number** (`4,5` or `4.5`), **checkbox** (`sim`/`não`/`yes`/`no`), **text** and **URL** as is.
- A value that cannot be read (`due:31/02`) stays in the title and the reply says so.

Saved messages get a 👍 reaction. The polling position is stored in the database, so a restart
does not save messages twice. Only one process can poll a bot: use a second bot (in
`.env.test`) for `scripts/test-env.sh`.

## HTTP capture API

Every server describes this API as an OpenAPI 3.1 document at `/api/openapi.json` (no login
needed): import it into an API client (Bruno, Insomnia, Postman) or generate a client from it.

Base path `/api/capture`; every request needs `Authorization: Bearer <token>`, a token made in
**Settings → Capture tokens** (or with `pnpm vasta token add <username> <name>`, or the legacy
`VASTA_CAPTURE_TOKEN`). Every body may
include `channel` (shown on the block; `api` by default, also `shortcuts`, `email`, `raycast`,
`browser`) and `spaceId` (one of the token owner's spaces; their capture space by default).

| Request | Body | Creates |
|---------|------|---------|
| `POST /note` | `{ text }` | block in today's note; URLs become weblinks |
| `POST /weblink` | `{ url, title?, note? }` | weblink (reused if the URL was saved before) |
| `POST /task` | `{ title, note?, due?, priority? }` or `{ line, … }` | task; `due` is `YYYY-MM-DD` or ISO; priority `high`/`medium`/`low`; `line` is read like the bot's first line (title and properties) |
| `POST /object` | `{ type, title?, line?, text?, props? }` | object of a type given by id, built-in key or name; `props` by property id win over `line` |
| `POST /file` | multipart: `file`, `caption?`, `channel?` | media object |
| `POST /food` | `{ text }` | food logged on today's note, `text` as after `/food` ([Food](#food)); answers `{ dailyNoteId, day, entries, created, problems, summary }` |
| `GET /today` | | `{ day, dailyNoteId }`, creating the note if needed |

Captures answer `201` with `{ dailyNoteId, blockId, objects: [{ id, typeId, title }] }` (task and
object captures add `summary`, e.g. "Task “Buy coffee”, due Fri 24 Oct, priority High", and
`unreadable` for values that could not be read), `400` with `{ error }` for bad input and `401`
for a wrong token.

```sh
curl -X POST http://127.0.0.1:5174/api/capture/note \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text": "Idea from the terminal", "channel": "api"}'
```

### Browser extension

`extensions/browser/` is a Manifest V3 extension (Chrome, Edge, Brave; Firefox with MV3 support).
Load it unpacked (`chrome://extensions` → Developer mode → Load unpacked), open its options and
enter the Vasta address (the web app, e.g. `http://127.0.0.1:5173`, or the reverse-proxy address
that forwards `/api/capture`) and your capture token; it asks for permission to reach only that
address. Then:

- the toolbar button (or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd>) saves the current page,
  with an optional note;
- right-click → **Save page to Vasta** / **Save link to Vasta** saves without the popup (the
  badge shows ✓ or !).

Pages are saved through `POST /api/capture/weblink` with channel `browser`, so they also land in
today's daily note.

### iOS and macOS Shortcuts (share sheet)

On the iPhone this is the way to capture from other apps: iOS Safari does not support the Web
Share Target API, so the installed app cannot appear in the share sheet itself. **Settings →
Capture tokens → Use on iPhone** shows these steps with the server's address filled in and buttons
to copy the address and the `Bearer` header.

1. New shortcut → in its details turn on **Show in Share Sheet**, accepting **URLs** and **Safari
   web pages**.
2. Add **Get Contents of URL**: URL `https://<your address>/api/capture/weblink`, method `POST`,
   headers `Authorization: Bearer <token>` and `Content-Type: application/json`, request body
   **JSON** with `url` = *Shortcut Input* and `channel` = `shortcuts`.
3. Optionally add **Ask for Input** (text, "Note") before it and pass its answer as `note`, and
   **Show Notification** after it.

For plain text instead of links, post `text` to `/api/capture/note` the same way.

A **quick task** shortcut (Siri or the Action button) works the same: **Dictate Text** or **Ask
for Input**, then **Get Contents of URL** to `/api/capture/task` with JSON `line` = the text and
`channel` = `shortcuts`, then **Show Notification** with the answer's `summary`. Typed text can
carry properties as above (`Comprar café due:amanhã 15h`).

### Reaching it from the phone

The server listens on 127.0.0.1. The whole API needs a login or a token, so it can be published
through a reverse proxy over HTTPS; see [accounts.md](accounts.md#exposing-the-server).
Telegram needs none of this.

## Desktop app quick capture

The desktop app's global shortcut (⌘⇧Space) opens a quick capture dialog in the web app
(`components/QuickCapture.vue`, [desktop.md](desktop.md)), or the floating panel from other apps.
The text goes to today's note of the capture space as a captured item with the channel `desktop`.
Online it is `POST /api/spaces/:id/captures` (`{ text, channel }`, with the session cookie), which
runs the same note capture as the API (links become weblinks). Offline the local replica appends
the item itself (`ClientStore.capture`, links stay links) and it syncs later. Both use
`appendCapture` in core.

**An object of a type**: a text that starts with `/` and a type's name makes an object of that
type instead, and the note embeds it, as Telegram's `/new` does:

```
/Livro Duna autor:"Frank Herbert" nota:4,5
/task Comprar café due:sexta 15h priority:alta
```

The first line after the type is the title and its properties (above), the other lines the body.
The longest run of words that names a type wins (`/Reading list Summer`); the built-in key works
too (`/task`). Text that starts with `/` but names no type is captured as it is. In the dialog,
`/` lists the types (arrows and Enter or Tab pick one), and a line under the field shows what will
be made: the title, the properties it read, and values it could not read. Types made from a file
or a page (images, PDFs, weblinks…), daily notes, dates and queries are not offered. Online the
request adds `typeId` (the server reads the line with the user's zone); offline
`ClientStore.captureObject` does the same on the replica with the device's zone, creating relation
targets and new select options there.

**Values at the cursor**: after a relation's `name:` the list offers objects of its types (the
latest ones, then those whose title has what is typed, spaces included: `autor:frank her`); picking
one writes its title, quoted when it has spaces. A relation to daily notes offers days instead,
since daily notes have no title: picking one writes `2026-10-19`, and a typed day (`hoje`, `amanhã`,
`sexta`, `19/10`) is that day's note, made when missing; the same works in Telegram, the API and for
agents. A select offers its options, a person the space's members (picking one writes the
username; offline the replica reads names from the members the app last loaded, `setPeople`). A
multiple relation, select or person keeps the values before a comma.
Esc puts the list away. The code is `lib/typed-line.ts` (`complete`) with `lib/use-completions.ts`.

**The desktop app's floating panel** (0.1.7) shows the same list and preview: it is a page of its
own without the workspace, so it asks the web app in the main window (`suggest_capture` →
`vasta:capture-suggest`; the answer comes back through `capture_suggestions` with the request's
`seq`), and grows downwards to fit the list (`fit_capture`). Older apps take `/Type …` without a
list.

## ⌘K

The palette takes the same syntax to create an object without a daily-note entry: `/` lists the
types (and a relation's or select's `name:` its values, as above), and `/Livro Duna nota:5` shows
"Create “Duna”" with what the line sets; Enter creates and opens it. It is `POST /api/objects` with `line` (or `ClientStore.createObject` with a line on the
replica).

## Food

In a space that tracks food (Settings › Food tracking, [data-model.md](data-model.md#nutrition)),
`/food` logs what was eaten on today's note, in Telegram, the capture API
(`POST /api/capture/food`), the app's quick capture, ⌘K and the desktop panel (online or offline:
`POST /api/spaces/:id/food-line`, `ClientStore.logFoodLine`), and for agents (`log_food`). It is not
an inbox item: the entries go to the day's Food block, without a callout. Core's `logFoodLine`
reads the line:

```
/food 2 slices of white bread, coffee 200 ml at breakfast
/food rice 150g and beans 100g lunch yesterday
/food lunch: lasagna, salad
```

- Items are separated by commas, semicolons, lines, or "and" next to an amount ("rice 100g and
  beans 80g"; "mac and cheese" stays one food).
- An item is a food or recipe with an amount before it ("2 slices of bread", "150 g rice", "half a
  cup of rice") or after it ("rice 150g", "bread 2 slices"). A count alone ("2 eggs") or no amount
  ("banana", "lasagna") is that many of its first portion, or a recipe's serving.
- The name is matched ignoring case, accents and plurals (and aliases); otherwise the only food that
  starts with it or has all its words. Several matches and none exact: the item is skipped and the
  reply asks which. No match: a food of that name is made without nutrition data.
- A meal at the end ("at lunch", "dinner") or in front ("lunch: …"), by its name (or "supper" for
  dinner). A meal word without "at"/"for" that is also a food is the food. Without a meal, the one
  whose time is nearest.
- "yesterday" or "today" at the end logs on that day, at the meal's time.
- An amount that can't be worked out yet (no such portion, a new food) is logged without grams and
  shows as needing data; "Update from the food" works it out once the food has the portion.
- **Just the kcal**, for when what it was is not known: an item with kcal (`300 kcal`, `~350kcal`,
  `350 calories`) is a quick entry, logged by its numbers without making or needing a food.
  Optional grams of protein, carbs, fat or fiber go with it (`35 g of protein`, `20g carbs`,
  `fat 10g`); the words around them name it, and "~", "about" and brackets are dropped:

  ```
  /food 300 kcal at snack
  /food muffin ~350 kcal
  /food lunch plate 650 kcal 35 g protein 70 g carbs 20 g fat at lunch
  ```

  The Food block's picker does the same when the search has kcal in it ("Log “Muffin” without a
  food"); such an entry opens to change its name and numbers.

In the app, `/` offers `/food` once the space tracks food (the Food type itself is not offered:
`/Food` logs), the foods and recipes are offered at the cursor after an amount, and the line under
the field says what will be logged.

## Inbox

**Inbox** in the sidebar (`/inbox`, `server/src/inbox.ts`) lists what was captured into the daily
notes of the last 14 days ("Show older" goes further back), newest first and grouped by day, with
the channel, the time and the content. Mark an item done with its circle (or the check in the
callout's corner in the daily note): it leaves the inbox ("Show done" brings it back) and looks
faded in its note; nothing is deleted. "Open in note" opens the daily note at that item.
API: `GET /api/spaces/:id/inbox?today=YYYY-MM-DD&days=14`, `PUT /api/objects/:noteId/captures/:captureId`
with `{ done }`.

## Captures and open pages

The web app listens to `/api/events` (Server-Sent Events). An open page that has no unsaved
edits reloads when something is captured into it. If you are typing in today's note when an
item arrives, your save still keeps it: the server appends capture blocks that are newer than
the version you were editing (`mergeCaptures`), and the page then shows them.
