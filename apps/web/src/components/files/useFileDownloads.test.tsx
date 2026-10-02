/* oxlint-disable react/immutability -- The SSR probe captures the hook result for behavioral tests. */
import { EnvironmentId } from "@bibcode/contracts";
import * as Effect from "effect/Effect";
import type { DownloadSink } from "@bibcode/client-runtime/operations";
import type { DownloadResult } from "@bibcode/client-runtime/state/file-transfers";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
const state = vi.hoisted(() => ({
  availability: { route: "http", connected: true, serverName: "Studio" },
  phase: null as string | null,
  cancellable: true,
  calls: [] as Array<{ label: string; input: any }>,
  prepare: vi.fn(),
  mint: vi.fn(),
  download: vi.fn(),
  release: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("@effect/atom-react", async () => {
  const React = await import("react");
  return {
    RegistryContext: React.createContext({}),
    useAtomValue: (atom: { kind: string }, select?: (value: any) => any) => {
      const value =
        atom.kind === "empty-availability"
          ? { route: "unavailable", connected: false, serverName: "Server" }
          : atom.kind === "empty-operation"
            ? null
            : atom.kind === "availability"
              ? state.availability
              : state.phase === null
                ? null
                : { phase: state.phase, cancellable: state.cancellable };
      return select ? select(value) : value;
    },
  };
});
vi.mock("~/state/fileTransfers", () => ({
  noFileTransferAvailability: { kind: "empty-availability" },
  noFileTransferOperation: { kind: "empty-operation" },
  fileTransfers: {
    availability: () => ({ kind: "availability" }),
    operation: () => ({ kind: "operation" }),
    prepareDownload: { label: "prepare" },
    prepareHttpDownload: { label: "mint" },
    download: { label: "download" },
    releaseAdmission: (...args: unknown[]) => state.release(...args),
    dismiss: (...args: unknown[]) => state.dismiss(...args),
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) => async (input: any) => {
    state.calls.push({ label: command.label, input });
    return await { prepare: state.prepare, mint: state.mint, download: state.download }[
      command.label
    ]!(input);
  },
}));
vi.mock("@bibcode/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: (r: { interrupted?: boolean }) => r.interrupted === true,
  squashAtomCommandFailure: (r: { error?: unknown }) => r.error,
}));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (v: unknown) => v,
  toastManager: { add: vi.fn() },
}));
import { useFileDownloads } from "./useFileDownloads";
const environmentId = EnvironmentId.make("host");
const token = { operationId: 1, serverName: "Studio", route: "http" };
function render(selectedEnvironmentId: EnvironmentId | null = environmentId) {
  const showMutationError = vi.fn(),
    toasts = { add: vi.fn() };
  const captured = { value: null as ReturnType<typeof useFileDownloads> | null };
  function Probe() {
    captured.value = useFileDownloads({
      environmentId: selectedEnvironmentId,
      cwd: "/original",
      showMutationError,
      toasts,
    });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (captured.value === null) throw new Error("Download hook did not render.");
  return { ...captured.value, showMutationError, toasts };
}
async function flush() {
  for (let i = 0; i < 24; i++) await Promise.resolve();
}
function deferred<A>() {
  let resolve!: (a: A) => void;
  const promise = new Promise<A>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function native() {
  return {
    pickFolder: vi.fn(async (): Promise<string | null> => "/picked"),
    downloadToFolder: vi.fn(async () => "/picked/a.txt"),
    beginDownloadFile: vi.fn(async () => ({ handle: "h" })),
    appendDownloadFile: vi.fn(async () => {}),
    finishDownloadFile: vi.fn(async () => ({ path: "/picked/a.txt" })),
    abortDownloadFile: vi.fn(async () => {}),
  };
}
beforeEach(() => {
  state.availability = { route: "http", connected: true, serverName: "Studio" };
  state.phase = null;
  state.cancellable = true;
  state.calls = [];
  state.prepare.mockReset().mockImplementation(async () => ({
    _tag: "Success",
    value: { ...token, route: state.availability.route },
  }));
  state.mint.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { url: "https://fresh.invalid/api/transfers/signed", fileName: "a.txt" },
  });
  state.download
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { path: "/fixture/saved.txt" } });
  state.release.mockReset();
  state.dismiss.mockReset();
  vi.stubGlobal("window", {});
});
afterEach(() => vi.unstubAllGlobals());
describe("Files download admission hookup", () => {
  it("refuses an empty environment scope without inventing an ID or starting work", async () => {
    const h = render(null);
    expect(h.downloadDisabledReason).toContain("Reconnect");
    h.downloadEntry("a.txt");
    await flush();
    expect(state.prepare).not.toHaveBeenCalled();
    expect(h.getUploadDisabledReason()).toContain("Reconnect");
  });
  it("captures original intent before picker and consumes only the guarded fresh HTTP URL", async () => {
    const bridge = native(),
      chosen = deferred<string | null>();
    bridge.pickFolder.mockReturnValue(chosen.promise);
    vi.stubGlobal("window", { desktopBridge: bridge });
    const h = render();
    h.downloadEntry("original.txt");
    await flush();
    expect(state.calls.map((c) => c.label)).toEqual(["prepare"]);
    expect(state.calls[0]!.input).toEqual({
      environmentId,
      cwd: "/original",
      relativePath: "original.txt",
    });
    expect(state.release).not.toHaveBeenCalled();
    chosen.resolve("/picked");
    await flush();
    expect(bridge.downloadToFolder).toHaveBeenCalledWith({
      directory: "/picked",
      url: "https://fresh.invalid/api/transfers/signed",
      fileName: "a.txt",
    });
    expect(state.calls[1]!.input).toEqual({ environmentId, admission: token });
    expect(state.release).toHaveBeenCalledOnce();
    expect(h.toasts.add).toHaveBeenCalledWith(
      expect.objectContaining({ description: "/picked/a.txt" }),
    );
  });
  it("does not release a legacy native HTTP claim before the noncancellable save settles", async () => {
    const bridge = native(),
      saved = deferred<string>();
    bridge.downloadToFolder.mockReturnValue(saved.promise);
    vi.stubGlobal("window", { desktopBridge: bridge });
    const h = render();
    h.downloadEntry("a.txt");
    await flush();
    expect(bridge.downloadToFolder).toHaveBeenCalledOnce();
    expect(state.release).not.toHaveBeenCalled();
    saved.resolve("/picked/final.txt");
    await flush();
    expect(state.release).toHaveBeenCalledOnce();
  });
  it("releases a cancelled picker without minting or beginning a sink", async () => {
    const bridge = native();
    bridge.pickFolder.mockResolvedValue(null);
    vi.stubGlobal("window", { desktopBridge: bridge });
    render().downloadEntry("a.txt");
    await flush();
    expect(state.mint).not.toHaveBeenCalled();
    expect(state.download).not.toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledOnce();
  });
  it("refuses picker-invalidated HTTP admission without native save", async () => {
    const bridge = native();
    state.mint.mockResolvedValue({ _tag: "Failure", interrupted: true });
    vi.stubGlobal("window", { desktopBridge: bridge });
    const h = render();
    h.downloadEntry("a.txt");
    await flush();
    expect(bridge.downloadToFolder).not.toHaveBeenCalled();
    expect(h.showMutationError).not.toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledOnce();
  });
  it.each(["beginDownloadFile", "appendDownloadFile", "finishDownloadFile", "abortDownloadFile"])(
    "disables older pinned native hosts missing %s without HTTP fallback",
    async (missing) => {
      state.availability.route = "in-channel";
      const bridge = { ...native(), [missing]: undefined };
      vi.stubGlobal("window", { desktopBridge: bridge });
      const h = render();
      expect(h.downloadDisabledReason).toBe("Update this app to save encrypted downloads");
      h.downloadEntry("a.txt");
      await flush();
      expect(state.mint).not.toHaveBeenCalled();
      expect(state.download).not.toHaveBeenCalled();
      expect(bridge.pickFolder).not.toHaveBeenCalled();
      expect(bridge.downloadToFolder).not.toHaveBeenCalled();
    },
  );
  it.effect("selects the real raw sink after native picker without any HTTP mint", () =>
    Effect.gen(function* () {
      state.availability.route = "in-channel";
      const bridge = native();
      vi.stubGlobal("window", { desktopBridge: bridge });
      render().downloadEntry("a.txt");
      yield* Effect.promise(flush);
      const sink = state.download.mock.calls[0]![0].sink as DownloadSink<DownloadResult>;
      yield* sink.start({
        _tag: "start",
        kind: "file",
        fileName: "a.txt",
        sizeBytes: 1,
        version: { sizeBytes: 1, modifiedAtNs: "1" },
      });
      yield* sink.write(0, new Uint8Array([7]));
      yield* sink.finish();
      expect(state.mint).not.toHaveBeenCalled();
      expect(bridge.downloadToFolder).not.toHaveBeenCalled();
      expect(bridge.beginDownloadFile).toHaveBeenCalledWith({
        directory: "/picked",
        fileName: "a.txt",
      });
      expect(bridge.appendDownloadFile).toHaveBeenCalledWith({
        handle: "h",
        bytes: new Uint8Array([7]),
      });
    }),
  );
  it("selects Blob ready sink in browser without automatic Save or HTTP", async () => {
    state.availability.route = "in-channel";
    const h = render();
    h.downloadEntry("a.txt");
    await flush();
    await new Promise((r) => setTimeout(r, 0));
    await flush();
    expect(state.download).toHaveBeenCalledOnce();
    expect(state.mint).not.toHaveBeenCalled();
    expect(h.toasts.add).not.toHaveBeenCalled();
    expect(state.release).toHaveBeenCalledOnce();
  });
  it("explains unavailable encrypted route and keeps legacy uploads blocked", async () => {
    state.availability.route = "unavailable";
    const h = render();
    expect(h.downloadDisabledReason).toBe(
      "Update Studio to transfer files over its encrypted connection",
    );
    expect(h.uploadDisabledReason).toBe(h.downloadDisabledReason);
    h.downloadEntry("a.txt");
    await flush();
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.mint).not.toHaveBeenCalled();
  });
  it("projects busy states without subscribing the tree to decoded byte progress", () => {
    state.phase = "ready";
    expect(render().downloadDisabledReason).toBe(
      "Save or dismiss the ready download before starting another.",
    );
    state.phase = "running";
    expect(render().downloadDisabledReason).toBe("Finish or cancel the current transfer.");
    state.cancellable = false;
    expect(render().downloadDisabledReason).toBe("Wait for the current download to finish.");
  });
});
