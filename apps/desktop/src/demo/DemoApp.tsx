/**
 * Typort's editor, running standalone in a browser — deployed to GitHub
 * Pages as a live demo. It reuses the desktop app's editor modules (Monaco +
 * Shiki, open-typora) with no Tauri layer: pick a sample from the menu and
 * read / edit it exactly as you would in a real Typort window.
 *
 * This is a trimmed sibling of routes/SessionEditor.tsx — same chrome and
 * same editor-mounting logic, minus the remote session, saving and conflict
 * handling, which a static demo has nothing to talk to.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { detectLanguage, isHtmlPath, isMarkdownPath } from "../lib/fileLang.js";
import { CODE_THEMES, DEFAULT_CODE_THEME } from "../lib/codeThemes.js";
import { DEMO_SAMPLES } from "./demoSamples.js";

const FONT_MIN = 10;
const FONT_MAX = 24;
const FONT_DEFAULT = 14;
const FONT_STEP = 1;

function clampFontSize(px: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(px)));
}

function readStoredCodeTheme(): string {
  try {
    const v = localStorage.getItem("typort.codeTheme");
    return v && CODE_THEMES.some((t) => t.id === v) ? v : DEFAULT_CODE_THEME;
  } catch {
    return DEFAULT_CODE_THEME;
  }
}

function readStoredFontSize(): number {
  try {
    const v = parseInt(localStorage.getItem("typort.codeFontSize") ?? "", 10);
    return Number.isFinite(v) ? clampFontSize(v) : FONT_DEFAULT;
  } catch {
    return FONT_DEFAULT;
  }
}

/** Initial sample from the URL hash (e.g. #rust) so a given sample is
 *  shareable and survives a reload; defaults to the first sample. */
function readInitialSampleId(): string {
  const fromHash = window.location.hash.replace(/^#/, "");
  return DEMO_SAMPLES.some((s) => s.id === fromHash)
    ? fromHash
    : DEMO_SAMPLES[0].id;
}

export function DemoApp() {
  const [sampleId, setSampleId] = useState<string>(readInitialSampleId);
  const sample = useMemo(
    () => DEMO_SAMPLES.find((s) => s.id === sampleId) ?? DEMO_SAMPLES[0],
    [sampleId],
  );
  const [codeTheme, setCodeTheme] = useState<string>(readStoredCodeTheme);
  const [codeFontSize, setCodeFontSize] = useState<number>(readStoredFontSize);
  const [htmlMode, setHtmlMode] = useState<"preview" | "source">("preview");
  // Bumped to re-render the HTML preview iframe after edits / a reset.
  const [, forceRender] = useState(0);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<DemoEditor | null>(null);
  const draftRef = useRef<string>(sample.content);
  const codeThemeRef = useRef(codeTheme);
  const codeFontSizeRef = useRef(codeFontSize);

  const isMarkdown = isMarkdownPath(sample.filename);
  const isHtml = isHtmlPath(sample.filename);
  // Monaco is the visible editor for code files, and for HTML in source mode.
  const monacoVisible = !isMarkdown && (!isHtml || htmlMode === "source");
  // The chrome follows the code theme on every non-markdown file, exactly
  // like the desktop window does.
  const isDarkChrome =
    !isMarkdown && CODE_THEMES.find((t) => t.id === codeTheme)?.dark === true;

  // Mount the right editor whenever the chosen sample changes. Markdown opens
  // in the open-typora WYSIWYG editor; everything else in Monaco.
  useEffect(() => {
    if (!hostRef.current) return;
    const host = hostRef.current;
    let active = true;
    let editor: DemoEditor | null = null;
    draftRef.current = sample.content;

    const handleChange = (content: string) => {
      draftRef.current = content;
    };

    (async () => {
      if (isMarkdownPath(sample.filename)) {
        const mod = await loadEditorModule();
        if (!active) return;
        editor = mod.createEditor(host, {
          initialContent: sample.content,
          onChange: handleChange,
          openLink: (href) => window.open(href, "_blank", "noopener"),
        });
      } else {
        try {
          const { createCodeEditor } = await import("../lib/monacoEditor.js");
          if (!active) return;
          editor = await createCodeEditor(host, {
            initialContent: sample.content,
            language: detectLanguage(sample.filename),
            theme: codeThemeRef.current,
            fontSize: codeFontSizeRef.current,
            onChange: handleChange,
          });
        } catch (err) {
          // Monaco/Shiki failed to load — fall back to a bare textarea.
          console.error("code editor failed to load:", err);
          if (!active) return;
          editor = makeFallbackEditor(host, sample.content, handleChange);
        }
      }
      if (!active) {
        try {
          editor?.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      editorRef.current = editor;
      editor.focus();
    })();

    return () => {
      active = false;
      try {
        editor?.destroy();
      } catch {
        /* ignore */
      }
      editorRef.current = null;
    };
  }, [sampleId]);

  // Live theme changes on the running Monaco editor; persisted for next time.
  useEffect(() => {
    codeThemeRef.current = codeTheme;
    try {
      localStorage.setItem("typort.codeTheme", codeTheme);
    } catch {
      /* localStorage unavailable — non-fatal */
    }
    editorRef.current?.setTheme?.(codeTheme);
  }, [codeTheme]);

  // Live font-size changes on the running Monaco editor; persisted likewise.
  useEffect(() => {
    codeFontSizeRef.current = codeFontSize;
    try {
      localStorage.setItem("typort.codeFontSize", String(codeFontSize));
    } catch {
      /* localStorage unavailable — non-fatal */
    }
    editorRef.current?.setFontSize?.(codeFontSize);
  }, [codeFontSize]);

  // Keep the URL hash in sync so the current sample is shareable / reloadable.
  useEffect(() => {
    try {
      window.history.replaceState(null, "", `#${sampleId}`);
    } catch {
      /* ignore */
    }
  }, [sampleId]);

  // Switching HTML to source un-hides Monaco's container — re-layout it.
  useEffect(() => {
    if (isHtml && htmlMode === "source") editorRef.current?.layout?.();
  }, [isHtml, htmlMode]);

  function resetSample() {
    editorRef.current?.setMarkdown(sample.content);
    draftRef.current = sample.content;
    forceRender((n) => n + 1);
  }

  return (
    <div className={isDarkChrome ? "session chrome-dark" : "session"}>
      <div className="session-header">
        <span className="demo-brand">Typort</span>
        <span className="theme-select-wrap demo-file">
          <select
            className="theme-select"
            value={sampleId}
            onChange={(e) => {
              setSampleId(e.target.value);
              setHtmlMode("preview");
            }}
            aria-label="Sample file"
            title="Choose a language / sample file"
          >
            {DEMO_SAMPLES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </span>
        <span className="demo-hint">live editor demo — edits stay in this browser tab</span>
        <div className="actions">
          {isHtml && (
            <div className="mode-toggle" role="group" aria-label="HTML view">
              <button
                className={htmlMode === "preview" ? "active" : ""}
                aria-pressed={htmlMode === "preview"}
                onClick={() => setHtmlMode("preview")}
              >
                Preview
              </button>
              <button
                className={htmlMode === "source" ? "active" : ""}
                aria-pressed={htmlMode === "source"}
                onClick={() => {
                  setHtmlMode("source");
                  forceRender((n) => n + 1);
                }}
              >
                Source
              </button>
            </div>
          )}
          {monacoVisible && (
            <span className="theme-select-wrap">
              <select
                className="theme-select"
                value={codeTheme}
                onChange={(e) => setCodeTheme(e.target.value)}
                aria-label="Editor theme"
                title="Editor theme"
              >
                {CODE_THEMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </span>
          )}
          {monacoVisible && <FontStepper value={codeFontSize} onChange={setCodeFontSize} />}
          <button onClick={resetSample} title="Restore the original sample">
            Reset
          </button>
          <a
            className="demo-gh"
            href="https://github.com/zhuconv/Typort"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub ↗
          </a>
        </div>
      </div>
      <div className={isMarkdown ? "session-body" : "session-body code"}>
        <div
          ref={hostRef}
          className={isHtml && htmlMode === "preview" ? "editor-host hidden" : "editor-host"}
        />
        {isHtml && htmlMode === "preview" && (
          <iframe
            className="html-preview"
            title="HTML preview"
            sandbox="allow-scripts"
            srcDoc={draftRef.current}
          />
        )}
      </div>
    </div>
  );
}

/* ---------------- font-size stepper ---------------- */
/* A copy of the desktop SessionEditor's stepper — editable field + buttons. */

function FontStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (px: number) => void;
}) {
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
      >
        A&minus;
      </button>
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
      >
        A+
      </button>
    </div>
  );
}

/* ---------------- editor adapters ---------------- */

interface DemoEditor {
  getMarkdown(): string;
  setMarkdown(md: string): void;
  focus(): void;
  destroy(): void;
  /** Monaco only — switch the Shiki theme at runtime. */
  setTheme?(theme: string): void;
  /** Monaco only — update the font size (px). */
  setFontSize?(px: number): void;
  /** Monaco only — force a re-layout. */
  layout?(): void;
}

interface CreateEditorOptions {
  initialContent: string;
  onChange?: (md: string) => void;
  openLink?: (href: string) => void;
}

interface EditorModule {
  createEditor: (host: HTMLElement, opts: CreateEditorOptions) => DemoEditor;
}

let editorModulePromise: Promise<EditorModule> | null = null;

/** Lazily load open-typora (heavy) plus its stylesheets, with a fallback. */
async function loadEditorModule(): Promise<EditorModule> {
  if (editorModulePromise) return editorModulePromise;
  editorModulePromise = (async () => {
    try {
      await import("open-typora/widgets.css");
      await import("open-typora/theme-typora.css");
      const mod = await import("open-typora");
      return mod as unknown as EditorModule;
    } catch {
      return {
        createEditor: (host, opts) =>
          makeFallbackEditor(host, opts.initialContent, opts.onChange),
      };
    }
  })();
  return editorModulePromise;
}

/** Bare textarea — used only if Monaco or open-typora fail to load. */
function makeFallbackEditor(
  host: HTMLElement,
  initialContent: string,
  onChange?: (md: string) => void,
): DemoEditor {
  const ta = document.createElement("textarea");
  ta.value = initialContent;
  ta.className = "demo-fallback-textarea";
  ta.spellcheck = false;
  ta.addEventListener("input", () => onChange?.(ta.value));
  host.innerHTML = "";
  host.appendChild(ta);
  return {
    getMarkdown: () => ta.value,
    setMarkdown: (md: string) => {
      ta.value = md;
    },
    focus: () => ta.focus(),
    destroy: () => ta.remove(),
  };
}
