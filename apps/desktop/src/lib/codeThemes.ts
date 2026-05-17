/**
 * Code-editor theme catalogue.
 *
 * Kept dependency-free (no monaco / shiki import) so SessionEditor can render
 * the theme picker synchronously without pulling the heavy Monaco bundle into
 * markdown-only windows.
 */

export interface CodeTheme {
  /** Shiki theme id — also the Monaco theme id after shikiToMonaco(). */
  id: string;
  label: string;
  dark: boolean;
}

export const CODE_THEMES: CodeTheme[] = [
  { id: "github-dark-default", label: "GitHub Dark", dark: true },
  { id: "github-light-default", label: "GitHub Light", dark: false },
  { id: "vitesse-dark", label: "Vitesse Dark", dark: true },
  { id: "vitesse-light", label: "Vitesse Light", dark: false },
];

export const DEFAULT_CODE_THEME = "github-dark-default";

export function isKnownCodeTheme(id: string): boolean {
  return CODE_THEMES.some((t) => t.id === id);
}
