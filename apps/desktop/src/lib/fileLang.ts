/**
 * Decide how Typort should open a file: as WYSIWYG markdown (open-typora) or
 * as code (Monaco). For the code path, map the path to a Monaco/Shiki
 * language id.
 */

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdown", "mkd"]);
const HTML_EXTS = new Set(["html", "htm"]);

/** extension (lowercase, no dot) -> Monaco/Shiki language id */
const EXT_LANG: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx",
  json: "json", jsonc: "jsonc", json5: "json5",
  html: "html", htm: "html", xml: "xml", svg: "xml",
  css: "css", scss: "scss", sass: "scss", less: "less",
  py: "python", pyi: "python",
  rs: "rust", go: "go",
  java: "java", kt: "kotlin", kts: "kotlin",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", rb: "ruby", php: "php", swift: "swift", lua: "lua",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  yaml: "yaml", yml: "yaml", toml: "toml",
  ini: "ini", conf: "ini", cfg: "ini",
  sql: "sql", diff: "diff", patch: "diff",
  vue: "vue", svelte: "svelte",
};

/** Whole-basename matches (lowercased) for files with no useful extension. */
const NAME_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "make",
  ".bashrc": "shellscript",
  ".zshrc": "shellscript",
  ".bash_profile": "shellscript",
};

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** True when the file should open in the WYSIWYG markdown editor. */
export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTS.has(extOf(basename(path)));
}

/** True when the file can be shown as a rendered HTML preview. */
export function isHtmlPath(path: string): boolean {
  return HTML_EXTS.has(extOf(basename(path)));
}

/**
 * Monaco/Shiki language id for a code file. Falls back to "plaintext"
 * (Monaco built-in) for anything unrecognised — the editor still works,
 * just without highlighting.
 */
export function detectLanguage(path: string): string {
  const name = basename(path).toLowerCase();
  const byName = NAME_LANG[name];
  if (byName) return byName;
  return EXT_LANG[extOf(name)] ?? "plaintext";
}
