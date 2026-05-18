/**
 * Sample files for the browser demo — one per language. Each is a real file
 * under ./samples, imported raw so it shows up verbatim in the editor.
 */
import welcomeMd from "./samples/welcome.md?raw";
import pageHtml from "./samples/page.html?raw";
import exampleTs from "./samples/example.ts?raw";
import examplePy from "./samples/example.py?raw";
import exampleRs from "./samples/example.rs?raw";
import exampleGo from "./samples/example.go?raw";
import exampleCpp from "./samples/example.cpp?raw";
import exampleCss from "./samples/example.css?raw";
import exampleJson from "./samples/example.json?raw";
import exampleSh from "./samples/example.sh?raw";

export interface DemoSample {
  /** Stable id used by the picker and React keys. */
  id: string;
  /** Human label shown in the picker. */
  label: string;
  /** Drives language detection and the markdown / HTML / code routing. */
  filename: string;
  /** Initial file contents. */
  content: string;
}

/**
 * Markdown first (shows the WYSIWYG editor), then HTML, then code. Typed as a
 * non-empty tuple so `DEMO_SAMPLES[0]` is a safe default under
 * `noUncheckedIndexedAccess`.
 */
export const DEMO_SAMPLES: [DemoSample, ...DemoSample[]] = [
  { id: "markdown", label: "Markdown", filename: "welcome.md", content: welcomeMd },
  { id: "html", label: "HTML", filename: "page.html", content: pageHtml },
  { id: "typescript", label: "TypeScript", filename: "example.ts", content: exampleTs },
  { id: "python", label: "Python", filename: "example.py", content: examplePy },
  { id: "rust", label: "Rust", filename: "example.rs", content: exampleRs },
  { id: "go", label: "Go", filename: "example.go", content: exampleGo },
  { id: "cpp", label: "C++", filename: "example.cpp", content: exampleCpp },
  { id: "css", label: "CSS", filename: "example.css", content: exampleCss },
  { id: "json", label: "JSON", filename: "example.json", content: exampleJson },
  { id: "shell", label: "Shell", filename: "example.sh", content: exampleSh },
];
