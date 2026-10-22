# Contributing

Thanks for wanting to help. Bug reports, ideas and pull requests are all welcome. For anything
bigger than a fix, open an issue first, so we can agree on the shape before you spend time on it.
The [roadmap](https://github.com/users/ariedotme/projects/1) shows what is planned; items in Ready
or with the `good first issue` label are a good place to start.

## Setting up

Requirements: Node.js 24+ and pnpm 10. For the desktop app, Rust and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) as well.

```sh
pnpm install
pnpm dev          # API on 127.0.0.1:5174, web app on http://127.0.0.1:5173
```

The first start logs a setup code: open the web app and create your account with it. Data lives
in `data/` (gitignored); settings in `.env` (copy `.env.example`). To start from made-up data
instead of an empty space:

```sh
pnpm seed data          # accounts tester and anatest, password test-password
```

How the parts fit together is in the [README](README.md#development) and `docs/`; start with
[docs/data-model.md](docs/data-model.md).

## Checks

```sh
pnpm test         # unit and integration tests (Vitest)
pnpm typecheck
```

Both run on every pull request (`.github/workflows/ci.yml`), together with a Docker build and a
compile of the desktop app.

**Browser checks** drive the real app with Playwright, against an isolated test environment that
never touches `data/`. They need zsh and the `sqlite3` command (both ship with macOS; on Linux,
install them):

```sh
scripts/test-env.sh                         # API on 5184, web app on 5183
cd scripts/browser-checks && npm install && npx playwright install chromium webkit
node editor.mjs                             # one check; each file says what it covers
```

`test-env.sh` copies `data/` when it has a database, and otherwise starts from the seed. Some
checks use the built app that the API serves on 5184 (`pnpm --filter @vasta/web build` first).
Run the checks for the parts your change touches.

**Load test**: `pnpm load-test 50000` fills a space with made-up objects (pages that mention each
other, tasks, books, three years of daily notes), starts the real server on it and times what the
app asks for, a full sync from nothing, and captures one at a time and many at once. Run it before
and after a change that touches the store, queries or sync.

## Conventions

- **Match the code around you**: naming, comment density, file layout. There is no formatter
  config; keep the style of the file you edit.
- **Comments say why**, or what a reader cannot see from the code. Document functions and types
  that other modules use.
- **Docs in English**, updated in the same change when behavior changes (`docs/` and the README).
- **Tests** for server and core behavior; a browser check when a change is mostly in the UI.
- **Commit messages**: one short line saying what changed, in plain words.
- **No new dependencies** without a reason; the server deliberately has few.

## Local files that stay out of git

- `setup/`: your own deploy files and scripts (compose files for your server, release helpers).
- `handoffs/`: notes for picking work back up, including those written by coding agents
  ([AGENTS.md](AGENTS.md)).

## License

Vasta is licensed under the [AGPL-3.0](LICENSE). By contributing, you agree that your
contribution is licensed under the same terms.
