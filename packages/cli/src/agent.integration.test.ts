/**
 * Integration test: runs a mock JS WebSocket hub and exercises the CLI agent
 * end-to-end. The mock plays the role the Tauri Rust hub plays in production.
 */
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import {
  type AgentHello,
  type AgentToHubMessage,
  parseAgentToHub,
} from "@typort/protocol";
import { sha256 } from "@typort/file-session";
import { runAgent } from "./agent.js";

interface MockHub {
  url: string;
  close: () => Promise<void>;
  awaitHello: () => Promise<AgentHello>;
  /** Send a message to the agent and await its first reply. */
  request: (msg: object) => Promise<AgentToHubMessage>;
  /** Send a message; return the agent's nth reply (1-indexed). */
  requestNth: (msg: object, n: number) => Promise<AgentToHubMessage>;
  socket: () => WebSocket | undefined;
}

async function startMockHub(expectedToken?: string): Promise<MockHub> {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let active: WebSocket | undefined;
  let helloResolve: ((h: AgentHello) => void) | undefined;
  const helloPromise = new Promise<AgentHello>((r) => (helloResolve = r));
  const messageQueue: AgentToHubMessage[] = [];
  const messageWaiters: Array<(m: AgentToHubMessage) => void> = [];

  http.on("upgrade", (req, sock, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/agent/connect") {
      sock.destroy();
      return;
    }
    if (expectedToken !== undefined) {
      const t = url.searchParams.get("token") ?? "";
      const auth = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (t !== expectedToken && auth !== expectedToken) {
        sock.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, sock, head, (ws) => {
      active = ws;
      ws.on("message", (data) => {
        const raw = JSON.parse(data.toString());
        const msg = parseAgentToHub(raw);
        if (msg.type === "agent.hello" && helloResolve) {
          helloResolve(msg);
        }
        if (messageWaiters.length > 0) {
          messageWaiters.shift()!(msg);
        } else {
          messageQueue.push(msg);
        }
        if (msg.type === "agent.hello") {
          ws.send(JSON.stringify({ type: "hub.accept", sessionId: msg.sessionId }));
        }
      });
    });
  });

  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const url = `ws://127.0.0.1:${port}`;

  function takeNext(): Promise<AgentToHubMessage> {
    if (messageQueue.length > 0) return Promise.resolve(messageQueue.shift()!);
    return new Promise((r) => messageWaiters.push(r));
  }

  return {
    url,
    socket: () => active,
    awaitHello: () => helloPromise,
    async request(msg: object) {
      // Drain any queued messages first; we only care about replies *after* this send.
      while (messageQueue.length > 0) messageQueue.shift();
      active!.send(JSON.stringify(msg));
      return takeNext();
    },
    async requestNth(msg: object, n: number) {
      while (messageQueue.length > 0) messageQueue.shift();
      active!.send(JSON.stringify(msg));
      let last: AgentToHubMessage | undefined;
      for (let i = 0; i < n; i++) {
        last = await takeNext();
      }
      return last!;
    },
    async close() {
      if (active) active.close();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "typort-cli-int-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("agent integration", () => {
  it("sends a valid agent.hello with hash + content", async () => {
    const hub = await startMockHub("tok");
    try {
      const file = join(dir, "hello.md");
      writeFileSync(file, "# initial\n");
      const exit = runAgent({
        file,
        hubWs: hub.url,
        token: "tok",
        readonly: false,
        sessionId: "session-A",
        exitAfterFirstSave: false,
      });
      const hello = await hub.awaitHello();
      expect(hello.protocolVersion).toBe(1);
      expect(hello.sessionId).toBe("session-A");
      expect(hello.path).toBe(file);
      expect(hello.content).toBe("# initial\n");
      expect(hello.hash).toBe(sha256("# initial\n"));
      expect(hello.sizeBytes).toBe(10);
      expect(hello.readonly).toBe(false);

      hub.socket()!.send(
        JSON.stringify({ type: "session.close", sessionId: "session-A", reason: "editorClosed" }),
      );
      await exit;
    } finally {
      await hub.close();
    }
  });

  it("performs a happy-path save: hub asks save, file content updates", async () => {
    const hub = await startMockHub();
    try {
      const file = join(dir, "save.md");
      writeFileSync(file, "v1");
      const baseHash = sha256("v1");
      const agentDone = runAgent({
        file,
        hubWs: hub.url,
        token: undefined,
        readonly: false,
        sessionId: "session-B",
        exitAfterFirstSave: true,
        // dev insecure: agent normally requires a token, but for tests we can skip via no-tls flag
        insecureNoTls: true,
      });
      // We didn't pass a token, so override the env for this test:
      // (runAgent itself doesn't enforce token presence — the CLI's `main` does.)

      await hub.awaitHello();
      const reply = await hub.request({
        type: "file.save",
        sessionId: "session-B",
        seq: 1,
        baseHash,
        content: "v2",
        reason: "autosave",
      });
      expect(reply.type).toBe("file.save.ok");
      if (reply.type === "file.save.ok") {
        expect(reply.hash).toBe(sha256("v2"));
      }
      expect(readFileSync(file, "utf8")).toBe("v2");
      await agentDone;
    } finally {
      await hub.close();
    }
  });

  it("rejects a stale save with file.save.conflict", async () => {
    const hub = await startMockHub();
    try {
      const file = join(dir, "conflict.md");
      writeFileSync(file, "remote-v1");
      const agentDone = runAgent({
        file,
        hubWs: hub.url,
        token: undefined,
        readonly: false,
        sessionId: "session-C",
        exitAfterFirstSave: true,
        insecureNoTls: true,
      });
      await hub.awaitHello();
      // Simulate someone else editing the file out-of-band before the editor saves:
      writeFileSync(file, "remote-v2-changed-externally");
      const stale = sha256("remote-v1");
      const reply = await hub.request({
        type: "file.save",
        sessionId: "session-C",
        seq: 1,
        baseHash: stale,
        content: "editor-wanted-v3",
        reason: "autosave",
      });
      expect(reply.type).toBe("file.save.conflict");
      if (reply.type === "file.save.conflict") {
        expect(reply.currentHash).toBe(sha256("remote-v2-changed-externally"));
        expect(reply.currentContent).toBe("remote-v2-changed-externally");
      }
      // disk is whatever we wrote externally — never the editor's draft
      expect(readFileSync(file, "utf8")).toBe("remote-v2-changed-externally");
      await agentDone;
    } finally {
      await hub.close();
    }
  });

  it("file.saveSibling writes a .typort-conflict-* file beside the original (Keep-mine)", async () => {
    const hub = await startMockHub();
    try {
      const file = join(dir, "keep-mine.md");
      writeFileSync(file, "remote-original");
      const agentDone = runAgent({
        file,
        hubWs: hub.url,
        token: undefined,
        readonly: false,
        sessionId: "session-E",
        // exit handle: we close from the test below.
        exitAfterFirstSave: false,
        insecureNoTls: true,
      });
      await hub.awaitHello();

      // Someone else changes the file out-of-band (this is exactly the conflict scenario).
      writeFileSync(file, "remote-changed");

      // The user's local draft is something different from both versions on disk.
      const draft = "## my-local-draft\n\nthis is what I wanted to save\n";

      const reply = await hub.request({
        type: "file.saveSibling",
        sessionId: "session-E",
        seq: 99,
        content: draft,
      });

      expect(reply.type).toBe("file.saveSibling.ok");
      let writtenPath: string | undefined;
      if (reply.type === "file.saveSibling.ok") {
        writtenPath = reply.path;
        expect(reply.seq).toBe(99);
        // path is a sibling of `file`
        expect(dirname(reply.path)).toBe(dir);
        // basename pattern matches plan §11.3
        expect(reply.path).toMatch(/keep-mine\.md\.typort-conflict-[0-9]{8}-[0-9]{6}\.md$/);
        expect(reply.sizeBytes).toBe(Buffer.byteLength(draft, "utf8"));
      }

      // Sibling file actually contains the local draft.
      expect(readFileSync(writtenPath!, "utf8")).toBe(draft);
      // Original file wasn't touched by the saveSibling write.
      expect(readFileSync(file, "utf8")).toBe("remote-changed");
      // The directory has exactly the original + one sibling, nothing else.
      const entries = readdirSync(dir).filter((n) => !n.startsWith("."));
      expect(entries.length).toBe(2);

      // Send session.close so the agent's promise resolves.
      hub.socket()!.send(
        JSON.stringify({ type: "session.close", sessionId: "session-E", reason: "editorClosed" }),
      );
      await agentDone;
    } finally {
      await hub.close();
    }
  });

  it("supports the merge save flow: stale → conflict, then save with current hash + reason=merge → ok", async () => {
    const hub = await startMockHub();
    try {
      const file = join(dir, "merge.md");
      writeFileSync(file, "v1");
      const agentDone = runAgent({
        file,
        hubWs: hub.url,
        token: undefined,
        readonly: false,
        sessionId: "session-F",
        exitAfterFirstSave: false,
        insecureNoTls: true,
      });
      await hub.awaitHello();

      // Someone modifies the file out-of-band.
      writeFileSync(file, "remote-v2");
      const remoteHash = sha256("remote-v2");
      const staleHash = sha256("v1");

      // Editor still thinks base is "v1" → first save attempt conflicts.
      const reply1 = await hub.request({
        type: "file.save",
        sessionId: "session-F",
        seq: 1,
        baseHash: staleHash,
        content: "editor-draft",
        reason: "autosave",
      });
      expect(reply1.type).toBe("file.save.conflict");

      // User merges, hub sends a save with reason=merge using the remote's actual hash.
      const reply2 = await hub.request({
        type: "file.save",
        sessionId: "session-F",
        seq: 2,
        baseHash: remoteHash,
        content: "hand-merged-result",
        reason: "merge",
      });
      expect(reply2.type).toBe("file.save.ok");
      if (reply2.type === "file.save.ok") {
        expect(reply2.hash).toBe(sha256("hand-merged-result"));
      }
      expect(readFileSync(file, "utf8")).toBe("hand-merged-result");

      hub.socket()!.send(
        JSON.stringify({ type: "session.close", sessionId: "session-F", reason: "editorClosed" }),
      );
      await agentDone;
    } finally {
      await hub.close();
    }
  });

  it("returns file.save.error on a readonly session", async () => {
    const hub = await startMockHub();
    try {
      const file = join(dir, "ro.md");
      writeFileSync(file, "hello");
      const agentDone = runAgent({
        file,
        hubWs: hub.url,
        token: undefined,
        readonly: true,
        sessionId: "session-D",
        exitAfterFirstSave: true,
        insecureNoTls: true,
      });
      await hub.awaitHello();
      const reply = await hub.request({
        type: "file.save",
        sessionId: "session-D",
        seq: 1,
        baseHash: sha256("hello"),
        content: "no",
        reason: "manual",
      });
      expect(reply.type).toBe("file.save.error");
      if (reply.type === "file.save.error") {
        expect(reply.code).toBe("readonly");
      }
      expect(readFileSync(file, "utf8")).toBe("hello");
      await agentDone;
    } finally {
      await hub.close();
    }
  });
});
