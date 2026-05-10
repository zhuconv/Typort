use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

use crate::AppState;
use crate::protocol::{
    FileReload as PFileReload, FileSave as PFileSave, FileSaveSibling as PFileSaveSibling,
    HubToAgent,
};
use crate::session::{
    PendingReply, ReloadOutcome, SaveOutcome, SaveSiblingOutcome, SessionSnapshot, SessionStatus,
    SessionSummary,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    hub_bound: bool,
    hub_address: String,
    token_configured: bool,
    token: Option<String>,
    protocol_version: u32,
    active_sessions: usize,
}

#[tauri::command]
pub fn get_app_status(state: State<'_, AppState>) -> AppStatus {
    let bound = state.hub_address.lock();
    let address = match *bound {
        Some(addr) => format!("http://{addr}"),
        None => state.config.http_url(),
    };
    let active = state.registry.lock().len();
    AppStatus {
        hub_bound: bound.is_some(),
        hub_address: address,
        token_configured: !state.config.token.is_empty(),
        token: if state.config.token.is_empty() {
            None
        } else {
            Some(state.config.token.clone())
        },
        protocol_version: crate::protocol::PROTOCOL_VERSION,
        active_sessions: active,
    }
}

#[tauri::command]
pub fn copy_tunnel_help(state: State<'_, AppState>) -> String {
    format!(
        "ssh -R {port}:127.0.0.1:{port} user@server\n# then on the remote server:\nexport TYPORT_TOKEN={token}\ntyport open /path/to/file.md\n",
        port = state.config.port,
        token = if state.config.token.is_empty() {
            "<token-not-set>"
        } else {
            &state.config.token
        }
    )
}

#[tauri::command]
pub fn list_sessions(state: State<'_, AppState>) -> Vec<SessionSummary> {
    state.registry.lock().list()
}

#[tauri::command]
pub fn get_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionSnapshot, String> {
    let reg = state.registry.lock();
    reg.get(&session_id)
        .map(|s| s.snapshot())
        .ok_or_else(|| format!("no such session: {session_id}"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub kind: String,
    pub hash: Option<String>,
    pub message: Option<String>,
    pub conflict_content: Option<String>,
    pub conflict_hash: Option<String>,
}

#[tauri::command]
pub async fn save_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    content: String,
    reason: Option<String>,
) -> Result<SaveResult, String> {
    do_save(
        &app,
        &state,
        &session_id,
        content,
        reason.unwrap_or_else(|| "autosave".into()),
        None,
    )
    .await
}

/// Save a hand-merged version against a caller-supplied base_hash (typically
/// the remote's hash from the conflict response). Used by the "Edit & merge"
/// branch — without this, save_session would still try to use the session's
/// now-stale base_hash and immediately re-conflict.
#[tauri::command]
pub async fn save_merged(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    content: String,
    base_hash: String,
) -> Result<SaveResult, String> {
    do_save(&app, &state, &session_id, content, "merge".into(), Some(base_hash)).await
}

async fn do_save(
    app: &AppHandle,
    state: &State<'_, AppState>,
    session_id: &str,
    content: String,
    reason: String,
    base_hash_override: Option<String>,
) -> Result<SaveResult, String> {
    let (tx, rx) = oneshot::channel::<SaveOutcome>();

    let (msg, agent_tx) = {
        let mut reg = state.registry.lock();
        let s = reg
            .get_mut(session_id)
            .ok_or_else(|| format!("no such session: {session_id}"))?;
        if s.readonly {
            return Ok(SaveResult::error("session is readonly"));
        }
        let seq = s.next_seq();
        s.pending.insert(seq, PendingReply::Save(tx));
        s.status = SessionStatus::Saving;
        let base_hash = base_hash_override.unwrap_or_else(|| s.base_hash.clone());
        let msg = HubToAgent::Save(PFileSave {
            session_id: session_id.to_string(),
            seq,
            base_hash,
            content,
            reason,
        });
        (msg, s.agent_tx.clone())
    };

    let _ = app.emit(
        "session.status",
        serde_json::json!({ "sessionId": session_id, "status": "saving" }),
    );

    if agent_tx.send(msg).await.is_err() {
        return Err("agent disconnected".into());
    }

    let outcome = tokio::time::timeout(std::time::Duration::from_secs(15), rx)
        .await
        .map_err(|_| "save timed out".to_string())?
        .map_err(|_| "save canceled".to_string())?;

    Ok(match outcome {
        SaveOutcome::Ok { hash, .. } => SaveResult {
            kind: "ok".into(),
            hash: Some(hash),
            message: None,
            conflict_content: None,
            conflict_hash: None,
        },
        SaveOutcome::Conflict {
            current_hash,
            current_content,
            ..
        } => SaveResult {
            kind: "conflict".into(),
            hash: None,
            message: None,
            conflict_content: Some(current_content),
            conflict_hash: Some(current_hash),
        },
        SaveOutcome::Error { message, .. } => SaveResult::error(&message),
    })
}

impl SaveResult {
    fn error(msg: &str) -> Self {
        Self {
            kind: "error".into(),
            hash: None,
            message: Some(msg.into()),
            conflict_content: None,
            conflict_hash: None,
        }
    }
}

#[tauri::command]
pub async fn reload_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionSnapshot, String> {
    let (tx, rx) = oneshot::channel::<ReloadOutcome>();

    let agent_tx = {
        let mut reg = state.registry.lock();
        let s = reg
            .get_mut(&session_id)
            .ok_or_else(|| format!("no such session: {session_id}"))?;
        s.pending.insert(0, PendingReply::Reload(tx));
        s.agent_tx.clone()
    };

    let msg = HubToAgent::Reload(PFileReload {
        session_id: session_id.clone(),
    });
    if agent_tx.send(msg).await.is_err() {
        return Err("agent disconnected".into());
    }

    let outcome = tokio::time::timeout(std::time::Duration::from_secs(15), rx)
        .await
        .map_err(|_| "reload timed out".to_string())?
        .map_err(|_| "reload canceled".to_string())?;

    match outcome {
        ReloadOutcome::Ok {
            content, hash, ..
        } => {
            let mut reg = state.registry.lock();
            if let Some(s) = reg.get_mut(&session_id) {
                s.initial_content = content.clone();
                s.base_hash = hash.clone();
                s.status = SessionStatus::Saved;
                Ok(s.snapshot())
            } else {
                Err("session vanished during reload".into())
            }
        }
        ReloadOutcome::Error { message } => Err(message),
    }
}

#[tauri::command]
pub async fn close_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    close_session_internal(state.registry.clone(), &session_id).await;
    Ok(())
}

/// Shared cleanup used by both the explicit close_session command (in-app
/// "Close" button) and the OS-level window-destroyed event handler.
/// Idempotent: if the session is already gone, this is a no-op.
pub(crate) async fn close_session_internal(
    registry: std::sync::Arc<parking_lot::Mutex<crate::session::SessionRegistry>>,
    session_id: &str,
) {
    let agent_tx = {
        let reg = registry.lock();
        reg.get(session_id).map(|s| s.agent_tx.clone())
    };
    if let Some(tx) = agent_tx {
        let _ = tx
            .send(HubToAgent::Close(crate::protocol::SessionClose {
                session_id: session_id.to_string(),
                reason: "editorClosed".into(),
            }))
            .await;
    }
    let mut reg = registry.lock();
    reg.remove(session_id);
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSiblingResult {
    pub kind: String,
    pub path: Option<String>,
    pub message: Option<String>,
}

/// Write the editor's current draft as a `.typort-conflict-<ts>.md` sibling
/// next to the originally-opened path. The agent picks the timestamped
/// suffix; the hub never specifies an arbitrary path. This is the "Keep mine"
/// branch of the conflict-resolution UI.
#[tauri::command]
pub async fn save_as_conflict(
    state: State<'_, AppState>,
    session_id: String,
    content: String,
) -> Result<SaveSiblingResult, String> {
    let (tx, rx) = oneshot::channel::<SaveSiblingOutcome>();

    let (msg, agent_tx) = {
        let mut reg = state.registry.lock();
        let s = reg
            .get_mut(&session_id)
            .ok_or_else(|| format!("no such session: {session_id}"))?;
        let seq = s.next_seq();
        s.pending.insert(seq, PendingReply::SaveSibling(tx));
        let msg = HubToAgent::SaveSibling(PFileSaveSibling {
            session_id: session_id.clone(),
            seq,
            content,
        });
        (msg, s.agent_tx.clone())
    };

    if agent_tx.send(msg).await.is_err() {
        return Err("agent disconnected".into());
    }

    let outcome = tokio::time::timeout(std::time::Duration::from_secs(15), rx)
        .await
        .map_err(|_| "saveSibling timed out".to_string())?
        .map_err(|_| "saveSibling canceled".to_string())?;

    Ok(match outcome {
        SaveSiblingOutcome::Ok { path, .. } => SaveSiblingResult {
            kind: "ok".into(),
            path: Some(path),
            message: None,
        },
        SaveSiblingOutcome::Error { message } => SaveSiblingResult {
            kind: "error".into(),
            path: None,
            message: Some(message),
        },
    })
}
