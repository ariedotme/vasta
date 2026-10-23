# Agent notes

- **Handoffs** live in `handoffs/` (gitignored, local to each checkout). Write a handoff there when
  work stops mid-way or a plan spans sessions (`handoffs/handoff-<topic>.md`), and read the
  relevant ones before picking a topic back up.
- **`setup/`** (gitignored) holds a checkout's own deploy files and scripts: compose files, deploy
  and release scripts, notes about one particular server. Nothing in the tracked tree may depend
  on it.
- **`CHANGELOG.md`**: add what a change means for the people using Vasta under `## Unreleased`
  (Added, Changed, Fixed) in the same commit. `scripts/release.sh` refuses a release without it,
  and the section becomes the GitHub release's notes.
- Ideas, bugs and tech debt for later are issues on the [roadmap project](https://github.com/users/ariedotme/projects/1): `gh issue create
  -R ariedotme/vasta`, then `gh project item-add 1 --owner ariedotme --url <issue url>` and set its
  Status, Priority and Area (`gh project item-edit`). Not in a `TODO.md`.
