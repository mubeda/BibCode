import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PROJECT_ENTRY_PATH_MAX_LENGTH } from "./project.ts";
import { UploadData } from "./uploads.ts";

export const ProjectFileVersion = Schema.Struct({
  sizeBytes: NonNegativeInt,
  modifiedAtNs: Schema.String.check(Schema.isPattern(/^-?[0-9]+$/)),
});
export type ProjectFileVersion = typeof ProjectFileVersion.Type;
export const ProjectReadDownloadInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_ENTRY_PATH_MAX_LENGTH)),
  offset: Schema.optional(NonNegativeInt),
  expect: Schema.optional(ProjectFileVersion),
});
export type ProjectReadDownloadInput = typeof ProjectReadDownloadInput.Type;
export const ProjectDownloadEvent = Schema.Union([
  Schema.TaggedStruct("start", {
    fileName: TrimmedNonEmptyString,
    kind: Schema.Literals(["file", "archive"]),
    sizeBytes: Schema.NullOr(NonNegativeInt),
    version: Schema.NullOr(ProjectFileVersion),
  }),
  Schema.TaggedStruct("bytes", { offset: NonNegativeInt, data: UploadData }),
  Schema.TaggedStruct("end", { totalBytes: NonNegativeInt }),
]);
export type ProjectDownloadEvent = typeof ProjectDownloadEvent.Type;
export class ProjectDownloadError extends Schema.TaggedError<ProjectDownloadError>()(
  "ProjectDownloadError",
  {
    reason: Schema.Literals(["changed", "capacity", "not_resumable"]),
    message: TrimmedNonEmptyString,
  },
) {}

export const ProjectCreateDownloadUrlInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_ENTRY_PATH_MAX_LENGTH)),
});
export type ProjectCreateDownloadUrlInput = typeof ProjectCreateDownloadUrlInput.Type;

export const ProjectCreateDownloadUrlResult = Schema.Struct({
  relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  expiresAt: Schema.Finite,
  fileName: TrimmedNonEmptyString,
  kind: Schema.Literals(["file", "archive"]),
});
export type ProjectCreateDownloadUrlResult = typeof ProjectCreateDownloadUrlResult.Type;

export const ProjectCreateUploadUrlInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  // "" (empty string) targets the workspace root.
  relativeDirectory: Schema.String.check(Schema.isMaxLength(PROJECT_ENTRY_PATH_MAX_LENGTH)),
  // The one file the minted token authorises. The upload route takes the name from the token, so a
  // leaked URL can only write this file in this directory.
  fileName: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
});
export type ProjectCreateUploadUrlInput = typeof ProjectCreateUploadUrlInput.Type;

export const ProjectCreateUploadUrlResult = Schema.Struct({
  relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  expiresAt: Schema.Finite,
  maxBytes: Schema.Finite,
});
export type ProjectCreateUploadUrlResult = typeof ProjectCreateUploadUrlResult.Type;

export class ProjectTransferError extends Schema.TaggedError<ProjectTransferError>()(
  "ProjectTransferError",
  {
    cwd: TrimmedNonEmptyString,
    relativePath: Schema.String,
    failure: Schema.Literals(["not_found", "outside_root", "not_configured", "operation_failed"]),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
