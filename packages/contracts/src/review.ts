import * as Schema from "effect/Schema";
import { DiffContextLines, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";
import { VcsError } from "./vcs.ts";

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  /** `-U<N>` for every source; omitted, Git's own default applies. */
  contextLines: Schema.optionalKey(DiffContextLines),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewDiffPreviewSourceKind = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
  /** The `contextLines` Git applied. An older server omits it, having ignored the request. */
  contextLines: Schema.optionalKey(DiffContextLines),
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffPreviewSource),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;

/** A full Git object ID: lowercase hex, 40 digits (SHA-1) or 64 (SHA-256). */
export const GitObjectId = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/));
export type GitObjectId = typeof GitObjectId.Type;

/**
 * One side of a changed file: a blob by its object ID, or the working-tree file whose current
 * content the patch named as `expectedOid`.
 */
export const ReviewFileVersionRequest = Schema.Union([
  Schema.TaggedStruct("blob", { oid: GitObjectId }),
  Schema.TaggedStruct("worktree", {
    path: TrimmedNonEmptyString,
    expectedOid: GitObjectId,
  }),
]);
export type ReviewFileVersionRequest = typeof ReviewFileVersionRequest.Type;

export const ReviewReadFileVersionInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  version: ReviewFileVersionRequest,
});
export type ReviewReadFileVersionInput = typeof ReviewReadFileVersionInput.Type;

/** Why a version has no text: `changed` means the working-tree file moved past the patch. */
export const ReviewFileVersionUnavailableReason = Schema.Literals([
  "missing",
  "binary",
  "too-large",
  "not-a-file",
  "changed",
]);
export type ReviewFileVersionUnavailableReason = typeof ReviewFileVersionUnavailableReason.Type;

export const ReviewReadFileVersionResult = Schema.Union([
  Schema.TaggedStruct("text", { contents: Schema.String, byteLength: NonNegativeInt }),
  Schema.TaggedStruct("unavailable", {
    reason: ReviewFileVersionUnavailableReason,
    byteLength: Schema.NullOr(NonNegativeInt),
  }),
]);
export type ReviewReadFileVersionResult = typeof ReviewReadFileVersionResult.Type;

/** A tool name Git accepts as `--tool=<id>`: never an option, a path or shell. */
export const ReviewDiffToolId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
);
export type ReviewDiffToolId = typeof ReviewDiffToolId.Type;

export const ReviewListDiffToolsInput = Schema.Struct({ cwd: TrimmedNonEmptyString });
export type ReviewListDiffToolsInput = typeof ReviewListDiffToolsInput.Type;

/** `builtin`: one of Git's own tools found here; `custom`: a `difftool.<tool>.cmd`. */
export const ReviewDiffToolKind = Schema.Literals(["builtin", "custom"]);
export type ReviewDiffToolKind = typeof ReviewDiffToolKind.Type;

export const ReviewDiffTool = Schema.Struct({
  id: ReviewDiffToolId,
  label: Schema.String,
  kind: ReviewDiffToolKind,
});
export type ReviewDiffTool = typeof ReviewDiffTool.Type;

/** The Git config key the default came from, in Git's own `--gui` order. */
export const ReviewDiffToolDefaultSource = Schema.Literals([
  "diff.guitool",
  "merge.guitool",
  "diff.tool",
  "merge.tool",
]);
export type ReviewDiffToolDefaultSource = typeof ReviewDiffToolDefaultSource.Type;

/** The diff apps `git difftool --tool-help` finds on the server's computer. */
export const ReviewListDiffToolsResult = Schema.Struct({
  tools: Schema.Array(ReviewDiffTool),
  defaultToolId: Schema.NullOr(ReviewDiffToolId),
  defaultSource: Schema.NullOr(ReviewDiffToolDefaultSource),
});
export type ReviewListDiffToolsResult = typeof ReviewListDiffToolsResult.Type;

/** One file (with its old path for a rename), or every file of the scope with `--dir-diff`. */
export const ReviewDiffToolTarget = Schema.Union([
  Schema.TaggedStruct("file", {
    path: TrimmedNonEmptyString,
    previousPath: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.TaggedStruct("all", {}),
]);
export type ReviewDiffToolTarget = typeof ReviewDiffToolTarget.Type;

/** The scope whose revisions the server resolves; the client never names a ref for a turn. */
export const ReviewDiffToolScope = Schema.Union([
  Schema.TaggedStruct("working-tree", {}),
  Schema.TaggedStruct("branch", { baseRef: Schema.NullOr(TrimmedNonEmptyString) }),
  Schema.TaggedStruct("turn", {
    threadId: TrimmedNonEmptyString,
    fromTurnCount: NonNegativeInt,
    toTurnCount: NonNegativeInt,
  }).check(
    Schema.makeFilter((scope) => scope.fromTurnCount <= scope.toTurnCount, {
      expected: "fromTurnCount less than or equal to toTurnCount",
    }),
  ),
]);
export type ReviewDiffToolScope = typeof ReviewDiffToolScope.Type;

export const ReviewOpenDiffToolInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  toolId: ReviewDiffToolId,
  target: ReviewDiffToolTarget,
  scope: ReviewDiffToolScope,
});
export type ReviewOpenDiffToolInput = typeof ReviewOpenDiffToolInput.Type;

export const ReviewOpenDiffToolResult = Schema.TaggedStruct("opened", {});
export type ReviewOpenDiffToolResult = typeof ReviewOpenDiffToolResult.Type;

export const ReviewDiffToolFailureReason = Schema.Literals([
  "launch-failed",
  "too-many-open",
  "shutting-down",
  "invalid-request",
]);
export type ReviewDiffToolFailureReason = typeof ReviewDiffToolFailureReason.Type;

/** A diff app that did not open, with the `git difftool` command for **Copy command**. */
export class ReviewDiffToolError extends Schema.TaggedError<ReviewDiffToolError>()(
  "ReviewDiffToolError",
  {
    reason: ReviewDiffToolFailureReason,
    message: Schema.String,
    command: Schema.Array(Schema.String),
  },
) {}
