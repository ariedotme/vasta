#!/bin/sh
# Prepare a release: name CHANGELOG.md's Unreleased section after the version, set the version
# everywhere it is written, check, commit and tag. Pushing the tag (git push origin main vX.Y.Z)
# runs .github/workflows/release.yml, which publishes the server image and the desktop app, with
# that section of the changelog as the release's notes.
#   scripts/release.sh 0.2.0
set -eu
cd "$(dirname "$0")/.."
V=${1:?usage: scripts/release.sh <version>, e.g. 0.2.0}
echo "$V" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "A version looks like 0.2.0." >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "Commit first: the working tree has changes." >&2; exit 1; }
# The changelog: "## Unreleased" with something under it becomes "## X.Y.Z (date)", and a new empty
# Unreleased section goes above it.
V=$V node -e '
  const fs = require("fs")
  const text = fs.readFileSync("CHANGELOG.md", "utf8")
  const match = /^## Unreleased\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)
  if (!match || !match[1].trim()) { console.error("Write what changed under ## Unreleased in CHANGELOG.md first."); process.exit(1) }
  const date = new Date().toISOString().slice(0, 10)
  fs.writeFileSync("CHANGELOG.md", text.replace("## Unreleased\n", `## Unreleased\n\n## ${process.env.V} (${date})\n`))
'
V=$V node -e '
  const fs = require("fs")
  for (const file of ["package.json", "packages/desktop/package.json", "packages/desktop/src-tauri/tauri.conf.json"]) {
    const json = JSON.parse(fs.readFileSync(file, "utf8")); json.version = process.env.V
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n")
  }
  const cargo = "packages/desktop/src-tauri/Cargo.toml"
  fs.writeFileSync(cargo, fs.readFileSync(cargo, "utf8").replace(/^version = ".*"$/m, `version = "${process.env.V}"`))
'
# The app's own version in Cargo.lock; nothing else changes there.
(cd packages/desktop/src-tauri && cargo update -p vasta-desktop --offline -q)
pnpm -s typecheck
pnpm -s test > /dev/null
git add CHANGELOG.md
git commit -q -am "Release $V"
git tag "v$V"
echo "Tagged v$V. Publish it with: git push origin main v$V"
