import * as Effect from "effect/Effect";
import { afterEach, describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Fiber from "effect/Fiber";
import type { DownloadStart } from "@bibcode/client-runtime/operations";
import {
  browserDownloadSink,
  desktopDownloadSink,
  streamingDownloadBridge,
  saveBrowserDownload,
} from "./fileTransfers";
const start = (sizeBytes: number | null = 3): DownloadStart =>
  sizeBytes === null
    ? { _tag: "start", fileName: "a.zip", kind: "archive", sizeBytes: null, version: null }
    : {
        _tag: "start",
        fileName: "a.bin",
        kind: "file",
        sizeBytes,
        version: { sizeBytes, modifiedAtNs: "1" },
      };
function bridgeFixture() {
  return {
    pickFolder: vi.fn(async () => "/picked"),
    beginDownloadFile: vi.fn(async () => ({ handle: "owned" })),
    appendDownloadFile: vi.fn(async (_input: { handle: string; bytes: Uint8Array }) => {}),
    finishDownloadFile: vi.fn(async () => ({ path: "/picked/a.bin" })),
    abortDownloadFile: vi.fn(async (_input: { handle: string }) => {}),
  };
}
afterEach(() => {
  vi.useRealTimers();
});
describe("browser download sink", () => {
  it.effect("rejects known sizes over 2 GiB before bytes, and accepts the boundary", () =>
    Effect.gen(function* () {
      const sink = browserDownloadSink();
      expect((yield* Effect.flip(sink.start(start(2 * 1024 ** 3 + 1)))).message).toBe(
        "This download exceeds the 2 GiB browser limit. Use the desktop app.",
      );
      yield* sink.start(start(2 * 1024 ** 3));
      yield* sink.abort();
    }),
  );
  it.effect("refuses unknown archives before crossing cumulative storage budget", () =>
    Effect.gen(function* () {
      const sink = browserDownloadSink({ maximumBytes: 4 });
      yield* sink.start(start(null));
      yield* sink.write(0, new Uint8Array([1, 2, 3]));
      expect((yield* Effect.flip(sink.write(3, new Uint8Array([4, 5])))).message).toContain(
        "2 GiB browser limit",
      );
      const result = yield* sink.finish();
      expect(
        Array.from(new Uint8Array(yield* Effect.promise(() => result.blob.arrayBuffer()))),
      ).toEqual([1, 2, 3]);
    }),
  );
  it.effect("owns retained bytes and clears old parts on archive reset", () =>
    Effect.gen(function* () {
      const sink = browserDownloadSink();
      const bytes = new Uint8Array([1, 2, 3]);
      yield* sink.start(start(null));
      yield* sink.write(0, bytes);
      bytes.fill(7);
      const first = yield* sink.finish();
      expect(
        Array.from(new Uint8Array(yield* Effect.promise(() => first.blob.arrayBuffer()))),
      ).toEqual([1, 2, 3]);
      yield* sink.reset(start(null));
      yield* sink.write(0, new Uint8Array([4]));
      const second = yield* sink.finish();
      expect(
        Array.from(new Uint8Array(yield* Effect.promise(() => second.blob.arrayBuffer()))),
      ).toEqual([4]);
    }),
  );
  it.effect("supports empty files and clears abandoned parts on abort", () =>
    Effect.gen(function* () {
      const sink = browserDownloadSink();
      yield* sink.start(start(0));
      expect((yield* sink.finish()).blob.size).toBe(0);
      yield* sink.start(start(null));
      yield* sink.write(0, new Uint8Array([9]));
      yield* sink.abort();
      yield* sink.start(start(0));
      expect((yield* sink.finish()).blob.size).toBe(0);
    }),
  );
});
describe("native raw sink", () => {
  it("requires all four bridge methods", () => {
    const bridge = bridgeFixture();
    expect(streamingDownloadBridge(bridge)).not.toBeNull();
    for (const name of [
      "beginDownloadFile",
      "appendDownloadFile",
      "finishDownloadFile",
      "abortDownloadFile",
    ] as const)
      expect(streamingDownloadBridge({ ...bridge, [name]: undefined })).toBeNull();
    expect(streamingDownloadBridge(undefined)).toBeNull();
  });
  it.effect("awaits append and forwards the original Uint8Array", () =>
    Effect.gen(function* () {
      const bridge = bridgeFixture();
      // This is the native Promise boundary; the tested sink executes in the scoped test fiber.
      let resolve!: () => void;
      bridge.appendDownloadFile.mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      );
      const sink = desktopDownloadSink(bridge, "/picked");
      yield* sink.start(start());
      const bytes = new Uint8Array([1, 2, 3]);
      let settled = false;
      const write = yield* Effect.forkChild(
        sink.write(0, bytes).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              settled = true;
            }),
          ),
        ),
      );
      yield* Effect.yieldNow;
      expect(settled).toBe(false);
      expect(bridge.appendDownloadFile.mock.calls[0]?.[0]?.bytes).toBe(bytes);
      resolve();
      yield* Fiber.join(write);
      expect(yield* sink.finish()).toEqual({ path: "/picked/a.bin" });
      yield* sink.abort();
      expect(bridge.abortDownloadFile).not.toHaveBeenCalled();
    }),
  );
  it.effect("joins old-handle abort before archive restart", () =>
    Effect.gen(function* () {
      const bridge = bridgeFixture();
      let release!: () => void;
      bridge.abortDownloadFile.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const sink = desktopDownloadSink(bridge, "/picked");
      yield* sink.start(start(null));
      const reset = yield* Effect.forkChild(sink.reset(start(null)));
      yield* Effect.yieldNow;
      expect(bridge.beginDownloadFile).toHaveBeenCalledTimes(1);
      release();
      yield* Fiber.join(reset);
      expect(bridge.beginDownloadFile).toHaveBeenCalledTimes(2);
      yield* sink.abort();
    }),
  );
  it.effect("keeps a late begin owned so cancellation cleans its native handle", () =>
    Effect.gen(function* () {
      const bridge = bridgeFixture();
      let release!: (value: { handle: string }) => void;
      bridge.beginDownloadFile.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const sink = desktopDownloadSink(bridge, "/picked");
      let settled = false;
      const run = yield* Effect.forkChild(
        sink.start(start()).pipe(
          Effect.onExit(() => sink.abort()),
          Effect.onExit(() =>
            Effect.sync(() => {
              settled = true;
            }),
          ),
        ),
      );
      yield* Effect.yieldNow;
      const interrupted = yield* Effect.forkChild(Fiber.interrupt(run));
      yield* Effect.yieldNow;
      expect(settled).toBe(false);
      release({ handle: "late" });
      yield* Fiber.join(interrupted);
      expect(bridge.abortDownloadFile).toHaveBeenCalledWith({ handle: "late" });
    }),
  );
  it.effect("surfaces native string failures", () =>
    Effect.gen(function* () {
      const bridge = bridgeFixture();
      bridge.beginDownloadFile.mockRejectedValueOnce("Disk is full.");
      expect(
        (yield* Effect.flip(desktopDownloadSink(bridge, "/picked").start(start()))).message,
      ).toBe("Disk is full.");
    }),
  );
});
describe("browser Save gesture", () => {
  it("creates, clicks, removes and revokes one owned anchor URL only on Save", () => {
    vi.useFakeTimers();
    const anchor = { href: "", download: "", rel: "", click: vi.fn(), remove: vi.fn() };
    const doc = {
      createElement: () => anchor,
      body: { appendChild: vi.fn() },
    } as unknown as Document;
    const urls = { createObjectURL: vi.fn(() => "blob:own-download"), revokeObjectURL: vi.fn() };
    const value = { fileName: "a.bin", blob: new Blob(["abc"]) };
    expect(urls.createObjectURL).not.toHaveBeenCalled();
    saveBrowserDownload(value, doc, urls);
    expect(urls.createObjectURL).toHaveBeenCalledWith(value.blob);
    expect(anchor.download).toBe("a.bin");
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(urls.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:own-download");
  });
  it("cleans on synchronous Save failure and preserves ready bytes", () => {
    const anchor = {
      href: "",
      download: "",
      rel: "",
      click: vi.fn(() => {
        throw new Error("Save was blocked.");
      }),
      remove: vi.fn(),
    };
    const doc = {
      createElement: () => anchor,
      body: { appendChild: vi.fn() },
    } as unknown as Document;
    const urls = { createObjectURL: vi.fn(() => "blob:own-download"), revokeObjectURL: vi.fn() };
    const value = { fileName: "a.bin", blob: new Blob(["abc"]) };
    expect(() => saveBrowserDownload(value, doc, urls)).toThrow("Save was blocked.");
    expect(urls.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:own-download");
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(value.blob.size).toBe(3);
  });
});
