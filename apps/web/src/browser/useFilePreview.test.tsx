// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import { AtomRegistry, AsyncResult, type Atom } from "effect/unstable/reactivity";
import { act, startTransition, Suspense, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
const h = vi.hoisted(() => ({
  run: vi.fn(),
  apply: vi.fn(),
  remember: vi.fn(),
  browser: vi.fn(),
  toast: vi.fn(),
  atoms: null as unknown,
  hook: null as unknown,
}));
vi.mock("~/state/fileTransfers", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const availability = Atom.family((_id: EnvironmentId) =>
    Atom.make({ route: "http", connected: true, serverName: "Studio" }),
  );
  h.atoms = availability;
  return { fileTransfers: { availability } };
});
vi.mock("~/state/preview", () => ({
  previewEnvironment: { openFile: { label: "open-file", run: h.run } },
}));
vi.mock("~/previewStateStore", () => ({
  isPreviewSupportedInRuntime: () => true,
  applyPreviewServerSnapshot: h.apply,
  rememberPreviewUrl: h.remember,
}));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openBrowser: h.browser }) },
}));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (v: unknown) => v,
  toastManager: { add: h.toast },
}));
import { useFilePreview } from "./useFilePreview";
const environmentId = EnvironmentId.make("host"),
  threadRef = scopeThreadRef(environmentId, ThreadId.make("thread"));
const value = {
  url: "https://bound.invalid/api/assets/key/file.html",
  snapshot: {
    threadId: threadRef.threadId,
    tabId: "tab",
    navStatus: { _tag: "Idle" as const },
    canGoBack: false,
    canGoForward: false,
    updatedAt: "2026-10-02T00:00:00Z",
  },
  isCurrentContext: () => true,
};
let registry: AtomRegistry.AtomRegistry, root: Root, container: HTMLDivElement;
function Probe({
  contextKey = "first",
  currentThread = threadRef,
}: {
  contextKey?: string;
  currentThread?: typeof threadRef;
}) {
  const selected = useFilePreview({
    environmentId: currentThread.environmentId,
    threadRef: currentThread,
    contextKey,
  });
  useLayoutEffect(() => {
    h.hook = selected;
  }, [selected]);
  return (
    <output>{selected.availability.enabled ? "available" : selected.availability.reason}</output>
  );
}
const hook = () => h.hook as ReturnType<typeof useFilePreview>;
async function render(contextKey = "first", currentThread = threadRef) {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <Probe contextKey={contextKey} currentThread={currentThread} />
      </RegistryContext.Provider>,
    ),
  );
}
const atom = () =>
  (
    h.atoms as (
      id: EnvironmentId,
    ) => Atom.Writable<{ route: string; connected: boolean; serverName: string }>
  )(environmentId);
function deferred<A>() {
  let resolve!: (a: A) => void;
  const promise = new Promise<A>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  registry = AtomRegistry.make();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  h.run.mockReset().mockResolvedValue(AsyncResult.success(value));
  h.apply.mockReset();
  h.remember.mockReset();
  h.browser.mockReset();
  h.toast.mockReset();
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  registry.dispose();
  container.remove();
});
describe("file preview view lifetime", () => {
  it("uses the real scoped command with a live signal and publishes only its checked result", async () => {
    await act(async () => {
      expect((await hook().openFile("/repo/file.html"))._tag).toBe("Success");
    });
    expect(h.run).toHaveBeenCalledWith(
      registry,
      { environmentId, input: { threadId: threadRef.threadId, filePath: "/repo/file.html" } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(h.apply).toHaveBeenCalledWith(threadRef, value.snapshot);
  });
  it("exposes pinned refusal and never dispatches a capability operation", async () => {
    await act(async () =>
      registry.set(atom(), { route: "in-channel", connected: true, serverName: "Studio" }),
    );
    expect(container.textContent).toContain(
      "Preview isn't available over encrypted connections yet.",
    );
    await act(async () => {
      await hook().openFile("/repo/file.pdf");
    });
    expect(h.run).not.toHaveBeenCalled();
  });
  it.each(["unmount", "resource", "thread"] as const)(
    "retires %s without stale apply or toast after a pending result",
    async (kind) => {
      const pending = deferred<ReturnType<typeof AsyncResult.success<typeof value>>>();
      h.run.mockReturnValueOnce(pending.promise);
      let result!: ReturnType<ReturnType<typeof useFilePreview>["openFile"]>;
      await act(async () => {
        result = hook().openFile("/repo/file.html");
      });
      const signal = h.run.mock.calls[0]![2].signal as AbortSignal;
      if (kind === "unmount") await act(async () => root.render(null));
      else if (kind === "resource") await render("other-resource");
      else await render("first", scopeThreadRef(environmentId, ThreadId.make("other")));
      expect(signal.aborted).toBe(true);
      pending.resolve(AsyncResult.success(value));
      await act(async () => {
        await result;
      });
      expect(h.apply).not.toHaveBeenCalled();
      expect(h.remember).not.toHaveBeenCalled();
      expect(h.toast).not.toHaveBeenCalled();
    },
  );
  it("keeps metadata label changes on the same view and surfaces active uncertainty", async () => {
    const pending = deferred<ReturnType<typeof AsyncResult.success<typeof value>>>();
    h.run.mockReturnValueOnce(pending.promise);
    let result!: ReturnType<ReturnType<typeof useFilePreview>["openFile"]>;
    await act(async () => {
      result = hook().openFile("file.html");
    });
    await act(async () =>
      registry.set(atom(), { route: "http", connected: true, serverName: "Renamed" }),
    );
    expect((h.run.mock.calls[0]![2].signal as AbortSignal).aborted).toBe(false);
    pending.resolve(
      AsyncResult.failure(
        Cause.fail({
          _tag: "FilePreviewUncertainError",
          message: "The preview may already have opened. Check Preview before trying again.",
        }),
      ) as never,
    );
    await act(async () => {
      await result;
    });
    expect(h.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Preview could not be confirmed",
        description: "The preview may already have opened. Check Preview before trying again.",
      }),
    );
    expect(h.apply).not.toHaveBeenCalled();
  });
});

describe("independent committed view callback review", () => {
  it("does not admit an old resource callback into a replacement view", async () => {
    const oldOpen = hook().openFile;
    const oldCurrent = hook().isCurrentView;
    await render("replacement-resource");
    expect(oldCurrent()).toBe(false);
    expect((await oldOpen("/repo/original.html"))._tag).toBe("Failure");
    expect(h.run).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });
  it("does not revive an old view witness after an A-B-A transition", async () => {
    const oldCurrent = hook().isCurrentView;
    await render("replacement-resource");
    expect(oldCurrent()).toBe(false);
    await render("first");
    expect(oldCurrent()).toBe(false);
    expect(hook().isCurrentView()).toBe(true);
  });
  it("does not let an old callback abort a fresh pending operation", async () => {
    const oldOpen = hook().openFile;
    await render("replacement-resource");
    const pendingResult = deferred<ReturnType<typeof AsyncResult.success<typeof value>>>();
    h.run.mockReturnValueOnce(pendingResult.promise);
    let fresh!: ReturnType<ReturnType<typeof useFilePreview>["openFile"]>;
    await act(async () => {
      fresh = hook().openFile("/repo/current.html");
    });
    const freshSignal = h.run.mock.calls[0]![2].signal as AbortSignal;
    const stale = oldOpen("/repo/original.html");
    pendingResult.resolve(AsyncResult.success(value));
    await Promise.all([fresh, stale]);
    expect(freshSignal.aborted).toBe(false);
    expect(h.run).toHaveBeenCalledOnce();
  });
});

describe("uncommitted preview view", () => {
  it("keeps the committed request alive while a replacement render suspends", async () => {
    const replacementRendered = vi.fn();
    const suspended = new Promise<never>(() => {});
    function ConcurrentProbe({ replacement }: { replacement: boolean }) {
      const selected = useFilePreview({
        environmentId,
        threadRef,
        contextKey: replacement ? "replacement" : "committed",
      });
      useLayoutEffect(() => {
        h.hook = selected;
      }, [selected]);
      if (replacement) {
        replacementRendered();
        throw suspended;
      }
      return <output>committed</output>;
    }
    const tree = (replacement: boolean) => (
      <RegistryContext.Provider value={registry}>
        <Suspense fallback={<output>waiting</output>}>
          <ConcurrentProbe replacement={replacement} />
        </Suspense>
      </RegistryContext.Provider>
    );
    await act(async () => root.render(tree(false)));
    const committed = hook();
    const reply = deferred<ReturnType<typeof AsyncResult.success<typeof value>>>();
    h.run.mockReturnValueOnce(reply.promise);
    let result!: ReturnType<typeof committed.openFile>;
    await act(async () => {
      result = committed.openFile("/repo/committed.html");
    });
    const signal = h.run.mock.calls[0]![2].signal as AbortSignal;
    await act(async () => {
      startTransition(() => root.render(tree(true)));
    });
    expect(replacementRendered).toHaveBeenCalled();
    expect(container.textContent).toBe("committed");
    expect(committed.isCurrentView()).toBe(true);
    expect(signal.aborted).toBe(false);
    reply.resolve(AsyncResult.success(value));
    await act(async () => {
      expect((await result)._tag).toBe("Success");
    });
    expect(h.run).toHaveBeenCalledOnce();
    expect(h.apply).toHaveBeenCalledWith(threadRef, value.snapshot);
  });
});
