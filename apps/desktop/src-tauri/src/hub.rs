use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;

use axum::{
    Router,
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use crate::AppState;
use crate::protocol::{
    AgentHello, AgentToHub, FileRemoteChanged, HubAccept, HubReject, HubToAgent, PROTOCOL_VERSION,
    SessionClose,
};
use crate::session::{
    PendingReply, ReloadOutcome, SaveOutcome, SaveSiblingOutcome, SessionRegistry, SessionState,
    SessionStatus,
};
use crate::window;

#[derive(Clone)]
struct HubAppState {
    app_handle: AppHandle,
    registry: Arc<Mutex<SessionRegistry>>,
    expected_token: String,
    dev_insecure: bool,
}

pub async fn run_hub(
    app_handle: AppHandle,
    registry: Arc<Mutex<SessionRegistry>>,
    expected_token: String,
    dev_insecure: bool,
) -> Result<(), HubError> {
    let port: u16 = std::env::var("TYPORT_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(17887);
    let addr: SocketAddr = ([127, 0, 0, 1], port).into();

    let app_state = HubAppState {
        app_handle: app_handle.clone(),
        registry,
        expected_token,
        dev_insecure,
    };

    let router = Router::new()
        .route("/health", get(health))
        .route("/agent/connect", get(ws_connect))
        .with_state(app_state);

    let listener = TcpListener::bind(addr).await.map_err(HubError::Bind)?;
    log::info!("typort hub listening on http://{addr}");

    {
        // Persist the bound socket address into AppState so commands can read it.
        let state: tauri::State<AppState> = app_handle.state();
        *state.hub_address.lock() = Some(addr);
    }

    axum::serve(listener, router)
        .await
        .map_err(HubError::Serve)?;
    Ok(())
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

#[derive(Debug, Deserialize)]
struct WsQuery {
    token: Option<String>,
}

async fn ws_connect(
    State(state): State<HubAppState>,
    Query(q): Query<WsQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer ").or(s.strip_prefix("bearer ")));
    let provided = q.token.as_deref().or(bearer).unwrap_or("");

    if !state.dev_insecure {
        if state.expected_token.is_empty() {
            log::warn!("rejecting connection: no token configured");
            return (StatusCode::UNAUTHORIZED, "no token configured").into_response();
        }
        if !ct_eq(provided, &state.expected_token) {
            return (StatusCode::UNAUTHORIZED, "invalid token").into_response();
        }
    }

    ws.on_upgrade(move |socket| handle_socket(socket, state))
        .into_response()
}

/// Constant-time string compare (good enough for tokens we control).
fn ct_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

async fn handle_socket(socket: WebSocket, state: HubAppState) {
    let (mut ws_tx, mut ws_rx) = socket.split();

    // Wait for the first message and require it to be agent.hello.
    let hello = match wait_for_hello(&mut ws_rx).await {
        Ok(h) => h,
        Err(e) => {
            log::warn!("ws: hello failed: {e}");
            let reject = HubToAgent::Reject(HubReject {
                session_id: None,
                reason: e,
            });
            let _ = ws_tx
                .send(Message::Text(serde_json::to_string(&reject).unwrap_or_default()))
                .await;
            return;
        }
    };

    let session_id = hello.session_id.clone();
    let display_name = hello.display_name.clone();

    // Build agent_tx so commands.rs can push HubToAgent messages to this socket.
    let (agent_tx, mut agent_rx) = mpsc::channel::<HubToAgent>(32);

    // Insert the session.
    {
        let mut reg = state.registry.lock();
        let s = SessionState {
            session_id: session_id.clone(),
            server: hello.server.clone(),
            cwd: hello.cwd.clone(),
            path: hello.path.clone(),
            display_name: hello.display_name.clone(),
            initial_content: hello.content.clone(),
            base_hash: hello.hash.clone(),
            mtime_ms: hello.mtime_ms,
            size_bytes: hello.size_bytes,
            readonly: hello.readonly,
            status: SessionStatus::Saved,
            agent_tx,
            seq: AtomicU64::new(1),
            pending: Default::default(),
        };
        reg.insert(s);
    }

    // Create the editor window for this session.
    if let Err(e) = window::ensure_session_window(&state.app_handle, &session_id) {
        log::warn!("could not create session window: {e}");
    }

    // Send accept.
    let accept = HubToAgent::Accept(HubAccept {
        session_id: session_id.clone(),
    });
    if ws_tx
        .send(Message::Text(serde_json::to_string(&accept).unwrap_or_default()))
        .await
        .is_err()
    {
        log::warn!("ws: failed to send accept; closing");
        cleanup_session(&state, &session_id);
        return;
    }

    log::info!("session {session_id} opened: {display_name}");

    // Forward task: send messages from agent_rx (commands.rs) to the WS.
    let mut writer_task = tokio::spawn(async move {
        while let Some(msg) = agent_rx.recv().await {
            let s = match serde_json::to_string(&msg) {
                Ok(s) => s,
                Err(e) => {
                    log::warn!("ws: serialize outgoing failed: {e}");
                    continue;
                }
            };
            if ws_tx.send(Message::Text(s)).await.is_err() {
                break;
            }
        }
        // closing the sink lets the recv loop wind down on graceful close
        let _ = ws_tx.close().await;
    });

    // Reader loop: parse incoming agent→hub messages and dispatch.
    loop {
        tokio::select! {
            biased;
            _ = &mut writer_task => {
                break;
            }
            msg = ws_rx.next() => {
                match msg {
                    Some(Ok(Message::Text(t))) => {
                        match serde_json::from_str::<AgentToHub>(&t) {
                            Ok(parsed) => dispatch_agent_message(&state, parsed),
                            Err(e) => log::warn!("ws: bad message: {e}: {t}"),
                        }
                    }
                    Some(Ok(Message::Binary(_))) => {}
                    Some(Ok(Message::Ping(_))) | Some(Ok(Message::Pong(_))) => {}
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(e)) => {
                        log::warn!("ws read error: {e}");
                        break;
                    }
                }
            }
        }
    }

    log::info!("session {session_id} closed");
    cleanup_session(&state, &session_id);
}

async fn wait_for_hello(
    ws_rx: &mut futures_util::stream::SplitStream<WebSocket>,
) -> Result<AgentHello, String> {
    let timeout = tokio::time::Duration::from_secs(10);
    let msg = tokio::time::timeout(timeout, ws_rx.next())
        .await
        .map_err(|_| "timeout waiting for hello".to_string())?
        .ok_or_else(|| "socket closed before hello".to_string())?
        .map_err(|e| format!("read error: {e}"))?;

    let text = match msg {
        Message::Text(t) => t,
        _ => return Err("expected text frame".to_string()),
    };
    let parsed: AgentToHub =
        serde_json::from_str(&text).map_err(|e| format!("not valid AgentToHub: {e}"))?;
    match parsed {
        AgentToHub::Hello(h) => {
            if h.protocol_version != PROTOCOL_VERSION {
                return Err(format!(
                    "protocol version mismatch: agent={}, hub={}",
                    h.protocol_version, PROTOCOL_VERSION
                ));
            }
            Ok(h)
        }
        _ => Err("first message must be agent.hello".to_string()),
    }
}

fn dispatch_agent_message(state: &HubAppState, msg: AgentToHub) {
    match msg {
        AgentToHub::Hello(_) => {
            log::warn!("unexpected duplicate hello");
        }
        AgentToHub::SaveOk(ok) => {
            resolve_save(state, &ok.session_id, ok.seq, SaveOutcome::Ok {
                hash: ok.hash,
                mtime_ms: ok.mtime_ms,
                size_bytes: ok.size_bytes,
            });
        }
        AgentToHub::SaveConflict(c) => {
            resolve_save(state, &c.session_id, c.seq, SaveOutcome::Conflict {
                current_hash: c.current_hash,
                current_content: c.current_content,
                mtime_ms: c.mtime_ms,
            });
        }
        AgentToHub::SaveError(e) => {
            resolve_save(state, &e.session_id, e.seq, SaveOutcome::Error {
                message: e.message,
                code: e.code,
            });
        }
        AgentToHub::SaveSiblingOk(ok) => {
            resolve_save_sibling(state, &ok.session_id, ok.seq, SaveSiblingOutcome::Ok {
                path: ok.path,
                hash: ok.hash,
                size_bytes: ok.size_bytes,
            });
        }
        AgentToHub::SaveSiblingError(e) => {
            resolve_save_sibling(state, &e.session_id, e.seq, SaveSiblingOutcome::Error {
                message: e.message,
            });
        }
        AgentToHub::RemoteChanged(rc) => {
            on_remote_changed(state, rc);
        }
        AgentToHub::ReloadOk(ro) => {
            resolve_reload(state, &ro.session_id, ReloadOutcome::Ok {
                content: ro.content,
                hash: ro.hash,
                mtime_ms: ro.mtime_ms,
                size_bytes: ro.size_bytes,
            });
        }
        AgentToHub::Close(c) => {
            on_session_close(state, c);
        }
    }
}

fn resolve_save(state: &HubAppState, session_id: &str, seq: u64, outcome: SaveOutcome) {
    let mut reg = state.registry.lock();
    if let Some(s) = reg.get_mut(session_id) {
        match s.pending.remove(&seq) {
            Some(PendingReply::Save(tx)) => {
                let _ = tx.send(outcome.clone());
            }
            Some(other) => {
                log::warn!("save reply for seq {seq} but pending was wrong variant");
                s.pending.insert(seq, other);
            }
            None => {
                log::warn!("save reply for unknown seq {seq}");
            }
        }
        // Also mirror status into the session for the UI.
        s.status = match outcome {
            SaveOutcome::Ok { ref hash, .. } => {
                s.base_hash = hash.clone();
                SessionStatus::Saved
            }
            SaveOutcome::Conflict { .. } => SessionStatus::Conflict,
            SaveOutcome::Error { .. } => SessionStatus::Unsaved,
        };
    }
    drop(reg);
    emit_status(state, session_id, &outcome);
}

fn emit_status(state: &HubAppState, session_id: &str, outcome: &SaveOutcome) {
    let payload = match outcome {
        SaveOutcome::Ok { hash, .. } => serde_json::json!({
            "sessionId": session_id,
            "status": "saved",
            "hash": hash,
        }),
        SaveOutcome::Conflict { current_hash, current_content, .. } => serde_json::json!({
            "sessionId": session_id,
            "status": "conflict",
            "conflictHash": current_hash,
            "conflictContent": current_content,
        }),
        SaveOutcome::Error { message, .. } => serde_json::json!({
            "sessionId": session_id,
            "status": "unsaved",
            "message": message,
        }),
    };
    let _ = state.app_handle.emit("session.status", payload);
}

fn resolve_save_sibling(
    state: &HubAppState,
    session_id: &str,
    seq: u64,
    outcome: SaveSiblingOutcome,
) {
    let mut reg = state.registry.lock();
    if let Some(s) = reg.get_mut(session_id) {
        match s.pending.remove(&seq) {
            Some(PendingReply::SaveSibling(tx)) => {
                let _ = tx.send(outcome);
            }
            Some(other) => {
                log::warn!("saveSibling reply for seq {seq} but pending was wrong variant");
                s.pending.insert(seq, other);
            }
            None => {
                log::warn!("saveSibling reply for unknown seq {seq}");
            }
        }
    }
}

fn resolve_reload(state: &HubAppState, session_id: &str, outcome: ReloadOutcome) {
    let mut reg = state.registry.lock();
    if let Some(s) = reg.get_mut(session_id) {
        // Reload pending is keyed under seq=0 by convention (we only track one outstanding reload at a time).
        if let Some(PendingReply::Reload(tx)) = s.pending.remove(&0) {
            if let ReloadOutcome::Ok { hash, .. } = &outcome {
                s.base_hash = hash.clone();
                s.status = SessionStatus::Saved;
            }
            let _ = tx.send(outcome);
        }
    }
}

fn on_remote_changed(state: &HubAppState, rc: FileRemoteChanged) {
    let payload = serde_json::json!({
        "sessionId": rc.session_id,
        "hash": rc.hash,
        "mtimeMs": rc.mtime_ms,
        "sizeBytes": rc.size_bytes,
    });
    let _ = state.app_handle.emit("session.remoteChanged", payload);
}

fn on_session_close(state: &HubAppState, c: SessionClose) {
    cleanup_session(state, &c.session_id);
    let _ = state.app_handle.emit(
        "session.closed",
        serde_json::json!({ "sessionId": c.session_id, "reason": c.reason }),
    );
}

fn cleanup_session(state: &HubAppState, session_id: &str) {
    let mut reg = state.registry.lock();
    if let Some(s) = reg.remove(session_id) {
        // Resolve any pending replies with Error so frontend doesn't hang.
        for (_, pending) in s.pending.into_iter() {
            match pending {
                PendingReply::Save(tx) => {
                    let _ = tx.send(SaveOutcome::Error {
                        message: "session disconnected".into(),
                        code: "io_error".into(),
                    });
                }
                PendingReply::SaveSibling(tx) => {
                    let _ = tx.send(SaveSiblingOutcome::Error {
                        message: "session disconnected".into(),
                    });
                }
                PendingReply::Reload(tx) => {
                    let _ = tx.send(ReloadOutcome::Error {
                        message: "session disconnected".into(),
                    });
                }
            }
        }
    }
    let _ = state.app_handle.emit(
        "session.status",
        serde_json::json!({ "sessionId": session_id, "status": "disconnected" }),
    );
}

#[derive(Debug, thiserror::Error)]
pub enum HubError {
    #[error("hub bind failed: {0}")]
    Bind(std::io::Error),
    #[error("hub serve failed: {0}")]
    Serve(std::io::Error),
}

