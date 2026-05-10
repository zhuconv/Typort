use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tokio::sync::{mpsc, oneshot};

use crate::protocol::HubToAgent;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionStatus {
    Loading,
    Saved,
    Saving,
    Unsaved,
    Conflict,
    Disconnected,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSnapshot {
    pub session_id: String,
    pub display_name: String,
    pub server: String,
    pub path: String,
    pub initial_content: String,
    pub base_hash: String,
    pub readonly: bool,
    pub status: SessionStatus,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub display_name: String,
    pub status: SessionStatus,
}

pub enum PendingReply {
    Save(oneshot::Sender<SaveOutcome>),
    SaveSibling(oneshot::Sender<SaveSiblingOutcome>),
    Reload(oneshot::Sender<ReloadOutcome>),
}

#[derive(Debug, Clone)]
pub enum SaveSiblingOutcome {
    Ok {
        path: String,
        hash: String,
        size_bytes: u64,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone)]
pub enum SaveOutcome {
    Ok {
        hash: String,
        mtime_ms: f64,
        size_bytes: u64,
    },
    Conflict {
        current_hash: String,
        current_content: String,
        mtime_ms: f64,
    },
    Error {
        message: String,
        code: String,
    },
}

#[derive(Debug, Clone)]
pub enum ReloadOutcome {
    Ok {
        content: String,
        hash: String,
        mtime_ms: f64,
        size_bytes: u64,
    },
    Error {
        message: String,
    },
}

pub struct SessionState {
    pub session_id: String,
    pub server: String,
    pub cwd: String,
    pub path: String,
    pub display_name: String,
    pub initial_content: String,
    pub base_hash: String,
    pub mtime_ms: f64,
    pub size_bytes: u64,
    pub readonly: bool,
    pub status: SessionStatus,
    pub agent_tx: mpsc::Sender<HubToAgent>,
    pub seq: AtomicU64,
    pub pending: HashMap<u64, PendingReply>,
}

impl SessionState {
    pub fn snapshot(&self) -> SessionSnapshot {
        SessionSnapshot {
            session_id: self.session_id.clone(),
            display_name: self.display_name.clone(),
            server: self.server.clone(),
            path: self.path.clone(),
            initial_content: self.initial_content.clone(),
            base_hash: self.base_hash.clone(),
            readonly: self.readonly,
            status: self.status.clone(),
        }
    }

    pub fn summary(&self) -> SessionSummary {
        SessionSummary {
            session_id: self.session_id.clone(),
            display_name: self.display_name.clone(),
            status: self.status.clone(),
        }
    }

    pub fn next_seq(&self) -> u64 {
        self.seq.fetch_add(1, Ordering::SeqCst)
    }
}

pub struct SessionRegistry {
    sessions: HashMap<String, SessionState>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    pub fn insert(&mut self, s: SessionState) {
        self.sessions.insert(s.session_id.clone(), s);
    }

    pub fn remove(&mut self, id: &str) -> Option<SessionState> {
        self.sessions.remove(id)
    }

    pub fn get(&self, id: &str) -> Option<&SessionState> {
        self.sessions.get(id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut SessionState> {
        self.sessions.get_mut(id)
    }

    pub fn list(&self) -> Vec<SessionSummary> {
        self.sessions.values().map(SessionState::summary).collect()
    }

    pub fn len(&self) -> usize {
        self.sessions.len()
    }
}
