import { describe, expect, it } from "@effect/vitest";

import type { TerminalAttachStreamEvent, TerminalSessionSnapshot } from "@bibcode/contracts";

import {
  createTerminalTranscriptRuntime,
  type TerminalRenderSignal,
} from "./terminalTranscriptRuntime.ts";

const snapshotData = (
  history: string,
  status: TerminalSessionSnapshot["status"] = "running",
  consoleTheme?: "light" | "dark",
): TerminalSessionSnapshot => ({
  threadId: "thread-1",
  terminalId: "terminal-1",
  cwd: "/repo",
  worktreePath: null,
  status,
  pid: 1,
  history,
  oscColorResponderActive: false,
  firstAttachmentGrant: false,
  exitCode: null,
  exitSignal: null,
  ...(consoleTheme === undefined ? {} : { consoleTheme }),
  label: "Terminal 1",
  updatedAt: "2026-07-17T00:00:00.000Z",
  sequence: 1,
});

const snapshot = (
  history: string,
  status: TerminalSessionSnapshot["status"] = "running",
): TerminalAttachStreamEvent => ({
  type: "snapshot",
  snapshot: snapshotData(history, status),
});

const restarted = (
  history: string,
  status: TerminalSessionSnapshot["status"] = "running",
): TerminalAttachStreamEvent => ({
  type: "restarted",
  threadId: "thread-1",
  terminalId: "terminal-1",
  sequence: 2,
  snapshot: { ...snapshotData(history, status), sequence: 2 },
});

/** Signals without their size position, which the generation tests below cover. */
const withoutPosition = (signals: ReadonlyArray<TerminalRenderSignal>) =>
  signals.map((signal) => {
    if (signal.type === "delta") return signal;
    const { sequence: _sequence, generation: _generation, ...rest } = signal;
    return rest;
  });

const output = (data: string): TerminalAttachStreamEvent => ({
  type: "output",
  threadId: "thread-1",
  terminalId: "terminal-1",
  sequence: 3,
  data,
});

describe("createTerminalTranscriptRuntime", () => {
  it("delivers applied size and claim in stream order and hydrates the latest size", () => {
    const runtime = createTerminalTranscriptRuntime();
    runtime.ingest({
      type: "snapshot",
      snapshot: { ...snapshotData("boot"), size: { cols: 151, rows: 50, sizeClaim: "a" } },
    });
    const signals: TerminalRenderSignal[] = [];
    runtime.attachRenderer((signal) => signals.push(signal));
    runtime.ingest(output("before"));
    runtime.ingest({
      type: "resized",
      threadId: "thread-1",
      terminalId: "terminal-1",
      size: { cols: 91, rows: 42, sizeClaim: "b" },
    });
    runtime.ingest(output("after"));
    expect(withoutPosition(signals)).toEqual([
      { type: "reset", snapshot: "boot", size: { cols: 151, rows: 50, sizeClaim: "a" } },
      { type: "delta", data: "before" },
      { type: "resized", size: { cols: 91, rows: 42, sizeClaim: "b" } },
      { type: "delta", data: "after" },
    ]);
    const hydration: TerminalRenderSignal[] = [];
    runtime.attachRenderer((signal) => hydration.push(signal));
    expect(withoutPosition(hydration)).toEqual([
      { type: "reset", snapshot: "bootbeforeafter", size: { cols: 91, rows: 42, sizeClaim: "b" } },
    ]);
    runtime.ingest({ type: "cleared", threadId: "thread-1", terminalId: "terminal-1" });
    expect(withoutPosition(hydration).at(-1)).toEqual({
      type: "reset",
      snapshot: "",
      size: { cols: 91, rows: 42, sizeClaim: "b" },
    });
    runtime.ingest(restarted("fresh"));
    expect(withoutPosition(hydration).at(-1)).toEqual({ type: "reset", snapshot: "fresh" });
  });

  it("broadcasts claim-only changes without lifecycle notifications", () => {
    const runtime = createTerminalTranscriptRuntime();
    runtime.ingest(snapshot(""));
    const metadata = runtime.metadata();
    const signals: TerminalRenderSignal[] = [];
    runtime.attachRenderer((signal) => signals.push(signal));
    for (const sizeClaim of ["a", "b"]) {
      runtime.ingest({
        type: "resized",
        threadId: "thread-1",
        terminalId: "terminal-1",
        size: { cols: 80, rows: 24, sizeClaim },
      });
    }
    expect(withoutPosition(signals.slice(1))).toEqual([
      { type: "resized", size: { cols: 80, rows: 24, sizeClaim: "a" } },
      { type: "resized", size: { cols: 80, rows: 24, sizeClaim: "b" } },
    ]);
    expect(runtime.metadata()).toBe(metadata);
  });
  it("hydrates the server color responder flag and clears it for legacy snapshots", () => {
    const runtime = createTerminalTranscriptRuntime();
    runtime.ingest({
      type: "snapshot",
      snapshot: { ...snapshotData("colors"), oscColorResponderActive: true },
    });
    const signals: TerminalRenderSignal[] = [];
    runtime.attachRenderer((signal) => signals.push(signal));
    expect(signals[0]).toMatchObject({ type: "reset", oscColorResponderActive: true });
    runtime.ingest(snapshot("legacy"));
    const reset = signals.at(-1)!;
    expect(reset.type === "reset" && (reset.oscColorResponderActive ?? false)).toBe(false);
  });

  it("grants startup replay only once to the snapshot owner, including delayed hydration", () => {
    const runtime = createTerminalTranscriptRuntime();
    runtime.ingest({
      type: "snapshot",
      snapshot: {
        ...snapshotData("\x1b[6n\x1b[c"),
        firstAttachmentGrant: true,
        size: { cols: 80, rows: 24, sizeClaim: "owner" },
      },
    });
    const mirror: TerminalRenderSignal[] = [];
    runtime.attachRenderer((signal) => mirror.push(signal), "mirror");
    expect(mirror[0]).not.toHaveProperty("firstAttachmentGrant", true);
    const owner: TerminalRenderSignal[] = [];
    const first = runtime.attachRenderer((signal) => owner.push(signal), "owner");
    expect(owner[0]).toMatchObject({ type: "reset", firstAttachmentGrant: true });
    first.detach();
    const later: TerminalRenderSignal[] = [];
    runtime.attachRenderer((signal) => later.push(signal), "owner");
    expect(later[0]).not.toHaveProperty("firstAttachmentGrant", true);
  });

  it("delivers a first-attachment grant once to an already attached owner", () => {
    const runtime = createTerminalTranscriptRuntime();
    const signals: TerminalRenderSignal[] = [];
    runtime.attachRenderer((signal) => signals.push(signal), "owner");
    runtime.ingest({
      type: "snapshot",
      snapshot: {
        ...snapshotData("query"),
        firstAttachmentGrant: true,
        size: { cols: 80, rows: 24, sizeClaim: "owner" },
      },
    });
    expect(signals.at(-1)).toHaveProperty("firstAttachmentGrant", true);
    runtime.ingest({ type: "cleared", threadId: "thread-1", terminalId: "terminal-1" });
    expect(signals.at(-1)).not.toHaveProperty("firstAttachmentGrant", true);
  });

  it("starts closed with one stable metadata object", () => {
    const runtime = createTerminalTranscriptRuntime();

    expect(runtime.metadata()).toEqual({
      status: "closed",
      error: null,
      consoleTheme: null,
      generation: 0,
      revision: 0,
    });
    expect(runtime.metadata()).toBe(runtime.metadata());
    expect(runtime.snapshot()).toBe("");
  });

  it("retains the authoritative console theme across attach and restart snapshots", () => {
    const runtime = createTerminalTranscriptRuntime();

    runtime.ingest({ type: "snapshot", snapshot: snapshotData("light", "running", "light") });
    expect(runtime.metadata().consoleTheme).toBe("light");

    runtime.ingest({
      type: "restarted",
      threadId: "thread-1",
      terminalId: "terminal-1",
      sequence: 2,
      snapshot: { ...snapshotData("dark", "running", "dark"), sequence: 2 },
    });
    expect(runtime.metadata().consoleTheme).toBe("dark");
  });

  it("replaces the transcript on a resync but keeps the attachment generation", () => {
    const runtime = createTerminalTranscriptRuntime();
    runtime.ingest(snapshot("boot\n"));
    runtime.ingest(output("partial"));
    const generation = runtime.metadata().generation;
    const signals: TerminalRenderSignal[] = [];
    runtime.attachRenderer((signal) => signals.push(signal));
    signals.length = 0;

    // The server fell behind and lost output, and the process exited meanwhile: it sends the
    // session's whole state again.
    runtime.ingest({
      type: "snapshot",
      snapshot: snapshotData("boot\nall of the output\n", "exited"),
      resync: true,
    });

    expect(runtime.snapshot()).toBe("boot\nall of the output\n");
    expect(withoutPosition(signals)).toEqual([
      { type: "reset", snapshot: "boot\nall of the output\n" },
    ]);
    expect(runtime.metadata().status).toBe("exited");
    // Same process: input waiting to be written is not discarded as for a new attachment.
    expect(runtime.metadata().generation).toBe(generation);
    runtime.ingest(snapshot("fresh\n"));
    expect(runtime.metadata().generation).toBe(generation + 1);
  });

  it("attach plus live output reconstructs exactly with no gap or duplicate (C1)", () => {
    const runtime = createTerminalTranscriptRuntime();
    runtime.ingest(snapshot("boot\n"));
    runtime.ingest(output("a"));
    let reconstructed = "";
    const signals: TerminalRenderSignal[] = [];
    const renderer = runtime.attachRenderer((signal) => {
      signals.push(signal);
      if (signal.type === "reset") reconstructed = signal.snapshot;
      if (signal.type === "delta") reconstructed += signal.data;
    });

    expect(withoutPosition(signals)).toEqual([{ type: "reset", snapshot: "boot\na" }]);
    runtime.ingest(output("b"));
    runtime.ingest(output("c"));
    expect(reconstructed).toBe("boot\nabc");
    expect(reconstructed).toBe(runtime.snapshot());

    renderer.detach();
    renderer.detach();
    runtime.ingest(output("d"));
    expect(reconstructed).toBe("boot\nabc");
    expect(runtime.snapshot()).toBe("boot\nabcd");
  });

  it("registers before reset delivery so recursively ingested output cannot be missed", () => {
    const runtime = createTerminalTranscriptRuntime();
    runtime.ingest(snapshot("prompt> "));
    const signals: TerminalRenderSignal[] = [];

    runtime.attachRenderer((signal) => {
      signals.push(signal);
      if (signal.type === "reset") {
        runtime.ingest(output("nested"));
      }
    });

    expect(withoutPosition(signals)).toEqual([
      { type: "reset", snapshot: "prompt> " },
      { type: "delta", data: "nested" },
    ]);
    expect(runtime.snapshot()).toBe("prompt> nested");
  });

  it("serializes recursive ingestion so every renderer observes the same FIFO order", () => {
    const runtime = createTerminalTranscriptRuntime();
    runtime.ingest(snapshot(""));
    const first: string[] = [];
    const second: string[] = [];
    runtime.attachRenderer((signal) => {
      if (signal.type !== "delta") return;
      first.push(signal.data);
      if (signal.data === "1") runtime.ingest(output("2"));
    });
    runtime.attachRenderer((signal) => {
      if (signal.type === "delta") second.push(signal.data);
    });

    runtime.ingest(output("1"));

    expect(first).toEqual(["1", "2"]);
    expect(second).toEqual(["1", "2"]);
    expect(runtime.snapshot()).toBe("12");
  });

  it("uses snapshot fan-out so renderer set mutation neither skips nor duplicates delivery", () => {
    const runtime = createTerminalTranscriptRuntime();
    runtime.ingest(snapshot(""));
    const removed: TerminalRenderSignal[] = [];
    const added: TerminalRenderSignal[] = [];
    const remover: TerminalRenderSignal[] = [];
    const removedHandle = runtime.attachRenderer((signal) => removed.push(signal));
    runtime.attachRenderer((signal) => {
      remover.push(signal);
      if (signal.type === "delta" && signal.data === "x") {
        removedHandle.detach();
        runtime.attachRenderer((next) => added.push(next));
      }
    });
    removed.length = 0;
    remover.length = 0;

    runtime.ingest(output("x"));
    expect(removed).toEqual([{ type: "delta", data: "x" }]);
    expect(remover).toEqual([{ type: "delta", data: "x" }]);
    expect(withoutPosition(added)).toEqual([{ type: "reset", snapshot: "x" }]);

    runtime.ingest(output("y"));
    expect(removed).toEqual([{ type: "delta", data: "x" }]);
    expect(withoutPosition(added)).toEqual([
      { type: "reset", snapshot: "x" },
      { type: "delta", data: "y" },
    ]);
  });

  it("contains throwing renderer and metadata observers without corrupting other delivery", () => {
    const runtime = createTerminalTranscriptRuntime();
    const rendererSignals: TerminalRenderSignal[] = [];
    const metadataRevisions: number[] = [];
    runtime.attachRenderer(() => {
      throw new Error("renderer failed");
    });
    runtime.attachRenderer((signal) => rendererSignals.push(signal));
    runtime.subscribeMetadata(() => {
      throw new Error("metadata failed");
    });
    runtime.subscribeMetadata((metadata) => metadataRevisions.push(metadata.revision));
    rendererSignals.length = 0;

    expect(() => runtime.ingest(snapshot("safe"))).not.toThrow();
    expect(() => runtime.ingest(output("!"))).not.toThrow();

    expect(withoutPosition(rendererSignals)).toEqual([
      { type: "reset", snapshot: "safe" },
      { type: "delta", data: "!" },
    ]);
    expect(metadataRevisions).toEqual([1]);
    expect(runtime.snapshot()).toBe("safe!");
  });

  it("output ingests and renders without metadata allocation, revision, or emission (C2)", () => {
    const runtime = createTerminalTranscriptRuntime();
    runtime.ingest(snapshot(""));
    const metadataEvents: unknown[] = [];
    runtime.subscribeMetadata((metadata) => metadataEvents.push(metadata));
    const before = runtime.metadata();

    runtime.ingest(output("lots of output\n"));
    runtime.ingest(output("more\n"));

    expect(runtime.metadata()).toBe(before);
    expect(runtime.metadata().revision).toBe(1);
    expect(metadataEvents).toEqual([]);
    expect(runtime.snapshot()).toBe("lots of output\nmore\n");
  });

  it("snapshot and restart replace the transcript, bump generation once, and render before metadata", () => {
    const runtime = createTerminalTranscriptRuntime();
    const order: string[] = [];
    const renderSignals: TerminalRenderSignal[] = [];
    runtime.attachRenderer((signal) => {
      renderSignals.push(signal);
      order.push(`render:${signal.type}`);
    });
    runtime.subscribeMetadata((metadata) => order.push(`metadata:${metadata.revision}`));
    renderSignals.length = 0;
    order.length = 0;

    runtime.ingest(snapshot("old\n", "starting"));
    const firstMetadata = runtime.metadata();
    runtime.ingest(output("old-tail"));
    runtime.ingest(restarted("fresh\n", "running"));

    expect(withoutPosition(renderSignals)).toEqual([
      { type: "reset", snapshot: "old\n" },
      { type: "delta", data: "old-tail" },
      { type: "reset", snapshot: "fresh\n" },
    ]);
    expect(order).toEqual([
      "render:reset",
      "metadata:1",
      "render:delta",
      "render:reset",
      "metadata:2",
    ]);
    expect(firstMetadata).not.toBe(runtime.metadata());
    expect(runtime.metadata()).toEqual({
      status: "running",
      error: null,
      consoleTheme: null,
      generation: 2,
      revision: 2,
    });
    expect(runtime.snapshot()).toBe("fresh\n");
  });

  it("handles cleared, exited, closed, error, and activity with exact lifecycle emissions", () => {
    const runtime = createTerminalTranscriptRuntime();
    runtime.ingest(snapshot("seed"));
    const renderSignals: TerminalRenderSignal[] = [];
    const metadataEvents: Array<ReturnType<typeof runtime.metadata>> = [];
    runtime.attachRenderer((signal) => renderSignals.push(signal));
    runtime.subscribeMetadata((metadata) => metadataEvents.push(metadata));
    renderSignals.length = 0;
    const beforeActivity = runtime.metadata();

    runtime.ingest({
      type: "activity",
      threadId: "thread-1",
      terminalId: "terminal-1",
      sequence: 4,
      hasRunningSubprocess: true,
      label: "node",
    });
    expect(runtime.metadata()).toBe(beforeActivity);
    expect(metadataEvents).toEqual([]);
    expect(renderSignals).toEqual([]);

    runtime.ingest({
      type: "error",
      threadId: "thread-1",
      terminalId: "terminal-1",
      sequence: 5,
      message: "boom",
    });
    runtime.ingest({
      type: "cleared",
      threadId: "thread-1",
      terminalId: "terminal-1",
      sequence: 6,
    });
    runtime.ingest({
      type: "exited",
      threadId: "thread-1",
      terminalId: "terminal-1",
      sequence: 7,
      exitCode: 1,
      exitSignal: null,
    });
    runtime.ingest({
      type: "closed",
      threadId: "thread-1",
      terminalId: "terminal-1",
      sequence: 8,
    });

    expect(metadataEvents.map((metadata) => metadata.revision)).toEqual([2, 3, 4, 5]);
    expect(metadataEvents.map((metadata) => metadata.status)).toEqual([
      "error",
      "error",
      "exited",
      "closed",
    ]);
    expect(metadataEvents.map((metadata) => metadata.error)).toEqual(["boom", null, null, null]);
    expect(metadataEvents.every((metadata) => metadata.generation === 1)).toBe(true);
    expect(withoutPosition(renderSignals)).toEqual([{ type: "reset", snapshot: "" }]);
    expect(runtime.snapshot()).toBe("");
  });

  it("bounds reset snapshots with the configured UTF-8 transcript cap", () => {
    const runtime = createTerminalTranscriptRuntime({ maxBufferBytes: 4 });
    const signals: TerminalRenderSignal[] = [];
    runtime.attachRenderer((signal) => signals.push(signal));
    signals.length = 0;

    runtime.ingest(snapshot("😀😀"));

    expect(runtime.snapshot()).toBe("😀");
    expect(withoutPosition(signals)).toEqual([{ type: "reset", snapshot: "😀" }]);
  });

  it("metadata unsubscribe is idempotent", () => {
    const runtime = createTerminalTranscriptRuntime();
    const revisions: number[] = [];
    const unsubscribe = runtime.subscribeMetadata((metadata) => revisions.push(metadata.revision));

    unsubscribe();
    unsubscribe();
    runtime.ingest(snapshot(""));

    expect(revisions).toEqual([]);
  });
});

describe("createTerminalTranscriptRuntime with several attach streams (#348)", () => {
  const at = (sequence: number, history: string, pid = 7, rows = 30) =>
    ({
      type: "snapshot",
      snapshot: {
        ...snapshotData(history),
        pid,
        sequence,
        size: { cols: 80, rows, sizeClaim: "a" },
      },
    }) satisfies TerminalAttachStreamEvent;
  const resizedAt = (sequence: number, rows: number) =>
    ({
      type: "resized",
      threadId: "thread-1",
      terminalId: "terminal-1",
      sequence,
      size: { cols: 80, rows, sizeClaim: "a" },
    }) satisfies TerminalAttachStreamEvent;
  const outputAt = (sequence: number, data: string) =>
    ({
      type: "output",
      threadId: "thread-1",
      terminalId: "terminal-1",
      sequence,
      data,
    }) satisfies TerminalAttachStreamEvent;
  const restartedAt = (sequence: number, history: string, pid: number) =>
    ({
      type: "restarted",
      threadId: "thread-1",
      terminalId: "terminal-1",
      sequence,
      snapshot: { ...snapshotData(history), pid, sequence },
    }) satisfies TerminalAttachStreamEvent;
  const appliedRows = (runtime: ReturnType<typeof createTerminalTranscriptRuntime>) => {
    const seen: Array<number> = [];
    runtime.attachRenderer((signal) => {
      if (signal.type === "resized") seen.push(signal.size.rows);
      if (signal.type === "reset" && signal.size) seen.push(signal.size.rows);
    });
    return seen;
  };

  it("keeps a newer size when another stream delivers an older one late", () => {
    const runtime = createTerminalTranscriptRuntime();
    const a = {};
    const b = {};
    runtime.ingest(at(10, "h"), a);
    runtime.ingest(at(10, "h"), b);
    const rows = appliedRows(runtime);
    runtime.ingest(resizedAt(11, 30), a);
    runtime.ingest(resizedAt(12, 20), a);
    runtime.ingest(resizedAt(11, 30), b);
    expect(rows).toEqual([30, 30, 20]);
    const late: TerminalRenderSignal[] = [];
    runtime.attachRenderer((signal) => late.push(signal));
    expect(withoutPosition(late)).toEqual([
      { type: "reset", snapshot: "h", size: { cols: 80, rows: 20, sizeClaim: "a" } },
    ]);
  });

  it("appends output delivered by two streams once, in order, without a gap", () => {
    const runtime = createTerminalTranscriptRuntime();
    const a = {};
    const b = {};
    runtime.ingest(at(10, "h"), a);
    runtime.ingest(outputAt(11, "1"), a);
    runtime.ingest(outputAt(12, "2"), a);
    // The second stream's snapshot is older than what the first already applied.
    runtime.ingest(at(10, "h"), b);
    runtime.ingest(outputAt(11, "1"), b);
    runtime.ingest(outputAt(13, "3"), a);
    runtime.ingest(outputAt(12, "2"), b);
    runtime.ingest(outputAt(13, "3"), b);
    runtime.ingest(outputAt(14, "4"), b);
    expect(runtime.snapshot()).toBe("h1234");
  });

  it("applies a newer resync from another stream and ignores an equal or older one", () => {
    const runtime = createTerminalTranscriptRuntime();
    const a = {};
    const b = {};
    runtime.ingest(at(10, "h"), a);
    runtime.ingest(outputAt(11, "1"), a);
    runtime.ingest({ ...at(11, "h1"), resync: true }, b);
    runtime.ingest({ ...at(9, "old"), resync: true }, b);
    expect(runtime.snapshot()).toBe("h1");
    runtime.ingest({ ...at(15, "caught-up"), resync: true }, b);
    expect(runtime.snapshot()).toBe("caught-up");
    expect(runtime.metadata().generation).toBe(1);
    runtime.ingest(outputAt(12, "stale"), a);
    runtime.ingest(outputAt(16, "!"), a);
    expect(runtime.snapshot()).toBe("caught-up!");
  });

  it("drops a lagging stream's old-process events after a restart and resumes it after its own restart", () => {
    const runtime = createTerminalTranscriptRuntime();
    const a = {};
    const b = {};
    runtime.ingest(at(490, "old"), a);
    runtime.ingest(at(490, "old"), b);
    runtime.ingest(restartedAt(1, "new", 8), a);
    runtime.ingest(outputAt(2, "a"), a);
    runtime.ingest(outputAt(498, "stale"), b);
    runtime.ingest(resizedAt(499, 50), b);
    expect(runtime.snapshot()).toBe("newa");
    expect(runtime.metadata().generation).toBe(2);
    runtime.ingest(restartedAt(1, "new", 8), b);
    expect(runtime.metadata().generation).toBe(2);
    expect(runtime.snapshot()).toBe("newa");
    runtime.ingest(outputAt(2, "a"), b);
    runtime.ingest(outputAt(3, "b"), b);
    expect(runtime.snapshot()).toBe("newab");
  });

  it("treats an exited snapshot (no pid) as the last process and keeps the first stream live", () => {
    const runtime = createTerminalTranscriptRuntime();
    const a = {};
    const b = {};
    const statuses: Array<string> = [];
    runtime.ingest(at(10, "h"), a);
    runtime.ingest(
      {
        type: "exited",
        threadId: "thread-1",
        terminalId: "terminal-1",
        sequence: 11,
        exitCode: 0,
        exitSignal: null,
      },
      a,
    );
    runtime.subscribeMetadata((next) => statuses.push(next.status));
    // A stream attached after the exit sees the same session without a pid.
    runtime.ingest(
      {
        type: "snapshot",
        snapshot: { ...snapshotData("h", "exited"), pid: null, sequence: 11 },
      },
      b,
    );
    runtime.ingest(
      { type: "closed", threadId: "thread-1", terminalId: "terminal-1", sequence: 12 },
      a,
    );
    expect(statuses).toEqual(["closed"]);
    expect(runtime.metadata().generation).toBe(1);
  });

  it("starts over for a snapshot of another process even at a lower sequence", () => {
    const runtime = createTerminalTranscriptRuntime();
    const a = {};
    const b = {};
    runtime.ingest(at(40, "old"), a);
    runtime.ingest(at(2, "reopened", 9), b);
    expect(runtime.snapshot()).toBe("reopened");
    expect(runtime.metadata().generation).toBe(2);
  });

  it("ignores a cleared and a closed event already applied from another stream", () => {
    const runtime = createTerminalTranscriptRuntime();
    const a = {};
    const b = {};
    const statuses: Array<string> = [];
    runtime.ingest(at(10, "h"), a);
    runtime.ingest(at(10, "h"), b);
    runtime.subscribeMetadata((next) => statuses.push(next.status));
    const cleared = {
      type: "cleared",
      threadId: "thread-1",
      terminalId: "terminal-1",
      sequence: 11,
    } satisfies TerminalAttachStreamEvent;
    const closed = {
      type: "closed",
      threadId: "thread-1",
      terminalId: "terminal-1",
      sequence: 13,
    } satisfies TerminalAttachStreamEvent;
    runtime.ingest(cleared, a);
    runtime.ingest(outputAt(12, "kept"), a);
    runtime.ingest(cleared, b);
    expect(runtime.snapshot()).toBe("kept");
    runtime.ingest(closed, a);
    runtime.ingest(closed, b);
    expect(statuses).toEqual(["running", "closed"]);
  });
});

describe("createTerminalTranscriptRuntime ordered by server generation (#348)", () => {
  const generation = (process: number, boot = "boot-a") => ({ boot, process });
  const snapshotAt = (
    process: number,
    sequence: number,
    history: string,
    options: {
      readonly pid?: number | null;
      readonly status?: TerminalSessionSnapshot["status"];
      readonly boot?: string;
    } = {},
  ) =>
    ({
      type: "snapshot",
      snapshot: {
        ...snapshotData(history, options.status ?? "running"),
        pid: options.pid === undefined ? process : options.pid,
        sequence,
        size: { cols: 80, rows: 30, sizeClaim: "a" },
        generation: generation(process, options.boot),
      },
    }) satisfies TerminalAttachStreamEvent;
  const restartedAt = (process: number, sequence: number, history: string) =>
    ({
      type: "restarted",
      threadId: "thread-1",
      terminalId: "terminal-1",
      sequence,
      snapshot: {
        ...snapshotData(history),
        pid: process,
        sequence,
        size: { cols: 80, rows: 30, sizeClaim: "a" },
        generation: generation(process),
      },
    }) satisfies TerminalAttachStreamEvent;
  const outputAt = (sequence: number, data: string) =>
    ({
      type: "output",
      threadId: "thread-1",
      terminalId: "terminal-1",
      sequence,
      data,
    }) satisfies TerminalAttachStreamEvent;
  const resizedAt = (sequence: number, rows: number) =>
    ({
      type: "resized",
      threadId: "thread-1",
      terminalId: "terminal-1",
      sequence,
      size: { cols: 80, rows, sizeClaim: "a" },
    }) satisfies TerminalAttachStreamEvent;
  const closedAt = (sequence: number, process: number) =>
    ({
      type: "closed",
      threadId: "thread-1",
      terminalId: "terminal-1",
      sequence,
      generation: generation(process),
    }) satisfies TerminalAttachStreamEvent;

  it("keeps the newest process when another stream delivers an older restart late", () => {
    const runtime = createTerminalTranscriptRuntime();
    const a = {};
    const b = {};
    runtime.ingest(snapshotAt(6, 10, "six"), a);
    runtime.ingest(snapshotAt(6, 10, "six"), b);
    runtime.ingest(restartedAt(7, 1, "seven"), a);
    runtime.ingest(restartedAt(8, 1, "eight"), a);
    runtime.ingest(restartedAt(9, 1, "nine"), a);
    // The second stream delivers its delayed restart of process 8, then goes away.
    runtime.ingest(restartedAt(8, 1, "eight"), b);
    runtime.ingest(outputAt(2, "!"), a);
    expect(runtime.snapshot()).toBe("nine!");
  });

  it("ignores a late exited snapshot of an earlier process that has no pid", () => {
    const runtime = createTerminalTranscriptRuntime();
    const a = {};
    const b = {};
    const statuses: Array<string> = [];
    runtime.ingest(snapshotAt(1, 10, "old"), a);
    runtime.ingest(restartedAt(2, 1, "new"), a);
    runtime.subscribeMetadata((next) => statuses.push(next.status));
    runtime.ingest(snapshotAt(1, 40, "old exited", { pid: null, status: "exited" }), b);
    runtime.ingest(outputAt(2, "x"), a);
    expect(runtime.snapshot()).toBe("newx");
    expect(statuses).toEqual([]);
  });

  it("starts over for a new process that reuses a pid with a reset sequence", () => {
    const runtime = createTerminalTranscriptRuntime();
    const a = {};
    const b = {};
    runtime.ingest(snapshotAt(1, 50, "old", { pid: 7 }), a);
    runtime.ingest(snapshotAt(2, 3, "fresh", { pid: 7 }), b);
    expect(runtime.snapshot()).toBe("fresh");
    runtime.ingest(outputAt(4, "!"), b);
    expect(runtime.snapshot()).toBe("fresh!");
  });

  it("applies a lagging stream's close by generation, not against another stream's sequence", () => {
    const runtime = createTerminalTranscriptRuntime();
    const a = {};
    const b = {};
    runtime.ingest(snapshotAt(3, 10, "h"), a);
    runtime.ingest(snapshotAt(3, 10, "h"), b);
    runtime.ingest(outputAt(100, "far ahead"), a);
    // The second stream lost the real close to its lag; the server reports it at its own cursor.
    runtime.ingest(closedAt(11, 3), b);
    expect(runtime.metadata().status).toBe("closed");
  });

  it("drops a close of an earlier process and applies one close per process once", () => {
    const runtime = createTerminalTranscriptRuntime();
    const a = {};
    const b = {};
    const statuses: Array<string> = [];
    runtime.ingest(snapshotAt(3, 10, "h"), a);
    runtime.ingest(restartedAt(4, 1, "new"), a);
    runtime.subscribeMetadata((next) => statuses.push(next.status));
    runtime.ingest(closedAt(11, 3), b);
    expect(runtime.metadata().status).toBe("running");
    runtime.ingest(closedAt(2, 4), a);
    runtime.ingest(closedAt(9, 4), b);
    expect(statuses).toEqual(["closed"]);
    // A process the close outranked cannot bring the terminal back.
    runtime.ingest(restartedAt(4, 1, "new"), b);
    expect(runtime.metadata().status).toBe("closed");
  });

  it("delivers the size of a resync whose transcript another stream already applied", () => {
    const runtime = createTerminalTranscriptRuntime();
    const requester = { sizeClaim: "a" };
    const other = { sizeClaim: "b" };
    runtime.ingest(snapshotAt(1, 10, "h"), requester);
    runtime.ingest(snapshotAt(1, 10, "h"), other);
    const signals: TerminalRenderSignal[] = [];
    runtime.attachRenderer((signal) => signals.push(signal), "a");
    // The requester's no-op acknowledgement at 11 reaches only its stream, which falls behind
    // and loses it; the other stream delivers the next output.
    runtime.ingest(outputAt(12, "!"), other);
    // The server's catch-up for the requester carries the size as of 12.
    runtime.ingest({ ...snapshotAt(1, 12, "h!"), resync: true }, requester);
    expect(signals.slice(1)).toEqual([
      { type: "delta", data: "!" },
      {
        type: "resized",
        size: { cols: 80, rows: 30, sizeClaim: "a" },
        sequence: 12,
        generation: generation(1),
      },
    ]);
    expect(runtime.snapshot()).toBe("h!");
    // Once delivered, the same size position is not delivered again.
    runtime.ingest({ ...snapshotAt(1, 12, "h!"), resync: true }, requester);
    expect(signals).toHaveLength(3);
  });

  it("keeps a closed process closed when a delayed resync of it arrives", () => {
    const runtime = createTerminalTranscriptRuntime();
    const a = { sizeClaim: "a" };
    const b = { sizeClaim: "b" };
    runtime.ingest(snapshotAt(3, 10, "h"), a);
    runtime.ingest(snapshotAt(3, 10, "h"), b);
    runtime.ingest(closedAt(13, 3), a);
    // Each stream's catch-up from before the close, delivered after it.
    runtime.ingest({ ...snapshotAt(3, 12, "late b"), resync: true }, b);
    runtime.ingest({ ...snapshotAt(3, 12, "late a"), resync: true }, a);
    expect(runtime.metadata().status).toBe("closed");
    expect(runtime.snapshot()).toBe("h");
    // Only a newer process reopens it.
    runtime.ingest(restartedAt(4, 1, "reopened"), a);
    expect(runtime.metadata().status).toBe("running");
    expect(runtime.snapshot()).toBe("reopened");
  });

  it("follows a restarted server and never returns to the one it left", () => {
    const runtime = createTerminalTranscriptRuntime();
    const a = {};
    runtime.ingest(snapshotAt(57, 90, "before"), a);
    runtime.ingest(snapshotAt(1, 2, "after", { boot: "boot-b" }), a);
    expect(runtime.snapshot()).toBe("after");
    runtime.ingest(snapshotAt(58, 1, "stale", { boot: "boot-a" }), {});
    expect(runtime.snapshot()).toBe("after");
  });

  it("renders output after the size the server published before it, across streams", () => {
    const runtime = createTerminalTranscriptRuntime();
    const claimed = { sizeClaim: "a" };
    const unclaimed = {};
    runtime.ingest(snapshotAt(1, 10, "h"), claimed);
    runtime.ingest(snapshotAt(1, 10, "h"), unclaimed);
    const order: Array<string> = [];
    runtime.attachRenderer((signal) => {
      if (signal.type === "resized") order.push(`resized ${signal.size.rows}`);
      if (signal.type === "delta") order.push(`delta ${signal.data}`);
    });
    // Size events reach only claimed streams, so the unclaimed stream's output 12 arrives
    // before resize 11; parsed first, it would be laid out at the old size for good.
    runtime.ingest(outputAt(12, "!"), unclaimed);
    runtime.ingest(resizedAt(11, 20), claimed);
    runtime.ingest(outputAt(12, "!"), claimed);
    expect(order).toEqual(["resized 20", "delta !"]);
    expect(runtime.snapshot()).toBe("h!");
  });

  it("lets a stream without sizes order output again once the claimed stream ends", () => {
    const runtime = createTerminalTranscriptRuntime();
    const claimed = { sizeClaim: "a" };
    const unclaimed = {};
    runtime.ingest(snapshotAt(1, 10, "h"), claimed);
    runtime.ingest(snapshotAt(1, 10, "h"), unclaimed);
    runtime.ingest(outputAt(11, "1"), claimed);
    runtime.ingest(outputAt(11, "1"), unclaimed);
    runtime.releaseSource(claimed);
    runtime.ingest(outputAt(12, "2"), unclaimed);
    expect(runtime.snapshot()).toBe("h12");
  });

  it("does not hold output back for a claimed stream still on an earlier process", () => {
    const runtime = createTerminalTranscriptRuntime();
    const claimed = { sizeClaim: "a" };
    const unclaimed = {};
    runtime.ingest(snapshotAt(1, 10, "h"), claimed);
    runtime.ingest(snapshotAt(1, 10, "h"), unclaimed);
    runtime.ingest(restartedAt(2, 1, "new"), unclaimed);
    runtime.ingest(outputAt(2, "!"), unclaimed);
    expect(runtime.snapshot()).toBe("new!");
  });

  it("tells a renderer its own stream attached when that stream's snapshot was already applied", () => {
    const runtime = createTerminalTranscriptRuntime();
    runtime.ingest(snapshotAt(2, 10, "h"), { sizeClaim: "old" });
    const mine: TerminalRenderSignal[] = [];
    const other: TerminalRenderSignal[] = [];
    runtime.attachRenderer((signal) => mine.push(signal), "new");
    runtime.attachRenderer((signal) => other.push(signal), "old");
    const stream = { sizeClaim: "new" };
    runtime.ingest(snapshotAt(2, 10, "h"), stream);
    // A resync of the same stream is not a new attachment.
    runtime.ingest({ ...snapshotAt(2, 10, "h"), resync: true }, stream);
    expect(mine.slice(1)).toEqual([
      {
        type: "attached",
        size: { cols: 80, rows: 30, sizeClaim: "a" },
        sequence: 10,
        generation: generation(2),
      },
    ]);
    expect(other.slice(1)).toEqual([]);
    expect(runtime.snapshot()).toBe("h");
  });

  it("tells renderers the sequence and generation of each size it delivers", () => {
    const runtime = createTerminalTranscriptRuntime();
    runtime.ingest(snapshotAt(2, 10, "h"));
    const signals: TerminalRenderSignal[] = [];
    runtime.attachRenderer((signal) => signals.push(signal));
    runtime.ingest(resizedAt(11, 20));
    expect(signals).toEqual([
      {
        type: "reset",
        snapshot: "h",
        size: { cols: 80, rows: 30, sizeClaim: "a" },
        sequence: 10,
        generation: generation(2),
      },
      {
        type: "resized",
        size: { cols: 80, rows: 20, sizeClaim: "a" },
        sequence: 11,
        generation: generation(2),
      },
    ]);
  });
});
