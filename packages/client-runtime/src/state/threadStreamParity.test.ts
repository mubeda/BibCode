// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadHistoryPage,
  OrchestrationThreadStreamItem,
} from "@bibcode/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { appendHistoryPage, mergeThreadHistory, type OlderHistory } from "./threadHistory.ts";
import { applyThreadPatch } from "./threadPatch.ts";

// The RPC client decodes stream values through the JSON codec, as here.
const decodeItem = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationThreadStreamItem));
const decodeSubscribeInput = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationSubscribeThreadInput),
);
const decodePage = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationThreadHistoryPage));
const decodeThreadSnapshot = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationThreadDetailSnapshot),
);

// Written by the server test `thread_stream_lifecycle_fixture_matches_the_wire`:
// one thread's first snapshot, every patch its stream then sent, and its last snapshot.
const fixture = JSON.parse(
  NodeFS.readFileSync(
    NodePath.resolve(
      import.meta.dirname,
      "../../../contracts/fixtures/thread-stream/lifecycle.json",
    ),
    "utf8",
  ),
) as { initial: unknown; patches: ReadonlyArray<unknown>; final: unknown };

describe("thread stream parity with the server", () => {
  it("rebuilds the server's last snapshot from its first snapshot and the patches", () => {
    const initial = decodeItem({ kind: "snapshot", snapshot: fixture.initial });
    const last = decodeItem({ kind: "snapshot", snapshot: fixture.final });
    if (initial.kind !== "snapshot" || last.kind !== "snapshot") throw new Error("snapshots");
    expect(fixture.patches.length).toBeGreaterThan(10);

    let thread = initial.snapshot.thread;
    let sequence = initial.snapshot.snapshotSequence;
    for (const value of fixture.patches) {
      const item = decodeItem(value);
      if (item.kind !== "patch") throw new Error("patch");
      expect(item.snapshotSequence).toBeGreaterThanOrEqual(sequence);
      sequence = item.snapshotSequence;
      thread = applyThreadPatch(thread, item.patch);
    }

    // A command that leaves the thread unchanged advances the sequence with no patch.
    expect(sequence).toBeLessThanOrEqual(last.snapshot.snapshotSequence);
    expect(thread).toEqual(last.snapshot.thread);
  });

  // Written by the server test `thread_stream_resume_fixture_matches_the_wire`: a resume input,
  // then the snapshot, `unchanged` and patch items a resuming client receives.
  it("decodes a resume and the items that answer it", () => {
    const resume = JSON.parse(
      NodeFS.readFileSync(
        NodePath.resolve(
          import.meta.dirname,
          "../../../contracts/fixtures/thread-stream/resume.json",
        ),
        "utf8",
      ),
    ) as { input: unknown; items: ReadonlyArray<unknown> };
    const input = decodeSubscribeInput(resume.input);
    const [opened, unchanged, patch] = resume.items.map((item) => decodeItem(item));
    if (opened?.kind !== "snapshot" || unchanged?.kind !== "unchanged" || patch?.kind !== "patch") {
      throw new Error("snapshot, unchanged, patch");
    }
    expect(input.resume).toEqual({
      revision: opened.revision,
      snapshotSequence: opened.snapshot.snapshotSequence,
    });
    expect(unchanged.revision).toBe(opened.revision);
    expect(patch.revision).not.toBe(opened.revision);
    expect(applyThreadPatch(opened.snapshot.thread, patch.patch).title).toBe("Renamed");
  });

  it("ignores fields a newer server adds", () => {
    const initial = decodeItem({ kind: "snapshot", snapshot: fixture.initial });
    if (initial.kind !== "snapshot") throw new Error("snapshot");
    const patched = applyThreadPatch(initial.snapshot.thread, {
      set: { futureField: 1, title: "Renamed" },
      unset: [],
      arrays: { futureList: { length: 1, changes: [[0, 1]] } },
    });
    expect(patched).toEqual({ ...initial.snapshot.thread, title: "Renamed" });
  });

  // Written by the server test `thread_stream_window_fixture_matches_the_wire` (#226): a
  // subscribe with `history`, the windowed snapshot with a live and a carried row, a patch,
  // every older page, a page answered stale after a revert, and the whole thread.
  it("rebuilds the windowed snapshot, carried rows and pages from window.json", () => {
    const window = JSON.parse(
      NodeFS.readFileSync(
        NodePath.resolve(
          import.meta.dirname,
          "../../../contracts/fixtures/thread-stream/window.json",
        ),
        "utf8",
      ),
    ) as {
      input: unknown;
      items: ReadonlyArray<unknown>;
      pages: ReadonlyArray<unknown>;
      stalePage: { _tag: string };
      whole: unknown;
    };
    expect(decodeSubscribeInput(window.input).history).toEqual({});
    const [opened, patch] = window.items.map((item) => decodeItem(item));
    if (opened?.kind !== "snapshot" || patch?.kind !== "patch") throw new Error("snapshot, patch");
    const history = opened.snapshot.thread.history;
    expect(history?.hasOlder).toBe(true);
    expect(history?.carried.activities.map((row) => row.id)).toEqual(["ask"]);
    expect(opened.snapshot.thread.messages.some((row) => row.streaming)).toBe(true);
    const held = applyThreadPatch(opened.snapshot.thread, patch.patch);
    const older = window.pages
      .map((page) => decodePage(page))
      .reduce<OlderHistory | null>((loaded, page) => appendHistoryPage(loaded, page), null);
    expect(window.pages.length).toBeGreaterThanOrEqual(2);
    const merged = mergeThreadHistory(held, older);
    const whole = decodeThreadSnapshot(window.whole).thread;
    const byId = <T extends { readonly id: string }>(rows: ReadonlyArray<T>) =>
      rows.toSorted((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    // Every row exactly once, each the server's current copy.
    expect(byId(merged.messages)).toEqual(byId(whole.messages));
    expect(merged.activities).toEqual(whole.activities);
    expect(merged.history).toMatchObject({ hasOlder: false, olderRows: 0, loadedFrom: null });
    expect(window.stalePage._tag).toBe("OrchestrationThreadHistoryStaleError");
  });
});
