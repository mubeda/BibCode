import { Window } from "happy-dom";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createFileTransferToastController,
  type TransferToastState,
  type FileTransferToastPayload,
} from "./transferPresentation";
function harness() {
  let state: TransferToastState | null = null;
  let payload: FileTransferToastPayload | null = null;
  const manager = {
    add: vi.fn((value: FileTransferToastPayload) => {
      payload = value;
      return "toast-1";
    }),
    update: vi.fn((_id: string, value: FileTransferToastPayload) => {
      payload = value;
    }),
    close: vi.fn((_id: string) => {
      payload?.onClose?.();
    }),
  };
  const controller = createFileTransferToastController(manager, () => state);
  return {
    manager,
    controller,
    set: (value: TransferToastState | null) => {
      state = value;
      controller.sync();
    },
    payload: () => payload!,
  };
}
const progress = {
  direction: "download" as const,
  fileName: "a.zip",
  sentBytes: 3 * 1024 ** 2,
  totalBytes: 10 * 1024 ** 2,
  phase: "transferring" as const,
};
describe("one owned transfer toast", () => {
  it("prepares with real Cancel, then shows joined cancellation without another Cancel", () => {
    const h = harness();
    const cancel = vi.fn();
    h.set({ phase: "preparing", operationId: 1, fileName: "a.zip", cancel });
    expect(h.payload().title).toBe("Preparing a.zip…");
    h.payload().actionProps!.onClick();
    expect(cancel).toHaveBeenCalledOnce();
    h.set({ phase: "cancelling", operationId: 1, fileName: "a.zip" });
    expect(h.payload().title).toBe("Cancelling a.zip…");
    expect(h.payload().actionProps).toBeUndefined();
  });
  it("keeps legacy HTTP downloading noncancellable through close until actual completion", () => {
    const h = harness();
    h.set({ phase: "http", operationId: 1, fileName: "a.zip" });
    expect(h.payload().title).toBe("Downloading a.zip…");
    expect(h.payload().actionProps).toBeUndefined();
    h.payload().onClose();
    h.set({ phase: "saved", operationId: 1, path: "/picked/a.zip", discard: vi.fn() });
    expect(h.payload().title).toBe("Download saved");
  });
  it.each(["disposed", "old-instance", "superseded"] as const)(
    "never reads a retired registry through a %s action",
    (retired) => {
      let state: TransferToastState = {
        phase: "ready",
        operationId: 1,
        fileName: "a.zip",
        save: vi.fn(),
        discard: vi.fn(),
      };
      let payload!: FileTransferToastPayload;
      let retiredReader = false;
      let retiredReads = 0;
      const manager = {
        add: vi.fn((value: FileTransferToastPayload) => {
          payload = value;
          return "toast";
        }),
        update: vi.fn((_id: string, value: FileTransferToastPayload) => {
          payload = value;
        }),
        close: vi.fn(),
      };
      const controller = createFileTransferToastController(manager, () => {
        if (retiredReader) {
          retiredReads += 1;
          throw new Error("Registry has been disposed.");
        }
        return state;
      });
      controller.sync();
      const oldAction = payload.actionProps!.onClick;
      if (retired === "disposed") controller.dispose();
      else if (retired === "old-instance") {
        payload.onClose();
        controller.sync();
      } else {
        state = { ...state, operationId: 2 };
        controller.sync();
      }
      retiredReader = true;
      expect(oldAction).not.toThrow();
      expect(retiredReads).toBe(0);
      controller.dispose();
    },
  );
  it("updates one sticky toast and suppresses identical rounded progress", () => {
    const h = harness();
    const cancel = vi.fn();
    h.set({ phase: "running", operationId: 1, progress, cancel });
    h.set({
      phase: "running",
      operationId: 1,
      progress: { ...progress, sentBytes: progress.sentBytes + 1 },
      cancel,
    });
    expect(h.manager.add).toHaveBeenCalledOnce();
    expect(h.manager.update).not.toHaveBeenCalled();
    expect(h.payload().timeout).toBe(0);
    h.set({
      phase: "running",
      operationId: 1,
      progress: { ...progress, sentBytes: 4 * 1024 ** 2 },
      cancel,
    });
    expect(h.manager.update).toHaveBeenCalledOnce();
  });
  it("renders keyboard-focusable Cancel and dispatches exactly one cancellation", () => {
    const h = harness();
    const cancel = vi.fn();
    h.set({ phase: "running", operationId: 1, progress, cancel });
    const window = new Window();
    const button = window.document.createElement("button");
    button.textContent = h.payload().actionProps!.children;
    button.addEventListener("click", h.payload().actionProps!.onClick);
    window.document.body.append(button);
    button.focus();
    expect(window.document.activeElement).toBe(button);
    expect(button.textContent).toBe("Cancel");
    button.click();
    button.click();
    expect(cancel).toHaveBeenCalledOnce();
    window.close();
  });
  it("any user close cancels running work once instead of hiding uncancellable work", () => {
    const h = harness();
    const cancel = vi.fn();
    h.set({ phase: "running", operationId: 1, progress, cancel });
    h.payload().onClose();
    h.payload().onClose();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("retains the file name while reconnecting", () => {
    const h = harness();
    h.set({
      phase: "running",
      operationId: 1,
      progress: { ...progress, phase: "reconnecting" },
      cancel: vi.fn(),
    });
    expect(h.payload().title).toContain("a.zip");
    expect(h.payload().description).toBe("Reconnecting…");
  });
  it("releases dismissed terminal display records and fences a closed toast instance", () => {
    const h = harness();
    const discard = vi.fn();
    h.set({ phase: "saved", operationId: 1, path: "/picked/a.zip", discard });
    const oldClose = h.payload().onClose;
    h.payload().onClose();
    expect(discard).toHaveBeenCalledOnce();
    // The same operation can still be observed before its dismissal update is delivered.
    h.set({ phase: "saved", operationId: 1, path: "/picked/a.zip", discard });
    const closeCount = h.manager.close.mock.calls.length;
    oldClose();
    h.controller.dispose();
    expect(h.manager.close.mock.calls.length).toBe(closeCount + 1);
    expect(discard).toHaveBeenCalledOnce();
  });
  it("keeps Save available after failure and releases ready bytes only on successful Save", () => {
    const h = harness();
    const save = vi.fn().mockImplementationOnce(() => {
      throw new Error("Save blocked.");
    });
    const discard = vi.fn();
    h.set({ phase: "ready", operationId: 1, fileName: "a.zip", save, discard });
    h.payload().actionProps!.onClick();
    expect(discard).not.toHaveBeenCalled();
    expect(h.payload().description).toBe("Save blocked.");
    const window = new Window();
    const button = window.document.createElement("button");
    button.textContent = h.payload().actionProps!.children;
    button.addEventListener("click", h.payload().actionProps!.onClick);
    window.document.body.append(button);
    button.focus();
    expect(window.document.activeElement).toBe(button);
    expect(button.textContent).toBe("Save");
    button.click();
    button.click();
    expect(save).toHaveBeenCalledTimes(2);
    expect(discard).toHaveBeenCalledOnce();
    window.close();
  });
  it("dismisses ready work without invoking Save", () => {
    const h = harness();
    const save = vi.fn();
    const discard = vi.fn();
    h.set({ phase: "ready", operationId: 1, fileName: "a.zip", save, discard });
    h.payload().onClose();
    h.payload().onClose();
    expect(save).not.toHaveBeenCalled();
    expect(discard).toHaveBeenCalledOnce();
  });
  it("fences old callbacks from newer operations and reads finishing state before Cancel", () => {
    const h = harness();
    const oldCancel = vi.fn();
    const newCancel = vi.fn();
    h.set({ phase: "running", operationId: 1, progress, cancel: oldCancel });
    const oldAction = h.payload().actionProps!.onClick;
    const oldClose = h.payload().onClose;
    h.set({ phase: "running", operationId: 2, progress, cancel: newCancel });
    oldAction();
    oldClose();
    expect(oldCancel).not.toHaveBeenCalled();
    expect(newCancel).not.toHaveBeenCalled();
    const cancelAction = h.payload().actionProps!.onClick;
    h.set({ phase: "finishing", operationId: 2, fileName: "a.zip" });
    cancelAction();
    expect(newCancel).not.toHaveBeenCalled();
    expect(h.payload().actionProps).toBeUndefined();
  });
  it("disposing a view closes only its toast and preserves runtime ownership", () => {
    const h = harness();
    const cancel = vi.fn();
    h.set({ phase: "running", operationId: 1, progress, cancel });
    h.controller.dispose();
    expect(h.manager.close).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });
  it("closing finishing display never consumes the eventual saved-record dismissal", () => {
    const h = harness();
    const discard = vi.fn();
    h.set({ phase: "finishing", operationId: 1, fileName: "a.zip" });
    h.payload().onClose();
    h.set({ phase: "saved", operationId: 1, path: "/picked/a.zip", discard });
    h.payload().onClose();
    expect(discard).toHaveBeenCalledOnce();
  });
});
