import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FileSessionError,
  atomicWriteSync,
  isConflictError,
  readSnapshot,
  safeSave,
  sha256,
  writeConflictBackup,
} from "./index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "typort-file-session-"));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe("sha256", () => {
  it("matches reference values", () => {
    expect(sha256("")).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256("hello\n")).toBe(
      "sha256:5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
    );
  });

  it("treats string and matching buffer the same", () => {
    expect(sha256("# hi")).toBe(sha256(Buffer.from("# hi", "utf8")));
  });
});

describe("readSnapshot", () => {
  it("reads content + computes hash + size", async () => {
    const p = join(dir, "x.md");
    writeFileSync(p, "# title\n");
    const snap = await readSnapshot(p);
    expect(snap.content).toBe("# title\n");
    expect(snap.hash).toBe(sha256("# title\n"));
    expect(snap.sizeBytes).toBe(8);
    expect(snap.readonly).toBe(false);
  });

  it("respects path with spaces", async () => {
    const p = join(dir, "name with spaces.md");
    writeFileSync(p, "ok");
    const snap = await readSnapshot(p);
    expect(snap.content).toBe("ok");
  });

  it("throws not_found for missing file", async () => {
    await expect(readSnapshot(join(dir, "missing.md"))).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("throws too_large above maxBytes", async () => {
    const p = join(dir, "big.md");
    writeFileSync(p, "x".repeat(100));
    await expect(readSnapshot(p, { maxBytes: 10 })).rejects.toMatchObject({
      code: "too_large",
    });
  });

  it("marks readonly file as readonly", async () => {
    const p = join(dir, "ro.md");
    writeFileSync(p, "ro");
    chmodSync(p, 0o444);
    try {
      const snap = await readSnapshot(p);
      // root can write to anything regardless of mode; skip assertion if so.
      if (process.getuid?.() !== 0) {
        expect(snap.readonly).toBe(true);
      }
    } finally {
      chmodSync(p, 0o644);
    }
  });
});

describe("atomicWriteSync", () => {
  it("writes new file content", () => {
    const p = join(dir, "y.md");
    writeFileSync(p, "old\n");
    const r = atomicWriteSync(p, "new\n");
    expect(readFileSync(p, "utf8")).toBe("new\n");
    expect(r.hash).toBe(sha256("new\n"));
    expect(r.sizeBytes).toBe(4);
  });

  it("does not leak tmp files in directory on success", () => {
    const p = join(dir, "z.md");
    writeFileSync(p, "old");
    atomicWriteSync(p, "new");
    const entries = readdirSync(dir);
    expect(entries.filter((e) => e.includes("typort-tmp"))).toEqual([]);
  });

  it("preserves file mode best-effort", () => {
    const p = join(dir, "mode.md");
    writeFileSync(p, "a");
    chmodSync(p, 0o600);
    atomicWriteSync(p, "b");
    const stat = statSync(p);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("works on path with spaces", () => {
    const p = join(dir, "with space.md");
    writeFileSync(p, "old");
    atomicWriteSync(p, "new content");
    expect(readFileSync(p, "utf8")).toBe("new content");
  });
});

describe("safeSave", () => {
  it("writes when base hash matches", async () => {
    const p = join(dir, "a.md");
    writeFileSync(p, "v1");
    const baseHash = sha256("v1");
    const r = await safeSave(p, "v2", baseHash);
    expect(readFileSync(p, "utf8")).toBe("v2");
    expect(r.hash).toBe(sha256("v2"));
  });

  it("rejects with conflict when disk hash differs from base", async () => {
    const p = join(dir, "b.md");
    writeFileSync(p, "v1");
    const staleBase = sha256("v0-never-was-on-disk");
    let caught: unknown;
    try {
      await safeSave(p, "v2", staleBase);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FileSessionError);
    expect(isConflictError(caught)).toBe(true);
    if (isConflictError(caught)) {
      expect(caught.currentHash).toBe(sha256("v1"));
      expect(caught.currentContent).toBe("v1");
    }
    // disk untouched
    expect(readFileSync(p, "utf8")).toBe("v1");
  });

  it("returns not_found when file missing", async () => {
    let caught: unknown;
    try {
      await safeSave(join(dir, "missing.md"), "x", sha256("x"));
    } catch (err) {
      caught = err;
    }
    expect((caught as FileSessionError).code).toBe("not_found");
  });
});

describe("writeConflictBackup", () => {
  it("creates a sibling .typort-conflict file with given content", () => {
    const p = join(dir, "c.md");
    writeFileSync(p, "remote-version");
    const r = writeConflictBackup(p, "my-local-version");
    expect(r.path).toMatch(/c\.md\.typort-conflict-[0-9]{8}-[0-9]{6}\.md$/);
    expect(r.hash).toBe(sha256("my-local-version"));
    expect(r.sizeBytes).toBe(Buffer.byteLength("my-local-version", "utf8"));
    expect(readFileSync(r.path, "utf8")).toBe("my-local-version");
    // original untouched
    expect(readFileSync(p, "utf8")).toBe("remote-version");
  });
});
