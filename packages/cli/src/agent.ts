import { hostname } from "node:os";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import {
  AGENT_CONNECT_PATH,
  type AgentHello,
  type FileSave,
  type FileSaveConflict,
  type FileSaveError,
  type FileSaveOk,
  type FileSaveSibling,
  type FileSaveSiblingError,
  type FileSaveSiblingOk,
  type HubReject,
  PROTOCOL_VERSION,
  safeParseHubToAgent,
} from "@typort/protocol";
import {
  FileSessionError,
  isConflictError,
  readSnapshot,
  safeSave,
  watchPolling,
  writeConflictBackup,
  type SessionSnapshot,
} from "@typort/file-session";

export interface RunAgentOpts {
  file: string;
  hubWs: string;
  token?: string | undefined;
  readonly: boolean;
  insecureNoTls?: boolean;
  /** Override hostname (used in tests). */
  serverName?: string;
  /** Override sessionId (used in tests). */
  sessionId?: string;
  /** When set, agent exits after first save round-trip (used in tests). */
  exitAfterFirstSave?: boolean;
  /** Optional logger override. */
  log?: (msg: string) => void;
}

export async function runAgent(opts: RunAgentOpts): Promise<number> {
  const log = opts.log ?? ((m) => process.stderr.write(m + "\n"));

  let snap: SessionSnapshot;
  try {
    snap = await readSnapshot(opts.file, { readonly: opts.readonly });
  } catch (err) {
    if (err instanceof FileSessionError) {
      log(`error reading file: [${err.code}] ${err.message}`);
      return 1;
    }
    throw err;
  }

  const sessionId = opts.sessionId ?? randomUUID();
  const server = opts.serverName ?? hostname();
  const cwd = dirname(opts.file);
  const displayName = `${server}:${opts.file}`;

  const hello: AgentHello = {
    type: "agent.hello",
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    server,
    cwd,
    path: opts.file,
    displayName,
    content: snap.content,
    hash: snap.hash,
    mtimeMs: snap.mtimeMs,
    sizeBytes: snap.sizeBytes,
    readonly: snap.readonly,
  };

  const url = buildConnectUrl(opts.hubWs, opts.token);
  if (!opts.insecureNoTls && !urlIsLoopback(url) && !url.startsWith("wss://")) {
    log(
      `refusing to send token over plain ws:// to non-localhost ${url}; pass --insecure-no-tls if you really want this`,
    );
    return 2;
  }

  const ws = new WebSocket(url, {
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : undefined,
  });

  const state = {
    baseHash: snap.hash,
    closed: false,
    accepted: false,
  };

  const watcher = watchPolling(opts.file, snap.hash, (newSnap) => {
    if (state.closed) return;
    sendJson(ws, {
      type: "file.remoteChanged",
      sessionId,
      hash: newSnap.hash,
      mtimeMs: newSnap.mtimeMs,
      sizeBytes: newSnap.sizeBytes,
    });
  });

  return await new Promise<number>((resolveExit) => {
    const cleanup = (code: number) => {
      state.closed = true;
      watcher.stop();
      try {
        ws.close();
      } catch {
        // ignore
      }
      resolveExit(code);
    };

    ws.on("open", () => {
      log(`connected to hub ${opts.hubWs} session=${sessionId}`);
      sendJson(ws, hello);
    });

    ws.on("message", async (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(data.toString());
      } catch {
        log("received non-JSON message; ignoring");
        return;
      }
      const result = safeParseHubToAgent(raw);
      if (!result.success) {
        log(`malformed hub message: ${result.error.message}`);
        return;
      }
      const msg = result.data;
      switch (msg.type) {
        case "hub.accept":
          state.accepted = true;
          log(`hub accepted session ${msg.sessionId}`);
          break;
        case "hub.reject":
          log(`hub rejected: ${(msg as HubReject).reason}`);
          cleanup(1);
          break;
        case "file.save":
          await handleSave(msg, opts, state, ws, log);
          if (opts.exitAfterFirstSave) cleanup(0);
          break;
        case "file.saveSibling":
          handleSaveSibling(msg, opts, ws, log);
          break;
        case "file.reload":
          await handleReload(opts.file, msg.sessionId, state, ws, log);
          break;
        case "session.close":
          log(`session closed by hub: ${msg.reason}`);
          cleanup(0);
          break;
      }
    });

    ws.on("error", (err) => {
      log(`websocket error: ${(err as Error).message}`);
      cleanup(1);
    });

    ws.on("close", (code, reason) => {
      log(`websocket closed code=${code} reason=${reason.toString()}`);
      if (!state.closed) cleanup(state.accepted ? 0 : 1);
    });

    const onSig = () => {
      log("received exit signal");
      sendJson(ws, { type: "session.close", sessionId, reason: "agentExit" });
      cleanup(0);
    };
    process.once("SIGINT", onSig);
    process.once("SIGTERM", onSig);
  });
}

async function handleSave(
  save: FileSave,
  opts: RunAgentOpts,
  state: { baseHash: string },
  ws: WebSocket,
  log: (m: string) => void,
) {
  if (opts.readonly) {
    const err: FileSaveError = {
      type: "file.save.error",
      sessionId: save.sessionId,
      seq: save.seq,
      message: "session is readonly",
      code: "readonly",
    };
    sendJson(ws, err);
    return;
  }
  try {
    const result = await safeSave(opts.file, save.content, save.baseHash);
    state.baseHash = result.hash;
    const ok: FileSaveOk = {
      type: "file.save.ok",
      sessionId: save.sessionId,
      seq: save.seq,
      hash: result.hash,
      mtimeMs: result.mtimeMs,
      sizeBytes: result.sizeBytes,
    };
    sendJson(ws, ok);
    log(`saved seq=${save.seq} hash=${result.hash}`);
  } catch (err) {
    if (isConflictError(err)) {
      const conflict: FileSaveConflict = {
        type: "file.save.conflict",
        sessionId: save.sessionId,
        seq: save.seq,
        baseHash: save.baseHash,
        currentHash: err.currentHash,
        currentContent: err.currentContent,
        mtimeMs: err.mtimeMs,
      };
      sendJson(ws, conflict);
      log(`conflict on seq=${save.seq}`);
      return;
    }
    if (err instanceof FileSessionError) {
      const e: FileSaveError = {
        type: "file.save.error",
        sessionId: save.sessionId,
        seq: save.seq,
        message: err.message,
        code:
          err.code === "not_found" || err.code === "io_error" || err.code === "readonly"
            ? err.code
            : "unknown",
      };
      sendJson(ws, e);
      log(`save error seq=${save.seq}: ${err.message}`);
      return;
    }
    const e: FileSaveError = {
      type: "file.save.error",
      sessionId: save.sessionId,
      seq: save.seq,
      message: (err as Error).message,
      code: "unknown",
    };
    sendJson(ws, e);
  }
}

function handleSaveSibling(
  msg: FileSaveSibling,
  opts: RunAgentOpts,
  ws: WebSocket,
  log: (m: string) => void,
) {
  try {
    const r = writeConflictBackup(opts.file, msg.content);
    const reply: FileSaveSiblingOk = {
      type: "file.saveSibling.ok",
      sessionId: msg.sessionId,
      seq: msg.seq,
      path: r.path,
      hash: r.hash,
      sizeBytes: r.sizeBytes,
    };
    sendJson(ws, reply);
    log(`saved sibling: ${r.path}`);
  } catch (err) {
    const reply: FileSaveSiblingError = {
      type: "file.saveSibling.error",
      sessionId: msg.sessionId,
      seq: msg.seq,
      message: (err as Error).message,
    };
    sendJson(ws, reply);
    log(`saveSibling error seq=${msg.seq}: ${(err as Error).message}`);
  }
}

async function handleReload(
  file: string,
  sessionId: string,
  state: { baseHash: string },
  ws: WebSocket,
  log: (m: string) => void,
) {
  try {
    const snap = await readSnapshot(file);
    state.baseHash = snap.hash;
    sendJson(ws, {
      type: "file.reload.ok",
      sessionId,
      content: snap.content,
      hash: snap.hash,
      mtimeMs: snap.mtimeMs,
      sizeBytes: snap.sizeBytes,
    });
    log(`reload sent for session=${sessionId}`);
  } catch (err) {
    log(`reload failed: ${(err as Error).message}`);
  }
}

function sendJson(ws: WebSocket, msg: object) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    // socket might be closed already
  }
}

function urlIsLoopback(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
  } catch {
    return false;
  }
}

function buildConnectUrl(base: string, token: string | undefined): string {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  const u = new URL(trimmed + AGENT_CONNECT_PATH);
  if (token) u.searchParams.set("token", token);
  return u.toString();
}

