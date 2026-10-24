import type { ProjectWritePrecondition } from "@bibcode/contracts";
import type { AtomCommandResult } from "@bibcode/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// A detached Pierre editor: these cases reconcile without an attached document. The attached
// cases (undo, carets) run against real Pierre in pierreEditProvider.integration.test.tsx.
const pierre = vi.hoisted(() => {
  class Editor {
    readonly options: Record<string, unknown>;
    canUndo = false;
    canRedo = false;
    readonly undo = vi.fn();
    readonly redo = vi.fn();
    readonly cleanUp = vi.fn();
    readonly getFile = vi.fn(() => undefined);

    constructor(options: Record<string, unknown>) {
      this.options = options;
    }
  }
  return { Editor };
});

vi.mock("@pierre/diffs/edit", () => ({ Editor: pierre.Editor }));

import { FileEditingSession } from "./fileEditingSession";
import { FileEditingSessionRegistry } from "./fileEditingSessionRegistry";

type WriteResult = AtomCommandResult<{ readonly version?: string }, unknown>;

const saved = (version: string): WriteResult =>
  AsyncResult.success({ relativePath: "src/app.ts", version });
const refused = (failure: "file_changed_on_disk" | "file_missing_on_disk"): WriteResult =>
  AsyncResult.failure(Cause.fail({ _tag: "ProjectWriteFileError", failure, message: failure }));

function deferredResult() {
  let resolve!: (value: WriteResult) => void;
  const promise = new Promise<WriteResult>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createSession(options: { version?: string; contents?: string } = {}) {
  const persist = vi
    .fn<
      (
        relativePath: string,
        contents: string,
        precondition: ProjectWritePrecondition | null,
      ) => Promise<WriteResult>
    >()
    .mockImplementation(async (_path, contents) => saved(`saved:${contents}`));
  const onConflictChange = vi.fn();
  const onConfirmed = vi.fn();
  const session = new FileEditingSession<unknown, { readonly version?: string }, unknown>({
    cwd: "/repo",
    relativePath: "src/app.ts",
    debounceMs: 500,
    base: { version: options.version ?? "v1", contents: options.contents ?? "old\n" },
    persist,
    onPendingChange: vi.fn(),
    onConfirmed,
    onConflictChange,
  });
  return { session, persist, onConflictChange, onConfirmed };
}

/** Runs one disk check with the given version and, when asked, the given read. */
function check(
  session: FileEditingSession<unknown, { readonly version?: string }, unknown>,
  disk: Parameters<FileEditingSession<unknown>["reconcileVersion"]>[1],
  read?: { version: string; contents: string },
) {
  const token = session.beginDiskCheck();
  if (token === null) return "blocked" as const;
  const outcome = session.reconcileVersion(token, disk);
  if (outcome === "read" && read) session.reconcileRead(token, read);
  return outcome;
}

describe("FileEditingSession disk reconciliation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps today's unguarded saves when the server returned no version", async () => {
    const persist = vi.fn(async () => AsyncResult.success(undefined));
    const session = new FileEditingSession({
      cwd: "/repo",
      relativePath: "src/app.ts",
      debounceMs: 500,
      base: { version: undefined, contents: "old\n" },
      persist,
      onPendingChange: vi.fn(),
      onConfirmed: vi.fn(),
    });

    expect(session.watchesDisk).toBe(false);
    expect(session.beginDiskCheck()).toBeNull();
    session.changeOutsideEditor("edited\n");
    await expect(session.flush()).resolves.toBe("saved");
    expect(persist).toHaveBeenCalledWith("src/app.ts", "edited\n", null);
  });

  it("guards each save with the last version it saw and confirms the committed one", async () => {
    const { session, persist, onConfirmed } = createSession();

    session.changeOutsideEditor("one\n");
    await session.flush();
    session.changeOutsideEditor("two\n");
    await session.flush();

    expect(persist.mock.calls.map((call) => call[2])).toEqual([
      { _tag: "version", version: "v1" },
      { _tag: "version", version: "saved:one\n" },
    ]);
    expect(onConfirmed).toHaveBeenLastCalledWith("src/app.ts", "two\n", "saved:two\n");
  });

  it("reloads a clean detached session from the query without writing", async () => {
    const { session, persist } = createSession();
    const editor = session.editor as unknown as InstanceType<typeof pierre.Editor>;
    const cacheKey = session.cacheKey;

    expect(
      check(session, { _tag: "present", version: "v2" }, { version: "v2", contents: "new\n" }),
    ).toBe("read");

    expect(session.cacheKey).not.toBe(cacheKey);
    expect(editor.cleanUp).toHaveBeenCalledOnce();
    expect(session.retainedContents).toBeNull();
    expect(session.unsavedContents).toBeNull();
    expect(session.getSnapshot()).toMatchObject({ conflict: null, deletedOnDisk: false });
    expect(persist).not.toHaveBeenCalled();

    session.changeOutsideEditor("newer\n");
    await session.flush();
    expect(persist).toHaveBeenCalledWith("src/app.ts", "newer\n", {
      _tag: "version",
      version: "v2",
    });
  });

  it("adopts a disk version whose text already matches the document", async () => {
    vi.useFakeTimers();
    const { session, persist } = createSession();
    session.changeOutsideEditor("same edit\n");

    check(session, { _tag: "present", version: "v2" }, { version: "v2", contents: "same edit\n" });

    expect(session.getSnapshot()).toMatchObject({
      conflict: null,
      save: { phase: "clean", canSave: false },
    });
    await vi.runAllTimersAsync();
    expect(persist).not.toHaveBeenCalled();
  });

  it("never changes an edited document and blocks every save path while it conflicts", async () => {
    vi.useFakeTimers();
    const { session, persist, onConflictChange } = createSession();
    const registry = new FileEditingSessionRegistry();
    registry.getOrCreate("src/app.ts", () => session);
    registry.setActivePath("src/app.ts");
    session.changeOutsideEditor("mine\n");
    const cacheKey = session.cacheKey;

    check(session, { _tag: "present", version: "v2" }, { version: "v2", contents: "agent\n" });

    expect(session.getSnapshot().conflict).toEqual({
      reason: "changed",
      diskKnown: true,
      unreadable: null,
    });
    expect(session.unsavedContents).toBe("mine\n");
    expect(session.cacheKey).toBe(cacheKey);
    expect(onConflictChange).toHaveBeenCalledWith("src/app.ts", true);
    expect(session.getSnapshot().save.canSave).toBe(false);

    await expect(session.flush()).resolves.toBe("failed");
    await expect(session.settle()).resolves.toBe("failed");
    // A right-panel tab switch flushes the previous file; it must not write over the agent.
    registry.setActivePath("src/other.ts");
    session.pauseSaving();
    session.resumeSaving();
    session.changeOutsideEditor("still mine\n");
    await vi.runAllTimersAsync();
    // Closing the tab keeps the session, so reopening shows the edits and the bar.
    await registry.reconcile([]);
    expect(registry.get("src/app.ts")).toBe(session);
    session.dispose();
    await vi.runAllTimersAsync();
    expect(persist).not.toHaveBeenCalled();
  });

  it("overwrites the disk version the conflict showed, then saves from what it wrote", async () => {
    const { session, persist, onConflictChange } = createSession();
    session.changeOutsideEditor("mine\n");
    check(session, { _tag: "present", version: "v2" }, { version: "v2", contents: "agent\n" });

    session.overwriteDisk();
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());

    expect(persist).toHaveBeenCalledWith("src/app.ts", "mine\n", {
      _tag: "version",
      version: "v2",
    });
    await vi.waitFor(() => expect(session.getSnapshot().save.phase).toBe("clean"));
    expect(session.getSnapshot().conflict).toBeNull();
    expect(onConflictChange).toHaveBeenLastCalledWith("src/app.ts", false);
    session.changeOutsideEditor("later\n");
    await session.flush();
    expect(persist).toHaveBeenLastCalledWith("src/app.ts", "later\n", {
      _tag: "version",
      version: "saved:mine\n",
    });
  });

  it("offers only Overwrite disk for a file that became unreadable, guarded by its version", async () => {
    const { session, persist } = createSession();

    check(session, { _tag: "unreadable", failure: "binary_file", version: "vb" });
    expect(session.getSnapshot().conflict).toEqual({
      reason: "unreadable",
      diskKnown: true,
      unreadable: "binary_file",
    });

    session.overwriteDisk();
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    expect(persist).toHaveBeenCalledWith("src/app.ts", "old\n", { _tag: "version", version: "vb" });
  });

  it("recreates a deleted file only with a missing precondition", async () => {
    const { session, persist } = createSession();
    session.changeOutsideEditor("mine\n");

    check(session, { _tag: "missing" });
    expect(session.getSnapshot().conflict).toMatchObject({ reason: "deleted", diskKnown: true });

    session.overwriteDisk();
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    expect(persist).toHaveBeenCalledWith("src/app.ts", "mine\n", { _tag: "missing" });
  });

  it("shows a clean deleted file as deleted, and reloads it when it comes back", () => {
    const { session, persist } = createSession();

    check(session, { _tag: "missing" });
    expect(session.getSnapshot()).toMatchObject({ conflict: null, deletedOnDisk: true });

    check(session, { _tag: "present", version: "v3" }, { version: "v3", contents: "back\n" });
    expect(session.getSnapshot()).toMatchObject({ conflict: null, deletedOnDisk: false });
    expect(persist).not.toHaveBeenCalled();
  });

  it("discards edits for a deleted file when the user reloads from disk", () => {
    const { session, persist } = createSession();
    session.changeOutsideEditor("mine\n");
    check(session, { _tag: "missing" });

    session.reloadFromDisk();

    expect(session.getSnapshot()).toMatchObject({
      conflict: null,
      deletedOnDisk: true,
      save: { phase: "clean" },
    });
    expect(session.unsavedContents).toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });

  it("skips a check that overlaps a save; the save's response settles the base", async () => {
    const { session, persist } = createSession();
    const write = deferredResult();
    persist.mockReturnValueOnce(write.promise);
    const tokenBeforeSave = session.beginDiskCheck()!;

    session.changeOutsideEditor("one\n");
    const flushed = session.flush();
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    expect(session.beginDiskCheck()).toBeNull();
    // The user keeps typing while the save is in flight.
    session.changeOutsideEditor("two\n");
    write.resolve(saved("v-one"));
    await flushed;

    // A check that started before the save saw a version the save has since replaced.
    expect(session.reconcileVersion(tokenBeforeSave, { _tag: "present", version: "v-one" })).toBe(
      "stale",
    );
    expect(check(session, { _tag: "present", version: "v-one" })).toBe("settled");
    expect(session.unsavedContents).toBe("two\n");
    expect(session.getSnapshot().conflict).toBeNull();
    await session.flush();
    expect(persist).toHaveBeenLastCalledWith("src/app.ts", "two\n", {
      _tag: "version",
      version: "v-one",
    });
  });

  it("turns a refused save into a conflict and asks for a disk check", async () => {
    const { session, persist } = createSession();
    const requested = vi.fn();
    session.subscribeDiskCheckRequests(requested);
    persist.mockResolvedValueOnce(refused("file_changed_on_disk"));
    session.changeOutsideEditor("mine\n");

    await expect(session.flush()).resolves.toBe("failed");

    expect(session.getSnapshot().conflict).toEqual({
      reason: "changed",
      diskKnown: false,
      unreadable: null,
    });
    expect(requested).toHaveBeenCalledOnce();
    check(session, { _tag: "present", version: "v2" }, { version: "v2", contents: "agent\n" });
    expect(session.getSnapshot().conflict).toMatchObject({ reason: "changed", diskKnown: true });
    expect(session.unsavedContents).toBe("mine\n");
  });

  it("releases a conflict when the disk returns to the version the edits were based on", async () => {
    const { session, persist } = createSession();
    session.changeOutsideEditor("mine\n");
    check(session, { _tag: "present", version: "v2" }, { version: "v2", contents: "agent\n" });

    expect(check(session, { _tag: "present", version: "v1" })).toBe("settled");

    expect(session.getSnapshot().conflict).toBeNull();
    await expect(session.flush()).resolves.toBe("saved");
    expect(persist).toHaveBeenCalledWith("src/app.ts", "mine\n", {
      _tag: "version",
      version: "v1",
    });
  });
});
