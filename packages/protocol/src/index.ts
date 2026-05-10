import { z } from "zod";

export const PROTOCOL_VERSION = 1;

const SessionIdSchema = z.string().min(1).max(128);
const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, "expected sha256:<64-hex>");
const SeqSchema = z.number().int().nonnegative();

/* ========== agent → hub: agent.hello ========== */
export const AgentHelloSchema = z.object({
  type: z.literal("agent.hello"),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  sessionId: SessionIdSchema,
  server: z.string().min(1).max(256),
  cwd: z.string().min(1).max(4096),
  path: z.string().min(1).max(4096),
  displayName: z.string().min(1).max(512),
  content: z.string(),
  hash: HashSchema,
  mtimeMs: z.number().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
  readonly: z.boolean(),
});
export type AgentHello = z.infer<typeof AgentHelloSchema>;

/* ========== hub → agent: hub.accept / hub.reject ========== */
export const HubAcceptSchema = z.object({
  type: z.literal("hub.accept"),
  sessionId: SessionIdSchema,
});
export type HubAccept = z.infer<typeof HubAcceptSchema>;

export const HubRejectSchema = z.object({
  type: z.literal("hub.reject"),
  sessionId: SessionIdSchema.optional(),
  reason: z.string().max(512),
});
export type HubReject = z.infer<typeof HubRejectSchema>;

/* ========== hub → agent: file.save ========== */
export const FileSaveSchema = z.object({
  type: z.literal("file.save"),
  sessionId: SessionIdSchema,
  seq: SeqSchema,
  baseHash: HashSchema,
  content: z.string(),
  reason: z.enum(["autosave", "manual", "close", "merge"]),
});
export type FileSave = z.infer<typeof FileSaveSchema>;

/* ========== agent → hub: file.save.ok ========== */
export const FileSaveOkSchema = z.object({
  type: z.literal("file.save.ok"),
  sessionId: SessionIdSchema,
  seq: SeqSchema,
  hash: HashSchema,
  mtimeMs: z.number().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
});
export type FileSaveOk = z.infer<typeof FileSaveOkSchema>;

/* ========== agent → hub: file.save.conflict ========== */
export const FileSaveConflictSchema = z.object({
  type: z.literal("file.save.conflict"),
  sessionId: SessionIdSchema,
  seq: SeqSchema,
  baseHash: HashSchema,
  currentHash: HashSchema,
  currentContent: z.string(),
  mtimeMs: z.number().nonnegative(),
});
export type FileSaveConflict = z.infer<typeof FileSaveConflictSchema>;

/* ========== agent → hub: file.save.error ========== */
export const FileSaveErrorSchema = z.object({
  type: z.literal("file.save.error"),
  sessionId: SessionIdSchema,
  seq: SeqSchema,
  message: z.string().max(2048),
  code: z.enum(["readonly", "io_error", "not_found", "unknown"]).default("unknown"),
});
export type FileSaveError = z.infer<typeof FileSaveErrorSchema>;

/* ========== agent → hub: file.remoteChanged ========== */
export const FileRemoteChangedSchema = z.object({
  type: z.literal("file.remoteChanged"),
  sessionId: SessionIdSchema,
  hash: HashSchema,
  mtimeMs: z.number().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
});
export type FileRemoteChanged = z.infer<typeof FileRemoteChangedSchema>;

/* ========== hub → agent: file.reload ========== */
export const FileReloadSchema = z.object({
  type: z.literal("file.reload"),
  sessionId: SessionIdSchema,
});
export type FileReload = z.infer<typeof FileReloadSchema>;

/* ========== agent → hub: file.reload.ok ========== */
export const FileReloadOkSchema = z.object({
  type: z.literal("file.reload.ok"),
  sessionId: SessionIdSchema,
  content: z.string(),
  hash: HashSchema,
  mtimeMs: z.number().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
});
export type FileReloadOk = z.infer<typeof FileReloadOkSchema>;

/* ========== hub → agent: file.saveSibling ==========
 * Used by the conflict-resolution "Keep mine" path. The agent writes the
 * content as a sibling file next to the originally-opened path, with a
 * timestamped `.typort-conflict-<ts>.md` suffix. The agent picks the suffix
 * (the hub does not get to specify an arbitrary path: the agent only ever
 * writes inside the directory of the originally-opened file).
 */
export const FileSaveSiblingSchema = z.object({
  type: z.literal("file.saveSibling"),
  sessionId: SessionIdSchema,
  seq: SeqSchema,
  content: z.string(),
});
export type FileSaveSibling = z.infer<typeof FileSaveSiblingSchema>;

export const FileSaveSiblingOkSchema = z.object({
  type: z.literal("file.saveSibling.ok"),
  sessionId: SessionIdSchema,
  seq: SeqSchema,
  path: z.string().min(1).max(4096),
  hash: HashSchema,
  sizeBytes: z.number().int().nonnegative(),
});
export type FileSaveSiblingOk = z.infer<typeof FileSaveSiblingOkSchema>;

export const FileSaveSiblingErrorSchema = z.object({
  type: z.literal("file.saveSibling.error"),
  sessionId: SessionIdSchema,
  seq: SeqSchema,
  message: z.string().max(2048),
});
export type FileSaveSiblingError = z.infer<typeof FileSaveSiblingErrorSchema>;

/* ========== both directions: session.close ========== */
export const SessionCloseSchema = z.object({
  type: z.literal("session.close"),
  sessionId: SessionIdSchema,
  reason: z.enum(["editorClosed", "agentExit", "error", "timeout"]),
});
export type SessionClose = z.infer<typeof SessionCloseSchema>;

/* ========== unions ========== */
export const AgentToHubMessageSchema = z.discriminatedUnion("type", [
  AgentHelloSchema,
  FileSaveOkSchema,
  FileSaveConflictSchema,
  FileSaveErrorSchema,
  FileSaveSiblingOkSchema,
  FileSaveSiblingErrorSchema,
  FileRemoteChangedSchema,
  FileReloadOkSchema,
  SessionCloseSchema,
]);
export type AgentToHubMessage = z.infer<typeof AgentToHubMessageSchema>;

export const HubToAgentMessageSchema = z.discriminatedUnion("type", [
  HubAcceptSchema,
  HubRejectSchema,
  FileSaveSchema,
  FileSaveSiblingSchema,
  FileReloadSchema,
  SessionCloseSchema,
]);
export type HubToAgentMessage = z.infer<typeof HubToAgentMessageSchema>;

/* ========== helpers ========== */

export function parseAgentToHub(raw: unknown): AgentToHubMessage {
  return AgentToHubMessageSchema.parse(raw);
}

export function parseHubToAgent(raw: unknown): HubToAgentMessage {
  return HubToAgentMessageSchema.parse(raw);
}

export function safeParseAgentToHub(raw: unknown) {
  return AgentToHubMessageSchema.safeParse(raw);
}

export function safeParseHubToAgent(raw: unknown) {
  return HubToAgentMessageSchema.safeParse(raw);
}

export const DEFAULT_HUB_HOST = "127.0.0.1";
export const DEFAULT_HUB_PORT = 17887;
export const DEFAULT_HUB_HTTP = `http://${DEFAULT_HUB_HOST}:${DEFAULT_HUB_PORT}`;
export const DEFAULT_HUB_WS = `ws://${DEFAULT_HUB_HOST}:${DEFAULT_HUB_PORT}`;
export const AGENT_CONNECT_PATH = "/agent/connect";
export const HEALTH_PATH = "/health";

export function hashString(): typeof HashSchema {
  return HashSchema;
}
