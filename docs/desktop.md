# Desktop app

`packages/desktop` is Vasta for macOS, Windows and Linux, built with [Tauri 2](https://tauri.app).
It is a window on the user's Vasta server plus what a browser tab cannot do. The web app stays the
only UI.

## How it works

- **The window loads the server's web app** (e.g. `https://vasta.example.org`), so the session
  cookie, the service worker, the local replica (sqlite-wasm on OPFS) and web app updates work as
  in Safari. Checked on 2026-10-19 in macOS's WKWebView: service worker, OPFS with
  `createSyncAccessHandle` and Web Locks all work, and after one online session the app starts
  offline with the replica. The other option, bundling the web app inside the app
  (`tauri://localhost`), would need a configurable API base, CORS, cross-site cookies (WebKit
  blocks third-party cookies) and a proxy for `/media`. Not needed.
- **First start**: a bundled page (`packages/desktop/src/`) asks for the server's address and
  checks that something answers there. Once the web app has loaded, the window opens the server
  directly: offline, its service worker answers.
- **The server's pages get six commands** (and moving the window from their top bars, 0.1.9), `set_notify_token` (the token the app hears reminders with, 0.1.11) and `notify` (a reminder the page heard, for 0.1.10's web app; [reminders.md](reminders.md)), `set_shortcut` (Settings › Desktop app),
  `capture_result` and `capture_suggestions` (answers to the capture panel, 0.1.7) and
  `update_app` (the web app's "Update", 0.1.8), through a capability the app adds at run time for the chosen server's origin (`allow_server` in
  `main.rs`; the app's commands get their own permissions from `build.rs`, so the server cannot
  call the connect page's). `capabilities/default.json` covers the bundled page. Everything else
  desktop-only runs in Rust (`src-tauri/src/main.rs`), which talks to the page by dispatching DOM
  events that `packages/web/src/lib/platform.ts` listens for (`vasta:capture`, `vasta:today`,
  `vasta:settings`), or by opening `/?capture`, `/?today` or `/?settings` when the window is not
  showing the web app. What the page knows about the app (version, shortcut, where updates
  come from) comes from an **initialization script**, which needs no IPC permission: it sets
  `window.__VASTA_DESKTOP__` before the page's scripts run, and the app sets it again after each
  page load (a `vasta:desktop` event), since the shortcut can change. Settings › Desktop app shows
  it (0.1.2 and later; changing the shortcut there, 0.1.3 and later).
- **External links** (`target="_blank"`, which every link to another site in the web app uses)
  open in the default browser. Links to the server's own pages (an image opened from a note) open
  in a new app window. The opener plugin's own link interception is off: it would call Tauri
  from the page, which has no access.
- Settings live in `settings.json` in the app's config folder (macOS:
  `~/Library/Application Support/io.github.ariedotme.vasta/`): `server`, `visited` and optionally
  `shortcut`. The web data (service worker caches, OPFS replica) is WebKit's store for the app
  (macOS: `~/Library/WebKit/io.github.ariedotme.vasta/`).

## What it adds

| | |
|---|---|
| Quick capture | Global shortcut **⌘⇧Space** (Ctrl+Shift+Space on Windows/Linux). From any other app it opens a **floating panel** (`capture.html`, like Spotlight or Raycast): over everything, centered on the screen with the pointer, the text field focused; Enter saves, Shift+Enter adds a line, Esc or clicking elsewhere closes it and keeps the draft. Vasta's window stays as it was. The panel hands the text to the web app in the main window (hidden or not; `submit_capture` → a `vasta:capture-text` event), which captures it like its own dialog and answers (`capture_result`); then the panel hides and macOS gives the focus back to the app that had it. When Vasta's window is in front, the shortcut opens the web app's own Quick capture dialog instead. The text goes to today's note of the user's capture space (Settings › Account), or of the open space when none is set, as a captured item (channel "Desktop app", shown in the Inbox). Online the server takes it (links become weblinks); offline the replica does (links stay plain links) and it syncs later. `/Type title name:value` makes an object of that type, embedded in the note ([capture.md](capture.md#desktop-app-quick-capture)); the web app reads it, so it works in the panel of every version. From 0.1.7 the panel also lists the types after `/` and a relation's objects or a select's options after `name:`, with a line saying what will be made: it asks the web app (`suggest_capture` → a `vasta:capture-suggest` event; the web app answers with `capture_suggestions`) and grows to fit the list (`fit_capture`). The panel needs the web app loaded and logged in (else: "Vasta did not answer"). |
| Menu-bar item | Open Vasta, Quick Capture, Today (the calendar's day view, with the daily note), Open at Login, Settings…, Check for Updates…, Change Server…, Quit. A left click opens the window. |
| Settings | One Settings screen, the web app's: **⌘,** (the app's menu on macOS; Ctrl+, on Windows and Linux, taken by the web app) or Settings… in the menu-bar item. Its Desktop app section shows the version and where updates come from, and records a new quick capture shortcut: click the field and press the keys. `set_shortcut` registers it before dropping the old one, so a shortcut another app or the system holds is refused and the old one keeps working; it saves `"shortcut"` in `settings.json` ([Tauri's accelerator syntax](https://v2.tauri.app/plugin/global-shortcut/), keys as `KeyboardEvent.code`) and relabels the menu item. A key needs ⌘, ⌃ or ⌥ (function keys may go alone). While the shortcut field has focus, pressing the current shortcut only says it is the current one (the web app decides; 0.1.3 swallowed it whenever the window showed `/settings`, even hidden, fixed in 0.1.4). |
| Window | Closing it, ⌘W or ⌘Q (the app menu's Close Vasta) keeps the app running in the menu bar, with the shortcut working. Only Quit Vasta (the menu-bar item, or the app menu without a shortcut) ends it, or force quitting; the Dock's Quit and logging out still quit. Size and position are remembered. ⌘[ / ⌘] go back and forward, ⌘R reloads. |
| Title bar (macOS) | None, as in Capacities (0.1.9): the window's close, minimize and zoom buttons sit in the page's top-left corner (`TitleBarStyle::Overlay`, `traffic_light_position` centering them in the 48px top bar). The app tells the web app (`overlayTitleBar` in `window.__VASTA_DESKTOP__`), which leaves them room in the sidebar's top row (and makes the sidebar a little wider) or in the top bar when the sidebar is hidden, puts the offline/update banner under the top bar, and drops the room in full screen. The top bars move the window and a double click zooms it (`data-tauri-drag-region="deep"`, so buttons and links in them still work); the server's pages and the connect page get `core:window:allow-start-dragging` and `allow-internal-toggle-maximize` for it. Older apps keep the title bar and the web app lays out as before. |
| Transparent panel | The capture panel's window is transparent on macOS, which needs Tauri's `macos-private-api` (`macOSPrivateApi` in `tauri.conf.json`; fine outside the Mac App Store). |
| macOS menus | Vasta (About, Settings… ⌘,, Services, Hide, Close Vasta ⌘Q, Quit Vasta), Edit, Window. |
| Links | External links open in the default browser. |
| `vasta://` links | `vasta://o/<id>`, `vasta://o/<id>#b-<block>` (a link to a block, 0.1.6), `vasta://day/2026-10-19`, `vasta://capture`, `vasta://today`, or any path of the web app. |
| Open at login | From the menu-bar item. It starts hidden in the menu bar. |
| Updates | Checked 20 s after start, then every 6 hours, and from the menu: `<server>/desktop/latest.json`, signed with the updater key. It asks (bringing the window forward) before installing, then restarts. The web app inside updates with the server, as in a browser: when the server has a newer build, its banner says "Update" in the app (not "Reload"), and the button (`update_app`, 0.1.8) offers a newer desktop version first, with the same dialog, and reloads the window when there is none. Older apps reload. |
| One instance | Opening it again focuses the running one. |
| Notifications | Reminders (habits, events, food) as system notifications while the app runs, its window closed too (0.1.11; Settings › Reminders, "Also as notifications of the desktop app"). `notifications.rs` keeps the app's own connection to `<server>/api/notifications` with a `notify` token the web app hands over (`set_notify_token`; [reminders.md](reminders.md)); `tauri-plugin-notification` shows them, and a click opens the reminder's page in the window. Checked on 2026-10-21 with a debug bundle started hidden (`--hidden`) against the test env: a test reminder arrived (macOS's notification database recorded it), a refused token was dropped, and after the server restarted the app reconnected in about 14 s and the next test arrived. 0.1.10 heard them through the page, which stopped once the window was closed. Not checked by hand: the click, and Windows/Linux. |

## Installing

Download the newest build from the [releases](https://github.com/ariedotme/vasta/releases/latest)
(Settings › This device links there too). The app is not signed by Apple or Microsoft, so each
system warns the first time:

- **macOS** (Apple silicon): open `Vasta_<version>_aarch64.dmg` and drag Vasta to Applications.
  The first time, macOS refuses to open it: go to System Settings › Privacy & Security and choose
  **Open Anyway** (or run `xattr -dr com.apple.quarantine /Applications/Vasta.app`). Updates the
  app installs itself do not need this again.
- **Windows**: run `Vasta_<version>_x64-setup.exe`. SmartScreen warns about an unknown publisher:
  More info › Run anyway.
- **Linux**: `Vasta_<version>_amd64.AppImage` (`chmod +x`, then run it) or the `.deb`. The menu-bar
  item needs a panel that supports AppIndicator (GNOME needs the AppIndicator extension).

On first start the app asks for your server's address (e.g. `https://vasta.example.org`); Change
Server… in the menu-bar item changes it later. The app checks the releases for updates (Check for
Updates…, and the web app's Update banner).

## Building and releasing

Toolchain: Rust (rustup), pnpm, and the [Tauri prerequisites](https://tauri.app/start/prerequisites/)
for your system (Xcode command-line tools on macOS, WebKitGTK on Linux). Development:

```sh
pnpm --filter @vasta/desktop dev       # debug build, opens the app (needs a server to point at)
cd packages/desktop/src-tauri && cargo test
```

Releases are built by GitHub Actions (`.github/workflows/release.yml`) when a version tag is
pushed: `scripts/release.sh 0.2.0` sets the version in the three files that hold it, checks,
commits and tags; `git push origin main v0.2.0` publishes. The workflow builds macOS (Apple
silicon), Windows (NSIS installer) and Linux (AppImage, `.deb`), signs the updater archives and
attaches `latest.json`, the manifest installed apps check at
`https://github.com/ariedotme/vasta/releases/latest/download/latest.json`.

The updater key's public half is in `tauri.conf.json`; the private half is the repository secret
`TAURI_SIGNING_PRIVATE_KEY`. **Keep a backup of the key**: without it, installed apps cannot be
updated (a new key means everyone reinstalls by hand). A fork that publishes its own builds makes
its own key (`pnpm --filter @vasta/desktop tauri signer generate`) and changes both, plus the
`UPDATES` address in `src-tauri/src/main.rs`.

## Checking by hand

Playwright cannot drive the Tauri window. Before a release, on the Mac, with the test env
(`scripts/test-env.sh`, server `http://127.0.0.1:5184`) or production:

1. First start: the connect page; a wrong address says nothing answers; the right one opens the
   login.
2. Log in; the space loads; Settings › This device says it keeps a copy.
3. ⌘⇧Space from another app: the floating panel, focused; Esc closes it (the draft stays) and the
   other app gets the focus back. Capture a text with a link: the panel hides, and the Inbox shows
   it with "Desktop app" and a weblink card. With Vasta's window in front: its own dialog.
4. A link to another site (a weblink card) opens in the default browser; the window stays.
5. Close the window: the app stays in the menu bar; the menu-bar icon and the Dock icon bring it
   back. Menu-bar item: Today opens today's note; Open at Login toggles (check System Settings ›
   General › Login Items); Change Server… shows the connect page with Cancel. ⌘, opens Settings;
   its Desktop app section records a new shortcut (one another app holds is refused), the menu
   item shows it, and it works from another app. ⌘Q hides the window and the app keeps running;
   Quit Vasta ends it.
6. Offline: quit, stop the server (or turn Wi-Fi off), start the app: it opens with the offline
   banner and the replica. Quick capture works, and the item reaches the server once it is back.
7. `open vasta://today` in Terminal opens today's note (installed app only: macOS registers the
   scheme from the bundle).
8. Updates: with a newer version published, Check for Updates… offers it, installs and restarts.

To check a build without touching an installed app's settings and WebKit data, bundle it under
another identifier:
`pnpm --filter @vasta/desktop tauri build --debug --bundles app --no-sign --config '{"identifier":"io.github.ariedotme.vasta.dev","productName":"Vasta Dev","bundle":{"createUpdaterArtifacts":false}}'`
(then delete `~/Library/Application Support/io.github.ariedotme.vasta.dev/`).
