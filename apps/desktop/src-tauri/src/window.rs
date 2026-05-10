use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub fn ensure_session_window(
    app: &AppHandle,
    session_id: &str,
    display_name: &str,
) -> Result<(), tauri::Error> {
    let label = session_window_label(session_id);
    let title = format!("Typort — {}", display_name);

    if let Some(existing) = app.get_webview_window(&label) {
        #[cfg(target_os = "macos")]
        crate::activate_app_macos();
        let _ = existing.unminimize();
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let url_path = format!("index.html#/session/{}", urlencoding(session_id));
    let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url_path.into()))
        .title(title)
        .inner_size(1000.0, 720.0)
        .min_inner_size(540.0, 360.0)
        .resizable(true)
        .build()?;

    // First session window opening flips the app from menu-bar/accessory mode
    // (no Dock icon) to a regular Dock-visible app. Cleanup in
    // commands::close_session_internal flips it back when the last session
    // closes. We do this BEFORE activating + focusing so the Dock icon is
    // already in place by the time the user looks.
    #[cfg(target_os = "macos")]
    {
        let state: tauri::State<crate::AppState> = app.state();
        let session_count = state.registry.lock().len();
        if session_count == 1 {
            let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        }
        crate::activate_app_macos();
    }

    // Pop the new editor window in front of whatever app currently has focus.
    // Without this the window opens behind the terminal that ran
    // `typort open`, because trigger came via WebSocket and macOS doesn't
    // auto-activate Typort.
    let _ = window.show();
    let _ = window.set_focus();

    // When the user closes this window via the OS (red close button), we still
    // need to tell the remote agent to exit. Without this, the agent's
    // `typort open` process keeps running and holds the file watcher.
    let app_for_close = app.clone();
    let session_id_for_close = session_id.to_string();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            let app = app_for_close.clone();
            let sid = session_id_for_close.clone();
            tauri::async_runtime::spawn(async move {
                let state: tauri::State<crate::AppState> = app.state();
                crate::commands::close_session_internal(&app, state.registry.clone(), &sid).await;
            });
        }
    });

    Ok(())
}

pub fn session_window_label(session_id: &str) -> String {
    // Tauri labels must be alphanumeric / `_-/`. UUIDs are fine; sanitize anyway.
    let safe: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("session-{safe}")
}

fn urlencoding(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u32),
        })
        .collect()
}
