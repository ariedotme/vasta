// Whether the user is at this computer, for insistent reminders that start "the first time I'm at
// the computer after 8:00" (server/src/insistent.ts). The app tells the server
// (POST <server>/api/notifications/presence, with the notify token) when the user comes back: the
// computer woke from sleep, or input came after a while without any (macOS: the system's idle
// time); while they are here, now and then; and when they go away.
use std::time::{Duration, Instant, SystemTime};

use tauri::AppHandle;
use url::Url;

/// How often it looks.
const EVERY: Duration = Duration::from_secs(30);
/// No input for this long: away.
const IDLE: f64 = 5.0 * 60.0;
/// While here, the server hears it this often (it forgets a user it has not heard from in 3 minutes).
const HEARTBEAT: Duration = Duration::from_secs(90);

/// Seconds since the last keyboard or mouse input; None where the system does not say.
#[cfg(target_os = "macos")]
fn idle_seconds() -> Option<f64> {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(source: i32, event: u32) -> f64;
    }
    // kCGEventSourceStateCombinedSessionState, kCGAnyInputEventType.
    let seconds = unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) };
    seconds.is_finite().then_some(seconds)
}

#[cfg(not(target_os = "macos"))]
fn idle_seconds() -> Option<f64> {
    None
}

pub fn start(app: AppHandle, credentials: fn(&AppHandle) -> Option<(Url, String)>) {
    tauri::async_runtime::spawn(async move {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let Ok(client) = reqwest::Client::builder().user_agent(format!("Vasta desktop {}", app.package_info().version)).timeout(Duration::from_secs(15)).build() else { return };
        let mut here = false;
        let mut told: Option<Instant> = None;
        let mut last = (Instant::now(), SystemTime::now());
        loop {
            tokio::time::sleep(EVERY).await;
            // The monotonic clock stops while the computer sleeps; the wall clock does not.
            let (mono, wall) = (Instant::now(), SystemTime::now());
            let slept = wall.duration_since(last.1).unwrap_or_default().saturating_sub(mono.duration_since(last.0)) > Duration::from_secs(60);
            last = (mono, wall);
            let active = idle_seconds().map_or(true, |idle| idle < IDLE);
            let back = active && (!here || slept);
            let state = if back || (active && told.map_or(true, |at| at.elapsed() >= HEARTBEAT)) {
                Some("here")
            } else if !active && here {
                Some("away")
            } else {
                None
            };
            here = active;
            let Some(state) = state else { continue };
            let Some((server, token)) = credentials(&app) else { continue };
            let Ok(address) = server.join("api/notifications/presence") else { continue };
            match client.post(address).bearer_auth(token).json(&serde_json::json!({ "state": state })).send().await {
                Ok(response) if response.status().is_success() => told = Some(Instant::now()),
                // Older servers do not know presence: nothing to do.
                _ => {}
            }
        }
    });
}
