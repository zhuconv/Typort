//! Rust mirror of `packages/protocol`. Discriminated union by `type`.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AgentToHub {
    #[serde(rename = "agent.hello")]
    Hello(AgentHello),
    #[serde(rename = "file.save.ok")]
    SaveOk(FileSaveOk),
    #[serde(rename = "file.save.conflict")]
    SaveConflict(FileSaveConflict),
    #[serde(rename = "file.save.error")]
    SaveError(FileSaveError),
    #[serde(rename = "file.saveSibling.ok")]
    SaveSiblingOk(FileSaveSiblingOk),
    #[serde(rename = "file.saveSibling.error")]
    SaveSiblingError(FileSaveSiblingError),
    #[serde(rename = "file.remoteChanged")]
    RemoteChanged(FileRemoteChanged),
    #[serde(rename = "file.reload.ok")]
    ReloadOk(FileReloadOk),
    #[serde(rename = "session.close")]
    Close(SessionClose),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum HubToAgent {
    #[serde(rename = "hub.accept")]
    Accept(HubAccept),
    #[serde(rename = "hub.reject")]
    Reject(HubReject),
    #[serde(rename = "file.save")]
    Save(FileSave),
    #[serde(rename = "file.saveSibling")]
    SaveSibling(FileSaveSibling),
    #[serde(rename = "file.reload")]
    Reload(FileReload),
    #[serde(rename = "session.close")]
    Close(SessionClose),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentHello {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub server: String,
    pub cwd: String,
    pub path: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub content: String,
    pub hash: String,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: f64,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    pub readonly: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubAccept {
    #[serde(rename = "sessionId")]
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubReject {
    #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSave {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub seq: u64,
    #[serde(rename = "baseHash")]
    pub base_hash: String,
    pub content: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSaveOk {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub seq: u64,
    pub hash: String,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: f64,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSaveConflict {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub seq: u64,
    #[serde(rename = "baseHash")]
    pub base_hash: String,
    #[serde(rename = "currentHash")]
    pub current_hash: String,
    #[serde(rename = "currentContent")]
    pub current_content: String,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSaveError {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub seq: u64,
    pub message: String,
    #[serde(default)]
    pub code: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSaveSibling {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub seq: u64,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSaveSiblingOk {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub seq: u64,
    pub path: String,
    pub hash: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileSaveSiblingError {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub seq: u64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRemoteChanged {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub hash: String,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: f64,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileReload {
    #[serde(rename = "sessionId")]
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileReloadOk {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub content: String,
    pub hash: String,
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: f64,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionClose {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub reason: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_agent_hello() {
        let h = AgentToHub::Hello(AgentHello {
            protocol_version: 1,
            session_id: "s".into(),
            server: "host".into(),
            cwd: "/".into(),
            path: "/x.md".into(),
            display_name: "host:/x.md".into(),
            content: "# hi".into(),
            hash: "sha256:".to_string() + &"a".repeat(64),
            mtime_ms: 1.0,
            size_bytes: 4,
            readonly: false,
        });
        let s = serde_json::to_string(&h).unwrap();
        assert!(s.contains("\"type\":\"agent.hello\""));
        let parsed: AgentToHub = serde_json::from_str(&s).unwrap();
        match parsed {
            AgentToHub::Hello(h) => assert_eq!(h.session_id, "s"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn parse_file_save() {
        let raw = r#"{"type":"file.save","sessionId":"s","seq":1,"baseHash":"sha256:a","content":"x","reason":"autosave"}"#;
        let m: HubToAgent = serde_json::from_str(raw).unwrap();
        match m {
            HubToAgent::Save(s) => {
                assert_eq!(s.seq, 1);
                assert_eq!(s.reason, "autosave");
            }
            _ => panic!("wrong variant"),
        }
    }
}
