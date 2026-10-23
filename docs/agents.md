# Agents: the MCP server and the CLI

Agents (Claude Code, Codex, scripts) read and write Vasta through **an MCP endpoint on the server**
and **the `vasta` command**, which calls the same tools. There is no AI inside the app and no model
key to configure: the agents you already run do the work, as you, in your spaces.

## Tokens

Both need a token with the **Whole API** scope: Settings › Capture tokens, "Whole API (scripts,
agents)", one per agent so each can be revoked alone (or on the server:
`docker exec vasta vasta token add arie claude-code --scope api`). A token acts as its user: it
reaches the spaces the user is a member of and nothing else. Settings › Capture tokens › "Use with
agents" shows the commands below with the server's address (and the token, right after creating
one).

## The MCP endpoint

`POST <server>/mcp`, Streamable HTTP, `Authorization: Bearer <token>`. It keeps no sessions: every
request gets its own server (`packages/server/src/mcp.ts`), so GET and DELETE answer 405. Caddy
needs nothing for it (the answers are plain JSON, not streams).

```sh
# Claude Code
claude mcp add --transport http vasta https://vasta.example.org/mcp --header "Authorization: Bearer <token>"
```

```toml
# Codex: ~/.codex/config.toml, with VASTA_TOKEN set in the environment
[mcp_servers.vasta]
url = "https://vasta.example.org/mcp"
bearer_token_env_var = "VASTA_TOKEN"
```

The Claude app (claude.ai and the desktop app) adds remote MCP servers as connectors, which sign in
with OAuth; Vasta has no OAuth server and will not get one (Arie, 2026-10-19: MCP is for Claude
Code and Codex).

### Tools

| Tool | What it does |
| --- | --- |
| `list_spaces` | The user's spaces; the default (capture) space is marked |
| `add_comment` | A comment on an object, as the user (@username mentions a member) |
| `list_types` | A space's types with their properties, select options and object counts |
| `search` | Full-text search over titles and text |
| `get_object` | An object: type, properties in words, tags, text fields as Markdown, backlinks |
| `get_daily_note` | A day's note (today by default, in the user's time zone), made if missing |
| `query` | Objects of some types, filtered and sorted like a query in the app |
| `list_inbox` | Items captured lately (Telegram, quick capture, agents…) |
| `list_templates` | The space's templates (by type, the default marked) and snippets, with the questions they ask |
| `create_object` | A new object of a type, with properties and Markdown text; it starts from the type's default template, or `template` by name (`"blank"`: none), its questions answered by `answers` |
| `update_object` | Title, properties (null clears one) and text: append (default), prepend or replace |
| `capture` | A note into today's daily note, like the quick capture (channel "agent") |
| `list_habits` | The habits: done on a day (today by default; the amount for daily goals), weekdays, streaks, rates, the last days |
| `log_habit` | Mark a habit done or not on a day, or set or add to its amount toward a daily goal |
| `log_food` | Log what was eaten (a space that tracks food): a line as after `/food` ([capture.md](capture.md#food); an item with kcal, "muffin ~350 kcal 12 g protein", is logged by its numbers, without a food, e.g. an estimate from a photo of a plate), or one `food` with an `amount` and `meal`; `day` for another day |
| `nutrition_day` | A day's meals with their entries (ids), totals against the goal, whether it counts, the week's budget |
| `delete_food_entry` | Take an entry off a day |
| `save_food` | Make or fill in a food: nutrients per `per` grams as on its label (kept per 100 g), brand, portions |

Without `space`, tools use the user's capture space; a space can be named by id or name. Types are
named by name, plural or built-in key (`page`, `task`…), properties by name, select values by
label, related objects by title (missing options and objects are created, like the captures do),
people (person properties such as a task's Assignee) by username or name, `me` for the user,
dates as `YYYY-MM-DD`, an ISO date-time, or words the captures read ("friday 15h"). Formula
properties are computed: `get_object` shows their values, `query` filters and sorts by them, and
setting one is refused. `get_object` also says who made the object and who changed it last
(`createdBy`, `updatedBy`, "Name (username)"); `query` filters on them and on person properties
("Assignee contains me"). In a space with sprints, a task's sprint is set by the sprint's title,
or "current" for the one whose dates hold today. Templates ([data-model.md](data-model.md#templates-and-snippets))
never show in `search`, `query` or the other listings, only in `list_templates`. `get_object` on a food adds `nutrition` (per 100 g, portions, brand), on a
recipe its ingredients and what it comes to; so an agent can log a plate from a photo with
`log_food`, or fill a food from its label with `save_food`, without the app holding LLM keys. Results are
JSON; objects carry a `url` to open them in the app (`VASTA_WEB_URL`, else the request's address).

Writes go through the store like the app's own saves: the change feed tells open pages, and the
rich text is written to the object's Yjs document, so devices merge it with their own edits.

### Markdown

Text goes in and out as Markdown (`packages/core/src/markdown.ts`): paragraphs, headings, lists,
to-dos (`- [ ]`, `- [x]`), quotes, code blocks, rules, tables, line breaks; bold, italic, strike,
code, `==highlight==` and links. Vasta's own pieces:

- a mention: `[@Title](vasta://o/<id>)`; of one block: `[@Title › its text](vasta://o/<id>#b-<block>)`
- an embedded object (a card, an image): `![Title](vasta://o/<id>)`; one block of it (read-only,
  following the original): `![Title](vasta://o/<id>#b-<block>)`
- a callout: a quote that starts with `[!NOTE]`

Toggles, groups and columns come out as their content; block colors and ids are not part of the
Markdown. So "replace" rewrites a text with what Markdown holds; "append" and "prepend" leave the
rest of the text alone (captured items in a daily note stay captured items).

## The CLI

`packages/cli` (`bin/vasta`, Node 24, no build). Link it into your `PATH` once, from the repository:

```sh
pnpm install
ln -s "$PWD/packages/cli/bin/vasta" ~/.local/bin/vasta
vasta login https://vasta.example.org <token>     # saved in ~/.config/vasta/cli.json (mode 600)
```

Or set `VASTA_URL` and `VASTA_TOKEN` instead of logging in.

```sh
vasta search dune
vasta show <id or link>                    # properties and text as Markdown
vasta today                                # today's note (vasta today 2026-10-18 for another day)
vasta new Book Dune --prop author="Frank Herbert" --prop rating=5 --text "Spice."
vasta new Task "Login breaks" --template Bug --answer "Who saw it?=Lena"
vasta templates                            # templates and snippets, with their questions
echo "- read chapter 3" | vasta append today
vasta set <id> status=done --title "Done it"
vasta capture "call the dentist"
vasta inbox --days 3
vasta habits                               # ✓ done today, ○ not yet, – day off; streaks
vasta habit meditate                       # done today; "undo", "--day 2026-10-19"
vasta habit water +1                       # one more toward a daily goal ("5" sets it)
vasta food 2 slices of bread at breakfast  # log food; --day for another day
vasta nutrition                            # today's meals, totals against the goal, the week
vasta query --type Task --where "status is To do" --sort due
vasta tool get_object '{"id":"…"}'         # any tool, JSON in and out
```

`--json` prints the tools' answers as they are, for scripts. This is not the admin command of the
server machine (`pnpm vasta user add …`, `docker exec vasta vasta …`): that one manages accounts on
the server's database; this one talks to a server over HTTPS as a user.
