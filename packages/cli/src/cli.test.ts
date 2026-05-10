import { describe, expect, it } from "vitest";
import { httpToWs, parseArgs } from "./cli.js";

describe("parseArgs", () => {
  it("returns help when no args", () => {
    expect(parseArgs(["node", "typort"]).cmd).toBe("help");
  });

  it("returns help on -h", () => {
    expect(parseArgs(["node", "typort", "-h"]).cmd).toBe("help");
  });

  it("parses 'open <file>' as absolute path", () => {
    const r = parseArgs(["node", "typort", "open", "/abs/path/x.md"]);
    expect(r.cmd).toBe("open");
    expect(r.open!.file).toBe("/abs/path/x.md");
    expect(r.open!.readonly).toBe(false);
  });

  it("resolves relative paths against cwd", () => {
    const r = parseArgs(["node", "typort", "open", "./README.md"]);
    expect(r.open!.file.endsWith("/README.md")).toBe(true);
  });

  it("parses --readonly", () => {
    const r = parseArgs(["node", "typort", "open", "/x", "--readonly"]);
    expect(r.open!.readonly).toBe(true);
  });

  it("foreground defaults to false (detached)", () => {
    expect(parseArgs(["node", "typort", "open", "/x"]).open!.foreground).toBe(false);
  });

  it("parses --foreground and -f", () => {
    expect(parseArgs(["node", "typort", "open", "/x", "--foreground"]).open!.foreground).toBe(true);
    expect(parseArgs(["node", "typort", "open", "/x", "-f"]).open!.foreground).toBe(true);
  });

  it("parses --hub and --token", () => {
    const r = parseArgs([
      "node",
      "typort",
      "open",
      "/x",
      "--hub",
      "http://1.2.3.4:9999",
      "--token",
      "tok",
    ]);
    expect(r.open!.hubHttp).toBe("http://1.2.3.4:9999");
    expect(r.open!.hubWs).toBe("ws://1.2.3.4:9999");
    expect(r.open!.token).toBe("tok");
  });

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["node", "typort", "open", "/x", "--bogus"])).toThrow(
      /unknown flag/,
    );
  });

  it("rejects unknown commands", () => {
    expect(() => parseArgs(["node", "typort", "fly"])).toThrow(/unknown command/);
  });

  it("doctor and tunnel-help", () => {
    expect(parseArgs(["node", "typort", "doctor"]).cmd).toBe("doctor");
    expect(parseArgs(["node", "typort", "tunnel-help"]).cmd).toBe("tunnel-help");
  });
});

describe("httpToWs", () => {
  it("upgrades http to ws", () => {
    expect(httpToWs("http://127.0.0.1:1")).toBe("ws://127.0.0.1:1");
    expect(httpToWs("https://example.com")).toBe("wss://example.com");
  });

  it("passes through unknown schemes", () => {
    expect(httpToWs("ws://x")).toBe("ws://x");
  });
});
