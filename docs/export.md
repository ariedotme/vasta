# Export

A space can be exported whole, to keep a copy or to take it elsewhere: Markdown that people and
other apps can read, and JSON that keeps everything. Code:
[`packages/server/src/export.ts`](../packages/server/src/export.ts).

## Making one

- **In the app**: Settings › Space › **Export…**. Untick "With pictures and other files" for a
  small download without the media.
- **Over HTTP**: `GET /api/spaces/<id>/export` (`?media=0` without the media), with a session or
  an API token, for members of the space.
- **On the server**: `pnpm vasta space export <space> [file.zip] [--no-media]`
  (`docker exec vasta vasta space export …` in Docker), which needs no account.

The export is made on the server, so it needs a connection. It streams: media files are read one
after another while the ZIP downloads, so a large space never sits in memory whole.

## What is in the ZIP

```
README.md                  what is where
vasta.json                 everything (see below)
Pages/Garden plans.md      one Markdown file per object, in a folder per type (its plural name)
Daily notes/2026-11-05.md  daily notes, named by day
Whiteboards/Plan.md        a whiteboard's note…
Whiteboards/Plan.canvas    …and the board itself as a JSON Canvas (Obsidian opens it)
media/<key>                the files objects use: pictures, PDFs, audio, covers, link previews
```

Objects in the trash and templates are only in `vasta.json`. A file's name is the object's title
with `\ / : * ? " < > | # ^ [ ]` turned into `-`, at most 120 characters; two objects of a type
with the same name become `Name.md` and `Name (2).md` (the older one keeps the plain name). File
names are UTF-8 (the ZIP says so; macOS's old `unzip` command shows them wrong, Finder does not).

### Markdown

Each file starts with front matter (YAML; values are written as JSON, which YAML reads):

```yaml
---
id: "2f0c…"
title: "Dune: a novel"
type: "Book"
created: "2026-10-19T15:00:00.000Z"
updated: "2026-11-05T12:00:00.000Z"
date: "2026-11-04"                    # objects with a date (events, daily notes)
aliases: ["Duna"]
tags: ["sci-fi", "reading/2026"]     # tag paths, spaces as dashes (Obsidian's tags)
collections: ["[[Favorites]]"]
url: "https://…"                     # weblinks
cover: "media/<key>"                 # or the cover's address
Author: "[[Frank Herbert]]"          # the type's properties, by name
Genre: "Sci-fi"
Rating: 5
---
```

Properties are written in words: select options by label, people by name, dates as text
(`2026-11-04`, a range with `–`, a repeat rule in parentheses), related objects as `[[links]]` to
their files (Obsidian follows them), checkboxes as `true`/`false`. A property named like one of the
fixed keys gets " (property)" after its name. Formulas are left out (they are computed; their
expressions are in `vasta.json`), and so are rich-text fields, which are the body.

The body is the object's text as Markdown (the same Markdown agents read): each rich-text field,
under a `## Field` heading when the type has several. Mentions and embeds of other objects become
relative links to their files (`[@Frank Herbert](../Pages/Frank%20Herbert.md)`); an embedded
picture becomes the picture (`![Photo](../media/<key>)`); a mention of an object that is gone or in
the trash is left as its name. A file object (an image, a PDF…) shows its file; a weblink its
address; comments come last, under `## Comments`.

### vasta.json

```json
{
  "format": "vasta-export",
  "version": 1,
  "exportedAt": "2026-11-05T21:00:00.000Z",
  "space": { "id": "…", "name": "Notes" },
  "rows": [{ "table": "objects", "id": "…", "spaceId": "…", "rev": 318, "clock": { "title": "<hlc>" }, "record": { "…": "…" } }],
  "texts": { "<object id>": "<Yjs state, base64>" }
}
```

- `rows`: the space, its types, objects (with the trash and templates) and calendar
  subscriptions, exactly as the sync hands them out ([sync.md](sync.md#protocol)): each
  `record` is the full row (properties, relations, views, queries, media, dates, icons…) and
  `clock` the time each field was last changed. Calendar passwords are not exported.
- `texts`: each object's rich text as its Yjs document, so its history merges with copies
  elsewhere; `record.content` holds the same text as JSON for anything that only reads it.
- Media keys in records (`media.file.key`, `media.previewImageFile.key`, covers `/media/<key>`)
  name the files under `media/` (SHA-256 of the content and the extension).

`rows` and `texts` are what the server's import of moved notes takes (`POST /api/import`,
`ImportBatch` in [`transfer.ts`](../packages/server/src/transfer.ts)), so a later "Import a Vasta
export" can read a ZIP back as it is: the space keeps its ids, so it comes back as itself on a
server that does not have it.

## Not in the export

Accounts, members, sessions and tokens; capture channels; activity history; calendar passwords;
files nothing in the space uses.
