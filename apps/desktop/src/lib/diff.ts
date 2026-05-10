import { diffLines } from "diff";

export type DiffLine =
  | { kind: "context"; line: string; oldNum: number; newNum: number }
  | { kind: "added"; line: string; newNum: number }
  | { kind: "removed"; line: string; oldNum: number }
  | { kind: "skip"; oldStart: number; newStart: number; count: number };

export interface ComputeDiffOptions {
  /**
   * If a run of unchanged lines exceeds `contextLines * 2 + 1` lines, the
   * middle is collapsed into a single `skip` marker, leaving `contextLines`
   * lines of context above and below each change. Set to Infinity to disable.
   */
  contextLines?: number;
}

/**
 * Compute a unified-diff-style line list between `oldText` (e.g. remote)
 * and `newText` (e.g. local draft).
 *
 * Convention used here:
 *   - `removed` lines are present in OLD but not NEW
 *   - `added` lines are present in NEW but not OLD
 *
 * In our conflict modal, OLD = remote on disk, NEW = local draft, so:
 *   "−" markers = "you'd lose this if you click Keep mine"
 *   "+" markers = "you'd lose this if you click Reload remote"
 */
export function computeLineDiff(
  oldText: string,
  newText: string,
  opts: ComputeDiffOptions = {},
): DiffLine[] {
  const changes = diffLines(oldText, newText);
  const flat: DiffLine[] = [];
  let oldNum = 1;
  let newNum = 1;

  for (const c of changes) {
    // diffLines returns chunks whose `value` ends with "\n" if the source line
    // was newline-terminated. Splitting on "\n" then leaves a trailing "" we
    // want to drop, but a chunk that legitimately ends without newline (e.g.
    // last line of a no-final-newline file) should keep its line.
    const lines = splitChunkLines(c.value);
    for (const line of lines) {
      if (c.added) {
        flat.push({ kind: "added", line, newNum: newNum++ });
      } else if (c.removed) {
        flat.push({ kind: "removed", line, oldNum: oldNum++ });
      } else {
        flat.push({ kind: "context", line, oldNum: oldNum++, newNum: newNum++ });
      }
    }
  }

  const ctx = opts.contextLines ?? 3;
  if (!Number.isFinite(ctx)) return flat;
  return collapseContextRuns(flat, ctx);
}

function splitChunkLines(value: string): string[] {
  if (value === "") return [];
  // Normalize Windows endings, then split on \n. The diff lib gives us "\n"
  // termination per line; the last split element will be "" if the chunk ends
  // on \n, so drop that.
  const normalized = value.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function collapseContextRuns(flat: DiffLine[], context: number): DiffLine[] {
  const isChange = (l: DiffLine) => l.kind === "added" || l.kind === "removed";
  // Identify ranges of contiguous "context" surrounded by changes, and shrink
  // those runs that are longer than 2*context + 1.
  const out: DiffLine[] = [];
  let i = 0;
  while (i < flat.length) {
    const cur = flat[i]!;
    if (cur.kind !== "context") {
      out.push(cur);
      i++;
      continue;
    }
    let j = i;
    while (j < flat.length && flat[j]!.kind === "context") j++;
    const run = flat.slice(i, j);
    const hasChangeBefore = i > 0 && isChange(flat[i - 1]!);
    const hasChangeAfter = j < flat.length && isChange(flat[j]!);

    if (run.length > context * 2 + 1 && (hasChangeBefore || hasChangeAfter)) {
      const head = hasChangeBefore ? run.slice(0, context) : [];
      const tail = hasChangeAfter ? run.slice(run.length - context) : [];
      const skipped = run.length - head.length - tail.length;
      const firstSkipped = run[head.length]!;
      if (firstSkipped.kind !== "context") {
        // shouldn't happen, but guard
        out.push(...run);
      } else {
        out.push(...head);
        out.push({
          kind: "skip",
          oldStart: firstSkipped.oldNum,
          newStart: firstSkipped.newNum,
          count: skipped,
        });
        out.push(...tail);
      }
    } else {
      out.push(...run);
    }
    i = j;
  }
  return out;
}

export function summarizeDiff(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.kind === "added") added++;
    else if (l.kind === "removed") removed++;
  }
  return { added, removed };
}

const MARKER_LOCAL = "<<<<<<< your draft";
const MARKER_MID = "=======";
const MARKER_REMOTE = ">>>>>>> remote";

export interface BuildMarkersOptions {
  localLabel?: string;
  remoteLabel?: string;
}

/**
 * Build a git-mergetool-style merge text:
 *
 *   unchanged-context-1
 *   <<<<<<< your draft
 *   { lines local has but remote doesn't }
 *   =======
 *   { lines remote has but local doesn't }
 *   >>>>>>> remote
 *   unchanged-context-2
 *
 * Consecutive added/removed chunks are collapsed into a single hunk so the user
 * sees one marker block per region of disagreement, not one per line.
 *
 * Caller convention: pass `remote` as the on-disk content and `local` as the
 * editor's draft. Output uses LF line endings.
 */
export function buildConflictMarkerText(
  remote: string,
  local: string,
  opts: BuildMarkersOptions = {},
): string {
  const localLabel = opts.localLabel ?? "your draft";
  const remoteLabel = opts.remoteLabel ?? "remote";
  const headLocal = `<<<<<<< ${localLabel}`;
  const headRemote = `>>>>>>> ${remoteLabel}`;

  const changes = diffLines(remote, local);
  const out: string[] = [];
  let i = 0;
  while (i < changes.length) {
    const c = changes[i]!;
    if (!c.added && !c.removed) {
      out.push(c.value);
      i++;
      continue;
    }
    let added = "";
    let removed = "";
    while (i < changes.length && (changes[i]!.added || changes[i]!.removed)) {
      const ch = changes[i]!;
      if (ch.added) added += ch.value;
      else if (ch.removed) removed += ch.value;
      i++;
    }
    out.push(headLocal + "\n");
    out.push(ensureTrailingNewline(added));
    out.push(MARKER_MID + "\n");
    out.push(ensureTrailingNewline(removed));
    out.push(headRemote + "\n");
  }
  return out.join("");
}

function ensureTrailingNewline(s: string): string {
  if (s.length === 0) return s;
  return s.endsWith("\n") ? s : s + "\n";
}

/**
 * Count how many conflict markers remain in the merged text. Returns the count
 * of `<<<<<<< `, `=======` (exact line), and `>>>>>>> ` markers; zero means the
 * merge is fully resolved.
 */
export function countUnresolvedMarkers(text: string): number {
  let n = 0;
  const lines = text.split("\n");
  for (const line of lines) {
    if (
      line.startsWith("<<<<<<< ") ||
      line.startsWith(">>>>>>> ") ||
      line === MARKER_MID
    ) {
      n++;
    }
  }
  return n;
}

export const CONFLICT_MARKERS = {
  LOCAL: MARKER_LOCAL,
  MID: MARKER_MID,
  REMOTE: MARKER_REMOTE,
};
