/**
 * Monaco-based code editor for non-markdown files, with Shiki providing
 * VS Code-grade syntax highlighting (real TextMate grammars) and themes.
 *
 * Heavy module — dynamically imported by SessionEditor only when a code file
 * is opened, so markdown-only windows never pay the Monaco/Shiki cost.
 *
 * Fast-open path:
 *  - Shiki's JavaScript regex engine — no ~600 KB Oniguruma WASM to fetch and
 *    instantiate;
 *  - only the opened file's grammar is loaded, not all ~35;
 *  - the editor is shown as soon as the themes are ready; the grammar loads
 *    in the background and highlighting lights up a moment later.
 */

import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { createHighlighter, type BundledLanguage, type Highlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { shikiToMonaco } from "@shikijs/monaco";
import { CODE_THEMES } from "./codeThemes.js";

// Shiki replaces Monaco's tokenizer, so we only need Monaco's base editor
// worker (diff, links, basic services) — not the TS/JSON/CSS/HTML language
// workers. Typort is a fast editor, not an IDE: no IntelliSense workers.
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment =
  { getWorker: () => new EditorWorker() };

export interface CodeEditorHandle {
  /** Named to match the markdown editor adapter; returns plain text. */
  getMarkdown(): string;
  setMarkdown(content: string): void;
  focus(): void;
  /** Switch the active Shiki theme (global to all Monaco editors). */
  setTheme(theme: string): void;
  /** Update the editor font size (px). */
  setFontSize(px: number): void;
  /** Force a re-layout — e.g. after the container goes from hidden to visible. */
  layout(): void;
  destroy(): void;
}

export interface CreateCodeEditorOptions {
  initialContent: string;
  language: string;
  theme: string;
  fontSize: number;
  readonly?: boolean;
  onChange?: (content: string) => void;
}

// JavaScript regex engine — avoids fetching and instantiating the Oniguruma
// WASM. `forgiving` skips the rare grammar rule it cannot translate instead
// of throwing.
const shikiEngine = createJavaScriptRegexEngine({ forgiving: true });

let highlighterPromise: Promise<Highlighter> | null = null;
const wiredLangs = new Set<string>();

/**
 * Shared Shiki highlighter — created with the themes only (fast: a few small
 * JSON files, no grammars, no WASM). Languages are added on demand by
 * ensureLanguage(). Memoised across editor windows.
 */
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const hl = await createHighlighter({
        themes: CODE_THEMES.map((t) => t.id),
        langs: [],
        engine: shikiEngine,
      });
      // Registers the themes with Monaco (no languages loaded yet).
      shikiToMonaco(hl, monaco);
      return hl;
    })();
  }
  return highlighterPromise;
}

/** Load one language's grammar and wire its tokenizer into Monaco. */
async function ensureLanguage(lang: string): Promise<void> {
  if (lang === "plaintext" || wiredLangs.has(lang)) return;
  wiredLangs.add(lang);
  const hl = await getHighlighter();
  if (!hl.getLoadedLanguages().includes(lang)) {
    await hl.loadLanguage(lang as BundledLanguage);
  }
  shikiToMonaco(hl, monaco);
}

/** Comfortable line height for a given font size — keeps spacing airy as the
 *  user steps the font size up or down. */
function lineHeightFor(fontSize: number): number {
  return Math.round(fontSize * 1.55);
}

export async function createCodeEditor(
  host: HTMLElement,
  opts: CreateCodeEditorOptions,
): Promise<CodeEditorHandle> {
  // Wait only for the themes (fast). The editor is shown right away; the
  // grammar for `opts.language` is loaded in the background below.
  await getHighlighter();
  if (opts.language !== "plaintext") {
    monaco.languages.register({ id: opts.language });
  }

  const editor = monaco.editor.create(host, {
    value: opts.initialContent,
    language: opts.language,
    theme: opts.theme,
    readOnly: opts.readonly ?? false,
    automaticLayout: true,
    fontSize: opts.fontSize,
    lineHeight: lineHeightFor(opts.fontSize),
    fontFamily:
      '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontLigatures: true,
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    renderWhitespace: "selection",
    smoothScrolling: true,
    mouseWheelZoom: true,
    tabSize: 2,
    padding: { top: 10, bottom: 10 },
  });

  // Load this file's grammar in the background — the editor is already
  // visible with the text; syntax highlighting lights up a moment later.
  void ensureLanguage(opts.language).catch((err) =>
    console.error("shiki: failed to load language", opts.language, err),
  );

  // Bracket changes between a programmatic reload and a real edit, so a
  // reload doesn't fire onChange and trigger a redundant autosave.
  let suppressChange = false;
  const sub = opts.onChange
    ? editor.onDidChangeModelContent(() => {
        if (!suppressChange) opts.onChange!(editor.getValue());
      })
    : undefined;

  return {
    getMarkdown: () => editor.getValue(),
    setMarkdown: (content) => {
      if (editor.getValue() === content) return;
      suppressChange = true;
      editor.setValue(content);
      suppressChange = false;
    },
    focus: () => editor.focus(),
    setTheme: (theme) => monaco.editor.setTheme(theme),
    setFontSize: (px) =>
      editor.updateOptions({ fontSize: px, lineHeight: lineHeightFor(px) }),
    layout: () => editor.layout(),
    destroy: () => {
      sub?.dispose();
      editor.dispose();
    },
  };
}
