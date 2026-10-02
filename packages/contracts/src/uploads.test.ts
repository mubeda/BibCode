import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { UploadAppendInput, UploadBeginInput, UploadCancelResult, UploadError } from "./uploads.ts";

describe("staged chat upload contracts", () => {
  it("validates target, digest and declared size", () => {
    const input = {
      target: { _tag: "chat-attachment", type: "file", name: "a.txt", mimeType: "text/plain" },
      sizeBytes: 3,
      sha256: "a".repeat(64),
    };
    expect(Schema.decodeUnknownSync(UploadBeginInput)(input)).toEqual(input);
    for (const sha256 of ["A".repeat(64), "a".repeat(63)]) {
      expect(Schema.is(UploadBeginInput)({ ...input, sha256 })).toBe(false);
    }
    expect(Schema.is(UploadBeginInput)({ ...input, sizeBytes: -1 })).toBe(false);
    expect(
      Schema.is(UploadBeginInput)({
        ...input,
        target: { ...input.target, _tag: "workspace-file" },
      }),
    ).toBe(false);
  });

  it("accepts empty chunks and limits encoded bytes and offsets", () => {
    const input = { uploadId: "u-1", offset: 0, data: "" };
    expect(Schema.decodeUnknownSync(UploadAppendInput)(input)).toEqual(input);
    expect(Schema.is(UploadAppendInput)({ ...input, data: "A".repeat(1_398_104) })).toBe(true);
    expect(Schema.is(UploadAppendInput)({ ...input, data: "A".repeat(1_398_105) })).toBe(false);
    for (const offset of [-1, 0.5]) {
      expect(Schema.is(UploadAppendInput)({ ...input, offset })).toBe(false);
    }
  });

  it("decodes offset recovery and an idempotent cancel result", () => {
    expect(
      Schema.decodeUnknownSync(UploadError)({
        _tag: "UploadError",
        reason: "offset",
        message: "Upload offset changed.",
        receivedBytes: 65536,
      }).receivedBytes,
    ).toBe(65536);
    expect(Schema.decodeUnknownSync(UploadCancelResult)({})).toEqual({});
  });
});
