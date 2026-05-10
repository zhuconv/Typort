declare module "typora-web" {
  export interface CreateEditorOptions {
    initialContent?: string;
    onChange?: (md: string) => void;
    onFocus?: () => void;
    onBlur?: () => void;
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

declare module "typora-web/widgets.css";
declare module "typora-web/theme-typora.css";
declare module "typora-web/theme-github.css";
