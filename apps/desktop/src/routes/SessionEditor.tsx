import { useEffect, useMemo, useRef, useState } from "react";
import {
  invoke,
  listen,
  type SessionSnapshot,
  type SessionStatus,
  type SessionStatusEvent,
  type SaveResult,
  type SaveSiblingResult,
} from "../lib/tauriClient.js";
import {
  buildConflictMarkerText,
  computeLineDiff,
  countUnresolvedMarkers,
  summarizeDiff,
  type DiffLine,
} from "../lib/diff.js";

interface ConflictState {
  remoteContent: string;
  remoteHash: string;
}

export function SessionEditor({ sessionId }: { sessionId: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<TyportEditor | null>(null);
  const [snap, setSnap] = useState<SessionSnapshot | null>(null);
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [mergeMode, setMergeMode] = useState<{ initialMerged: string } | null>(null);
  const [mergedDraft, setMergedDraft] = useState<string>("");
  const [mergeSubmitting, setMergeSubmitting] = useState(false);
  const lastSavedHashRef = useRef<string | null>(null);
  const draftRef = useRef<string>("");

  // 1. Fetch session snapshot from Rust backend.
  useEffect(() => {
    let cancelled = false;
    invoke<SessionSnapshot>("get_session", { sessionId })
      .then((s) => {
        if (cancelled) return;
        setSnap(s);
        lastSavedHashRef.current = s.baseHash;
        draftRef.current = s.initialContent;
        setStatus(s.status === "loading" ? "saved" : s.status);
      })
      .catch((e) => setError(`Failed to load session: ${String(e)}`));
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // 2. Mount editor once snapshot is loaded.
  useEffect(() => {
    if (!snap || !hostRef.current) return;
    let active = true;
    let editor: TyportEditor | null = null;

    const debouncedSave = makeDebouncer(800);

    (async () => {
      const mod = await loadEditorModule();
      if (!active) return;
      editor = mod.createEditor(hostRef.current!, {
        initialContent: snap.initialContent,
        onChange: (md: string) => {
          draftRef.current = md;
          setStatus((cur) => (cur === "conflict" ? cur : "unsaved"));
          debouncedSave(() => requestSave(md, "autosave"));
        },
        // Cmd/Ctrl+click on a link → open the user's default browser via
        // the Tauri opener plugin. `window.open` inside WKWebView is a
        // no-op (no tab system) so without this links are unreachable.
        openLink: (href: string) => {
          import("@tauri-apps/plugin-opener")
            .then((m) => m.openUrl(href))
            .catch((err) => console.error("openLink failed:", err));
        },
      });
      editorRef.current = editor;
    })();

    return () => {
      active = false;
      try {
        editor?.destroy();
      } catch {
        // ignore
      }
      editorRef.current = null;
    };
  }, [snap]);

  // 3. Subscribe to backend status events for this session.
  useEffect(() => {
    let unlistenStatus: (() => void) | null = null;
    listen<SessionStatusEvent>("session.status", (e) => {
      if (e.payload.sessionId !== sessionId) return;
      setStatus(e.payload.status);
      if (e.payload.status === "conflict" && e.payload.conflictContent && e.payload.conflictHash) {
        setConflict({
          remoteContent: e.payload.conflictContent,
          remoteHash: e.payload.conflictHash,
        });
      }
      if (e.payload.message) setError(e.payload.message);
    }).then((u) => {
      unlistenStatus = u;
    });
    return () => {
      if (unlistenStatus) unlistenStatus();
    };
  }, [sessionId]);

  async function requestSave(content: string, reason: "autosave" | "manual" | "close") {
    if (!snap) return;
    if (snap.readonly) return;
    setStatus("saving");
    try {
      const result = await invoke<SaveResult>("save_session", {
        sessionId,
        content,
        reason,
      });
      if (result.kind === "ok") {
        if (result.hash) lastSavedHashRef.current = result.hash;
        setStatus("saved");
      } else if (result.kind === "conflict") {
        setStatus("conflict");
        setConflict({
          remoteContent: result.conflictContent ?? "",
          remoteHash: result.conflictHash ?? "",
        });
      } else {
        setStatus("unsaved");
        setError(result.message ?? "save failed");
      }
    } catch (e) {
      setStatus("unsaved");
      setError(String(e));
    }
  }

  async function handleReload() {
    if (!snap) return;
    try {
      const reloaded = await invoke<SessionSnapshot>("reload_session", { sessionId });
      setSnap(reloaded);
      lastSavedHashRef.current = reloaded.baseHash;
      editorRef.current?.setMarkdown(reloaded.initialContent);
      setStatus("saved");
      setConflict(null);
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleSaveNow() {
    const md = editorRef.current?.getMarkdown() ?? draftRef.current;
    await requestSave(md, "manual");
  }

  async function handleClose() {
    try {
      await invoke<void>("close_session", { sessionId });
    } catch {
      // ignore
    }
    if (typeof window !== "undefined") {
      try {
        const w = (
          await import("@tauri-apps/api/window")
        ).getCurrentWindow();
        await w.close();
      } catch {
        window.close();
      }
    }
  }

  const headerLabel = useMemo(() => snap?.displayName ?? `session ${sessionId}`, [snap, sessionId]);

  return (
    <div className="session">
      <div className="session-header">
        <span className="path mono" title={headerLabel}>{headerLabel}</span>
        <span className={`status ${status}`}>{statusLabel(status, snap?.readonly)}</span>
        <div className="actions">
          <button onClick={handleReload} disabled={!snap}>Reload</button>
          <button
            onClick={handleSaveNow}
            disabled={!snap || snap.readonly || status === "saving"}
            className="primary"
          >Save now</button>
          <button onClick={handleClose}>Close</button>
        </div>
      </div>
      <div className="session-body">
        {error && (
          <div style={{ color: "var(--error)", marginBottom: 12 }}>
            {error} <button onClick={() => setError(null)}>dismiss</button>
          </div>
        )}
        {info && (
          <div style={{ color: "var(--ok)", marginBottom: 12 }}>
            {info} <button onClick={() => setInfo(null)}>dismiss</button>
          </div>
        )}
        <div ref={hostRef} className="editor-host" />
      </div>

      {conflict && !mergeMode && (
        <div className="conflict-modal-bg" role="dialog" aria-modal="true">
          <div className="conflict-modal">
            <h2>Remote file changed</h2>
            <p>
              The remote file has changed since this editor was opened. Typort will not
              overwrite remote changes silently.
            </p>
            <ConflictDiffPanel
              remote={conflict.remoteContent}
              localGetter={() => editorRef.current?.getMarkdown() ?? draftRef.current}
            />
            <div className="actions">
              <button
                onClick={() => {
                  const draft = editorRef.current?.getMarkdown() ?? draftRef.current;
                  const merged = buildConflictMarkerText(conflict.remoteContent, draft);
                  setMergeMode({ initialMerged: merged });
                  setMergedDraft(merged);
                  setError(null);
                }}
              >Edit &amp; merge…</button>
              <button
                onClick={async () => {
                  const draft = editorRef.current?.getMarkdown() ?? draftRef.current;
                  try {
                    const result = await invoke<SaveSiblingResult>("save_as_conflict", {
                      sessionId,
                      content: draft,
                    });
                    if (result.kind === "ok" && result.path) {
                      setInfo(`Your draft was saved as ${result.path}`);
                    } else if (result.kind === "error") {
                      setError(`Could not save your draft as a sibling file: ${result.message ?? "unknown error"}`);
                      return;
                    }
                  } catch (e) {
                    setError(`save_as_conflict failed: ${String(e)}`);
                    return;
                  }
                  await handleReload();
                }}
              >Keep mine as .conflict.md</button>
              <button className="primary" onClick={handleReload}>Reload remote</button>
              <button onClick={() => setConflict(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {conflict && mergeMode && (
        <div className="conflict-modal-bg" role="dialog" aria-modal="true">
          <div className="conflict-modal merge-modal">
            <MergeView
              initialMerged={mergeMode.initialMerged}
              draft={mergedDraft}
              onChange={setMergedDraft}
              submitting={mergeSubmitting}
              error={error}
              onCancel={() => {
                setMergeMode(null);
                setError(null);
              }}
              onSave={async () => {
                if (countUnresolvedMarkers(mergedDraft) > 0) return;
                setMergeSubmitting(true);
                setError(null);
                try {
                  const result = await invoke<SaveResult>("save_merged", {
                    sessionId,
                    content: mergedDraft,
                    baseHash: conflict.remoteHash,
                  });
                  if (result.kind === "ok") {
                    if (result.hash) lastSavedHashRef.current = result.hash;
                    editorRef.current?.setMarkdown(mergedDraft);
                    draftRef.current = mergedDraft;
                    setStatus("saved");
                    setMergeMode(null);
                    setConflict(null);
                    setInfo("Merge saved");
                  } else if (result.kind === "conflict") {
                    setError(
                      "Remote changed again while you were merging. Reload remote and re-merge.",
                    );
                  } else {
                    setError(result.message ?? "save_merged failed");
                  }
                } catch (e) {
                  setError(String(e));
                } finally {
                  setMergeSubmitting(false);
                }
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function statusLabel(s: SessionStatus, ro?: boolean): string {
  if (ro) return "readonly";
  switch (s) {
    case "loading": return "Loading…";
    case "saving": return "Saving…";
    case "saved": return "Saved";
    case "unsaved": return "Unsaved";
    case "conflict": return "Conflict";
    case "disconnected": return "Disconnected";
  }
}

/* ---------------- merge view ---------------- */

interface MergeViewProps {
  initialMerged: string;
  draft: string;
  onChange: (s: string) => void;
  submitting: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: () => void;
}

function MergeView({
  initialMerged,
  draft,
  onChange,
  submitting,
  error,
  onCancel,
  onSave,
}: MergeViewProps) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const unresolved = useMemo(() => countUnresolvedMarkers(draft), [draft]);
  const dirty = draft !== initialMerged;
  const lineCount = useMemo(() => draft.split("\n").length, [draft]);

  // Auto-focus the textarea when entering merge mode.
  useEffect(() => {
    if (taRef.current) taRef.current.focus();
  }, []);

  return (
    <>
      <h2>Merge edits</h2>
      <p>
        Resolve each <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt; / ======= / &gt;&gt;&gt;&gt;&gt;&gt;&gt;</code> block:
        keep your draft, the remote, both, or hand-edit the result. Save is enabled once
        no markers remain.
      </p>
      <div className="merge-meta">
        <span className={"marker-count" + (unresolved === 0 ? " ok" : " pending")}>
          {unresolved === 0 ? "✓ no markers" : `${unresolved} marker${unresolved === 1 ? "" : "s"} left`}
        </span>
        <span className="marker-spacer" />
        <span className="marker-info">{lineCount} lines{dirty ? " · edited" : ""}</span>
      </div>
      <textarea
        ref={taRef}
        className="merge-textarea"
        spellCheck={false}
        value={draft}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && (
        <div className="merge-error">{error}</div>
      )}
      <div className="actions">
        <button onClick={onCancel} disabled={submitting}>Back</button>
        <button
          className="primary"
          disabled={submitting || unresolved > 0}
          title={unresolved > 0 ? "Remove all conflict markers first" : "Save merged content"}
          onClick={onSave}
        >
          {submitting ? "Saving…" : "Save merged"}
        </button>
      </div>
    </>
  );
}

/* ---------------- conflict diff panel ---------------- */

interface ConflictDiffPanelProps {
  remote: string;
  /**
   * Captured at render time, so the diff reflects exactly what the editor
   * held at the moment the conflict modal appeared. Re-renders when the
   * panel opens, not on every keystroke.
   */
  localGetter: () => string;
}

function ConflictDiffPanel({ remote, localGetter }: ConflictDiffPanelProps) {
  const local = useMemo(() => localGetter(), [localGetter]);
  const [expanded, setExpanded] = useState(true);
  const lines = useMemo(
    () => computeLineDiff(remote, local, { contextLines: 3 }),
    [remote, local],
  );
  const stats = useMemo(() => summarizeDiff(lines), [lines]);

  if (stats.added === 0 && stats.removed === 0) {
    return (
      <div className="conflict-diff empty">
        Local draft and remote are byte-identical (the conflict came from a hash
        race, not a real divergence). Reloading is safe.
      </div>
    );
  }

  return (
    <div className="conflict-diff">
      <div className="conflict-diff-header">
        <button
          className="link"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? "▾" : "▸"} Diff
        </button>
        <span className="diff-stats">
          <span className="diff-stat removed">−{stats.removed}</span>
          <span className="diff-stat added">+{stats.added}</span>
        </span>
        <span className="diff-legend">
          <span className="legend-removed">− remote</span>
          <span className="legend-added">+ your draft</span>
        </span>
      </div>
      {expanded && (
        <pre className="conflict-diff-body" tabIndex={0}>
          {lines.map((l, i) => (
            <DiffRow key={i} line={l} />
          ))}
        </pre>
      )}
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  if (line.kind === "skip") {
    return (
      <div className="diff-line skip">
        <span className="diff-num" />
        <span className="diff-num" />
        <span className="diff-marker"> </span>
        <span className="diff-text">… {line.count} unchanged lines …</span>
      </div>
    );
  }
  const oldNum = "oldNum" in line ? String(line.oldNum) : "";
  const newNum = "newNum" in line ? String(line.newNum) : "";
  const marker = line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ";
  return (
    <div className={`diff-line ${line.kind}`}>
      <span className="diff-num">{oldNum}</span>
      <span className="diff-num">{newNum}</span>
      <span className="diff-marker">{marker}</span>
      <span className="diff-text">{line.line || " "}</span>
    </div>
  );
}

function makeDebouncer(ms: number): (fn: () => void) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (fn: () => void) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}

/* ---------------- editor adapter ---------------- */

interface TyportEditor {
  getMarkdown(): string;
  setMarkdown(md: string): void;
  focus(): void;
  destroy(): void;
}

interface CreateEditorOptions {
  initialContent: string;
  onChange?: (md: string) => void;
  openLink?: (href: string) => void;
}

interface EditorModule {
  createEditor: (host: HTMLElement, opts: CreateEditorOptions) => TyportEditor;
}

let editorModulePromise: Promise<EditorModule> | null = null;

async function loadEditorModule(): Promise<EditorModule> {
  if (editorModulePromise) return editorModulePromise;
  editorModulePromise = (async () => {
    try {
      // Style imports
      await import("typora-web/widgets.css");
      await import("typora-web/theme-typora.css");
      const mod = await import("typora-web");
      return mod as unknown as EditorModule;
    } catch {
      // Fallback: a bare textarea if typora-web fails to load (offline, etc.).
      return makeFallbackEditorModule();
    }
  })();
  return editorModulePromise;
}

function makeFallbackEditorModule(): EditorModule {
  return {
    createEditor(host, opts) {
      const ta = document.createElement("textarea");
      ta.value = opts.initialContent;
      ta.style.width = "100%";
      ta.style.height = "70vh";
      ta.style.fontFamily = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
      ta.addEventListener("input", () => opts.onChange?.(ta.value));
      host.innerHTML = "";
      host.appendChild(ta);
      return {
        getMarkdown: () => ta.value,
        setMarkdown: (md: string) => { ta.value = md; },
        focus: () => ta.focus(),
        destroy: () => ta.remove(),
      };
    },
  };
}
