import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ProjectCreateDownloadUrlInput,
  ProjectCreateDownloadUrlResult,
  ProjectCreateUploadUrlInput,
  ProjectCreateUploadUrlResult,
  ProjectTransferError,
} from "./transfer.ts";
import { WS_METHODS } from "./rpc.ts";

const decodeDownloadInput = Schema.decodeUnknownSync(ProjectCreateDownloadUrlInput);
const decodeDownloadResult = Schema.decodeUnknownSync(ProjectCreateDownloadUrlResult);
const decodeUploadInput = Schema.decodeUnknownSync(ProjectCreateUploadUrlInput);
const decodeUploadResult = Schema.decodeUnknownSync(ProjectCreateUploadUrlResult);

describe("transfer contracts", () => {
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
