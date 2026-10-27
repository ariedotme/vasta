fn main() {
    // Permissions for the app's own commands (allow-<command>): the bundled page gets the connect
    // ones, the capture panel its own, the server's pages only allow-set-shortcut,
    // allow-capture-result, allow-capture-questions, allow-capture-suggestions, allow-update-app, allow-notify and allow-set-notify-token (capabilities/, main.rs).
    let manifest = tauri_build::AppManifest::new().commands(&[
        "startup",
        "connect",
        "use_local",
        "use_server",
        "open_server",
        "set_shortcut",
        "submit_capture",
        "capture_result",
        "capture_questions",
        "close_capture",
        "suggest_capture",
        "capture_suggestions",
        "fit_capture",
        "update_app",
        "notify",
        "set_notify_token",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest)).expect("could not build Vasta");
}
