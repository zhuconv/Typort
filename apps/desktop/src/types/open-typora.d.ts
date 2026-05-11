declare module "open-typora" {
  export interface CreateEditorOptions {
    initialContent?: string;
    onChange?: (md: string) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    /** Custom handler for Cmd/Ctrl+click on a link. Default opens via
     *  `window.open(href)`. Inject a Tauri opener API in webview hosts. */
    openLink?: (href: string) => void;
  }

  export interface TyporaEditor {
    getMarkdown(): string;
    setMarkdown(md: string): void;
    toggleSource(): void;
    isSourceMode(): boolean;
    focus(): void;
    destroy(): void;
    /** Underlying ProseMirror EditorView. No stability guarantee. */
    view?: unknown;
  }

  export function createEditor(host: HTMLElement, opts?: CreateEditorOptions): TyporaEditor;
}

declare module "open-typora/widgets.css";
declare module "open-typora/theme-typora.css";
declare module "open-typora/theme-github.css";
