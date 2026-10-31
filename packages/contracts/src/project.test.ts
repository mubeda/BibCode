import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ProjectCreateEntryError,
  ProjectDeleteEntryError,
  ProjectDeleteEntryInput,
  ProjectDuplicateEntryError,
  ProjectFileVersion,
  ProjectListEntriesInput,
  ProjectListEntriesError,
  ProjectReadFileError,
  ProjectReadFileResult,
  ProjectRenameEntryError,
  ProjectSearchEntriesError,
  ProjectWriteFileError,
  ProjectWriteFileIfUnchangedInput,
} from "./project.ts";

const withDecodedMessage = <T extends object>(props: T, message: unknown): T =>
  Object.assign({}, props, { message }) as T;
const decodeListEntriesInput = Schema.decodeUnknownSync(ProjectListEntriesInput);
const decodeListError = Schema.decodeUnknownSync(ProjectListEntriesError);
const decodeCreateError = Schema.decodeUnknownSync(ProjectCreateEntryError);
const decodeRenameError = Schema.decodeUnknownSync(ProjectRenameEntryError);
const decodeDeleteError = Schema.decodeUnknownSync(ProjectDeleteEntryError);
const decodeDeleteInput = Schema.decodeUnknownSync(ProjectDeleteEntryInput);
const decodeDuplicateError = Schema.decodeUnknownSync(ProjectDuplicateEntryError);
const decodeSearchError = Schema.decodeUnknownSync(ProjectSearchEntriesError);
const decodeWriteError = Schema.decodeUnknownSync(ProjectWriteFileError);
const decodeReadResult = Schema.decodeUnknownSync(ProjectReadFileResult);
const decodeFileVersion = Schema.decodeUnknownSync(ProjectFileVersion);
const decodeGuardedWrite = Schema.decodeUnknownSync(ProjectWriteFileIfUnchangedInput);

describe("open-file disk versions", () => {
  const read = { relativePath: "a.ts", contents: "a", byteLength: 1, truncated: false };

  it("decodes a read result from a server without versions, and one with", () => {
    expect(decodeReadResult(read)).not.toHaveProperty("version");
    expect(decodeReadResult({ ...read, version: "ab12" })).toEqual({ ...read, version: "ab12" });
  });

  it("decodes each disk state", () => {
    expect(decodeFileVersion({ _tag: "present", version: "ab12" })).toEqual({
      _tag: "present",
      version: "ab12",
    });
    expect(decodeFileVersion({ _tag: "missing" })).toEqual({ _tag: "missing" });
    expect(
      decodeFileVersion({ _tag: "unreadable", failure: "file_too_large", version: "ab12" }),
    ).toEqual({ _tag: "unreadable", failure: "file_too_large", version: "ab12" });
    expect(() =>
      decodeFileVersion({ _tag: "unreadable", failure: "x", version: "ab12" }),
    ).toThrow();
  });

  it("requires a guarded write to name the disk state it was based on", () => {
    const write = { cwd: "/workspace", relativePath: "a.ts", contents: "b" };
    expect(() => decodeGuardedWrite(write)).toThrow();
    expect(decodeGuardedWrite({ ...write, precondition: { _tag: "missing" } })).toEqual({
      ...write,
      precondition: { _tag: "missing" },
    });
    expect(
      decodeGuardedWrite({ ...write, precondition: { _tag: "version", version: "ab12" } }),
    ).toEqual({ ...write, precondition: { _tag: "version", version: "ab12" } });
  });

  it("carries the two refusal failures on a write error", () => {
    for (const failure of ["file_changed_on_disk", "file_missing_on_disk"] as const) {
      expect(
        decodeWriteError({
          _tag: "ProjectWriteFileError",
          cwd: "/workspace",
          relativePath: "a.ts",
          failure,
          message: "refused",
        }).failure,
      ).toBe(failure);
    }
  });
});

describe("project RPC inputs", () => {
  it("accepts an omitted list limit and positive limits through 200", () => {
    expect(decodeListEntriesInput({ cwd: "/workspace" })).toEqual({
      cwd: "/workspace",
    });
    expect(decodeListEntriesInput({ cwd: "/workspace", limit: 1 })).toEqual({
      cwd: "/workspace",
      limit: 1,
    });
    expect(decodeListEntriesInput({ cwd: "/workspace", limit: 200 })).toEqual({
      cwd: "/workspace",
      limit: 200,
    });
  });

  it.each([0, -1, 1.5, 201])("rejects the invalid list limit %s", (limit) => {
    expect(() => decodeListEntriesInput({ cwd: "/workspace", limit })).toThrow();
  });

  it("accepts an omitted refresh opt-in and both explicit refresh values", () => {
    expect(decodeListEntriesInput({ cwd: "/workspace" })).not.toHaveProperty("refresh");
    expect(decodeListEntriesInput({ cwd: "/workspace", refresh: true })).toEqual({
      cwd: "/workspace",
      refresh: true,
    });
    expect(decodeListEntriesInput({ cwd: "/workspace", refresh: false })).toEqual({
      cwd: "/workspace",
      refresh: false,
    });
    expect(decodeListEntriesInput({ cwd: "/workspace", limit: 50, refresh: true })).toEqual({
      cwd: "/workspace",
      limit: 50,
      refresh: true,
    });
  });

  it.each(["true", 1, null])("rejects the invalid refresh value %s", (refresh) => {
    expect(() => decodeListEntriesInput({ cwd: "/workspace", refresh })).toThrow();
  });

  it("deletes permanently unless a delete asks for the trash", () => {
    expect(decodeDeleteInput({ cwd: "/workspace", relativePath: "a.txt" })).not.toHaveProperty(
      "toTrash",
    );
    expect(
      decodeDeleteInput({ cwd: "/workspace", relativePath: "a.txt", toTrash: true }).toTrash,
    ).toBe(true);
    expect(() =>
      decodeDeleteInput({ cwd: "/workspace", relativePath: "a.txt", toTrash: "yes" }),
    ).toThrow();
  });

  it("names a trash that could not take an entry", () => {
    expect(
      decodeDeleteError({
        _tag: "ProjectDeleteEntryError",
        cwd: "/workspace",
        relativePath: "a.txt",
        failure: "trash_unavailable",
        message: "The system trash could not take it; it was left in place.",
      }).failure,
    ).toBe("trash_unavailable");
  });
});

describe("project RPC errors", () => {
  it("derives stable messages from structured request context while retaining causes", () => {
    const cause = new Error("sensitive platform detail");
    const searchError = new ProjectSearchEntriesError({
      cwd: "/workspace",
      queryLength: "authorization: Bearer secret-token".length,
      limit: 20,
      failure: "search_index_search_failed",
      normalizedCwd: "/workspace",
      detail: "index unavailable",
      cause,
    });
    const readError = new ProjectReadFileError({
      cwd: "/workspace",
      relativePath: "src/index.ts",
      failure: "operation_failed",
      operation: "read",
      operationPath: "/workspace/src/index.ts",
      resolvedPath: "/workspace/src/index.ts",
      cause,
    });

    expect(searchError.message).toBe("Failed to search workspace entries in '/workspace'.");
    expect(searchError.message).not.toContain(cause.message);
    expect(searchError.normalizedCwd).toBe("/workspace");
    expect(searchError.queryLength).toBe("authorization: Bearer secret-token".length);
    expect(searchError).not.toHaveProperty("query");
    expect(searchError.message).not.toMatch(/Bearer|secret-token/);
    expect(searchError.cause).toBe(cause);
    expect(readError.message).toBe("Failed to read workspace file 'src/index.ts' in '/workspace'.");
    expect(readError.message).not.toContain(cause.message);
    expect(readError.cause).toBe(cause);
  });

  it("decodes legacy message-only errors during rolling upgrades", () => {
    const searchError = decodeSearchError({
      _tag: "ProjectSearchEntriesError",
      message: "Legacy project search failure.",
      query: "legacy sensitive query",
    });
    const writeError = decodeWriteError({
      _tag: "ProjectWriteFileError",
      message: "Legacy project write failure.",
    });

    expect(searchError.message).toBe("Legacy project search failure.");
    expect(searchError.cwd).toBeUndefined();
    expect(searchError.queryLength).toBeUndefined();
    expect(searchError).not.toHaveProperty("query");
    expect(searchError.failure).toBeUndefined();
    expect(writeError.message).toBe("Legacy project write failure.");
    expect(writeError.relativePath).toBeUndefined();
    expect(writeError.failure).toBeUndefined();
  });

  it("derives operation-specific messages for every project entry failure", () => {
    const listError = new ProjectListEntriesError({
      cwd: "/workspace",
      failure: "search_index_scan_timed_out",
    });
    const writeError = new ProjectWriteFileError({
      cwd: "/workspace",
      relativePath: "src/new.ts",
      failure: "operation_failed",
    });
    const createError = new ProjectCreateEntryError({
      cwd: "/workspace",
      relativePath: "src/new.ts",
      failure: "operation_failed",
    });
    const renameError = new ProjectRenameEntryError({
      cwd: "/workspace",
      relativePath: "src/old.ts",
      failure: "operation_failed",
    });
    const deleteError = new ProjectDeleteEntryError({
      cwd: "/workspace",
      relativePath: "src/old.ts",
      failure: "operation_failed",
    });
    const duplicateError = new ProjectDuplicateEntryError({
      cwd: "/workspace",
      relativePath: "src/source.ts",
      failure: "operation_failed",
    });

    expect(listError.message).toBe("Failed to list workspace entries in '/workspace'.");
    expect(writeError.message).toBe("Failed to write workspace file 'src/new.ts' in '/workspace'.");
    expect(createError.message).toBe(
      "Failed to create workspace entry 'src/new.ts' in '/workspace'.",
    );
    expect(renameError.message).toBe(
      "Failed to rename workspace entry 'src/old.ts' in '/workspace'.",
    );
    expect(deleteError.message).toBe(
      "Failed to delete workspace entry 'src/old.ts' in '/workspace'.",
    );
    expect(duplicateError.message).toBe(
      "Failed to duplicate workspace file 'src/source.ts' in '/workspace'.",
    );
  });

  it("preserves custom messages and structured fields while decoding entry errors", () => {
    const listError = decodeListError({
      _tag: "ProjectListEntriesError",
      cwd: "/workspace",
      failure: "search_index_search_failed",
      normalizedCwd: "/workspace",
      timeout: "5s",
      detail: "index unavailable",
      message: "Stored list failure.",
    });
    const createError = decodeCreateError({
      _tag: "ProjectCreateEntryError",
      cwd: "/workspace",
      relativePath: "src",
      failure: "operation_failed",
      resolvedPath: "/workspace/src",
      resolvedWorkspaceRoot: "/workspace",
      operation: "make-directory",
      operationPath: "/workspace/src",
      message: "Stored create failure.",
    });
    const renameError = decodeRenameError({
      _tag: "ProjectRenameEntryError",
      cwd: "/workspace",
      relativePath: "old",
      failure: "operation_failed",
      resolvedPath: "/workspace/old",
      resolvedWorkspaceRoot: "/workspace",
      operation: "rename",
      operationPath: "/workspace/old",
      message: "Stored rename failure.",
    });
    const deleteError = decodeDeleteError({
      _tag: "ProjectDeleteEntryError",
      cwd: "/workspace",
      relativePath: "old",
      failure: "operation_failed",
      resolvedPath: "/workspace/old",
      resolvedWorkspaceRoot: "/workspace",
      operation: "remove",
      operationPath: "/workspace/old",
      message: "Stored delete failure.",
    });
    const duplicateError = decodeDuplicateError({
      _tag: "ProjectDuplicateEntryError",
      cwd: "/workspace",
      relativePath: "source",
      failure: "operation_failed",
      resolvedPath: "/workspace/source",
      resolvedWorkspaceRoot: "/workspace",
      operation: "copy-file",
      operationPath: "/workspace/source",
      message: "Stored duplicate failure.",
    });

    expect(listError).toMatchObject({
      message: "Stored list failure.",
      cwd: "/workspace",
      failure: "search_index_search_failed",
      normalizedCwd: "/workspace",
      timeout: "5s",
      detail: "index unavailable",
    });
    expect(createError).toMatchObject({
      message: "Stored create failure.",
      relativePath: "src",
      operation: "make-directory",
      operationPath: "/workspace/src",
    });
    expect(renameError).toMatchObject({
      message: "Stored rename failure.",
      relativePath: "old",
      operation: "rename",
      resolvedPath: "/workspace/old",
    });
    expect(deleteError).toMatchObject({
      message: "Stored delete failure.",
      relativePath: "old",
      operation: "remove",
      resolvedWorkspaceRoot: "/workspace",
    });
    expect(duplicateError).toMatchObject({
      message: "Stored duplicate failure.",
      relativePath: "source",
      operation: "copy-file",
      operationPath: "/workspace/source",
    });
  });

  it("ignores a malformed decoded message override", () => {
    const error = new ProjectListEntriesError(
      withDecodedMessage({ cwd: "/workspace", failure: "search_index_search_failed" }, 42),
    );

    expect(error.message).toBe("Failed to list workspace entries in '/workspace'.");
  });
});
