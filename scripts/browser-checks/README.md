# Browser checks

Playwright scripts that drive the web app in the isolated test env (`scripts/test-env.sh`: Vite on
5183 without a service worker, the server on 5184 serving `packages/web/dist` with it). They refuse
other addresses; never point them at the dev server on 5173/5174 or at production.

    scripts/test-env.sh &            # restart it after server edits; `pnpm --filter @vasta/web build` for 5184
    cd scripts/browser-checks && npm install   # once (browsers: npx playwright install chromium webkit)
    VASTA_DATA=<the test env's dir> node ../../packages/server/src/cli.ts token add tester ui-test --scope capture
    CAPTURE_TOKEN=<token> node replica.mjs chromium http://127.0.0.1:5183
    CAPTURE_TOKEN=<token> node replica.mjs chromium http://127.0.0.1:5184   # + reload offline (service worker)
    CAPTURE_TOKEN=<token> node replica.mjs webkit http://127.0.0.1:5184     # iPhone 15 profile
    node views.mjs [base]        # every screen, search, trash + Undo, second tab, logout
    node editor.mjs [base]       # slash menu, mention, undo, moving a block, image upload
    node weblink.mjs             # a weblink created on the replica, fetched by the server
    node device.mjs; node update.mjs
    node desktop.mjs [base]      # Settings › This device: download links, the desktop app's version and shortcut
    node firstsync.mjs [chromium|webkit]   # LAST_OBJECT=<id>: also open it offline
    node refused.mjs             # a refused change: toast, Settings list, dismiss (PHONE=1, SHOTS=<dir>)
    node httpsave.mjs            # HTTP mode: a rename made elsewhere while typing is not undone
    node calendar.mjs [chromium|webkit] [base] [phone]   # repeating dates: drag, resize, the three choices, bars; phone = long press (chromium)
    node table.mjs [chromium|webkit] [base]   # Columns menu, resizing, filters through a relation (MODE=json too)
    node formula.mjs [chromium|webkit] [base]  # a formula column, writing one in Type settings, sort, filter, the object page (MODE=json too)
    node blocks.mjs [chromium|webkit] [base]   # block colors, copy link to block, opening it, ids of duplicates (MODE=json too)
    node quotes.mjs [chromium|webkit] [base]   # save a passage as a quote, open it from the highlight, delete it (MODE=json too)
    node handover.mjs [base]     # a second tab takes the replica over when the first closes
    node capture.mjs [base]      # /Type in quick capture (embedded in today's note), a relation's values, ⌘K, the panel's bridge (MODE=json too)
    node blockrefs.mjs [base]    # @Title#… mentions a block, @@ embeds one read-only; it follows edits; links open the block (MODE=json too)
    node channels.mjs [base]     # Settings › Capture channels and Telegram's chats (the bot's state faked)
    node inbox.mjs [base]        # Settings › Inbox: the word for reviewed items, fading, in the inbox and the daily note
    node nutrition.mjs [chromium|webkit] [base] [phone]   # food tracking: Settings, a weekly goal, the picker, editing, a recipe, portions, /food in ⌘K, the Nutrition page, kcal in the month (MODE=json too)
    node board.mjs [chromium|webkit] [base] [phone]   # drag between columns and within one (manual order), "+", WIP limit, folding, swimlanes, card fields, Blocked; phone = long press (chromium) (MODE=json too)
    node sprints.mjs [chromium|webkit] [base]   # Settings › Sprints (on, named Rodada), Current rodada and Backlog, a sprint's panel, Finish, Next (MODE=json too)
    node metrics.mjs [chromium|webkit] [base]  # the Tasks page's Metrics: numbers, done per week, cumulative flow (hover), what waits longest (SHOTS=<dir>: light and dark)
    node people.mjs [chromium|webkit] [base]   # a shared space: Assignee picked on a task, "Edited … by", Mine, a filter on Me, a board by assignee, assignee: in ⌘K, comments, the bell, activity (needs a second account: see the script; MODE=json too)
    node invites.mjs [base]      # Settings › Server accounts makes an invite link; someone new joins with it, once (seed data: tester is the first account)
    node scale.mjs [base]        # times on a big space (pnpm load-test 50000 --keep): first login, full replica, a big type page, Today, ⌘K, reload
    node panel.mjs               # the desktop capture panel page with the app faked: list, pick, Esc, growing (no server)
    MODE=json node views.mjs     # the same with the replica turned off (HTTP mode)

Notes: WebKit has no OPFS in an ephemeral context, so the scripts use a persistent profile; and
Playwright's WebKit keeps OPFS across profiles, so a WebKit run reuses the replica of the last one
(firstsync.mjs empties OPFS first). device.mjs's banner step times out (its `context.route` of `/`
does not reach the app's fetch in WebKit, likely because the service worker answers it);
update.mjs checks the banner.
For timing with more data, build a copy with extra objects and start the env on it:
`VASTA_TEST_SOURCE=<dir with vasta.db> scripts/test-env.sh`. In
headless Chromium wait a moment between a click and Enter (ProseMirror reads the click's selection
on `selectionchange`). On macOS, Meta+ArrowRight goes to the end of a line. When hover controls are
involved, walk the pointer step by step (see the project's UI test notes).
