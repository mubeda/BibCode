import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
const h = vi.hoisted(() => ({ supported: true, apply: vi.fn(), remember: vi.fn(), open: vi.fn() }));
vi.mock("~/previewStateStore", () => ({
  isPreviewSupportedInRuntime: () => h.supported,
  applyPreviewServerSnapshot: h.apply,
  rememberPreviewUrl: h.remember,
}));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openBrowser: h.open }) },
}));
import {
  openFileInPreview,
  filePreviewAvailability,
  ENCRYPTED_FILE_PREVIEW_REASON,
} from "./openFileInPreview";
const threadRef = scopeThreadRef(EnvironmentId.make("original"), ThreadId.make("thread"));
const snapshot = {
  threadId: threadRef.threadId,
  tabId: "tab",
  navStatus: { _tag: "Idle" as const },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-10-02T00:00:00Z",
};
const result = {
  isCurrentContext: () => true,
  url: "https://fresh.invalid/api/assets/cap/report.html",
  snapshot,
};
function inputs(
  overrides: Partial<
    Omit<Parameters<typeof openFileInPreview>[0], "openFile" | "threadRef" | "filePath">
  > = {},
) {
  return {
    threadRef,
    filePath: "/workspace/report.html",
    availability: { enabled: true as const },
    openFile: vi.fn(async () => AsyncResult.success(result)),
    isCurrent: () => true,
    ...overrides,
  };
}
beforeEach(() => {
  h.supported = true;
  h.apply.mockReset();
  h.remember.mockReset();
  h.open.mockReset();
});
afterEach(() => vi.restoreAllMocks());
describe("guarded file preview publication", () => {
  it.each(["in-channel", "unavailable"] as const)(
    "refuses pinned %s before calling the operation",
    async (route) => {
      const input = inputs({
        availability: filePreviewAvailability({ route, connected: true }, "report.html"),
      });
      const actual = await openFileInPreview(input);
      expect(actual).toMatchObject({ _tag: "Failure" });
      expect(input.openFile).not.toHaveBeenCalled();
      expect(h.apply).not.toHaveBeenCalled();
      expect(Cause.squash((actual as { cause: Cause.Cause<unknown> }).cause)).toMatchObject({
        message: ENCRYPTED_FILE_PREVIEW_REASON,
      });
    },
  );
  it("uses only the runtime returned URL/snapshot and forwards the initiating signal", async () => {
    const controller = new AbortController(),
      input = inputs({ signal: controller.signal });
    expect((await openFileInPreview(input))._tag).toBe("Success");
    expect(input.openFile).toHaveBeenCalledWith(
      {
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, filePath: input.filePath },
      },
      { signal: controller.signal },
    );
    expect(h.apply).toHaveBeenCalledWith(threadRef, snapshot);
    expect(h.remember).toHaveBeenCalledWith(threadRef, result.url);
    expect(h.open).toHaveBeenCalledWith(threadRef, "tab");
  });
  it("does not invoke an operation for a disposed view", async () => {
    const input = inputs({ isCurrent: () => false });
    const actual = await openFileInPreview(input);
    expect(actual._tag).toBe("Failure");
    expect(input.openFile).not.toHaveBeenCalled();
  });
  it.each(["context", "abort"] as const)(
    "suppresses late manual publication after %s changes",
    async (kind) => {
      let current = true;
      const controller = new AbortController();
      const input = inputs({ signal: controller.signal, isCurrent: () => current });
      input.openFile.mockImplementationOnce(async () => {
        if (kind === "abort") controller.abort();
        else current = false;
        return AsyncResult.success(result);
      });
      expect((await openFileInPreview(input))._tag).toBe("Failure");
      expect(h.apply).not.toHaveBeenCalled();
      expect(h.remember).not.toHaveBeenCalled();
      expect(h.open).not.toHaveBeenCalled();
    },
  );
  it("preserves active-context uncertainty without manual result publication", async () => {
    const failure = AsyncResult.failure(
      Cause.fail({
        _tag: "FilePreviewUncertainError",
        message: "The preview may already have opened. Check Preview before trying again.",
      }),
    );
    const input = inputs();
    input.openFile.mockResolvedValueOnce(failure as never);
    const actual = await openFileInPreview(input);
    expect(actual).toEqual(failure);
    expect(h.apply).not.toHaveBeenCalled();
  });
  it.each(["false", "missing"] as const)(
    "rejects a %s runtime current-context predicate before manual publication",
    async (kind) => {
      const input = inputs();
      input.openFile.mockResolvedValueOnce(
        AsyncResult.success({
          ...result,
          isCurrentContext: kind === "false" ? () => false : undefined,
        }) as never,
      );
      const actual = await openFileInPreview(input);
      expect(actual._tag).toBe("Failure");
      if (actual._tag !== "Failure") throw new Error("Expected uncertain preview");
      expect(Cause.squash(actual.cause)).toMatchObject({
        _tag: "FilePreviewUncertainError",
        message: "The preview may already have opened. Check Preview before trying again.",
      });
      expect(h.apply).not.toHaveBeenCalled();
      expect(h.remember).not.toHaveBeenCalled();
      expect(h.open).not.toHaveBeenCalled();
    },
  );
  it("checks the view again before each remaining manual effect without undoing the first", async () => {
    let current = true;
    h.apply.mockImplementationOnce(() => {
      current = false;
    });
    const actual = await openFileInPreview(inputs({ isCurrent: () => current }));
    expect(actual._tag).toBe("Failure");
    expect(h.apply).toHaveBeenCalledOnce();
    expect(h.remember).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
  });
  it("refuses missing connection and unsupported runtime without a new route", async () => {
    expect(
      filePreviewAvailability({ route: "http", connected: false }, "report.html"),
    ).toMatchObject({ enabled: false });
    h.supported = false;
    const input = inputs();
    expect((await openFileInPreview(input))._tag).toBe("Failure");
    expect(input.openFile).not.toHaveBeenCalled();
  });
});
