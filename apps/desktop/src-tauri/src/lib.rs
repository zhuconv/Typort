mod commands;
mod config;
mod hub;
mod protocol;
mod session;
mod window;

use std::sync::Arc;

use parking_lot::Mutex;
use tauri::{Manager, RunEvent, WindowEvent};

use crate::config::AppConfig;
use crate::session::SessionRegistry;

pub struct AppState {
    pub config: AppConfig,
    pub registry: Arc<Mutex<SessionRegistry>>,
    pub hub_address: parking_lot::Mutex<Option<std::net::SocketAddr>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if std::env::var("RUST_LOG").is_err() {
        std::env::set_var("RUST_LOG", "info,tower_http=warn");
    }
    let _ = env_logger::try_init();

    tauri::Builder::default()
        // Subsequent invocations of `pnpm tauri:dev` (or any second launch of the
        // binary) hit this callback inside the already-running instance. We
        // bring the welcome window forward instead of starting a second daemon.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_welcome_window(app);
        }))
        // Lets the frontend hand off `Cmd+click` on a hyperlink to the
        // user's default browser. Without this the embedded WKWebView
        // has no tab system and the link click is a no-op.
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config = AppConfig::load_or_init(&app.path())?;
            let registry = Arc::new(Mutex::new(SessionRegistry::new()));

            let state = AppState {
                config: config.clone(),
                registry: registry.clone(),
                hub_address: parking_lot::Mutex::new(None),
            };
            app.manage(state);

            // Start as a menu-bar/accessory app: hub runs, welcome window can
            // appear, but no Dock icon. We bump to Regular when the first
            // editor session opens (see window.rs::ensure_session_window) and
            // back to Accessory when the last session closes
            // (see commands.rs::close_session_internal).
            #[cfg(target_os = "macos")]
            {
                // Register the Dock icon BEFORE flipping to Accessory. In dev
                // mode the binary has no .icns (that's only embedded in the
                // .app bundle by `tauri build`), so without this NSApplication
                // falls back to a generic terminal/exec icon when we later
                // flip to Regular for editor sessions. Tauri v2 doesn't
                // expose a Rust-side setter for the macOS dock icon, so we
                // talk to AppKit directly.
                set_macos_dock_icon(include_bytes!("../icons/icon.png"));
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }

            // Tauri's auto-creation of the "main" window from tauri.conf.json
            // happens before our setup hook, but in Accessory mode the window
            // isn't focus-stolen the way Regular apps do it. Show + focus it
            // explicitly so the user actually sees Welcome on first launch.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }

            let app_handle = app.handle().clone();
            let registry_for_hub = registry.clone();
            let token_for_hub = config.token.clone();

            tauri::async_runtime::spawn(async move {
                if let Err(e) = hub::run_hub(
                    app_handle,
                    registry_for_hub,
                    token_for_hub,
                    config.dev_insecure,
                )
                .await
                {
                    log::error!("hub failed: {e:#}");
                }
            });

            Ok(())
        })
        // Welcome window's red close button hides the window instead of
        // quitting the app — the hub stays alive so remote `typort open`
        // can still bring up editor windows.
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_status,
            commands::copy_tunnel_help,
            commands::list_sessions,
            commands::get_session,
            commands::save_session,
            commands::save_merged,
            commands::reload_session,
            commands::close_session,
            commands::save_as_conflict,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // Default Tauri behavior on macOS already keeps the process alive
            // when the last visible window closes, but we make it explicit:
            // the only legitimate exit is Cmd+Q (which produces ExitRequested
            // with code Some(0) — we let that through).
            if let RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

/// Bring the welcome window to the front. Used by the single-instance plugin
/// callback when a second `pnpm tauri:dev` is invoked.
fn show_welcome_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg(target_os = "macos")]
fn set_macos_dock_icon(png_bytes: &[u8]) {
    use cocoa::appkit::NSApp;
    use cocoa::base::{id, nil};
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        let data: id = msg_send![
            class!(NSData),
            dataWithBytes:png_bytes.as_ptr() as *const std::ffi::c_void
            length:png_bytes.len()
        ];
        let image_alloc: id = msg_send![class!(NSImage), alloc];
        let image: id = msg_send![image_alloc, initWithData: data];
        if image != nil {
            let app: id = NSApp();
            let _: () = msg_send![app, setApplicationIconImage: image];
        }
    }
}

/// Force-activate the Typort app, stealing focus from whatever was on top
/// (typically the terminal that ran `typort open`). Tauri's WebviewWindow
/// `set_focus` brings the window to front of *our* app, but it doesn't make
/// the app active when the trigger came from an external WebSocket event.
#[cfg(target_os = "macos")]
pub(crate) fn activate_app_macos() {
    use cocoa::appkit::NSApp;
    use cocoa::base::{id, YES};
    use objc::{msg_send, sel, sel_impl};

    unsafe {
        let app: id = NSApp();
        let _: () = msg_send![app, activateIgnoringOtherApps: YES];
    }
}
