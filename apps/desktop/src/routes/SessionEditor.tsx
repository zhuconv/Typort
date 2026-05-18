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
import { detectLanguage, isHtmlPath, isMarkdownPath } from "../lib/fileLang.js";
import { CODE_THEMES, DEFAULT_CODE_THEME } from "../lib/codeThemes.js";

interface ConflictState {
  remoteContent: string;
  remoteHash: string;
}

function readStoredCodeTheme(): string {
  try {
    return localStorage.getItem("typort.codeTheme") ?? DEFAULT_CODE_THEME;
  } catch {
    return DEFAULT_CODE_THEME;
  }
}

const FONT_MIN = 10;
const FONT_MAX = 24;
const FONT_DEFAULT = 14;
const FONT_STEP = 1;

function clampFontSize(px: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(px)));
}

function readStoredFontSize(): number {
  try {
    const v = parseInt(localStorage.getItem("typort.codeFontSize") ?? "", 10);
    return Number.isFinite(v) ? clampFontSize(v) : FONT_DEFAULT;
  } catch {
    return FONT_DEFAULT;
  }
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
  const [codeTheme, setCodeTheme] = useState<string>(readStoredCodeTheme);
  const codeThemeRef = useRef(codeTheme);
  const [codeFontSize, setCodeFontSize] = useState<number>(readStoredFontSize);
  const codeFontSizeRef = useRef(codeFontSize);
  const isMarkdown = useMemo(() => (snap ? isMarkdownPath(snap.path) : false), [snap]);
  const isHtml = useMemo(() => (snap ? isHtmlPath(snap.path) : false), [snap]);
  const [htmlMode, setHtmlMode] = useState<"preview" | "source">("preview");
  // Monaco is the visible editor for code files, and for HTML in source mode.
  const monacoVisible = useMemo(
    () => !!snap && !isMarkdown && (!isHtml || htmlMode === "source"),
    [snap, isMarkdown, isHtml, htmlMode],
  );
  // The window chrome (header + native title bar) follows the code theme on
  // every non-markdown file — including HTML preview — so a dark-theme user
  // gets dark chrome there too, consistent with their code windows. The
  // previewed page renders however it renders, browser-style.
  const isDarkChrome = useMemo(
    () =>
      !!snap &&
      !isMarkdown &&
      CODE_THEMES.find((t) => t.id === codeTheme)?.dark === true,
    [snap, isMarkdown, codeTheme],
  );

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

  // 2. Mount the editor once the snapshot is loaded. Markdown files open in
  //    the open-typora WYSIWYG editor; every other file opens in Monaco with
  //    Shiki syntax highlighting.
  useEffect(() => {
    if (!snap || !hostRef.current) return;
    const host = hostRef.current;
    let active = true;
    let editor: TyportEditor | null = null;

    const debouncedSave = makeDebouncer(800);
    const handleChange = (content: string) => {
      draftRef.current = content;
      setStatus((cur) => (cur === "conflict" ? cur : "unsaved"));
      debouncedSave(() => requestSave(content, "autosave"));
    };

    (async () => {
      if (isMarkdownPath(snap.path)) {
        const mod = await loadEditorModule();
        if (!active) return;
        editor = mod.createEditor(host, {
          initialContent: snap.initialContent,
          onChange: handleChange,
          // Cmd/Ctrl+click on a link → open the user's default browser via
          // the Tauri opener plugin. `window.open` inside WKWebView is a
          // no-op (no tab system) so without this links are unreachable.
          openLink: (href: string) => {
            import("@tauri-apps/plugin-opener")
              .then((m) => m.openUrl(href))
              .catch((err) => console.error("openLink failed:", err));
          },
        });
      } else {
        try {
          const { createCodeEditor } = await import("../lib/monacoEditor.js");
          if (!active) return;
          editor = await createCodeEditor(host, {
            initialContent: snap.initialContent,
            language: detectLanguage(snap.path),
            theme: codeThemeRef.current,
            fontSize: codeFontSizeRef.current,
            readonly: snap.readonly,
            onChange: handleChange,
          });
        } catch (err) {
          // Monaco/Shiki failed to load — fall back to a bare textarea so
          // the file stays editable.
          console.error("code editor failed to load:", err);
          if (!active) return;
          editor = makeFallbackEditorModule().createEditor(host, {
            initialContent: snap.initialContent,
            onChange: handleChange,
          });
        }
      }
      if (!active) {
        try {
          editor?.destroy();
        } catch {
          // ignore
        }
        return;
      }
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

  // 4. Apply code-editor theme changes to the live Monaco instance and
  //    persist the choice for the next window.
  useEffect(() => {
    codeThemeRef.current = codeTheme;
    try {
      localStorage.setItem("typort.codeTheme", codeTheme);
    } catch {
      // localStorage unavailable — non-fatal
    }
    editorRef.current?.setTheme?.(codeTheme);
  }, [codeTheme]);

  // 5. Keep the native window chrome (title bar, native menus/scrollbars) in
  //    sync: dark for dark code themes, light otherwise. Best-effort — falls
  //    back to CSS-only chrome theming outside Tauri or without the permission.
  useEffect(() => {
    let cancelled = false;
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        if (!cancelled) {
          return getCurrentWindow().setTheme(isDarkChrome ? "dark" : "light");
        }
      })
      .catch(() => {
        /* not in Tauri, or set-theme not permitted — CSS chrome still applies */
      });
    return () => {
      cancelled = true;
    };
  }, [isDarkChrome]);

  // 6. Apply code-editor font-size changes to the live Monaco instance and
  //    persist the choice for the next window.
  useEffect(() => {
    codeFontSizeRef.current = codeFontSize;
    try {
      localStorage.setItem("typort.codeFontSize", String(codeFontSize));
    } catch {
      // localStorage unavailable — non-fatal
    }
    editorRef.current?.setFontSize?.(codeFontSize);
  }, [codeFontSize]);

  // 7. HTML switching to source view un-hides Monaco's container — force a
  //    re-layout so it sizes to the now-visible pane.
  useEffect(() => {
    if (isHtml && htmlMode === "source") {
      editorRef.current?.layout?.();
    }
  }, [isHtml, htmlMode]);

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
    <div className={isDarkChrome ? "session chrome-dark" : "session"}>
      <div className="session-header">
        <span className="path" title={headerLabel}>{headerLabel}</span>
        <span className={`status ${status}`}>{statusLabel(status, snap?.readonly)}</span>
        <div className="actions">
          {isHtml && (
            <div className="mode-toggle" role="group" aria-label="HTML view">
              <button
                className={htmlMode === "preview" ? "active" : ""}
                aria-pressed={htmlMode === "preview"}
                onClick={() => setHtmlMode("preview")}
              >Preview</button>
              <button
                className={htmlMode === "source" ? "active" : ""}
                aria-pressed={htmlMode === "source"}
                onClick={() => setHtmlMode("source")}
              >Source</button>
            </div>
          )}
          {monacoVisible && (
            <span className="theme-select-wrap">
              <select
                className="theme-select"
                value={codeTheme}
                onChange={(e) => setCodeTheme(e.target.value)}
                title="Code editor theme"
                aria-label="Code editor theme"
              >
                {CODE_THEMES.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
            </span>
          )}
          {monacoVisible && <FontStepper value={codeFontSize} onChange={setCodeFontSize} />}
          <button onClick={handleReload} disabled={!snap}>Reload</button>
          <button
            onClick={handleSaveNow}
            disabled={!snap || snap.readonly || status === "saving"}
            className="primary"
          >Save now</button>
          <button onClick={handleClose}>Close</button>
        </div>
      </div>
      <div className={isMarkdown ? "session-body" : "session-body code"}>
        {error && (
          <div className="session-banner error">
            {error} <button onClick={() => setError(null)}>dismiss</button>
          </div>
        )}
        {info && (
          <div className="session-banner ok">
            {info} <button onClick={() => setInfo(null)}>dismiss</button>
          </div>
        )}
        <div
          ref={hostRef}
          className={isHtml && htmlMode === "preview" ? "editor-host hidden" : "editor-host"}
        />
        {isHtml && htmlMode === "preview" && (
          <iframe
            className="html-preview"
            title="HTML preview"
            sandbox="allow-scripts"
            srcDoc={editorRef.current?.getMarkdown() ?? draftRef.current}
          />
        )}
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

/* ---------------- font-size stepper ---------------- */

function FontStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (px: number) => void;
}) {
  // Local draft string so the field can be cleared / half-typed without the
  // value being clamped on every keystroke. Committed on blur and on Enter.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit() {
    const parsed = parseInt(draft, 10);
    const next = Number.isFinite(parsed) ? clampFontSize(parsed) : value;
    onChange(next);
    setDraft(String(next));
  }

  return (
    <div className="font-stepper" role="group" aria-label="Editor font size">
      <button
        onClick={() => onChange(clampFontSize(value - FONT_STEP))}
        disabled={value <= FONT_MIN}
        aria-label="Decrease font size"
        title="Decrease font size"
      >A&minus;</button>
      <input
        className="font-stepper-input"
        type="text"
        inputMode="numeric"
        maxLength={3}
        value={draft}
        aria-label="Font size in pixels"
        title="Font size — type a value, or use the buttons"
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setDraft(String(value));
            e.currentTarget.blur();
          }
        }}
      />
      <button
        onClick={() => onChange(clampFontSize(value + FONT_STEP))}
        disabled={value >= FONT_MAX}
        aria-label="Increase font size"
        title="Increase font size"
      >A+</button>
    </div>
  );
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
  /** Code (Monaco) editor only — switch the Shiki theme at runtime. */
  setTheme?(theme: string): void;
  /** Code (Monaco) editor only — update the font size (px). */
  setFontSize?(px: number): void;
  /** Code (Monaco) editor only — force a re-layout. */
  layout?(): void;
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
  // bust-vite-deps-cache: force re-transform
  if (editorModulePromise) return editorModulePromise;
  editorModulePromise = (async () => {
    try {
      // Style imports
      await import("open-typora/widgets.css");
      await import("open-typora/theme-typora.css");
      const mod = await import("open-typora");
      return mod as unknown as EditorModule;
    } catch {
      // Fallback: a bare textarea if open-typora fails to load (offline, etc.).
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
