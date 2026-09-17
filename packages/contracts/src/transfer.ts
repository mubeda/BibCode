import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PROJECT_ENTRY_PATH_MAX_LENGTH } from "./project.ts";

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
