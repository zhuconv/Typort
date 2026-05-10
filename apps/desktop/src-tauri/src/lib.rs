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
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
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
