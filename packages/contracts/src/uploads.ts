import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const UploadId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type UploadId = typeof UploadId.Type;
export const UploadSha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
export const UploadData = Schema.String.check(Schema.isMaxLength(1_398_104));
export const UploadTarget = Schema.Union([
  Schema.TaggedStruct("chat-attachment", {
    type: Schema.Literals(["image", "file"]),
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
    mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  }),
]);
export type UploadTarget = typeof UploadTarget.Type;

export const UploadBeginInput = Schema.Struct({
  target: UploadTarget,
  sizeBytes: NonNegativeInt,
  sha256: Schema.optional(UploadSha256),
});
export type UploadBeginInput = typeof UploadBeginInput.Type;
export const UploadBeginResult = Schema.Struct({ uploadId: UploadId, exists: Schema.Boolean });
export type UploadBeginResult = typeof UploadBeginResult.Type;
export const UploadAppendInput = Schema.Struct({
  uploadId: UploadId,
  offset: NonNegativeInt,
  data: UploadData,
  sha256: Schema.optional(UploadSha256),
});
export type UploadAppendInput = typeof UploadAppendInput.Type;
export const UploadAppendResult = Schema.Struct({ receivedBytes: NonNegativeInt });
export type UploadAppendResult = typeof UploadAppendResult.Type;
export const UploadGetInput = Schema.Struct({ uploadId: UploadId });
export type UploadGetInput = typeof UploadGetInput.Type;
export const UploadGetResult = Schema.Struct({
  uploadId: UploadId,
  sizeBytes: NonNegativeInt,
  receivedBytes: NonNegativeInt,
  complete: Schema.Boolean,
});
export type UploadGetResult = typeof UploadGetResult.Type;
export const UploadCancelInput = Schema.Struct({ uploadId: UploadId });
export type UploadCancelInput = typeof UploadCancelInput.Type;
export const UploadCancelResult = Schema.Struct({});
export type UploadCancelResult = typeof UploadCancelResult.Type;

export class UploadError extends Schema.TaggedError<UploadError>()("UploadError", {
  reason: Schema.Literals(["quota", "not_found", "offset", "digest", "size", "invalid"]),
  message: TrimmedNonEmptyString,
  receivedBytes: Schema.optional(NonNegativeInt),
}) {}
