import { describe, expect, it } from "vitest";
import {
  buildConflictMarkerText,
  computeLineDiff,
  countUnresolvedMarkers,
  summarizeDiff,
} from "./diff.js";

describe("computeLineDiff", () => {
  it("returns no changes when texts are identical", () => {
    const d = computeLineDiff("a\nb\nc\n", "a\nb\nc\n");
    expect(summarizeDiff(d)).toEqual({ added: 0, removed: 0 });
    // Only context lines (or context + skip markers, but no adds/removes)
    expect(d.every((x) => x.kind === "context" || x.kind === "skip")).toBe(true);
  });

  it("marks pure additions", () => {
    const d = computeLineDiff("a\nb\n", "a\nb\nc\n");
    const adds = d.filter((x) => x.kind === "added");
    const rems = d.filter((x) => x.kind === "removed");
    expect(adds.length).toBe(1);
    expect(rems.length).toBe(0);
    expect(adds[0]).toMatchObject({ kind: "added", line: "c", newNum: 3 });
  });

  it("marks pure removals", () => {
    const d = computeLineDiff("a\nb\nc\n", "a\nc\n");
    const rems = d.filter((x) => x.kind === "removed");
    expect(rems.length).toBe(1);
    expect(rems[0]).toMatchObject({ kind: "removed", line: "b", oldNum: 2 });
  });

  it("handles single-line files without trailing newline", () => {
    const d = computeLineDiff("hello s", "hello outside-edit");
    const rem = d.find((x) => x.kind === "removed");
    const add = d.find((x) => x.kind === "added");
    expect(rem).toBeDefined();
    expect(add).toBeDefined();
    if (rem && rem.kind === "removed") expect(rem.line).toBe("hello s");
    if (add && add.kind === "added") expect(add.line).toBe("hello outside-edit");
  });

  it("computes diff for the conflict scenario you actually hit", () => {
    const remote =
      "# scratch\n\nhello what is your favorite thing outside-edit interesting outside-edit";
    const local =
      "# scratch\n\nhello what is your favorite thing outside-edit interesting s";
    const d = computeLineDiff(remote, local);
    // Only the third paragraph differs.
    const adds = d.filter((x) => x.kind === "added");
    const rems = d.filter((x) => x.kind === "removed");
    expect(adds.length).toBe(1);
    expect(rems.length).toBe(1);
    if (adds[0]?.kind === "added") {
      expect(adds[0].line.endsWith("interesting s")).toBe(true);
    }
    if (rems[0]?.kind === "removed") {
      expect(rems[0].line.endsWith("outside-edit")).toBe(true);
    }
  });

  it("collapses long unchanged runs into a skip marker", () => {
    const oldT = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const newT = oldT.replace("line 15", "line FIFTEEN");
    const d = computeLineDiff(oldT, newT, { contextLines: 3 });
    const skips = d.filter((x) => x.kind === "skip");
    expect(skips.length).toBeGreaterThanOrEqual(1);
    // Every skip must have a positive count
    for (const s of skips) {
      if (s.kind === "skip") expect(s.count).toBeGreaterThan(0);
    }
    // No raw context outside [start..3, change-3..change+3, change+3..end] regions
    const contexts = d.filter((x) => x.kind === "context").length;
    // Roughly: 3 lines before change + 3 lines after change = ≤ 6 (plus head/tail context).
    expect(contexts).toBeLessThan(15);
  });

  it("respects contextLines=Infinity (no collapsing)", () => {
    const oldT = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const newT = oldT.replace("line 15", "line FIFTEEN");
    const d = computeLineDiff(oldT, newT, { contextLines: Infinity });
    expect(d.find((x) => x.kind === "skip")).toBeUndefined();
  });
});

describe("summarizeDiff", () => {
  it("counts adds and removes", () => {
    const lines = computeLineDiff("a\nb\nc\n", "a\nx\nc\nd\n");
    expect(summarizeDiff(lines)).toEqual({ added: 2, removed: 1 });
  });

  it("returns zeros for identical input", () => {
    expect(summarizeDiff(computeLineDiff("same\n", "same\n"))).toEqual({
      added: 0,
      removed: 0,
    });
  });
});

describe("buildConflictMarkerText", () => {
  it("returns input unchanged when there's no diff", () => {
    expect(buildConflictMarkerText("a\nb\nc\n", "a\nb\nc\n")).toBe("a\nb\nc\n");
  });

  it("wraps a single mixed hunk in markers", () => {
    const remote = "A\nB\nC\n";
    const local = "A\nX\nC\n";
    const out = buildConflictMarkerText(remote, local);
    expect(out).toBe(
      "A\n" +
        "<<<<<<< your draft\n" +
        "X\n" +
        "=======\n" +
        "B\n" +
        ">>>>>>> remote\n" +
        "C\n",
    );
  });

  it("wraps a pure addition (remote section is empty)", () => {
    const remote = "A\nC\n";
    const local = "A\nB\nC\n";
    const out = buildConflictMarkerText(remote, local);
    expect(out).toBe(
      "A\n" +
        "<<<<<<< your draft\n" +
        "B\n" +
        "=======\n" +
        ">>>>>>> remote\n" +
        "C\n",
    );
  });

  it("wraps a pure removal (your-draft section is empty)", () => {
    const remote = "A\nB\nC\n";
    const local = "A\nC\n";
    const out = buildConflictMarkerText(remote, local);
    expect(out).toBe(
      "A\n" +
        "<<<<<<< your draft\n" +
        "=======\n" +
        "B\n" +
        ">>>>>>> remote\n" +
        "C\n",
    );
  });

  it("emits one marker block per region of disagreement", () => {
    const remote = "A\nB\nC\nD\n";
    const local = "A\nX\nC\nY\n";
    const out = buildConflictMarkerText(remote, local);
    // Expect TWO marker blocks, one for B↔X, one for D↔Y
    const localMarkers = out.split("\n").filter((l) => l.startsWith("<<<<<<< ")).length;
    const remoteMarkers = out.split("\n").filter((l) => l.startsWith(">>>>>>> ")).length;
    expect(localMarkers).toBe(2);
    expect(remoteMarkers).toBe(2);
  });

  it("handles files without trailing newline", () => {
    const remote = "hello s";
    const local = "hello outside-edit";
    const out = buildConflictMarkerText(remote, local);
    expect(out).toContain("<<<<<<< your draft\nhello outside-edit\n");
    expect(out).toContain("=======\nhello s\n>>>>>>> remote\n");
  });

  it("respects custom labels", () => {
    const out = buildConflictMarkerText("A\n", "B\n", {
      localLabel: "mine",
      remoteLabel: "theirs",
    });
    expect(out).toContain("<<<<<<< mine\n");
    expect(out).toContain(">>>>>>> theirs\n");
  });
});

describe("countUnresolvedMarkers", () => {
  it("returns 0 for clean text", () => {
    expect(countUnresolvedMarkers("# title\n\nsome content\n")).toBe(0);
  });

  it("counts each of the three marker kinds", () => {
    const text =
      "A\n<<<<<<< your draft\nX\n=======\nB\n>>>>>>> remote\nC\n";
    expect(countUnresolvedMarkers(text)).toBe(3);
  });

  it("counts multiple marker blocks", () => {
    const text =
      "A\n<<<<<<< your draft\nX\n=======\nB\n>>>>>>> remote\nC\n" +
      "<<<<<<< your draft\nY\n=======\nD\n>>>>>>> remote\n";
    expect(countUnresolvedMarkers(text)).toBe(6);
  });

  it("does not false-positive on a markdown ====== heading underline of length != 7", () => {
    // Setext H1 with 7 `=` would actually look identical to our mid-marker, so we
    // accept that edge case. But common 8+ or 5- underlines should NOT trip us.
    expect(countUnresolvedMarkers("Title\n========\n")).toBe(0);
    expect(countUnresolvedMarkers("Title\n=====\n")).toBe(0);
  });

  it("returns 0 once user has cleaned the merged text", () => {
    const merged = "A\nX\nB\nC\n"; // user kept both X and B, deleted markers
    expect(countUnresolvedMarkers(merged)).toBe(0);
  });
});
