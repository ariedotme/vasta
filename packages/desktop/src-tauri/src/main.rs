// Vasta for the desktop: a window on the user's Vasta server (its web app, service worker and local
// replica work as in a browser, offline included), plus what a browser tab cannot do: a menu-bar
// item, a global shortcut for quick capture, external links in the default browser, vasta:// links,
// start at login, updates and reminders as system notifications (notifications.rs). The server's
// pages get six commands (set_shortcut, from Settings; capture_result and capture_suggestions,
// answers to the capture panel; update_app, the web app's "Update"; set_notify_token, the token
// the app hears reminders with; notify, a reminder from a page, for web apps of 0.1.10); everything else runs in Rust and talks to the page by dispatching DOM events (see
// packages/web/src/lib/platform.ts). Closing the window or ⌘Q keeps the app in the menu bar; only
// Quit Vasta ends it. Without a server of their own, people can run one on this computer instead
// (local.rs): the window then shows that one, and the app logs its user in.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod local;
#[cfg(target_os = "macos")]
mod panel;
mod notifications;
mod settings;

use std::sync::Mutex;

use settings::Settings;
use tauri::ipc::CapabilityBuilder;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use url::Url;

const MAIN: &str = "main";
/// The floating quick capture panel (capture.html), and its size without a list of suggestions.
const CAPTURE: &str = "capture";
const PANEL_WIDTH: f64 = 680.0;
const PANEL_HEIGHT: f64 = 168.0;
/// Started at login: stay in the menu bar until opened.
const HIDDEN_ARG: &str = "--hidden";
const UPDATE_EVERY: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);

struct AppState {
    settings: Mutex<Settings>,
    /// The menu-bar item showing the shortcut, relabelled when it changes.
    capture_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    /// The menu-bar item opening the folder of the server on this computer, enabled while it is used.
    folder_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    /// Held while the server on this computer starts, so it starts once.
    starting: Mutex<()>,
    /// The panel's capture was sent with Ctrl+Enter: once saved, the window comes forward (the web
    /// app has opened what it made).
    open_capture: Mutex<bool>,
}

/// The bundled connect page.
fn local_url() -> Url {
    let base = if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" };
    Url::parse(base).unwrap()
}

fn state(app: &AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

fn server(app: &AppHandle) -> Option<Url> {
    state(app).settings.lock().unwrap().server_url()
}

/// The port of the server on this computer, when the app uses it.
fn local_port(app: &AppHandle) -> Option<u16> {
    let app_state = state(app);
    let settings = app_state.settings.lock().unwrap();
    settings.local.then_some(settings.local_port).flatten()
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN)
}

fn show(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.origin() == b.origin()
}

/// Whether the window shows the server's web app (rather than the connect page or nothing yet).
fn on_server(app: &AppHandle) -> bool {
    match (main_window(app).and_then(|w| w.url().ok()), server(app)) {
        (Some(current), Some(server)) => same_origin(&current, &server),
        _ => false,
    }
}

fn navigate(app: &AppHandle, url: Url) {
    if let Some(window) = main_window(app) {
        let _ = window.navigate(url);
    }
}

/// The connect page, with `query` (e.g. "setup" to change the server).
fn open_local(app: &AppHandle, query: Option<&str>) {
    let mut url = local_url();
    url.set_query(query);
    navigate(app, url);
}

/// Let the server's pages call set_shortcut (Settings › Desktop app), capture_result and
/// capture_suggestions (answers to the capture panel), update_app (the web app's "Update"),
/// set_notify_token and notify (reminders as system notifications), move
/// the window from their bars (data-tauri-drag-region; macOS has no title bar), and nothing else.
/// The server on this computer also gets use_server: its notes moved, the app switches over.
fn allow_server(app: &AppHandle, server: &Url) {
    let origin = server.origin().ascii_serialization();
    let local = server.host_str() == Some("127.0.0.1");
    let capability = CapabilityBuilder::new(format!("server-{origin}"))
        .remote(format!("{origin}/*"))
        .local(false)
        .window(MAIN)
        .permission("allow-set-shortcut")
        .permission("allow-capture-result")
        .permission("allow-capture-suggestions")
        .permission("allow-update-app")
        .permission("allow-notify")
        .permission("allow-set-notify-token")
        .permission("core:window:allow-start-dragging")
        .permission("core:window:allow-internal-toggle-maximize");
    let capability = if local { capability.permission("allow-use-server") } else { capability };
    if let Err(error) = app.add_capability(capability) {
        eprintln!("Could not allow {origin} to change the shortcut: {error}");
    }
}

/// A path of the web app (e.g. "o/<id>"), or its start page. On the server on this computer, through
/// the page that logs its user in; while it is not running, the connect page, which starts it.
fn open_path(app: &AppHandle, path: &str) {
    match (local_port(app), server(app)) {
        (Some(port), _) if local::running(app) => navigate(app, local::login_url(app, port, path)),
        (Some(_), _) => open_local(app, None),
        (None, Some(server)) => navigate(app, server.join(path).unwrap_or(server)),
        (None, None) => open_local(app, Some("setup")),
    }
    show(app);
}

/// Tell the web app something (it listens for these in lib/platform.ts).
fn dispatch(app: &AppHandle, event: &str) {
    if let Some(window) = main_window(app) {
        let _ = window.eval(format!("window.dispatchEvent(new CustomEvent({}))", serde_json::to_string(event).unwrap()));
    }
}

/// What the web app shows about the desktop app (Settings › This device): window.__VASTA_DESKTOP__,
/// then a vasta:desktop event. An initialization script sets it on every page before the page's
/// own scripts run; set again after each load, since the shortcut can change after the window was
/// made.
fn desktop_info_script(app: &AppHandle) -> String {
    let settings = state(app).settings.lock().unwrap().clone();
    let info = serde_json::json!({
        "version": app.package_info().version.to_string(),
        "shortcut": settings.shortcut(),
        "updates": UPDATES,
        "setShortcut": true,
        "updateApp": true,
        "overlayTitleBar": cfg!(target_os = "macos"),
        "notify": true,
        "notifyStream": true,
        "notifyToken": settings.notify_token.is_some(),
        "device": settings.device_name(),
        "local": settings.local,
    });
    format!("window.__VASTA_DESKTOP__ = {info}; window.dispatchEvent(new CustomEvent('vasta:desktop'))")
}

/// Quick capture or today's note: an event when the web app is open, else a start page query.
fn web_action(app: &AppHandle, action: &str) {
    show(app);
    if on_server(app) {
        dispatch(app, &format!("vasta:{action}"));
    } else {
        open_path(app, &format!("?{action}"));
    }
}

/// The global shortcut: the floating panel, over whatever app is in front. When Vasta's window is
/// the one in front, its own Quick capture dialog instead (or, while Settings records a new
/// shortcut, "this is the current one"); before the web app has loaded, the window with /?capture.
fn quick_capture(app: &AppHandle) {
    let in_front = main_window(app).is_some_and(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false));
    if in_front || !on_server(app) {
        return web_action(app, "capture");
    }
    match capture_panel(app) {
        Ok(panel) => {
            place_panel(app, &panel);
            // macOS: over the app in front without bringing Vasta (and its window) along.
            #[cfg(target_os = "macos")]
            panel::show(&panel);
            #[cfg(not(target_os = "macos"))]
            {
                let _ = panel.show();
                let _ = panel.set_focus();
            }
            let _ = panel.eval("window.dispatchEvent(new Event('vasta:open'))");
        }
        Err(error) => {
            eprintln!("Could not open the capture panel: {error}");
            web_action(app, "capture");
        }
    }
}

/// The panel window, made at start (or on first use, if that failed) and then only hidden and shown.
fn capture_panel(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(panel) = app.get_webview_window(CAPTURE) {
        return Ok(panel);
    }
    let builder = WebviewWindowBuilder::new(app, CAPTURE, WebviewUrl::App("capture.html".into()))
        .title("Quick Capture")
        .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
        .resizable(false)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .visible(false);
    // The card draws its own corners and shadow on a transparent window.
    #[cfg(target_os = "macos")]
    let builder = builder.transparent(true);
    let panel = builder.build()?;
    #[cfg(target_os = "macos")]
    panel::make(&panel);
    Ok(panel)
}

/// Centered on the screen with the pointer, a quarter of the way down.
fn place_panel(app: &AppHandle, panel: &WebviewWindow) {
    let monitor = app.cursor_position().ok().and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten()).or_else(|| panel.primary_monitor().ok().flatten());
    let (Some(monitor), Ok(size)) = (monitor, panel.outer_size()) else { return };
    let (origin, screen) = (monitor.position(), monitor.size());
    let x = origin.x + (screen.width as i32 - size.width as i32) / 2;
    let y = origin.y + screen.height as i32 / 4;
    let _ = panel.set_position(PhysicalPosition::new(x, y));
}

/// Hide the panel. The focus goes back to the app in front; on macOS it never left it (the panel
/// does not activate Vasta).
fn hide_panel(app: &AppHandle) {
    if let Some(panel) = app.get_webview_window(CAPTURE) {
        let _ = panel.hide();
    }
}

/// vasta://capture, vasta://today, or any path of the web app: vasta://o/<id>, vasta://day/2026-10-19,
/// vasta://o/<id>#b-<block> (a link to a block).
fn open_deep_link(app: &AppHandle, link: &Url) {
    let path = format!("{}{}", link.host_str().unwrap_or(""), link.path()).trim_matches('/').to_string();
    match path.as_str() {
        "capture" => quick_capture(app),
        "today" => web_action(app, "today"),
        _ => open_path(app, &with_query_and_fragment(path, link)),
    }
}

fn with_query_and_fragment(mut path: String, link: &Url) -> String {
    if let Some(query) = link.query() {
        path = format!("{path}?{query}");
    }
    if let Some(fragment) = link.fragment() {
        path = format!("{path}#{fragment}");
    }
    path
}

/// Links that would open a new window (target=_blank, window.open): pages of the server get a new
/// app window (e.g. an image opened from a note), everything else opens in the default browser.
fn new_window_response(app: &AppHandle, url: Url) -> NewWindowResponse<tauri::Wry> {
    #[cfg(debug_assertions)]
    eprintln!("new window: {url}");
    if server(app).is_some_and(|server| same_origin(&url, &server)) {
        return NewWindowResponse::Allow;
    }
    if matches!(url.scheme(), "http" | "https" | "mailto" | "tel") {
        if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
            eprintln!("Could not open {url}: {error}");
        }
    }
    NewWindowResponse::Deny
}

// The connect page's commands (capabilities/default.json limits them to the bundled page).

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Startup {
    /// The user's own server (also kept while they use the one on this computer).
    server: Option<String>,
    /// The app runs the server on this computer and shows it.
    local: bool,
    /// Where that server keeps its data, to tell people what to back up.
    data_dir: Option<String>,
    /// The server's web app loaded here before, so its service worker can start it offline.
    visited: bool,
    version: String,
}

#[tauri::command]
fn startup(app: AppHandle) -> Startup {
    let settings = state(&app).settings.lock().unwrap().clone();
    Startup {
        server: settings.remote_url().map(|u| u.to_string()),
        local: settings.local,
        data_dir: local::data_dir(&app).map(|dir| local::short_path(&app, &dir)),
        visited: settings.visited,
        version: app.package_info().version.to_string(),
    }
}

#[tauri::command]
fn connect(app: AppHandle, server: String) -> Result<String, String> {
    let url = settings::normalize_server(&server)?;
    {
        let app_state = state(&app);
        let mut settings = app_state.settings.lock().unwrap();
        if settings.local || settings.server_url().as_ref() != Some(&url) {
            allow_server(&app, &url);
            settings.server = Some(url.to_string());
            settings.local = false;
            settings.visited = false;
            // The token was the old server's.
            settings.notify_token = None;
            settings.save(&app);
            app.state::<notifications::Notifications>().restart.notify_one();
        }
    }
    // Its data stays where it is, for switching back.
    local::stop(&app);
    refresh_folder_item(&app);
    Ok(url.to_string())
}

/// The web app on the server on this computer, once its notes moved to `server` (Settings › Server
/// accounts): use that server from now on and open it, where the user logs in with their new
/// password. The notes on this computer stay where they are.
#[tauri::command]
fn use_server(app: AppHandle, server: String) -> Result<(), String> {
    if local_port(&app).is_none() {
        return Err("Vasta does not run on this computer.".into());
    }
    connect(app.clone(), server)?;
    open_path(&app, "");
    Ok(())
}

/// Use the server on this computer ("On this computer" on the connect page, and each launch after),
/// starting it if needed; the page then calls open_server.
#[tauri::command]
async fn use_local(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || start_local(&app)).await.map_err(|error| error.to_string())?
}

/// Start the server on this computer and make it the app's. It keeps its port, unless something else
/// took it since.
fn start_local(app: &AppHandle) -> Result<(), String> {
    let app_state = state(app);
    let _starting = app_state.starting.lock().unwrap();
    let saved = app_state.settings.lock().unwrap().local_port;
    let port = match saved {
        Some(port) if local::running(app) => port,
        _ => local::free_port(saved)?,
    };
    let switched = {
        let mut settings = app_state.settings.lock().unwrap();
        let switched = !settings.local || settings.local_port != Some(port);
        if switched {
            if !settings.local {
                settings.visited = false;
                // The token was the old server's.
                settings.notify_token = None;
            }
            settings.local = true;
            settings.local_port = Some(port);
            settings.save(app);
        }
        switched
    };
    if switched {
        allow_server(app, &local::url(port));
    }
    local::start(app, port)?;
    app.state::<notifications::Notifications>().restart.notify_one();
    refresh_folder_item(app);
    Ok(())
}

fn refresh_folder_item(app: &AppHandle) {
    let local = local_port(app).is_some();
    let item = state(app).folder_item.lock().unwrap().clone();
    if let Some(item) = item {
        let _ = item.set_enabled(local);
    }
}

/// Change the quick capture shortcut (from the web app's Settings): the new one is registered
/// before the old one is dropped for good, so a shortcut another app holds leaves the old one
/// working. An empty one means the default.
#[tauri::command]
fn set_shortcut(app: AppHandle, shortcut: String) -> Result<String, String> {
    let shortcuts = app.global_shortcut();
    let shortcut = if shortcut.is_empty() { settings::DEFAULT_SHORTCUT.to_string() } else { shortcut };
    let new: Shortcut = shortcut.parse().map_err(|_| format!("“{shortcut}” is not a shortcut."))?;
    let old = state(&app).settings.lock().unwrap().shortcut();
    if old.parse::<Shortcut>().ok() == Some(new) {
        return Ok(old);
    }
    let _ = shortcuts.unregister(old.as_str());
    if let Err(error) = shortcuts.register(new) {
        eprintln!("Could not register the shortcut {shortcut}: {error}");
        let _ = shortcuts.register(old.as_str());
        return Err("Another app or the system uses this shortcut. Choose another.".into());
    }
    {
        let app_state = state(&app);
        let mut settings = app_state.settings.lock().unwrap();
        settings.shortcut = (shortcut != settings::DEFAULT_SHORTCUT).then(|| shortcut.clone());
        settings.save(&app);
    }
    if let Some(item) = state(&app).capture_item.lock().unwrap().as_ref() {
        let _ = item.set_accelerator(Some(shortcut.as_str()));
    }
    if let Some(window) = main_window(&app) {
        let _ = window.eval(desktop_info_script(&app));
    }
    Ok(shortcut)
}

// The capture panel's commands (capabilities/capture.json), and the web app's answer.

/// Hand the panel's text to the web app in the main window, which answers with capture_result.
/// With `open` (Ctrl+Enter) the web app also opens what it made, and the window comes forward.
#[tauri::command]
fn submit_capture(app: AppHandle, text: String, open: Option<bool>) -> Result<(), String> {
    if !on_server(&app) {
        return Err("Vasta is not connected to its server yet. Open it first.".into());
    }
    let open = open.unwrap_or(false);
    *state(&app).open_capture.lock().unwrap() = open;
    let detail = serde_json::to_string(&text).unwrap();
    main_window(&app)
        .ok_or("Vasta has no window.")?
        .eval(format!("window.dispatchEvent(Object.assign(new CustomEvent('vasta:capture-text', {{ detail: {detail} }}), {{ open: {open} }}))"))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn capture_result(app: AppHandle, ok: bool, message: Option<String>) {
    let Some(panel) = app.get_webview_window(CAPTURE) else { return };
    if ok {
        let _ = panel.eval("window.dispatchEvent(new Event('vasta:capture-saved'))");
        hide_panel(&app);
        if std::mem::take(&mut *state(&app).open_capture.lock().unwrap()) {
            show(&app);
        }
    } else {
        let detail = serde_json::to_string(&message.unwrap_or_default()).unwrap();
        let _ = panel.eval(format!("window.dispatchEvent(new CustomEvent('vasta:capture-failed', {{ detail: {detail} }}))"));
    }
}

#[tauri::command]
fn close_capture(app: AppHandle) {
    hide_panel(&app);
}

/// Ask the web app what to offer at the panel's cursor (types after "/", a relation's objects, a
/// select's options); it answers with capture_suggestions. Nothing when it is not on the server.
#[tauri::command]
fn suggest_capture(app: AppHandle, text: String, cursor: u32, seq: u32) -> Result<(), String> {
    if !on_server(&app) {
        return Ok(());
    }
    let detail = serde_json::json!({ "text": text, "cursor": cursor, "seq": seq });
    main_window(&app)
        .ok_or("Vasta has no window.")?
        .eval(format!("window.dispatchEvent(new CustomEvent('vasta:capture-suggest', {{ detail: {detail} }}))"))
        .map_err(|error| error.to_string())
}

/// The web app's answer to suggest_capture, handed to the panel as it is (JSON).
#[tauri::command]
fn capture_suggestions(app: AppHandle, answer: serde_json::Value) {
    let Some(panel) = app.get_webview_window(CAPTURE) else { return };
    let _ = panel.eval(format!("window.dispatchEvent(new CustomEvent('vasta:capture-suggestions', {{ detail: {answer} }}))"));
}

/// Grow the panel downwards to show its list of suggestions, or back to its size without one.
#[tauri::command]
fn fit_capture(app: AppHandle, height: f64) {
    if let Some(panel) = app.get_webview_window(CAPTURE) {
        let _ = panel.set_size(LogicalSize::new(PANEL_WIDTH, height.clamp(PANEL_HEIGHT, 560.0)));
    }
}

/// A reminder handed over by a web app of 0.1.10, which heard it itself; newer ones leave it to
/// the app's own stream. Clicking it opens `path`, a page of the web app (e.g. "nutrition").
#[tauri::command]
fn notify(app: AppHandle, key: String, title: String, body: String, path: Option<String>) -> Result<(), String> {
    notifications::show(&app, key, title, body, path)
}

/// The token the app hears its user's reminders with (made by the web app inside it, after
/// logging in), or "" to forget it (logging out).
#[tauri::command]
fn set_notify_token(app: AppHandle, token: String) {
    {
        let app_state = state(&app);
        let mut settings = app_state.settings.lock().unwrap();
        settings.notify_token = Some(token.trim().to_string()).filter(|t| !t.is_empty());
        settings.save(&app);
    }
    app.state::<notifications::Notifications>().restart.notify_one();
    refresh_desktop_info(&app);
}

/// Tell the page what changed about the app (window.__VASTA_DESKTOP__ and a vasta:desktop event).
fn refresh_desktop_info(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.eval(desktop_info_script(app));
    }
}

/// The stream's server and token, when the app has both.
fn notify_credentials(app: &AppHandle) -> Option<(Url, String)> {
    let app_state = state(app);
    let settings = app_state.settings.lock().unwrap();
    Some((settings.server_url()?, settings.notify_token.clone()?))
}

/// The server refused the token (deleted in Settings, or the user is gone): forget it, and let
/// the page make another if someone is logged in there.
fn notify_token_refused(app: &AppHandle) {
    {
        let app_state = state(app);
        let mut settings = app_state.settings.lock().unwrap();
        settings.notify_token = None;
        settings.save(app);
    }
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || refresh_desktop_info(&app));
}

/// A click on a reminder's notification: its page, with the window brought forward.
fn open_notification(app: &AppHandle, id: i32) {
    let path = notifications::page_of(app, id);
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || match path {
        Some(path) => open_path(&app, &path),
        None => show(&app),
    });
}

#[tauri::command]
fn open_server(app: AppHandle) {
    open_path(&app, "");
}

/// The update manifest of the newest release, which the release workflow attaches to every
/// GitHub release (.github/workflows/release.yml).
const UPDATES: &str = "https://github.com/ariedotme/vasta/releases/latest/download/latest.json";

/// A message on the main window (brought forward): a sheet shows reliably on macOS, where an alert
/// without a parent opened from a background task may never appear. True for the first button.
fn ask(app: &AppHandle, text: String, kind: MessageDialogKind, buttons: MessageDialogButtons) -> bool {
    let mut dialog = app.dialog().message(text).title("Vasta").kind(kind).buttons(buttons);
    if let Some(window) = main_window(app) {
        show(app);
        dialog = dialog.parent(&window);
    }
    dialog.blocking_show()
}

fn tell(app: &AppHandle, text: String, kind: MessageDialogKind) {
    ask(app, text, kind, MessageDialogButtons::Ok);
}

/// Look for a newer desktop version and offer it; true when there was one (installed or not).
async fn check_for_update(app: AppHandle, asked: bool) -> bool {
    let say = |text: String, kind: MessageDialogKind| {
        if asked {
            tell(&app, text, kind);
        } else if kind == MessageDialogKind::Error {
            eprintln!("{text}");
        }
    };
    let endpoint = tauri::Url::parse(UPDATES).expect("a valid URL");
    let updater = match app.updater_builder().endpoints(vec![endpoint]).and_then(|b| b.build()) {
        Ok(updater) => updater,
        Err(error) => {
            say(format!("Could not check for updates: {error}"), MessageDialogKind::Error);
            return false;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let text = format!("Vasta {} is available (this is {}). Install it now? The app restarts.", update.version, update.current_version);
            if ask(&app, text, MessageDialogKind::Info, MessageDialogButtons::OkCancelCustom("Install and Restart".into(), "Later".into())) {
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(()) => {
                        // Before the new version starts its own, on the same port.
                        local::stop(&app);
                        app.restart()
                    }
                    Err(error) => tell(&app, format!("The update failed: {error}"), MessageDialogKind::Error),
                }
            }
            true
        }
        Ok(None) => {
            say(format!("Vasta {} is the newest version.", app.package_info().version), MessageDialogKind::Info);
            false
        }
        Err(error) => {
            say(format!("Could not check for updates: {error}"), MessageDialogKind::Error);
            false
        }
    }
}

/// The web app's "Update" (its banner, when the server has a newer build): a newer desktop version
/// is offered as from the menu (installing it restarts the app, which loads the new build too);
/// without one, the window reloads to load the new build.
#[tauri::command]
async fn update_app(app: AppHandle) {
    if !check_for_update(app.clone(), false).await {
        if let Some(window) = main_window(&app) {
            let _ = window.eval("location.reload()");
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let shortcut = state(app).settings.lock().unwrap().shortcut();
    let open = MenuItem::with_id(app, "open", "Open Vasta", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "capture", "Quick Capture", true, Some(shortcut.as_str()))?;
    let today = MenuItem::with_id(app, "today", "Today", true, None::<&str>)?;
    let at_login = CheckMenuItem::with_id(app, "login", "Open at Login", true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "Check for Updates…", true, None::<&str>)?;
    let change = MenuItem::with_id(app, "server", "Change Server…", true, None::<&str>)?;
    let folder = MenuItem::with_id(app, "folder", "Open Notes Folder", local_port(app).is_some(), None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+Comma"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit Vasta", true, None::<&str>)?;
    let separator = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(app, &[&open, &capture, &today, &separator()?, &at_login, &settings, &update, &change, &folder, &separator()?, &quit])?;
    *state(app).capture_item.lock().unwrap() = Some(capture.clone());
    *state(app).folder_item.lock().unwrap() = Some(folder.clone());

    TrayIconBuilder::with_id("vasta")
        .icon(tauri::include_image!("icons/tray.png"))
        .icon_as_template(true)
        .tooltip("Vasta")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => {
                if !on_server(app) {
                    open_path(app, "");
                }
                show(app);
            }
            "capture" => quick_capture(app),
            "today" => web_action(app, "today"),
            "login" => {
                let autolaunch = app.autolaunch();
                let enable = !autolaunch.is_enabled().unwrap_or(false);
                let _ = if enable { autolaunch.enable() } else { autolaunch.disable() };
                let _ = at_login.set_checked(autolaunch.is_enabled().unwrap_or(enable));
            }
            "update" => {
                tauri::async_runtime::spawn(check_for_update(app.clone(), true));
            }
            "server" => {
                open_local(app, Some("setup"));
                show(app);
            }
            "settings" => web_action(app, "settings"),
            "folder" => {
                if let Some(dir) = local::data_dir(app) {
                    let _ = app.opener().open_path(dir.display().to_string(), None::<&str>);
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Close the windows, keeping the app in the menu bar (the red button, ⌘W and ⌘Q do this).
fn close_windows(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        let _ = if label == MAIN || label == CAPTURE { window.hide() } else { window.close() };
    }
}

/// The macOS menu bar: the usual menus plus Settings… (⌘,). ⌘Q is Close Vasta, which keeps it in
/// the menu bar like closing the window; Quit Vasta (here without a shortcut, and in the menu-bar
/// item) ends it. Windows and Linux windows have no menu bar: the web app takes Ctrl+, itself.
#[cfg(target_os = "macos")]
fn build_app_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{AboutMetadata, Submenu};
    let separator = || PredefinedMenuItem::separator(app);
    let vasta = Submenu::with_items(
        app,
        "Vasta",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Vasta"), Some(AboutMetadata::default()))?,
            &separator()?,
            &MenuItem::with_id(app, "app-settings", "Settings…", true, Some("Cmd+Comma"))?,
            &separator()?,
            &PredefinedMenuItem::services(app, None)?,
            &separator()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &separator()?,
            &MenuItem::with_id(app, "app-close", "Close Vasta", true, Some("Cmd+Q"))?,
            &MenuItem::with_id(app, "app-quit", "Quit Vasta", true, None::<&str>)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &separator()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?, &PredefinedMenuItem::fullscreen(app, None)?, &separator()?, &PredefinedMenuItem::close_window(app, None)?],
    )?;
    app.set_menu(Menu::with_items(app, &[&vasta, &edit, &window])?)?;
    Ok(())
}

fn build_window(app: &AppHandle, visible: bool) -> tauri::Result<WebviewWindow> {
    let handle = app.clone();
    let loads = app.clone();
    // Once the web app has loaded here, the window opens it directly: WebKit's service worker only
    // starts it offline when the window opens on it, not after a navigation from the connect page.
    let settings = state(app).settings.lock().unwrap().clone();
    let start = match settings.server_url() {
        // The server on this computer starts from the connect page.
        Some(server) if settings.visited && !settings.local => WebviewUrl::External(server),
        _ => WebviewUrl::App("index.html".into()),
    };
    let builder = WebviewWindowBuilder::new(app, MAIN, start);
    // macOS: no title bar; the traffic lights sit in the page's top bar, which leaves room for them
    // and moves the window (overlayTitleBar in desktop_info_script).
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(18.0, 26.0));
    let window = builder
        .title("Vasta")
        .inner_size(1200.0, 820.0)
        .min_inner_size(420.0, 480.0)
        .visible(visible)
        .initialization_script(desktop_info_script(app))
        .on_new_window(move |url, _features| new_window_response(&handle, url))
        .on_page_load(move |window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                let _ = window.eval(desktop_info_script(window.app_handle()));
            }
            // Remember that the web app loaded once: from then on the connect page opens it even
            // when the server does not answer, and the service worker starts it offline.
            if payload.event() == PageLoadEvent::Finished && server(&loads).is_some_and(|s| same_origin(payload.url(), &s)) {
                let app_state = state(window.app_handle());
                let mut settings = app_state.settings.lock().unwrap();
                if !settings.visited {
                    settings.visited = true;
                    settings.save(window.app_handle());
                }
            }
        })
        .build()?;
    Ok(window)
}

fn main() {
    let app = tauri::Builder::default()
        // First, so a second launch (or a vasta:// link on Windows and Linux) reaches this one.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let links: Vec<Url> = argv.iter().filter_map(|arg| Url::parse(arg).ok()).filter(|u| u.scheme() == "vasta").collect();
            if links.is_empty() {
                show(app);
            }
            for link in links {
                open_deep_link(app, &link);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        // Its click interception script would call Tauri from the server's pages, which have no
        // access; new_window_response opens external links instead.
        .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec![HIDDEN_ARG])))
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_denylist(&[CAPTURE])
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::VISIBLE)
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // While Settings records a new shortcut, the web app takes this as "the current one".
                    if event.state == ShortcutState::Pressed {
                        quick_capture(app);
                    }
                })
                .build(),
        )
        .on_menu_event(|app, event| match event.id.as_ref() {
            "app-settings" => web_action(app, "settings"),
            "app-close" => close_windows(app),
            "app-quit" => app.exit(0),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![startup, connect, use_local, use_server, set_shortcut, open_server, submit_capture, capture_result, close_capture, suggest_capture, capture_suggestions, fit_capture, update_app, notify, set_notify_token])
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(AppState { settings: Mutex::new(Settings::load(&handle)), capture_item: Mutex::new(None), folder_item: Mutex::new(None), starting: Mutex::new(()), open_capture: Mutex::new(false) });
            app.manage(local::LocalServer::default());
            app.manage(notifications::Notifications::default());
            notifications::start(handle.clone(), notifications::Hooks { credentials: notify_credentials, refused: notify_token_refused });
            let clicks = handle.clone();
            let _ = handle.notification().on_action(move |action| {
                if action.action_id() == "tap" {
                    if let Some(notification) = action.notification() {
                        open_notification(&clicks, notification.id());
                    }
                }
            });
            if let Some(server) = server(&handle) {
                allow_server(&handle, &server);
            }
            #[cfg(target_os = "macos")]
            build_app_menu(&handle)?;

            let hidden = std::env::args().any(|arg| arg == HIDDEN_ARG);
            build_window(&handle, !hidden)?;
            // Made now: making a webview brings Vasta to the front (wry), as starting does anyway.
            if let Err(error) = capture_panel(&handle) {
                eprintln!("Could not make the capture panel: {error}");
            }
            build_tray(&handle)?;

            let shortcut = state(&handle).settings.lock().unwrap().shortcut();
            if let Err(error) = handle.global_shortcut().register(shortcut.as_str()) {
                eprintln!("Could not register the shortcut {shortcut}: {error}");
            }

            #[cfg(any(windows, target_os = "linux"))]
            let _ = handle.deep_link().register_all();
            let links = handle.clone();
            handle.deep_link().on_open_url(move |event| {
                for link in event.urls() {
                    open_deep_link(&links, &link);
                }
            });
            if let Ok(Some(started_with)) = handle.deep_link().get_current() {
                for link in started_with {
                    open_deep_link(&handle, &link);
                }
            }

            let updates = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                loop {
                    check_for_update(updates.clone(), false).await;
                    tokio::time::sleep(UPDATE_EVERY).await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps the app in the menu bar (only Quit Vasta ends it).
            match event {
                WindowEvent::CloseRequested { api, .. } if window.label() == MAIN || window.label() == CAPTURE => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                // Like Spotlight: clicking elsewhere closes the capture panel (the draft stays).
                WindowEvent::Focused(false) if window.label() == CAPTURE => hide_panel(window.app_handle()),
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("could not start Vasta");

    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            local::stop(app);
        }
        // macOS: clicking the Dock icon brings the window back.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            show(app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::with_query_and_fragment;
    use tauri::Url;

    #[test]
    fn deep_links_keep_the_block() {
        let link = Url::parse("vasta://o/abc#b-x1y2").unwrap();
        assert_eq!(with_query_and_fragment("o/abc".into(), &link), "o/abc#b-x1y2");
        let server = Url::parse("https://notas.example.org/").unwrap();
        assert_eq!(server.join("o/abc#b-x1y2").unwrap().as_str(), "https://notas.example.org/o/abc#b-x1y2");
        assert_eq!(with_query_and_fragment("day/2026-10-19".into(), &Url::parse("vasta://day/2026-10-19").unwrap()), "day/2026-10-19");
    }
}
