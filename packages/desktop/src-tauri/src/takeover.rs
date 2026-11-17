// The takeover: a reminder covers the screen (server/src/insistent.ts), like break apps do; or, as
// a pop-up, floats in a window over everything in the middle of the screen with the pointer. The server sends a `takeover` event on the app's notification stream
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
    /// Vasta was the app in front when the reminder showed up: when it goes, Vasta stays; when it
    /// was not, the app hides again, so the app that was in front gets its place back.
    was_active: Mutex<bool>,
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
    /// A window floating over everything instead of the whole screen.
    #[serde(default)]
    pub popup: bool,
}

/// The pop-up's size, in points.
const POPUP: (f64, f64) = (560.0, 560.0);

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
    // The reminder on the screen with the pointer; for the whole screen, covers on the others.
    let shown = app.get_webview_window(TAKEOVER).is_some();
    if !shown {
        let active = app.webview_windows().iter().any(|(label, window)| !is_takeover(label) && window.is_focused().unwrap_or(false));
        *app.state::<Takeovers>().was_active.lock().unwrap() = active;
    }
    // Another reminder's covers go when this one only pops up.
    if takeover.popup {
        for (label, window) in app.webview_windows() {
            if label.starts_with(COVER) {
                let _ = window.close();
            }
        }
    }
    let placed = if takeover.popup { floating(app, TAKEOVER, WebviewUrl::External(url.clone()), &here) } else { cover(app, TAKEOVER, WebviewUrl::External(url.clone()), &here) };
    match placed {
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
    for monitor in monitors.iter().filter(|m| !takeover.popup && (m.position() != here.position() || m.size() != here.size())) {
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
    let window = over_all(app, label, url)?;
    let _ = window.set_shadow(false);
    let _ = window.set_position(PhysicalPosition::new(monitor.position().x, monitor.position().y));
    let _ = window.set_size(PhysicalSize::new(monitor.size().width, monitor.size().height));
    Ok(window)
}

/// The pop-up: a window in the middle of the screen, above everything, on every Space.
fn floating(app: &AppHandle, label: &str, url: WebviewUrl, monitor: &tauri::Monitor) -> tauri::Result<WebviewWindow> {
    let window = over_all(app, label, url)?;
    let scale = monitor.scale_factor();
    let (width, height) = ((POPUP.0 * scale) as u32, (POPUP.1 * scale) as u32);
    let (width, height) = (width.min(monitor.size().width), height.min(monitor.size().height));
    let x = monitor.position().x + ((monitor.size().width - width) / 2) as i32;
    let y = monitor.position().y + ((monitor.size().height - height) / 2) as i32;
    let _ = window.set_shadow(true);
    let _ = window.set_size(PhysicalSize::new(width, height));
    let _ = window.set_position(PhysicalPosition::new(x, y));
    Ok(window)
}

/// The reminder's window (made once, hidden): no frame, above everything, on every Space.
fn over_all(app: &AppHandle, label: &str, url: WebviewUrl) -> tauri::Result<WebviewWindow> {
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
                // The pop-up's page rounds its corners; the full screen paints all of it.
                .transparent(true)
                .visible(false);
            let window = builder.build()?;
            #[cfg(target_os = "macos")]
            crate::panel::over_everything(&window);
            window
        }
    };
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
    let mut closed = false;
    for (label, window) in app.webview_windows() {
        if is_takeover(&label) {
            let _ = window.close();
            closed = true;
        }
    }
    // Out of the way again, unless Vasta was what the user was using.
    #[cfg(target_os = "macos")]
    if closed && !*app.state::<Takeovers>().was_active.lock().unwrap() {
        let _ = app.hide();
    }
}
