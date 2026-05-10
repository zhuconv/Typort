import { describe, expect, it } from "vitest";
import {
  AgentHelloSchema,
  FileSaveSchema,
  PROTOCOL_VERSION,
  parseAgentToHub,
  parseHubToAgent,
  safeParseAgentToHub,
} from "./index.js";

const VALID_HASH = "sha256:" + "a".repeat(64);

describe("AgentHelloSchema", () => {
  const valid = {
    type: "agent.hello",
    protocolVersion: PROTOCOL_VERSION,
    sessionId: "abc-123",
    server: "myserver",
    cwd: "/home/user",
    path: "/home/user/README.md",
    displayName: "myserver:/home/user/README.md",
    content: "# hi",
    hash: VALID_HASH,
    mtimeMs: 1_770_000_000_000,
    sizeBytes: 4,
    readonly: false,
  };

  it("accepts a valid hello", () => {
    expect(AgentHelloSchema.parse(valid)).toEqual(valid);
  });

  it("rejects a wrong protocol version", () => {
    expect(() => AgentHelloSchema.parse({ ...valid, protocolVersion: 99 })).toThrow();
  });

  it("rejects a malformed hash", () => {
    expect(() => AgentHelloSchema.parse({ ...valid, hash: "not-a-hash" })).toThrow();
  });

  it("rejects a missing path", () => {
    const { path: _path, ...without } = valid;
    expect(() => AgentHelloSchema.parse(without)).toThrow();
  });

  it("rejects negative size", () => {
    expect(() => AgentHelloSchema.parse({ ...valid, sizeBytes: -1 })).toThrow();
  });
});

describe("FileSaveSchema", () => {
  it("accepts a valid save", () => {
    expect(
      FileSaveSchema.parse({
        type: "file.save",
        sessionId: "s",
        seq: 1,
        baseHash: VALID_HASH,
        content: "# new",
        reason: "autosave",
      }),
    ).toBeTruthy();
  });

  it("rejects an invalid reason", () => {
    expect(() =>
      FileSaveSchema.parse({
        type: "file.save",
        sessionId: "s",
        seq: 1,
        baseHash: VALID_HASH,
        content: "",
        reason: "bogus",
      }),
    ).toThrow();
  });
});

describe("union dispatch", () => {
  it("parses agent-to-hub messages by type", () => {
    const msg = parseAgentToHub({
      type: "file.save.ok",
      sessionId: "s",
      seq: 5,
      hash: VALID_HASH,
      mtimeMs: 1,
      sizeBytes: 1,
    });
    expect(msg.type).toBe("file.save.ok");
  });

  it("parses hub-to-agent messages by type", () => {
    const msg = parseHubToAgent({
      type: "file.save",
      sessionId: "s",
      seq: 1,
      baseHash: VALID_HASH,
      content: "x",
      reason: "manual",
    });
    expect(msg.type).toBe("file.save");
  });

  it("safeParse returns error on unknown type", () => {
    const result = safeParseAgentToHub({ type: "agent.unknown", sessionId: "s" });
    expect(result.success).toBe(false);
  });

  it("safeParse returns error on garbage", () => {
    expect(safeParseAgentToHub("not-an-object").success).toBe(false);
    expect(safeParseAgentToHub(null).success).toBe(false);
    expect(safeParseAgentToHub({}).success).toBe(false);
  });
});
