/**
 * Thin wrapper around Tauri's `invoke` and `listen` so the rest of the app
 * doesn't reach into `@tauri-apps/api` directly.
 *
 * Falls back to a stub implementation in plain-Vite mode (e.g. browser preview)
 * so we can develop the frontend without running `tauri dev`.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";

export interface SessionSnapshot {
  sessionId: string;
  displayName: string;
  server: string;
  path: string;
  initialContent: string;
  baseHash: string;
  readonly: boolean;
  status: SessionStatus;
}

export type SessionStatus =
  | "loading"
  | "saved"
  | "saving"
  | "unsaved"
  | "conflict"
  | "disconnected";

export interface SaveResult {
  kind: "ok" | "conflict" | "error";
  hash?: string;
  message?: string;
  conflictContent?: string;
  conflictHash?: string;
}

export interface SaveSiblingResult {
  kind: "ok" | "error";
  path?: string;
  message?: string;
}

export interface AppStatus {
  hubBound: boolean;
  hubAddress: string;
  tokenConfigured: boolean;
  token?: string;
  protocolVersion: number;
  activeSessions: number;
}

export interface SessionStatusEvent {
  sessionId: string;
  status: SessionStatus;
  message?: string;
  conflictContent?: string;
  conflictHash?: string;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) {
    return mockInvoke<T>(cmd, args);
  }
  return tauriInvoke<T>(cmd, args);
}

export async function listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<UnlistenFn> {
  if (!isTauri) {
    return () => {};
  }
  return tauriListen<T>(event, cb);
}

/** ---------- mock for browser-preview dev (no Tauri) ---------- */

async function mockInvoke<T>(cmd: string, _args?: Record<string, unknown>): Promise<T> {
  if (cmd === "get_app_status") {
    const status: AppStatus = {
      hubBound: false,
      hubAddress: "(browser preview, no Tauri backend)",
      tokenConfigured: false,
      protocolVersion: 1,
      activeSessions: 0,
    };
    return status as unknown as T;
  }
  if (cmd === "copy_tunnel_help") {
    return "ssh -R 17887:127.0.0.1:17887 user@server" as unknown as T;
  }
  if (cmd === "get_session") {
    const snap: SessionSnapshot = {
      sessionId: "mock",
      displayName: "browser:/tmp/mock.md",
      server: "browser",
      path: "/tmp/mock.md",
      initialContent:
        "# Mock session\n\nThis is a stub session shown when you load the frontend in a plain browser without Tauri.\n",
      baseHash: "sha256:" + "0".repeat(64),
      readonly: false,
      status: "saved",
    };
    return snap as unknown as T;
  }
  if (cmd === "save_session" || cmd === "save_merged") {
    const result: SaveResult = { kind: "ok", hash: "sha256:" + "1".repeat(64) };
    return result as unknown as T;
  }
  if (cmd === "save_as_conflict") {
    const result: SaveSiblingResult = {
      kind: "ok",
      path: "/tmp/mock.md.typort-conflict-mock.md",
    };
    return result as unknown as T;
  }
  throw new Error(`mockInvoke: unhandled command ${cmd}`);
}
