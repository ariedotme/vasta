// The app's own settings, in settings.json in the app's config folder (on macOS
// ~/Library/Application Support/io.github.ariedotme.vasta/).
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use url::Url;

pub const DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+Space";

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// The Vasta server, e.g. "https://notas.example.org/" (kept while `local`, to switch back).
    pub server: Option<String>,
    /// Run Vasta's server on this computer instead (local.rs).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub local: bool,
    /// Its port, kept between launches: the web app's replica and login belong to its address.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_port: Option<u16>,
    /// The global shortcut for quick capture (Tauri's accelerator syntax), when not the default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shortcut: Option<String>,
    /// The server's web app finished loading here once.
    pub visited: bool,
    /// The token (scope "notify") the app hears its user's reminders with (notifications.rs).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notify_token: Option<String>,
    /// A short random id of this install, naming its token on the server ("Mac 3f2a").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
}

impl Settings {
    fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
        app.path().app_config_dir().ok().map(|dir| dir.join("settings.json"))
    }

    pub fn load(app: &AppHandle) -> Settings {
        let mut settings: Settings = Self::path(app)
            .and_then(|path| std::fs::read_to_string(path).ok())
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        if settings.device.is_none() {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos() ^ d.as_secs() as u32).unwrap_or(0);
            settings.device = Some(format!("{:04x}", (nanos ^ std::process::id()) & 0xffff));
            settings.save(app);
        }
        settings
    }

    /// This install as its notification token is named on the server: "Mac 3f2a".
    pub fn device_name(&self) -> String {
        let system = if cfg!(target_os = "macos") { "Mac" } else if cfg!(windows) { "Windows" } else { "Linux" };
        format!("{system} {}", self.device.as_deref().unwrap_or("app"))
    }

    pub fn save(&self, app: &AppHandle) {
        let Some(path) = Self::path(app) else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Err(error) = std::fs::write(&path, serde_json::to_string_pretty(self).unwrap()) {
            eprintln!("Could not save {}: {error}", path.display());
        }
    }

    /// The server the window shows: the one on this computer, or the user's.
    pub fn server_url(&self) -> Option<Url> {
        if self.local {
            return self.local_port.map(crate::local::url);
        }
        self.remote_url()
    }

    pub fn remote_url(&self) -> Option<Url> {
        self.server.as_deref().and_then(|s| normalize_server(s).ok())
    }

    pub fn shortcut(&self) -> String {
        self.shortcut.clone().unwrap_or_else(|| DEFAULT_SHORTCUT.to_string())
    }
}

/// "notas.example.org" or "https://notas.example.org/anything" → "https://notas.example.org/".
pub fn normalize_server(input: &str) -> Result<Url, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("Type the address of your Vasta server.".into());
    }
    let with_scheme = if input.contains("://") { input.to_string() } else { format!("https://{input}") };
    let mut url = Url::parse(&with_scheme).map_err(|_| format!("“{input}” is not a web address."))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(format!("“{input}” is not a web address."));
    }
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::normalize_server;

    #[test]
    fn normalizes_server_addresses() {
        assert_eq!(normalize_server("notas.example.org").unwrap().as_str(), "https://notas.example.org/");
        assert_eq!(normalize_server(" https://notas.example.org/o/1?x#y ").unwrap().as_str(), "https://notas.example.org/");
        assert_eq!(normalize_server("http://127.0.0.1:5184").unwrap().as_str(), "http://127.0.0.1:5184/");
        assert!(normalize_server("").is_err());
        assert!(normalize_server("ftp://example.org").is_err());
    }
}
