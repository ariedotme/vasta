#!/bin/zsh
# Isolated Vasta for automated UI tests: copies data/ into a temporary directory and serves it
# on other ports (API 5184, web 5183), so tests never touch the real data in data/. Without a
# data/vasta.db, it starts from made-up data instead (packages/server/src/seed.ts).
# Settings come from .env.test if it exists (never from .env), e.g. a separate test bot token.
#   scripts/test-env.sh [--lan] [copy-dir]
#   --lan                       also serve the web app on the local network, to open it on a phone
#   VASTA_TEST_SOURCE=<dir>     copy that data directory instead of data/
set -e
setopt null_glob
cd "$(dirname "$0")/.."
unset TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_CHAT_IDS VASTA_CAPTURE_TOKEN VASTA_SPACE VASTA_WEB_URL
if [ -f .env.test ]; then set -a; source ./.env.test; set +a; fi
export VASTA_WEB_URL=${VASTA_WEB_URL:-http://127.0.0.1:5183}
LAN=
if [ "${1:-}" = --lan ]; then LAN=1; shift; fi
SRC=${VASTA_TEST_SOURCE:-data}
DIR=${1:-$(mktemp -d -t vasta-test)}
rm -f "$DIR"/vasta.db*
if [ -e "$SRC/vasta.db" ]; then
  sqlite3 "$SRC/vasta.db" ".backup $DIR/vasta.db"   # consistent copy even while the dev server runs
  [ -e "$DIR/media" ] || ln -s "${SRC:A}/media" "$DIR/media"   # :A makes it absolute
else
  node --no-warnings packages/server/src/seed.ts "$DIR"
fi
# Test logins (tester and anatest / test-password); tester can use every space of the copy.
vasta() { VASTA_DATA="$DIR" node --no-warnings packages/server/src/cli.ts "$@" }
vasta user list | grep -q '^tester ' || echo test-password | vasta user add tester > /dev/null
vasta user list | grep -q '^anatest ' || echo test-password | vasta user add anatest --name "Ana Teste" > /dev/null
vasta space share --all tester --role owner > /dev/null
echo "Test data: $DIR (log in as tester or anatest / test-password)"
(cd packages/server && VASTA_DATA="$DIR" PORT=5184 node --no-warnings src/main.ts) &
if [ -n "$LAN" ]; then
  echo "On the phone (same Wi-Fi): http://$(ipconfig getifaddr en0 || echo '<this Mac>'):5183 (plain HTTP: no service worker, no install)"
  (cd packages/web && VASTA_API=http://127.0.0.1:5184 npx vite --host 0.0.0.0 --port 5183 --strictPort) &
else
  (cd packages/web && VASTA_API=http://127.0.0.1:5184 npx vite --port 5183 --strictPort) &
fi
wait
