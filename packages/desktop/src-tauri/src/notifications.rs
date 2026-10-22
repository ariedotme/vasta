// Reminders as system notifications (Settings › Reminders on the server). The app hears its
// user's reminders on its own, from <server>/api/notifications (Server-Sent Events), with a token
// of scope "notify" the web app asks the server for and hands over (set_notify_token): the web
// page's own connections do not last in WebKit once the window is closed, the app's do. Each
// reminder's key is shown once; a click opens its page.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Notify;

/// The server pings every 25 s: nothing for this long means the connection is gone.
const SILENCE: Duration = Duration::from_secs(70);

/// Reminders shown lately, by the server's key, so one is shown once even when it arrives twice
/// (the app's stream and an older web app's own); and the page each notification opens when
/// clicked, by its id. `restart` wakes the stream when the server or the token changes.
#[derive(Default)]
pub struct Notifications {
    shown: Mutex<Shown>,
    pub restart: Notify,
}

#[derive(Default)]
struct Shown {
    keys: HashMap<String, Instant>,
    pages: HashMap<i32, String>,
    next_id: i32,
}

/// A reminder as the server sends it (server/src/events.ts, DesktopNotification).
#[derive(Deserialize)]
struct Reminder {
    key: String,
    title: String,
    message: String,
    url: Option<String>,
}

/// Show a reminder, unless its key was shown in the last day. `path` is a page of the web app
/// ("nutrition", "o/<id>") to open when it is clicked.
pub fn show(app: &AppHandle, key: String, title: String, body: String, path: Option<String>) -> Result<(), String> {
    let id = {
        let mut shown = app.state::<Notifications>().inner().shown.lock().unwrap();
        let now = Instant::now();
        shown.keys.retain(|_, at| now.duration_since(*at) < Duration::from_secs(24 * 60 * 60));
        if shown.keys.contains_key(&key) {
            return Ok(());
        }
        shown.keys.insert(key, now);
        shown.next_id += 1;
        let id = shown.next_id;
        if shown.pages.len() > 200 {
            shown.pages.clear();
        }
        shown.pages.insert(id, path.unwrap_or_default());
        id
    };
    app.notification().builder().id(id).title(title).body(body).show().map_err(|error| error.to_string())
}

/// The page a clicked notification opens; None when it is not one of ours.
pub fn page_of(app: &AppHandle, id: i32) -> Option<String> {
    app.state::<Notifications>().inner().shown.lock().unwrap().pages.get(&id).cloned()
}

/// What the stream needs from the app: its server and token now, and what to do on news.
pub struct Hooks {
    pub credentials: fn(&AppHandle) -> Option<(url::Url, String)>,
    /// The server refused the token: forget it, so the web app makes another.
    pub refused: fn(&AppHandle),
}

enum Ended {
    /// The server or the token changed: connect again right away.
    Restart,
    /// The token was refused.
    Refused,
    /// The network or the server went away: try again in a while.
    Lost,
}

/// Keep listening for reminders while the app runs: connect when there is a server and a token,
/// again after a lost connection (5 s, doubling up to a minute), and when either changes.
pub fn start(app: AppHandle, hooks: Hooks) {
    tauri::async_runtime::spawn(async move {
        // reqwest's rustls has no crypto provider of its own; the updater installs the same one.
        let _ = rustls::crypto::ring::default_provider().install_default();
        let Ok(client) = reqwest::Client::builder().user_agent(format!("Vasta desktop {}", app.package_info().version)).build() else {
            eprintln!("Notifications: no HTTP client");
            return;
        };
        let mut wait = Duration::from_secs(5);
        loop {
            let restart = &app.state::<Notifications>().inner().restart;
            let Some((server, token)) = (hooks.credentials)(&app) else {
                restart.notified().await;
                continue;
            };
            match listen(&app, &client, &server, &token, &mut wait).await {
                Ended::Restart => {}
                Ended::Refused => {
                    (hooks.refused)(&app);
                    restart.notified().await;
                    // A new token at most every 10 s, should the server keep refusing them.
                    tokio::time::sleep(Duration::from_secs(10)).await;
                }
                Ended::Lost => {
                    tokio::select! {
                        _ = tokio::time::sleep(wait) => {}
                        _ = restart.notified() => {}
                    }
                    wait = (wait * 2).min(Duration::from_secs(60));
                }
            }
        }
    });
}

async fn listen(app: &AppHandle, client: &reqwest::Client, server: &url::Url, token: &str, wait: &mut Duration) -> Ended {
    let Ok(address) = server.join("api/notifications") else { return Ended::Lost };
    let restart = &app.state::<Notifications>().inner().restart;
    let request = client.get(address).bearer_auth(token).header("accept", "text/event-stream").send();
    let mut response = tokio::select! {
        response = request => match response {
            Ok(response) => response,
            Err(_) => return Ended::Lost,
        },
        _ = restart.notified() => return Ended::Restart,
    };
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Ended::Refused;
    }
    if !response.status().is_success() {
        return Ended::Lost;
    }
    *wait = Duration::from_secs(5);
    let mut events = Events::default();
    loop {
        tokio::select! {
            chunk = tokio::time::timeout(SILENCE, response.chunk()) => match chunk {
                Ok(Ok(Some(bytes))) => {
                    for data in events.push(&String::from_utf8_lossy(&bytes)) {
                        let Ok(reminder) = serde_json::from_str::<Reminder>(&data) else { continue };
                        let path = reminder.url.as_deref().and_then(|url| url.strip_prefix(server.as_str())).map(str::to_string);
                        if let Err(error) = show(app, reminder.key, reminder.title, reminder.message, path) {
                            eprintln!("Could not show a notification: {error}");
                        }
                    }
                }
                _ => return Ended::Lost,
            },
            _ = restart.notified() => return Ended::Restart,
        }
    }
}

/// Server-Sent Events read as they arrive: the data of each complete `notify` event.
#[derive(Default)]
struct Events {
    buffer: String,
}

impl Events {
    fn push(&mut self, text: &str) -> Vec<String> {
        self.buffer.push_str(&text.replace("\r\n", "\n"));
        let mut found = Vec::new();
        while let Some(end) = self.buffer.find("\n\n") {
            let block: String = self.buffer.drain(..end + 2).collect();
            let mut event = "message";
            let mut data = Vec::new();
            for line in block.lines() {
                if let Some(value) = line.strip_prefix("event:") {
                    event = value.trim();
                } else if let Some(value) = line.strip_prefix("data:") {
                    data.push(value.strip_prefix(' ').unwrap_or(value));
                }
            }
            if event == "notify" && !data.is_empty() {
                found.push(data.join("\n"));
            }
        }
        found
    }
}

#[cfg(test)]
mod tests {
    use super::Events;

    #[test]
    fn reads_notify_events_split_anywhere() {
        let mut events = Events::default();
        assert!(events.push(": ping\n\nevent: noti").is_empty());
        assert_eq!(events.push("fy\r\ndata: {\"key\":\"a\"}\r\n\r\nevent: other\ndata: x\n\n"), vec!["{\"key\":\"a\"}".to_string()]);
        assert!(events.buffer.is_empty());
    }
}
