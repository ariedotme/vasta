# Accounts and sharing

One Vasta server can hold several people. **Spaces are the unit of access**: a user sees the
spaces they are a member of, and everything inside them (objects, types, calendars, daily notes).
A space can have one member (a private space) or several (a shared one, e.g. "Home").

| Table | What it holds |
|-------|---------------|
| `users` | username (unique, case-insensitive), display name, scrypt password hash, optional time zone, capture space and Telegram user id |
| `space_members` | `(space, user, role)`; role `owner` or `editor` |
| `sessions` | browser logins (SHA-256 of the cookie secret, user agent, created, last seen, expiry) |
| `login_failures` | failed logins per username, for the throttle |
| `api_tokens` | bearer tokens for capture channels and scripts (SHA-256 of the secret, scope) |

Roles: both can change everything in the space, including its name and icon. Only owners add and
remove members or change roles (the server answers `403` to editors); anyone may leave a space,
and a space always keeps at least one owner. Owners can delete a space (see below).

## In the app: Settings

The space name at the top of the sidebar opens a menu to switch spaces, create one, open
**Settings** (`/settings`), change the password and log out. Settings has:

- **Account**: display name, time zone (with a button for this device's zone), capture space,
  password.
- **Space**: rename it, change its icon, create a new space; **members** with their roles. Owners
  add someone by their exact username (there is no user search, so accounts are not listed to
  others), change roles and remove members; everyone can leave.
- **Capture tokens**: list (name, scope, last used), create (the secret is shown once, next to the
  server address to paste into the browser extension or a Shortcut), revoke.
  A collapsible **Use on iPhone** note gives the Shortcuts recipe with this server's address
  (open by default on iPhone and iPad).
- **Telegram**: link with a one-time code sent to the bot (`/link <code>`, or the t.me deep link),
  or unlink. Codes live in the server's memory for 10 minutes.
- **Sessions**: every browser and installed app logged in to the account (device and browser from
  the user agent, when it logged in, when it was last used — updated at most once a minute), the
  current one marked. Log one out, or **log out everywhere else**.
- **Delete this space** (owners, in the Space section): a dialog that asks to type the space's
  name. Refused for the user's only space.

Creating accounts stays on the server's terminal, below: there are no sign-ups.

API behind it: `PUT /api/auth/me`, `GET|DELETE /api/auth/telegram`, `POST /api/auth/telegram/code`,
`GET|DELETE /api/auth/sessions` (list; log out the others), `DELETE /api/auth/sessions/:id`,
`POST /api/spaces`, `DELETE /api/spaces/:id` (owners; body `{ "name": "<the space's name>" }`),
`GET|POST /api/spaces/:id/members`, `PUT|DELETE /api/spaces/:id/members/:userId`,
`GET|POST /api/tokens`, `DELETE /api/tokens/:id` (only the caller's own tokens). Session ids in
the API are the first 16 hex digits of the stored hash, never the cookie value.

### Deleting a space

A deleted space goes to a **trash for 30 days**: it disappears at once for every member (lists,
search, captures, its calendars stop syncing), and members whose capture space it was capture to
their first space instead. The server purges it 30 days later (at start and every 6 hours):
objects, types, subscribed calendars and memberships. Media files stay in the store, since files
are shared by hash. A member left with no space at all gets a new one the next time the app loads.
Until the purge, its owners can bring it back from the app's Trash page (`/trash`, "Deleted
spaces"), and the server's admin from the terminal:

```sh
pnpm vasta space list          # deleted spaces are listed at the end
pnpm vasta space restore <space>
```

Deleted types and objects follow the same rule (`server/src/trash.ts`): they are listed on the
Trash page of their space, where any member can restore them or delete them for good, and the
same purge removes them 30 days after deletion.

## Setting up

**The first account** is made in the web app: while a server has no accounts, it logs a setup
code (`Setup code XXXX-XXXX-XXXX` in `docker logs vasta`, or the terminal running `pnpm dev`), and
the app asks for it with the new account's name, username and password. The code changes with
each start of the server and stops working once an account exists, so whoever reaches a fresh
server first cannot claim it without access to its log.

**Everyone else joins with an invite link.** The server's first account (who set it up) makes
links in Settings › Server accounts: each works once, for 7 days, and can make the new account a
member of one of its spaces, as editor or owner. Whoever opens the link sees who invited them, and
chooses their name, username and password; nobody sends a password around. Only a hash of each
link is stored (`invites` table), and an open invite can be revoked. Everyone else's Settings
says whom to ask.

Accounts are also managed with `pnpm vasta` (`packages/server/src/cli.ts`). It works while the
server runs and reads the same `data/` (or `VASTA_DATA`). In Docker, use
`docker exec -it vasta vasta …` with the same commands.

```sh
pnpm vasta user add ana --tz Europe/Lisbon   # asks for a password (8+ characters)
```

**The first user becomes the owner of every space that has no members**, which is how spaces
imported before accounts existed get an owner. Every later user gets a new, empty space of their
own (Pages and Tasks pinned). Then open the app and log in.

A space imported later (`pnpm import:capacities`) has no members, so nobody sees it until it is
shared: `pnpm vasta space share <space> <username> --role owner`.

Other commands:

```sh
pnpm vasta user list
pnpm vasta user passwd <username>                       # logs their sessions out
pnpm vasta user set <username> --name "Ana" --tz Europe/Lisbon --capture-space <space>
pnpm vasta user telegram <username> <telegram user id>  # or "none"
pnpm vasta user remove <username>                       # refused while they are a space's only owner

pnpm vasta space list                                   # ids, names, members
pnpm vasta space create "Home" --owner arie
pnpm vasta space rename "Home" Casa
pnpm vasta space share "Home" ana [--role editor|owner]
pnpm vasta space share --all tester --role owner        # every space (test copies)
pnpm vasta space unshare "Home" ana

pnpm vasta token add <username> <name> [--scope capture|api]   # prints the secret once
pnpm vasta token list [username]
pnpm vasta token revoke <token id>
```

Spaces can be named by id or by name. In scripts, the password is read from the first line of
stdin (`echo "$PASSWORD" | pnpm vasta user add …`).

## Channels

- **Capture API and browser extension**: each person creates their own token (Settings → Capture
  tokens, or `pnpm vasta token add ana phone`). Captures go to the token owner's capture space (their
  `--capture-space`, else `VASTA_SPACE` if they are a member of it, else their first space) and
  use their time zone (else `VASTA_TIMEZONE`). A `spaceId` in the request must be one of theirs.
  Capture tokens (the default scope) only reach `/api/capture`; `--scope api` tokens reach the
  whole API, for scripts.
- **Telegram**: one bot serves everyone. Each person links their account from Settings → Telegram
  (a one-time `/link <code>`), or sends `/id` to the bot and links the number with
  `pnpm vasta user telegram <username> <id>`; their messages then go to their own daily note.
  Messages from unlinked senders are ignored.
- **Older settings still work**: `VASTA_CAPTURE_TOKEN` and `TELEGRAM_ALLOWED_USER_IDS` capture as
  the **oldest** user. Prefer per-user tokens and linked Telegram users.
- **Server settings**: the chats the Telegram bot listens in belong to the server, not one user, so
  only its **first account** (who set it up) changes them, in Settings → Telegram;
  `TELEGRAM_ALLOWED_CHAT_IDS` is only their first value ([capture.md](capture.md#telegram)).

## How it is protected

- Passwords: scrypt (N = 2^16, r = 8, p = 1) with a random salt. Five failed logins in a row for a
  name lock it for 30 s, doubling up to 15 min. The count lives in the database (`login_failures`),
  so a restart does not reset it, and starts over after a day without failures.
- Browser sessions: a random 256-bit secret in an `HttpOnly`, `SameSite=Lax` cookie, `Secure`
  when the request came over HTTPS (directly or with `X-Forwarded-Proto: https` from the reverse
  proxy). Sessions last 30 days and slide while used. Changing the password logs out every other
  session.
- CSRF: changes made with the cookie must carry `X-Requested-With: vasta`, which the web app
  always sends. Another site cannot add that header without a CORS preflight, which the server
  never grants.
- Every route checks membership: a record in another space answers `404` as if it did not exist,
  lists and search only cover the user's spaces, and `/api/events` only sends changes of their
  spaces.
- `/media/*` needs a login but does **not** check the space: file names are SHA-256 hashes of
  their content, so they cannot be guessed, but anyone logged in who learns a hash can fetch it.
  Fine for people who trust each other; revisit before opening sign-ups.
- The server fetches URLs for weblinks (pages, preview images) and calendars on behalf of any
  logged-in user. It refuses loopback, private, link-local and other non-internet addresses, after
  resolving the name and again on every redirect (`server/src/safe-fetch.ts`), and drops
  credentials when a redirect leaves the origin. For services on your own network (a Nextcloud
  calendar on the LAN), allow them with `VASTA_ALLOW_PRIVATE_FETCH`: a comma-separated list of
  host names or addresses, or `1` for everything. Not covered: a DNS server that answers
  differently between the check and the fetch (DNS rebinding).

## Exposing the server

With accounts in place the whole app can sit behind a reverse proxy over HTTPS. Pass
`X-Forwarded-Proto` so the session cookie is marked `Secure`. The Docker image serves the web app
and the API from one port; see [deploy.md](deploy.md).
