// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@bibcode/contracts";
import type { FileTransferOperation } from "@bibcode/client-runtime/state/file-transfers";
import { AtomRegistry, type Atom } from "effect/unstable/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
const h = vi.hoisted(() => ({
  atom: null as unknown,
  cancel: vi.fn(),
  dismiss: vi.fn(),
  save: vi.fn(),
  payloads: new Map<string, any>(),
  nextId: 0,
  add: vi.fn(),
  update: vi.fn(),
  close: vi.fn(),
}));
vi.mock("~/state/fileTransfers", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  const operations = Atom.make<ReadonlyMap<EnvironmentId, FileTransferOperation>>(new Map());
  h.atom = operations;
  return {
    fileTransfers: {
      operations,
      operation: Atom.family((id: EnvironmentId) =>
        Atom.make((get) => get(operations).get(id) ?? null),
      ),
      cancel: h.cancel,
      dismiss: h.dismiss,
    },
  };
});
vi.mock("./fileTransfers", () => ({
  saveBrowserDownload: (...args: unknown[]) => h.save(...args),
}));
vi.mock("../ui/toast", () => ({
  toastManager: {
    add: (payload: any) => {
      const id = `toast-${++h.nextId}`;
      h.payloads.set(id, payload);
      h.add(payload);
      return id;
    },
    update: (id: string, payload: any) => {
      h.payloads.set(id, payload);
      h.update(id, payload);
    },
    close: (id: string) => {
      h.close(id);
      h.payloads.get(id)?.onClose();
      h.payloads.delete(id);
    },
  },
}));
import { FileTransferToasts } from "./FileTransferToasts";
const host = EnvironmentId.make("host"),
  other = EnvironmentId.make("other");
const progress = {
  direction: "download" as const,
  fileName: "a.zip",
  sentBytes: 0,
  totalBytes: 10 * 1024 ** 2,
  phase: "transferring" as const,
};
const running = (id = 1) => ({
  operationId: id,
  serverName: "Studio",
  fileName: "a.zip",
  route: "in-channel" as const,
  cancellable: true,
  phase: "running" as const,
  progress,
});
let root: Root, container: HTMLDivElement, registry: AtomRegistry.AtomRegistry;
const operationAtom = () =>
  h.atom as Atom.Writable<ReadonlyMap<EnvironmentId, FileTransferOperation>>;
async function set(entries: ReadonlyMap<EnvironmentId, FileTransferOperation>) {
  await act(async () => {
    registry.set(operationAtom(), entries);
  });
}
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.payloads.clear();
  h.nextId = 0;
  h.add.mockClear();
  h.update.mockClear();
  h.close.mockClear();
  h.cancel.mockClear();
  h.dismiss.mockClear();
  h.save.mockClear();
  registry = AtomRegistry.make();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <FileTransferToasts />
      </RegistryContext.Provider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  registry.dispose();
  container.remove();
});
describe("root transfer toast observers", () => {
  it("updates one toast only when rounded copy changes and keeps other environments independent", async () => {
    await set(new Map([[host, running()]]));
    expect(h.add).toHaveBeenCalledTimes(1);
    await set(new Map([[host, { ...running(), progress: { ...progress, sentBytes: 1 } }]]));
    expect(h.update).not.toHaveBeenCalled();
    await set(
      new Map([
        [host, { ...running(), progress: { ...progress, sentBytes: 1024 ** 2 } }],
        [other, running(2)],
      ]),
    );
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.add).toHaveBeenCalledTimes(2);
  });
  it("renders Save as a real action, saves and dismisses the exact ready operation once", async () => {
    const result = { fileName: "a.zip", blob: new Blob(["payload"]) };
    await set(new Map([[host, { ...running(), phase: "ready", result, cancellable: false }]]));
    const payload = h.payloads.values().next().value;
    expect(payload.actionProps.children).toBe("Save");
    payload.actionProps.onClick();
    payload.actionProps.onClick();
    expect(h.save).toHaveBeenCalledOnce();
    expect(h.save).toHaveBeenCalledWith(result);
    expect(h.dismiss).toHaveBeenCalledWith(registry, host, 1);
  });
  it("keeps joined finishing visible after catalog removal and cannot Cancel its publication", async () => {
    await set(new Map([[host, { ...running(), phase: "finishing", cancellable: false }]]));
    const payload = h.payloads.values().next().value;
    expect(payload.title).toBe("Finishing a.zip…");
    expect(payload.actionProps).toBeUndefined();
    payload.onClose();
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.dismiss).not.toHaveBeenCalled();
    await set(
      new Map([
        [host, { ...running(), phase: "saved", path: "/picked/a.zip", cancellable: false }],
      ]),
    );
    expect(h.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Download saved", description: "/picked/a.zip" }),
    );
  });
  it("keeps HTTP downloading noncancellable and programmatic observer disposal preserves work", async () => {
    await set(new Map([[host, { ...running(), route: "http", cancellable: false }]]));
    const payload = h.payloads.values().next().value;
    expect(payload.title).toBe("Downloading a.zip…");
    expect(payload.actionProps).toBeUndefined();
    await act(async () => root.render(null));
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.dismiss).not.toHaveBeenCalled();
    expect(() => payload.onClose()).not.toThrow();
    expect(h.cancel).not.toHaveBeenCalled();
  });
  it("closes absent records without cancel and stale callbacks cannot affect a newer invocation", async () => {
    await set(new Map([[host, running()]]));
    const old = h.payloads.values().next().value;
    await set(new Map());
    old.actionProps.onClick();
    expect(h.cancel).not.toHaveBeenCalled();
    await set(new Map([[host, running(2)]]));
    old.actionProps.onClick();
    expect(h.cancel).not.toHaveBeenCalled();
    h.payloads.values().next().value.actionProps.onClick();
    expect(h.cancel).toHaveBeenCalledWith(registry, host, 2);
  });
});
