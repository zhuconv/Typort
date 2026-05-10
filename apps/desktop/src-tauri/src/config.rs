use std::fs;
use std::io;
use std::path::PathBuf;

use rand::Rng;
use serde::{Deserialize, Serialize};

const DEFAULT_PORT: u16 = 17887;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub token: String,
    pub host: String,
    pub port: u16,
    pub dev_insecure: bool,
    pub config_dir: PathBuf,
}

impl AppConfig {
    /// Load `~/.config/typort/config.json` or create a fresh one with a random token.
    /// Falls back to in-memory defaults if the user dir is unavailable (so the app can still boot).
    pub fn load_or_init(path: &tauri::path::PathResolver<tauri::Wry>) -> Result<Self, ConfigError> {
        let dir = path
            .app_config_dir()
            .or_else(|_| {
                dirs::config_dir()
                    .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no config dir"))
                    .map(|d| d.join("typort"))
            })
            .map_err(|e| ConfigError::Path(e.to_string()))?;

        if let Err(e) = fs::create_dir_all(&dir) {
            log::warn!(
                "could not create config dir {}: {e}; falling back to in-memory token",
                dir.display()
            );
        }

        let path = dir.join("config.json");
        let dev_insecure = std::env::var("TYPORT_DEV_INSECURE").ok().as_deref() == Some("1");

        if let Ok(bytes) = fs::read(&path) {
            if let Ok(mut cfg) = serde_json::from_slice::<AppConfig>(&bytes) {
                cfg.config_dir = dir;
                cfg.dev_insecure = dev_insecure || cfg.dev_insecure;
                return Ok(cfg);
            }
            log::warn!("config.json present but unparseable; regenerating");
        }

        let token = generate_token(32);
        let cfg = AppConfig {
            token,
            host: "127.0.0.1".to_string(),
            port: DEFAULT_PORT,
            dev_insecure,
            config_dir: dir.clone(),
        };

        if let Ok(serialized) = serde_json::to_vec_pretty(&cfg) {
            if let Err(e) = fs::write(&path, serialized) {
                log::warn!(
                    "could not write config.json {}: {e}; token is in-memory only",
                    path.display()
                );
            }
        }
        Ok(cfg)
    }

    pub fn http_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }
}

fn generate_token(byte_len: usize) -> String {
    let mut buf = vec![0u8; byte_len];
    rand::thread_rng().fill(&mut buf[..]);
    hex::encode(buf)
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("path resolution failed: {0}")]
    Path(String),
}
