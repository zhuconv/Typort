/**
 * Monaco-based code editor for non-markdown files, with Shiki providing
 * VS Code-grade syntax highlighting (real TextMate grammars) and themes.
 *
 * Heavy module — dynamically imported by SessionEditor only when a code file
 * is opened, so markdown-only windows never pay the Monaco/Shiki cost.
 */

import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { createHighlighter } from "shiki";
import { shikiToMonaco } from "@shikijs/monaco";
import { CODE_THEMES } from "./codeThemes.js";

// Shiki replaces Monaco's tokenizer, so we only need Monaco's base editor
// worker (diff, links, basic services) — not the TS/JSON/CSS/HTML language
// workers. Typort is a fast editor, not an IDE: no IntelliSense workers.
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment =
  { getWorker: () => new EditorWorker() };

/**
 * Languages pre-loaded into the Shiki highlighter. Must stay a superset of
 * every id detectLanguage() can return (except "plaintext", which Monaco
 * provides natively).
 */
const SHIKI_LANGS = [
  "typescript", "tsx", "javascript", "jsx", "json", "jsonc", "json5",
  "html", "xml", "css", "scss", "less", "python", "rust", "go", "java",
  "kotlin", "c", "cpp", "csharp", "ruby", "php", "swift", "lua",
  "shellscript", "yaml", "toml", "ini", "sql", "diff", "vue", "svelte",
  "dockerfile", "make",
];

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

let shikiReady: Promise<void> | null = null;

/**
 * Build the Shiki highlighter once, register its languages with Monaco, and
 * wire Shiki's grammars + themes into Monaco. Memoised across editor windows.
 */
function ensureShiki(): Promise<void> {
  if (!shikiReady) {
    shikiReady = (async () => {
      const highlighter = await createHighlighter({
        themes: CODE_THEMES.map((t) => t.id),
        langs: SHIKI_LANGS,
      });
      for (const lang of highlighter.getLoadedLanguages()) {
        monaco.languages.register({ id: lang });
      }
      shikiToMonaco(highlighter, monaco);
    })();
  }
  return shikiReady;
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
  await ensureShiki();

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
