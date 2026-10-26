# Importing from Capacities

Vasta imports a Capacities **full export**: the ZIP of Markdown files Capacities makes of your
spaces. It works in the web app and the desktop app, on any system, and you do not need the
Capacities app installed.

1. In Capacities, make a full export. Either link style works (Markdown links or wikilinks).
2. In Vasta, open **Settings › Import** and choose the ZIP.
3. If the export holds several spaces, pick one. Then choose where it goes: a new space named after
   it, or a space you already have.
4. Click **Import**. When it is done, Vasta shows a report of what came in and what did not.

The ZIP is read in your browser. Only its notes and its files go to the server, so the import
syncs to your other devices like any other change.

## What comes over

- **Types**: one for each Capacities type. Built-in ones (Page, Daily note, Task, Weblink, Image,
  PDF, Audio, Video, File, Query, Tag) become Vasta's own. The others become new types, named after
  the export's `type` field split into words (`PersonagemDeRpg` becomes "Personagem de rpg").
- **Properties**: the export does not say what kind a property is, so Vasta reads it off the
  values. A link to another note is a relation, an ISO date (or a range, `start -> end`) a date,
  `true`/`false` a checkbox, a number a number, a web address a URL, and short words a select
  (several when written `A, B`). Anything else is text. A property no note fills in is left out.
- **Tasks**: Status, a Low/Medium/High priority and the due date go to the Task type's own fields.
- **Text**: headings, lists, to-dos, quotes, tables, bold, italic, highlights and links. A link to
  another note becomes a mention, and a link alone on its line an embedded object. A date mention
  (`[[Date/2026-05-04]]`) becomes a mention of that day's daily note.
- **Tags, aliases, icons and descriptions**, and the creation time where the export has it.
- **Media**: images, PDFs, audio and video from the export's `Media` folders, up to 25 MB each.
- **Weblinks**: the address, the embed (YouTube…) and the preview image.

## What does not

- **Query filters.** The export has a query's name but not what it asks, so imported queries
  list every object until you set them up again. The report names them.
- **Accents in type and property names.** The export writes names without them (`Definicao`).
  Rename them in each type's settings.
- **Files Capacities left out.** Some media objects say `Media: Not included` in the export; the
  report lists them, and the object comes over without its file.
- **Ids.** The export has none, so importing the same export twice makes copies.

## Into a space you already use

Types and tags with the same name as yours are shared: the imported objects join them, and
properties a type lacks are added to it. A day that already has a daily note keeps it, with the
imported text added below its own.

## From the Capacities desktop app's database

For developers, `packages/importer-capacities` also has a command that reads the Capacities
desktop app's local database on a Mac and writes a new `vasta.db`. It keeps more (query filters,
exact property kinds, block layouts), but needs a checkout of the repository:

    node packages/importer-capacities/src/cli.ts --out data/vasta.db --export ~/Downloads/Capacities.zip

A space imported this way has no members until it is shared ([accounts.md](accounts.md)).
