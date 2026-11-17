// The takeover: an insistent reminder's last steps cover the screen (server/src/insistent.ts), like
// break apps do. The server sends a `takeover` event on the app's notification stream
// (notifications.rs); the app opens the web app's page for it (/remind/<id>?takeover=1) in a
// window over the whole screen with the pointer, above other apps and on every Space, and dims the
// other screens (cover.html). The page answers it and closes it (close_takeover); the server's
// `dismiss` event closes it too, when it was answered anywhere else (the phone, Telegram).
//
// It never traps anyone: the page offers a way out after a few seconds (recorded as skipped); a
// page that does not show the reminder within a few seconds (logged out, the server gone away, an
// error) closes it at once, and the app closes it by itself if the page never says it is showing
// the reminder (takeover_ready), and a couple of minutes after the way out in any case.
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use url::Url;

/// The window with the reminder's page; the other screens' covers are `takeover-cover-<n>`.
pub const TAKEOVER: &str = "takeover";
const COVER: &str = "takeover-cover-";

/// How long the takeover stays at most, past its way out, before the app closes it by itself.
const LONGEST: Duration = Duration::from_secs(2 * 60);
/// How long the page has to say it shows the reminder.
const READY: Duration = Duration::from_secs(15);

/// The nag the takeover shows now, and whether its page said it shows it.
#[derive(Default)]
pub struct Takeovers {
    current: Mutex<Option<String>>,
    ready: Mutex<bool>,
}

/// The page shows the reminder (with its way out): it may stay.
pub fn ready(app: &AppHandle) {
    *app.state::<Takeovers>().ready.lock().unwrap() = true;
}

/// A takeover as the server sends it (server/src/events.ts, DesktopTakeover).
#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Takeover {
    pub id: String,
    pub path: String,
    pub escape_after: u64,
}

pub fn is_takeover(label: &str) -> bool {
    label == TAKEOVER || label.starts_with(COVER)
}

/// Cover the screens with the reminder at `url` (a page of the web app). Run on the main thread.
pub fn open(app: &AppHandle, takeover: Takeover, url: Url) {
    *app.state::<Takeovers>().current.lock().unwrap() = Some(takeover.id.clone());
    *app.state::<Takeovers>().ready.lock().unwrap() = false;
    let monitors = app.available_monitors().unwrap_or_default();
    let here = app.cursor_position().ok().and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten()).or_else(|| app.primary_monitor().ok().flatten());
    let Some(here) = here.or_else(|| monitors.first().cloned()) else {
        eprintln!("Takeover: no screen");
        return;
    };
    // The reminder on the screen with the pointer, covers on the others.
    let shown = app.get_webview_window(TAKEOVER).is_some();
    match cover(app, TAKEOVER, WebviewUrl::External(url.clone()), &here) {
        Ok(window) => {
            // Another reminder took over meanwhile: this one replaces it.
            if shown {
                let _ = window.navigate(url);
            }
            let _ = window.show();
            let _ = window.set_focus();
        }
        Err(error) => {
            eprintln!("Could not open the takeover: {error}");
            return;
        }
    }
    let mut n = 0;
    for monitor in monitors.iter().filter(|m| m.position() != here.position() || m.size() != here.size()) {
        n += 1;
        if let Ok(window) = cover(app, &format!("{COVER}{n}"), WebviewUrl::App("cover.html".into()), monitor) {
            let _ = window.show();
        }
    }
    // A page that does not show the reminder goes; whatever happens, it does not stay long.
    let app = app.clone();
    let id = takeover.id;
    let longest = Duration::from_secs(takeover.escape_after) + LONGEST;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(READY).await;
        if !*app.state::<Takeovers>().ready.lock().unwrap() {
            let (handle, id) = (app.clone(), id.clone());
            let _ = app.run_on_main_thread(move || close(&handle, Some(&id)));
            return;
        }
        tokio::time::sleep(longest.saturating_sub(READY)).await;
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || close(&handle, Some(&id)));
    });
}

/// A window over one whole screen, above everything, on every Space.
fn cover(app: &AppHandle, label: &str, url: WebviewUrl, monitor: &tauri::Monitor) -> tauri::Result<WebviewWindow> {
    let window = match app.get_webview_window(label) {
        Some(window) => window,
        None => {
            let builder = WebviewWindowBuilder::new(app, label, url)
                .title("Vasta reminder")
                .decorations(false)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .visible_on_all_workspaces(true)
                .shadow(false)
                .visible(false);
            let window = builder.build()?;
            #[cfg(target_os = "macos")]
            crate::panel::over_everything(&window);
            window
        }
    };
    let _ = window.set_position(PhysicalPosition::new(monitor.position().x, monitor.position().y));
    let _ = window.set_size(PhysicalSize::new(monitor.size().width, monitor.size().height));
    Ok(window)
}

/// Close the takeover: any (`None`), or only the one of this nag.
pub fn close(app: &AppHandle, id: Option<&str>) {
    {
        let state = app.state::<Takeovers>();
        let mut current = state.current.lock().unwrap();
        if id.is_some() && current.as_deref() != id {
            return;
        }
        *current = None;
    }
    for (label, window) in app.webview_windows() {
        if is_takeover(&label) {
            let _ = window.close();
        }
    }
}
