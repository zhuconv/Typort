mod commands;
mod config;
mod hub;
mod protocol;
mod session;
mod window;

use std::sync::Arc;

use parking_lot::Mutex;
use tauri::Manager;

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
        .setup(|app| {
            let config = AppConfig::load_or_init(&app.path())?;
            let registry = Arc::new(Mutex::new(SessionRegistry::new()));

            let state = AppState {
                config: config.clone(),
                registry: registry.clone(),
                hub_address: parking_lot::Mutex::new(None),
            };
            app.manage(state);

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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
