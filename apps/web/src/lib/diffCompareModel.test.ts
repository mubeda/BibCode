import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDiffFileRows,
  describeCompareNotice,
  describePatchOnlyReason,
  describeUnavailableVersion,
  EMPTY_DIFF_FILE_FILTERS,
  filterDiffFileRows,
  formatByteSize,
  formatFileCount,
  hasActiveDiffFileFilters,
  hydrateCompareFile,
  listChangeTargets,
  planCompareFile,
  reconcileSelectedRow,
  resolveCompareVersions,
  type DiffFileRow,
} from "./diffCompareModel";

const OLD_ID = "1".repeat(40);
const NEW_ID = "2".repeat(40);

function parse(patch: string): FileDiffMetadata[] {
  return parsePatchFiles(patch, "compare-model-test").flatMap((parsed) => parsed.files);
}

function rows(patch: string): DiffFileRow[] {
  return buildDiffFileRows(parse(patch));
}

/** Twenty numbered lines, with `replace` applied. */
function file(replace: Record<number, string> = {}, crlf = false): string {
  return Array.from({ length: 20 }, (_, index) => replace[index + 1] ?? `line ${index + 1}`)
    .map((line) => `${line}${crlf ? "\r\n" : "\n"}`)
    .join("");
}

const MODIFIED = [
  "diff --git a/src/app.ts b/src/app.ts",
  `index ${OLD_ID}..${NEW_ID} 100644`,
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -9,3 +9,3 @@",
  " line 9",
  "-line 10",
  "+line ten",
  " line 11",
  "",
].join("\n");

const MIXED = [
  MODIFIED.trimEnd(),
  "diff --git a/docs/New.md b/docs/New.md",
  "new file mode 100644",
  `index ${"0".repeat(40)}..${NEW_ID}`,
  "--- /dev/null",
  "+++ b/docs/New.md",
  "@@ -0,0 +1,2 @@",
  "+# New",
  "+text",
  "diff --git a/gone.txt b/gone.txt",
  "deleted file mode 100644",
  `index ${OLD_ID}..${"0".repeat(40)}`,
  "--- a/gone.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-bye",
  "diff --git a/old/name.ts b/new/name.ts",
  "similarity index 100%",
  "rename from old/name.ts",
  "rename to new/name.ts",
  "diff --git a/run.sh b/run.sh",
  "old mode 100644",
  "new mode 100755",
  "diff --git a/image.png b/image.png",
  `index ${OLD_ID}..${NEW_ID} 100644`,
  "Binary files a/image.png and b/image.png differ",
  "diff --git a/vendor/lib b/vendor/lib",
  `index ${OLD_ID}..${NEW_ID} 160000`,
  "--- a/vendor/lib",
  "+++ b/vendor/lib",
  "@@ -1 +1 @@",
  `-Subproject commit ${OLD_ID}`,
  `+Subproject commit ${NEW_ID}`,
  "",
].join("\n");

describe("diff file rows", () => {
  it("derives status and counts from a parsed patch", () => {
    const parsed = rows(MIXED);
    expect(
      parsed.map(({ path, previousPath, status, additions, deletions }) => ({
        path,
        previousPath,
        status,
        additions,
        deletions,
      })),
    ).toEqual([
      { path: "src/app.ts", previousPath: null, status: "modified", additions: 1, deletions: 1 },
      { path: "docs/New.md", previousPath: null, status: "added", additions: 2, deletions: 0 },
      { path: "gone.txt", previousPath: null, status: "deleted", additions: 0, deletions: 1 },
      {
        path: "new/name.ts",
        previousPath: "old/name.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
      },
      { path: "run.sh", previousPath: null, status: "modified", additions: 0, deletions: 0 },
      { path: "image.png", previousPath: null, status: "modified", additions: 0, deletions: 0 },
      { path: "vendor/lib", previousPath: null, status: "modified", additions: 1, deletions: 1 },
    ]);
  });

  it("filters by one status and a case-insensitive name, and counts what is shown", () => {
    const parsed = rows(MIXED);
    expect(filterDiffFileRows(parsed, EMPTY_DIFF_FILE_FILTERS)).toBe(parsed);
    expect(hasActiveDiffFileFilters(EMPTY_DIFF_FILE_FILTERS)).toBe(false);
    expect(
      filterDiffFileRows(parsed, { status: "added", query: "" }).map((row) => row.path),
    ).toEqual(["docs/New.md"]);
    expect(
      filterDiffFileRows(parsed, { status: "all", query: "NAME" }).map((row) => row.path),
    ).toEqual(["new/name.ts"]);
    expect(
      filterDiffFileRows(parsed, { status: "renamed", query: "old/" }).map((row) => row.path),
      "the old path of a rename matches too",
    ).toEqual(["new/name.ts"]);
    expect(filterDiffFileRows(parsed, { status: "deleted", query: "app" })).toEqual([]);
    expect(hasActiveDiffFileFilters({ status: "all", query: "  " })).toBe(false);
    expect(formatFileCount(2, 7)).toBe("2 of 7 files");
    expect(formatFileCount(0, 1)).toBe("0 of 1 file");
  });

  it("keeps the selected path when it survives a refresh, else takes the first row", () => {
    const parsed = rows(MIXED);
    expect(reconcileSelectedRow(parsed, "gone.txt")?.path).toBe("gone.txt");
    expect(reconcileSelectedRow(parsed, "vanished.ts")?.path).toBe("src/app.ts");
    expect(reconcileSelectedRow([], "gone.txt")).toBeNull();
  });
});

describe("compare plans", () => {
  it("reads a blob and the working file in the working tree, and two blobs elsewhere", () => {
    const [modified] = rows(MODIFIED);
    expect(planCompareFile(modified!, "working-tree", { liveTurnPatches: false })).toEqual({
      kind: "versions",
      old: { _tag: "blob", oid: OLD_ID },
      new: { _tag: "worktree", path: "src/app.ts", expectedOid: NEW_ID },
    });
    for (const scope of ["branch", "turn"] as const) {
      expect(planCompareFile(modified!, scope, { liveTurnPatches: false })).toEqual({
        kind: "versions",
        old: { _tag: "blob", oid: OLD_ID },
        new: { _tag: "blob", oid: NEW_ID },
      });
    }
  });

  it("requests nothing for files the patch already explains", () => {
    const plans = rows(MIXED)
      .slice(1)
      .map((row) => planCompareFile(row, "working-tree", { liveTurnPatches: false }));
    expect(plans).toEqual([
      { kind: "patch", reason: "added" },
      { kind: "patch", reason: "deleted" },
      { kind: "notice", notice: { kind: "renamed", previousPath: "old/name.ts" } },
      { kind: "notice", notice: { kind: "mode-changed", from: "100644", to: "100755" } },
      { kind: "notice", notice: { kind: "binary" } },
      { kind: "notice", notice: { kind: "submodule" } },
    ]);
    expect(
      plans.slice(2).map((plan) => plan.kind === "notice" && describeCompareNotice(plan.notice)),
    ).toEqual([
      "Renamed from old/name.ts. Contents unchanged.",
      "File mode changed from 100644 to 100755.",
      "Binary file. Use Open with to compare it in a diff app.",
      "Submodule. Open it as its own project to compare.",
    ]);
    expect(describePatchOnlyReason("added")).toBeNull();
    expect(describePatchOnlyReason("deleted")).toBe("Deleted");
  });

  it("explains an added or deleted binary file, but not an empty one", () => {
    const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
    const plans = rows(
      [
        "diff --git a/image.png b/image.png",
        "new file mode 100644",
        `index ${"0".repeat(40)}..${NEW_ID}`,
        "Binary files /dev/null and b/image.png differ",
        "diff --git a/old.png b/old.png",
        "deleted file mode 100644",
        `index ${OLD_ID}..${"0".repeat(40)}`,
        "Binary files a/old.png and /dev/null differ",
        // Untracked: the server writes no index line.
        "diff --git a/untracked.bin b/untracked.bin",
        "new file mode 100644",
        "Binary files /dev/null and b/untracked.bin differ",
        "diff --git a/empty.txt b/empty.txt",
        "new file mode 100644",
        `index ${"0".repeat(40)}..${EMPTY_BLOB}`,
        "diff --git a/emptied.txt b/emptied.txt",
        "deleted file mode 100644",
        `index ${EMPTY_BLOB}..${"0".repeat(40)}`,
        "",
      ].join("\n"),
    ).map((row) => [row.path, planCompareFile(row, "working-tree", { liveTurnPatches: false })]);
    expect(Object.fromEntries(plans)).toEqual({
      "image.png": { kind: "notice", notice: { kind: "binary" } },
      "old.png": { kind: "notice", notice: { kind: "binary" } },
      "untracked.bin": { kind: "notice", notice: { kind: "binary" } },
      "empty.txt": { kind: "patch", reason: "added" },
      "emptied.txt": { kind: "patch", reason: "deleted" },
    });
  });

  it("falls back to hunks only for abbreviated IDs, naming why", () => {
    const [short] = rows(MODIFIED.replace(`${OLD_ID}..${NEW_ID}`, "1111111..2222222"));
    const older = planCompareFile(short!, "working-tree", { liveTurnPatches: false });
    expect(older).toEqual({ kind: "patch", reason: "abbreviated-ids" });
    expect(describePatchOnlyReason("abbreviated-ids")).toBe("Full files need a newer server.");
    expect(planCompareFile(short!, "turn", { liveTurnPatches: true })).toEqual({
      kind: "patch",
      reason: "legacy-turn",
    });
    expect(describePatchOnlyReason("legacy-turn")).toBe(
      "Saved before full files were kept. Showing changed lines.",
    );
  });
});

describe("version reads", () => {
  it("waits for both reads and reports the first side without text", () => {
    const text = (contents: string) => ({ _tag: "text" as const, contents, byteLength: 1 });
    expect(resolveCompareVersions(null, text("b"))).toEqual({ kind: "loading" });
    expect(resolveCompareVersions(text("a"), text("b"))).toEqual({
      kind: "ready",
      old: "a",
      new: "b",
    });
    const tooLarge = resolveCompareVersions(
      { _tag: "unavailable", reason: "too-large", byteLength: 12_300_000 },
      null,
    );
    expect(tooLarge).toEqual({
      kind: "unavailable",
      side: "old",
      reason: "too-large",
      byteLength: 12_300_000,
    });
    expect(tooLarge.kind === "unavailable" && describeUnavailableVersion(tooLarge)).toBe(
      "Too large to show in full (12.3 MB). Showing changed lines.",
    );
    const missing = resolveCompareVersions(text("a"), {
      _tag: "unavailable",
      reason: "missing",
      byteLength: null,
    });
    expect(missing.kind === "unavailable" && missing.side).toBe("new");
    expect(
      describeUnavailableVersion({
        kind: "unavailable",
        side: "old",
        reason: "missing",
        byteLength: null,
      }),
    ).toBe("The full previous version is no longer in the repository.");
    expect(formatByteSize(4_375_000)).toBe("4.4 MB");
    expect(formatByteSize(512)).toBe("512 B");
  });
});

describe("hydration", () => {
  it("fills Git's hunks with both full files without touching the shared patch", () => {
    const [partial] = parse(MODIFIED);
    const result = hydrateCompareFile(partial!, file(), file({ 10: "line ten" }));
    expect(result.kind).toBe("hydrated");
    if (result.kind !== "hydrated") return;
    expect(result.fileDiff.isPartial).toBe(false);
    expect(result.fileDiff.additionLines).toHaveLength(20);
    expect(result.fileDiff.deletionLines).toHaveLength(20);
    expect(partial!.isPartial, "the patch Changes renders stays partial").toBe(true);
  });

  it("tolerates CRLF in the full files", () => {
    const [partial] = parse(MODIFIED);
    expect(hydrateCompareFile(partial!, file({}, true), file({ 10: "line ten" }, true)).kind).toBe(
      "hydrated",
    );
  });

  it("falls back when the files do not reproduce Git's hunks, as under textconv", () => {
    const [partial] = parse(MODIFIED);
    // A converter changed what Git compared: the stored files read differently.
    expect(
      hydrateCompareFile(partial!, file({ 10: "binary-ish" }), file({ 10: "line ten" })).kind,
    ).toBe("mismatch");
    expect(hydrateCompareFile(partial!, file(), file({ 10: "LINE TEN" })).kind).toBe("mismatch");
  });

  it("lists where each block of changes starts", () => {
    const [partial] = parse(
      [
        "diff --git a/a.txt b/a.txt",
        `index ${OLD_ID}..${NEW_ID} 100644`,
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -2,4 +2,3 @@",
        " line 2",
        "-line 3",
        " line 4",
        "-line 5",
        "@@ -15,0 +14,2 @@",
        "+added one",
        "+added two",
        "",
      ].join("\n"),
    );
    expect(listChangeTargets(partial!)).toEqual([
      { lineNumber: 3, side: "deletions" },
      { lineNumber: 5, side: "deletions" },
      { lineNumber: 14, side: "additions" },
    ]);
  });
});
