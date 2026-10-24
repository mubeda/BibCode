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
