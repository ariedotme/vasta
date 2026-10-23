// "On this computer": the app runs Vasta's server itself, for people without one. It is the same
// server as the Docker image's (bundled by scripts/bundle-server.mjs: Node.js as a sidecar next to
// the app's executable, server/ in the resources), on 127.0.0.1 only, with its data in the app's
// data folder. The server lives as long as the app: it stops when its stdin closes, which happens
// when the app quits or crashes. VASTA_LOCAL_KEY, new on every launch, lets the app log its user in
// (/api/auth/local), so there is no account to make and no password to remember.
use std::fs::File;
use std::io::Read;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use url::Url;

const READY_WITHIN: Duration = Duration::from_secs(30);

pub struct LocalServer {
    child: Mutex<Option<Child>>,
    key: String,
}

impl Default for LocalServer {
    fn default() -> Self {
        let mut bytes = [0u8; 24];
        getrandom::fill(&mut bytes).expect("the system's random numbers");
        LocalServer { child: Mutex::new(None), key: bytes.iter().map(|b| format!("{b:02x}")).collect() }
    }
}

pub fn url(port: u16) -> Url {
    Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap()
}

/// Where the server keeps vasta.db and media/ (on macOS
/// ~/Library/Application Support/io.github.ariedotme.vasta/data).
pub fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("data"))
}

/// A folder as people read it: "~/Library/…" rather than "/Users/name/Library/…" (not on Windows,
/// where ~ means nothing to them).
pub fn short_path(app: &AppHandle, path: &std::path::Path) -> String {
    match app.path().home_dir() {
        Ok(home) if !cfg!(windows) => path.strip_prefix(&home).map_or_else(|_| path.display().to_string(), |rest| format!("~/{}", rest.display())),
        _ => path.display().to_string(),
    }
}

/// `port` when nothing else listens on it, else one the system has free.
pub fn free_port(port: Option<u16>) -> Result<u16, String> {
    let bind = |port: u16| TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)));
    if let Some(port) = port.filter(|&p| bind(p).is_ok()) {
        return Ok(port);
    }
    let listener = bind(0).map_err(|error| format!("Could not find a free port: {error}"))?;
    listener.local_addr().map(|a| a.port()).map_err(|error| error.to_string())
}

/// Whether the server is running (it may have stopped on its own).
pub fn running(app: &AppHandle) -> bool {
    let local = app.state::<LocalServer>();
    let mut child = local.child.lock().unwrap();
    child.as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(None)))
}

/// Start the server on `port`, unless it runs already, and wait until it answers.
pub fn start(app: &AppHandle, port: u16) -> Result<(), String> {
    let local = app.state::<LocalServer>();
    let mut slot = local.child.lock().unwrap();
    if let Some(child) = slot.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            return Ok(());
        }
    }
    let data = data_dir(app).ok_or("The app has no data folder.")?;
    std::fs::create_dir_all(&data).map_err(|error| format!("Could not make {}: {error}", data.display()))?;
    let resources = app.path().resource_dir().map_err(|error| error.to_string())?.join("server");
    let node = std::env::current_exe().map_err(|error| error.to_string())?.with_file_name(if cfg!(windows) { "node.exe" } else { "node" });
    let log_path = data.join("server.log");
    let log = File::create(&log_path).map_err(|error| format!("Could not write {}: {error}", log_path.display()))?;

    let mut command = Command::new(&node);
    command
        .arg("--no-warnings")
        .arg(resources.join("server.mjs"))
        .env("HOST", "127.0.0.1")
        .env("PORT", port.to_string())
        .env("VASTA_DATA", &data)
        .env("VASTA_WEB_DIR", resources.join("web"))
        .env("VASTA_LOCAL_KEY", &local.key)
        .env("NODE_ENV", "production")
        .stdin(Stdio::piped())
        .stdout(log.try_clone().map_err(|error| error.to_string())?)
        .stderr(log);
    // No console window flashing up on Windows.
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
    let mut child = command.spawn().map_err(|error| format!("Could not start Vasta’s server ({}): {error}", node.display()))?;

    let started = Instant::now();
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("Vasta’s server stopped ({status}). {}", last_lines(&log_path)));
        }
        if TcpStream::connect_timeout(&address, Duration::from_millis(200)).is_ok() {
            break;
        }
        if started.elapsed() > READY_WITHIN {
            let _ = child.kill();
            return Err(format!("Vasta’s server did not start. {}", last_lines(&log_path)));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    *slot = Some(child);
    Ok(())
}

/// Stop the server: closing its stdin lets it close the database itself; after a few seconds it is
/// killed.
pub fn stop(app: &AppHandle) {
    let Some(local) = app.try_state::<LocalServer>() else { return };
    let Some(mut child) = local.child.lock().unwrap().take() else { return };
    drop(child.stdin.take());
    let until = Instant::now() + Duration::from_secs(3);
    while Instant::now() < until {
        if !matches!(child.try_wait(), Ok(None)) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// The page that logs the app's user in on the server, then opens `path` of the web app
/// ("", "o/<id>", "?capture", "o/<id>#b-<block>").
pub fn login_url(app: &AppHandle, port: u16, path: &str) -> Url {
    let key = &app.state::<LocalServer>().key;
    let (path, fragment) = path.split_once('#').map_or((path, None), |(p, f)| (p, Some(f)));
    let mut url = url(port).join("api/auth/local").unwrap();
    // The account made on first use is named after the computer's user.
    let user = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default();
    url.query_pairs_mut().append_pair("key", key).append_pair("name", &user).append_pair("next", &format!("/{}", path.trim_start_matches('/')));
    // A redirect without a fragment keeps the one of the page it came from.
    url.set_fragment(fragment);
    url
}

/// The end of the server's log, for an error message.
fn last_lines(path: &PathBuf) -> String {
    let mut text = String::new();
    let _ = File::open(path).and_then(|mut f| f.read_to_string(&mut text));
    let lines: Vec<&str> = text.lines().rev().take(5).collect();
    lines.into_iter().rev().collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_a_free_port() {
        let port = super::free_port(None).unwrap();
        let held = std::net::TcpListener::bind(("127.0.0.1", port)).unwrap();
        assert_ne!(super::free_port(Some(port)).unwrap(), port);
        drop(held);
        assert_eq!(super::free_port(Some(port)).unwrap(), port);
    }
}
