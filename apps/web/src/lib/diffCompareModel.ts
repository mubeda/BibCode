/**
 * The Diff panel's Compare view, as pure data: one row per changed file, the filters over
 * them, which full versions a selected file needs, and how those versions fill Git's hunks.
 */
import {
  hydratePartialDiff,
  type ChangeContent,
  type FileDiffMetadata,
  type Hunk,
} from "@pierre/diffs";
import type {
  ReviewFileVersionRequest,
  ReviewFileVersionUnavailableReason,
  ReviewReadFileVersionResult,
} from "@bibcode/contracts";

import { buildFileDiffRenderKey, resolveFileDiffPath } from "./diffRendering";

export type DiffFileStatus = "added" | "modified" | "deleted" | "renamed";
export type DiffStatusFilter = "all" | DiffFileStatus;

export const DIFF_FILE_STATUS_LABELS: Readonly<Record<DiffFileStatus, string>> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
};

export const DIFF_FILE_STATUS_LETTERS: Readonly<Record<DiffFileStatus, string>> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

export interface DiffFileRow {
  /** The same key Changes renders the file under. */
  readonly key: string;
  readonly path: string;
  /** The old path of a rename. */
  readonly previousPath: string | null;
  readonly status: DiffFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly fileDiff: FileDiffMetadata;
}

export interface DiffFileFilters {
  readonly status: DiffStatusFilter;
  readonly query: string;
}

export const EMPTY_DIFF_FILE_FILTERS: DiffFileFilters = { status: "all", query: "" };

function stripPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function fileStatus(fileDiff: FileDiffMetadata): DiffFileStatus {
  switch (fileDiff.type) {
    case "new":
      return "added";
    case "deleted":
      return "deleted";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    case "change":
      return "modified";
  }
}

/** One row per file, in the order given. Derived once per parsed patch. */
export function buildDiffFileRows(files: ReadonlyArray<FileDiffMetadata>): DiffFileRow[] {
  return files.map((fileDiff) => {
    let additions = 0;
    let deletions = 0;
    for (const hunk of fileDiff.hunks) {
      additions += hunk.additionLines;
      deletions += hunk.deletionLines;
    }
    const status = fileStatus(fileDiff);
    return {
      key: buildFileDiffRenderKey(fileDiff),
      path: resolveFileDiffPath(fileDiff),
      previousPath:
        status === "renamed" && fileDiff.prevName ? stripPrefix(fileDiff.prevName) : null,
      status,
      additions,
      deletions,
      fileDiff,
    };
  });
}

export function hasActiveDiffFileFilters(filters: DiffFileFilters): boolean {
  return filters.status !== "all" || filters.query.trim().length > 0;
}

/** The rows that match the status and a case-insensitive substring of either path. */
export function filterDiffFileRows(
  rows: ReadonlyArray<DiffFileRow>,
  filters: DiffFileFilters,
): ReadonlyArray<DiffFileRow> {
  if (!hasActiveDiffFileFilters(filters)) return rows;
  const query = filters.query.trim().toLocaleLowerCase();
  return rows.filter(
    (row) =>
      (filters.status === "all" || row.status === filters.status) &&
      (query.length === 0 ||
        row.path.toLocaleLowerCase().includes(query) ||
        (row.previousPath?.toLocaleLowerCase().includes(query) ?? false)),
  );
}

export function formatFileCount(visible: number, total: number): string {
  return `${visible} of ${total} ${total === 1 ? "file" : "files"}`;
}

export type DiffCompareScope = "working-tree" | "branch" | "turn";

/** A message shown instead of a diff, for a file whose versions say nothing more. */
export type CompareNotice =
  | { readonly kind: "renamed"; readonly previousPath: string }
  | { readonly kind: "mode-changed"; readonly from: string; readonly to: string }
  | { readonly kind: "binary" }
  | { readonly kind: "submodule" };

/** Why only Git's hunks are shown, with no full versions to read. */
export type ComparePatchOnlyReason =
  | "added"
  | "deleted"
  /** An older server printed abbreviated object IDs. */
  | "abbreviated-ids"
  /** A turn patch stored before checkpoints kept full files. */
  | "legacy-turn";

export type ComparePlan =
  | {
      readonly kind: "versions";
      readonly old: ReviewFileVersionRequest;
      readonly new: ReviewFileVersionRequest;
    }
  | { readonly kind: "patch"; readonly reason: ComparePatchOnlyReason }
  | { readonly kind: "notice"; readonly notice: CompareNotice };

const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function isFullObjectId(value: string | undefined): value is string {
  return value !== undefined && FULL_OBJECT_ID.test(value);
}

const SUBMODULE_MODE = "160000";

/** The empty blob's ID in SHA-1 and SHA-256 repositories, whole or abbreviated. */
const EMPTY_BLOB_IDS = [
  "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
  "473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813",
];

function isEmptyBlobId(value: string | undefined): boolean {
  return (
    value !== undefined &&
    value.length >= 7 &&
    EMPTY_BLOB_IDS.some((emptyId) => emptyId.startsWith(value))
  );
}

/**
 * What a file needs for Compare. The working tree's current side is read from disk and
 * checked against the patch's object ID; every other side is a blob.
 */
export function planCompareFile(
  row: DiffFileRow,
  scope: DiffCompareScope,
  /**
   * `liveTurnPatches`: the server computes turn patches from checkpoint refs, which print full
   * IDs, so short IDs in a turn patch mean one it stored before. It says so by reporting
   * `truncated` on every turn patch.
   */
  options: { readonly liveTurnPatches: boolean },
): ComparePlan {
  const { fileDiff } = row;
  if (fileDiff.mode === SUBMODULE_MODE || fileDiff.prevMode === SUBMODULE_MODE) {
    return { kind: "notice", notice: { kind: "submodule" } };
  }
  if (fileDiff.type === "rename-pure") {
    return {
      kind: "notice",
      notice: { kind: "renamed", previousPath: row.previousPath ?? row.path },
    };
  }
  // An added or deleted file with no hunks is binary, unless that side is the empty file, which
  // Git also prints without hunks.
  if (
    (fileDiff.type === "new" || fileDiff.type === "deleted") &&
    fileDiff.hunks.length === 0 &&
    !isEmptyBlobId(fileDiff.type === "new" ? fileDiff.newObjectId : fileDiff.prevObjectId)
  ) {
    return { kind: "notice", notice: { kind: "binary" } };
  }
  if (fileDiff.type === "new") return { kind: "patch", reason: "added" };
  if (fileDiff.type === "deleted") return { kind: "patch", reason: "deleted" };
  if (fileDiff.hunks.length === 0) {
    return fileDiff.prevMode !== undefined &&
      fileDiff.mode !== undefined &&
      fileDiff.prevMode !== fileDiff.mode
      ? {
          kind: "notice",
          notice: { kind: "mode-changed", from: fileDiff.prevMode, to: fileDiff.mode },
        }
      : { kind: "notice", notice: { kind: "binary" } };
  }
  if (!isFullObjectId(fileDiff.prevObjectId) || !isFullObjectId(fileDiff.newObjectId)) {
    return {
      kind: "patch",
      reason: scope === "turn" && options.liveTurnPatches ? "legacy-turn" : "abbreviated-ids",
    };
  }
  return {
    kind: "versions",
    old: { _tag: "blob", oid: fileDiff.prevObjectId },
    new:
      scope === "working-tree"
        ? { _tag: "worktree", path: row.path, expectedOid: fileDiff.newObjectId }
        : { _tag: "blob", oid: fileDiff.newObjectId },
  };
}

export type CompareVersionsState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly old: string; readonly new: string }
  | {
      readonly kind: "unavailable";
      readonly side: "old" | "new";
      readonly reason: ReviewFileVersionUnavailableReason;
      readonly byteLength: number | null;
    };

/** Both reads together: loading until each has a result, then both texts or the first gap. */
export function resolveCompareVersions(
  oldVersion: ReviewReadFileVersionResult | null,
  newVersion: ReviewReadFileVersionResult | null,
): CompareVersionsState {
  for (const [side, version] of [
    ["old", oldVersion],
    ["new", newVersion],
  ] as const) {
    if (version?._tag === "unavailable") {
      return { kind: "unavailable", side, reason: version.reason, byteLength: version.byteLength };
    }
  }
  if (oldVersion?._tag === "text" && newVersion?._tag === "text") {
    return { kind: "ready", old: oldVersion.contents, new: newVersion.contents };
  }
  return { kind: "loading" };
}

/** Decimal megabytes, as the patch cap is described: 4,375,000 bytes is "4.4 MB". */
export function formatByteSize(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * The note shown above Git's hunks when the full file is not shown. `changed` is not here:
 * the view revalidates the patch first, and says the file is changing only if it still is.
 */
export function describeUnavailableVersion(
  state: Extract<CompareVersionsState, { kind: "unavailable" }>,
): string {
  switch (state.reason) {
    case "too-large":
      return state.byteLength === null
        ? "Too large to show in full. Showing changed lines."
        : `Too large to show in full (${formatByteSize(state.byteLength)}). Showing changed lines.`;
    case "missing":
      return state.side === "old"
        ? "The full previous version is no longer in the repository."
        : "The full current version is no longer available.";
    case "binary":
      return "Showing changed lines. A full version of this file is binary.";
    case "not-a-file":
      return "Showing changed lines. One version of this path is not a regular file.";
    case "changed":
      return "This file is changing.";
  }
}

export function describePatchOnlyReason(reason: ComparePatchOnlyReason): string | null {
  switch (reason) {
    case "added":
      return null;
    case "deleted":
      return "Deleted";
    case "abbreviated-ids":
      return "Full files need a newer server.";
    case "legacy-turn":
      return "Saved before full files were kept. Showing changed lines.";
  }
}

export function describeCompareNotice(notice: CompareNotice): string {
  switch (notice.kind) {
    case "renamed":
      return `Renamed from ${notice.previousPath}. Contents unchanged.`;
    case "mode-changed":
      return `File mode changed from ${notice.from} to ${notice.to}.`;
    case "binary":
      return "Binary file. Use Open with to compare it in a diff app.";
    case "submodule":
      return "Submodule. Open it as its own project to compare.";
  }
}

export type CompareHydration =
  | { readonly kind: "hydrated"; readonly fileDiff: FileDiffMetadata }
  /** The full files do not reproduce Git's hunks: a text conversion or a filter changed them. */
  | { readonly kind: "mismatch" };

function comparableLine(line: string | undefined): string | undefined {
  if (line === undefined) return undefined;
  let end = line.length;
  if (line.endsWith("\n")) end -= 1;
  if (end > 0 && line[end - 1] === "\r") end -= 1;
  return line.slice(0, end);
}

function linesMatch(
  partial: ReadonlyArray<string>,
  partialStart: number,
  hydrated: ReadonlyArray<string>,
  hydratedStart: number,
  count: number,
): boolean {
  for (let offset = 0; offset < count; offset += 1) {
    if (
      comparableLine(partial[partialStart + offset]) !==
      comparableLine(hydrated[hydratedStart + offset])
    ) {
      return false;
    }
  }
  return true;
}

function changeBlocks(hunk: Hunk): ChangeContent[] {
  return hunk.hunkContent.filter((content): content is ChangeContent => content.type === "change");
}

/**
 * Whether every added and deleted line of every hunk reads the same in the full files.
 * Git's textconv drivers and filters such as Git LFS rewrite a file's diff, and a hydrated
 * view of such a file would place Git's hunks over the wrong text. A trailing `\r` is
 * ignored, so a CRLF checkout still matches.
 */
export function hydrationMatchesPatch(
  partial: FileDiffMetadata,
  hydrated: FileDiffMetadata,
): boolean {
  if (partial.hunks.length !== hydrated.hunks.length) return false;
  for (let index = 0; index < partial.hunks.length; index += 1) {
    const partialBlocks = changeBlocks(partial.hunks[index]!);
    const hydratedBlocks = changeBlocks(hydrated.hunks[index]!);
    if (partialBlocks.length !== hydratedBlocks.length) return false;
    for (let block = 0; block < partialBlocks.length; block += 1) {
      const before = partialBlocks[block]!;
      const after = hydratedBlocks[block]!;
      if (
        !linesMatch(
          partial.deletionLines,
          before.deletionLineIndex,
          hydrated.deletionLines,
          after.deletionLineIndex,
          before.deletions,
        ) ||
        !linesMatch(
          partial.additionLines,
          before.additionLineIndex,
          hydrated.additionLines,
          after.additionLineIndex,
          before.additions,
        )
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Fills Git's hunks with both full files. The patch's metadata is shared with Changes, so it
 * is cloned, never hydrated in place.
 */
export function hydrateCompareFile(
  fileDiff: FileDiffMetadata,
  oldContents: string,
  newContents: string,
): CompareHydration {
  if (!fileDiff.isPartial || (fileDiff.type !== "change" && fileDiff.type !== "rename-changed")) {
    return { kind: "mismatch" };
  }
  let hydrated: FileDiffMetadata;
  try {
    hydrated = hydratePartialDiff("clone", fileDiff, {
      oldFile: { name: stripPrefix(fileDiff.prevName ?? fileDiff.name), contents: oldContents },
      newFile: { name: stripPrefix(fileDiff.name), contents: newContents },
    });
  } catch {
    return { kind: "mismatch" };
  }
  return hydrationMatchesPatch(fileDiff, hydrated)
    ? { kind: "hydrated", fileDiff: hydrated }
    : { kind: "mismatch" };
}

export interface DiffChangeTarget {
  readonly lineNumber: number;
  readonly side: "additions" | "deletions";
}

/** The first line of each block of changes, in order: where Next and Previous change go. */
export function listChangeTargets(fileDiff: FileDiffMetadata): DiffChangeTarget[] {
  const targets: DiffChangeTarget[] = [];
  for (const hunk of fileDiff.hunks) {
    let additionLine = hunk.additionStart;
    let deletionLine = hunk.deletionStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        additionLine += content.lines;
        deletionLine += content.lines;
        continue;
      }
      targets.push(
        content.additions > 0
          ? { lineNumber: additionLine, side: "additions" }
          : { lineNumber: deletionLine, side: "deletions" },
      );
      additionLine += content.additions;
      deletionLine += content.deletions;
    }
  }
  return targets;
}

/**
 * The row to select after the patch is rebuilt: the same path when it is still visible,
 * otherwise the first visible row.
 */
export function reconcileSelectedRow(
  rows: ReadonlyArray<DiffFileRow>,
  selectedPath: string | null,
): DiffFileRow | null {
  return rows.find((row) => row.path === selectedPath) ?? rows[0] ?? null;
}
