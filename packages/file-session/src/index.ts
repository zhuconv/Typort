import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  openSync,
  promises as fsp,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, basename, join } from "node:path";

export type SessionSnapshot = {
  path: string;
  content: string;
  hash: string;
  mtimeMs: number;
  sizeBytes: number;
  readonly: boolean;
};

export const MAX_FILE_BYTES_DEFAULT = 10 * 1024 * 1024;

export class FileSessionError extends Error {
  code: "not_found" | "too_large" | "io_error" | "readonly" | "conflict" | "unknown";
  constructor(
    code: FileSessionError["code"],
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.code = code;
    this.name = "FileSessionError";
  }
}

export function sha256(content: string | Buffer): string {
  const h = createHash("sha256");
  h.update(typeof content === "string" ? Buffer.from(content, "utf8") : content);
  return "sha256:" + h.digest("hex");
}

export async function readSnapshot(
  absPath: string,
  opts: { maxBytes?: number; readonly?: boolean } = {},
): Promise<SessionSnapshot> {
  const maxBytes = opts.maxBytes ?? MAX_FILE_BYTES_DEFAULT;

  let stat;
  try {
    stat = await fsp.stat(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new FileSessionError("not_found", `file not found: ${absPath}`, err);
    }
    throw new FileSessionError("io_error", `stat failed: ${absPath}`, err);
  }

  if (!stat.isFile()) {
    throw new FileSessionError("io_error", `not a regular file: ${absPath}`);
  }
  if (stat.size > maxBytes) {
    throw new FileSessionError(
      "too_large",
      `file is ${stat.size} bytes; limit is ${maxBytes} bytes`,
    );
  }

  let buf: Buffer;
  try {
    buf = await fsp.readFile(absPath);
  } catch (err) {
    throw new FileSessionError("io_error", `read failed: ${absPath}`, err);
  }
  const content = buf.toString("utf8");

  let writable = true;
  try {
    await fsp.access(absPath, fsConstants.W_OK);
  } catch {
    writable = false;
  }
  const readonly = opts.readonly === true || !writable;

  return {
    path: absPath,
    content,
    hash: sha256(buf),
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    readonly,
  };
}

export type AtomicWriteResult = {
  path: string;
  hash: string;
  mtimeMs: number;
  sizeBytes: number;
};

/**
 * Atomic write: open tmp -> write -> fsync -> rename over original -> fsync dir.
 *
 * Preserves mode/uid/gid best-effort. Renames within the same directory so the
 * rename is atomic on POSIX filesystems.
 */
export function atomicWriteSync(absPath: string, content: string): AtomicWriteResult {
  const dir = dirname(absPath);
  const base = basename(absPath);
  const tmpName = `.${base}.typort-tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const tmpPath = join(dir, tmpName);

  let prevMode: number | undefined;
  let prevUid: number | undefined;
  let prevGid: number | undefined;
  if (existsSync(absPath)) {
    try {
      const st = statSync(absPath);
      prevMode = st.mode;
      prevUid = st.uid;
      prevGid = st.gid;
    } catch {
      // ignore — tmp file gets default mode
    }
  }

  const buf = Buffer.from(content, "utf8");
  const fd = openSync(tmpPath, "wx", 0o644);
  try {
    writeSync(fd, buf);
    try {
      fsyncSync(fd);
    } catch {
      // fsync best-effort
    }
    if (prevMode !== undefined) {
      try {
        fchmodSync(fd, prevMode & 0o7777);
      } catch {
        // permissions best-effort
      }
    }
    if (prevUid !== undefined && prevGid !== undefined) {
      try {
        fchownSync(fd, prevUid, prevGid);
      } catch {
        // ownership best-effort (often blocked for non-root)
      }
    }
  } finally {
    closeSync(fd);
  }

  try {
    renameSync(tmpPath, absPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw new FileSessionError("io_error", `rename failed: ${absPath}`, err);
  }

  // best-effort fsync the directory entry (POSIX)
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // not all platforms allow fsync on directories
  }

  const stat = statSync(absPath);
  return {
    path: absPath,
    hash: sha256(buf),
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
  };
}

/**
 * Hash-checked save:
 *  - if the on-disk content's hash !== expectedBaseHash, throw conflict (caller decides).
 *  - else write atomically.
 */
export async function safeSave(
  absPath: string,
  newContent: string,
  expectedBaseHash: string,
): Promise<AtomicWriteResult> {
  let buf: Buffer;
  try {
    buf = await fsp.readFile(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new FileSessionError("not_found", `file not found: ${absPath}`, err);
    }
    throw new FileSessionError("io_error", `read failed: ${absPath}`, err);
  }
  const currentHash = sha256(buf);
  if (currentHash !== expectedBaseHash) {
    const stat = await fsp.stat(absPath);
    const conflict = new FileSessionError(
      "conflict",
      `base hash mismatch: expected ${expectedBaseHash} but disk has ${currentHash}`,
    );
    (conflict as unknown as Record<string, unknown>).currentHash = currentHash;
    (conflict as unknown as Record<string, unknown>).currentContent = buf.toString("utf8");
    (conflict as unknown as Record<string, unknown>).mtimeMs = stat.mtimeMs;
    throw conflict;
  }
  return atomicWriteSync(absPath, newContent);
}

export type ConflictDetails = {
  currentHash: string;
  currentContent: string;
  mtimeMs: number;
};

export function isConflictError(err: unknown): err is FileSessionError & ConflictDetails {
  return err instanceof FileSessionError && err.code === "conflict";
}

export type ConflictBackupResult = {
  path: string;
  hash: string;
  sizeBytes: number;
};

/**
 * Write a `.typort-conflict-<timestamp>.md` next to the original. Used as the
 * "Keep mine" branch of conflict resolution.
 *
 * The path is always inside `dirname(absPath)` and the suffix always begins
 * with `.typort-conflict-`, so this can never be tricked into writing
 * elsewhere by anything the hub passes in (the hub passes only `content`).
 */
export function writeConflictBackup(absPath: string, content: string): ConflictBackupResult {
  const dir = dirname(absPath);
  const base = basename(absPath);
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const conflictPath = join(dir, `${base}.typort-conflict-${ts}.md`);
  const buf = Buffer.from(content, "utf8");
  writeFileSync(conflictPath, buf, { flag: "wx" });
  return {
    path: conflictPath,
    hash: sha256(buf),
    sizeBytes: buf.length,
  };
}

/**
 * Lightweight polling watcher. Calls onChange(snapshot) when hash changes.
 *
 * Keeps things simple at MVP: poll every `intervalMs`. Real fs.watch is finicky
 * across platforms, so polling is the safer default.
 */
export type PollWatcher = {
  stop: () => void;
};

export function watchPolling(
  absPath: string,
  baseHash: string,
  onChange: (snapshot: SessionSnapshot) => void,
  intervalMs = 1500,
): PollWatcher {
  let last = baseHash;
  let stopped = false;
  const id = setInterval(async () => {
    if (stopped) return;
    try {
      const snap = await readSnapshot(absPath);
      if (snap.hash !== last) {
        last = snap.hash;
        onChange(snap);
      }
    } catch {
      // file may have temporarily disappeared; ignore
    }
  }, intervalMs);
  return {
    stop() {
      stopped = true;
      clearInterval(id);
    },
  };
}
