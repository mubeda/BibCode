import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ProjectCreateDownloadUrlInput,
  ProjectCreateDownloadUrlResult,
  ProjectCreateUploadUrlInput,
  ProjectCreateUploadUrlResult,
  ProjectTransferError,
  ProjectFileVersion,
  ProjectReadDownloadInput,
  ProjectDownloadEvent,
  ProjectDownloadError,
} from "./transfer.ts";
import { WS_METHODS } from "./rpc.ts";

const decodeDownloadInput = Schema.decodeUnknownSync(ProjectCreateDownloadUrlInput);
const decodeDownloadResult = Schema.decodeUnknownSync(ProjectCreateDownloadUrlResult);
const decodeUploadInput = Schema.decodeUnknownSync(ProjectCreateUploadUrlInput);
const decodeUploadResult = Schema.decodeUnknownSync(ProjectCreateUploadUrlResult);
const decodeFileVersion = Schema.decodeUnknownSync(ProjectFileVersion);
const isFileVersion = Schema.is(ProjectFileVersion);
const decodeReadDownloadInput = Schema.decodeUnknownSync(ProjectReadDownloadInput);
const isReadDownloadInput = Schema.is(ProjectReadDownloadInput);
const decodeDownloadEvent = Schema.decodeUnknownSync(ProjectDownloadEvent);
const isDownloadEvent = Schema.is(ProjectDownloadEvent);
const decodeDownloadError = Schema.decodeUnknownSync(ProjectDownloadError);

describe("transfer contracts", () => {
  it("validates resumable downloads and their bounded stream events", () => {
    const version = { sizeBytes: 6, modifiedAtNs: "-1234567890123456789" };
    expect(decodeFileVersion(version)).toEqual(version);
    expect(isFileVersion({ ...version, modifiedAtNs: "1.1" })).toBe(false);
    expect(
      decodeReadDownloadInput({
        cwd: "/repo",
        relativePath: "a",
        offset: 3,
        expect: version,
      }).offset,
    ).toBe(3);
    expect(isReadDownloadInput({ cwd: "/repo", relativePath: "a", offset: -1 })).toBe(false);
    for (const event of [
      { _tag: "start", fileName: "a", kind: "file", sizeBytes: 6, version },
      { _tag: "start", fileName: "src.zip", kind: "archive", sizeBytes: null, version: null },
      { _tag: "bytes", offset: 3, data: "ZGVm" },
      { _tag: "end", totalBytes: 6 },
    ])
      expect(decodeDownloadEvent(event)).toEqual(event);
    expect(isDownloadEvent({ _tag: "bytes", offset: 0, data: "A".repeat(1_398_105) })).toBe(false);
    for (const reason of ["changed", "capacity", "not_resumable"] as const) {
      expect(
        decodeDownloadError({
          _tag: "ProjectDownloadError",
          reason,
          message: "Download refused.",
        }).reason,
      ).toBe(reason);
    }
    expect(WS_METHODS.projectsReadDownload).toBe("projects.readDownload");
  });
  it("registers both methods", () => {
    expect(WS_METHODS.projectsCreateDownloadUrl).toBe("projects.createDownloadUrl");
    expect(WS_METHODS.projectsCreateUploadUrl).toBe("projects.createUploadUrl");
  });

  it("decodes download input and result", () => {
    expect(decodeDownloadInput({ cwd: "/repo", relativePath: "src" })).toEqual({
      cwd: "/repo",
      relativePath: "src",
    });
    expect(
      decodeDownloadResult({
        relativeUrl: "/api/transfers/abc.def",
        expiresAt: 1_700_000_000_000,
        fileName: "src.zip",
        kind: "archive",
      }).kind,
    ).toBe("archive");
    expect(() => decodeDownloadInput({ cwd: "/repo", relativePath: "" })).toThrow();
  });

  it("allows an empty upload directory for the workspace root", () => {
    expect(
      decodeUploadInput({ cwd: "/repo", relativeDirectory: "", fileName: "a.txt" })
        .relativeDirectory,
    ).toBe("");
    expect(
      decodeUploadResult({ relativeUrl: "/api/transfers/x.y", expiresAt: 1, maxBytes: 1024 })
        .maxBytes,
    ).toBe(1024);
  });

  it("requires the upload token to name one file", () => {
    // The token authorises exactly this name, so an absent or over-long name is refused before a
    // URL is ever minted.
    expect(() => decodeUploadInput({ cwd: "/repo", relativeDirectory: "" })).toThrow();
    expect(() =>
      decodeUploadInput({ cwd: "/repo", relativeDirectory: "", fileName: "" }),
    ).toThrow();
    expect(() =>
      decodeUploadInput({ cwd: "/repo", relativeDirectory: "", fileName: "x".repeat(256) }),
    ).toThrow();
  });

  it("encodes the transfer error", () => {
    const error = new ProjectTransferError({
      cwd: "/repo",
      relativePath: "missing",
      failure: "not_found",
      message: "Entry was not found.",
    });
    expect(error._tag).toBe("ProjectTransferError");
  });
});
