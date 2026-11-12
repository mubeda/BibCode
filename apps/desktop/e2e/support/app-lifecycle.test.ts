import { describe, expect, it, vi } from "vite-plus/test";

import {
  dispatchDesktopUiApplicationExit,
  isDeadDesktopUiWebviewError,
  isFinalDesktopUiSpec,
  recoverDeadDesktopUiWebview,
} from "./app-lifecycle.ts";

describe("dispatchDesktopUiApplicationExit", () => {
  it("waits for native runtime shutdown before closing the main Tauri window", async () => {
    let acceptShutdown = (): void => {
      throw new Error("Shutdown acceptance was not initialized.");
    };
    const shutdownAccepted = new Promise<unknown>((resolve) => {
      acceptShutdown = () => resolve(undefined);
    });
    const invoke = vi
      .fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>()
      .mockImplementationOnce(() => shutdownAccepted)
      .mockResolvedValueOnce(undefined);

    const exitRequest = dispatchDesktopUiApplicationExit({
      __TAURI__: { core: { invoke } },
    });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("desktop_e2e_prepare_for_exit");

    acceptShutdown();
    await expect(exitRequest).resolves.toBe(true);
    expect(invoke).toHaveBeenNthCalledWith(2, "plugin:window|close", { label: "main" });
  });

  it("reports that no native close request was dispatched without the Tauri bridge", async () => {
    await expect(dispatchDesktopUiApplicationExit({})).resolves.toBe(false);
  });
});

describe("isFinalDesktopUiSpec", () => {
  const configuredSpecs = ["./specs/main-window.e2e.ts", "./specs/chat-activity-panel.e2e.ts"];

  it("defers shutdown while later configured specs still need the shared application", () => {
    expect(
      isFinalDesktopUiSpec(
        ["file:///X:/BibCode/apps/desktop/e2e/specs/main-window.e2e.ts"],
        configuredSpecs,
      ),
    ).toBe(false);
  });

  it("selects the final configured spec across WebdriverIO path formats", () => {
    expect(
      isFinalDesktopUiSpec(
        [String.raw`X:\BibCode\apps\desktop\e2e\specs\chat-activity-panel.e2e.ts`],
        configuredSpecs,
      ),
    ).toBe(true);
  });
});

describe("isDeadDesktopUiWebviewError", () => {
  it.each([
    "invalid session id",
    "no such window: target window already closed",
    "Error: connect ECONNREFUSED 127.0.0.1:4445",
    "socket hang up",
  ])("recognises %s as a dead webview", (message) => {
    expect(isDeadDesktopUiWebviewError(new Error(message))).toBe(true);
  });

  it("leaves an ordinary script failure alone", () => {
    expect(isDeadDesktopUiWebviewError(new Error("TypeError: x is not a function"))).toBe(false);
    expect(isDeadDesktopUiWebviewError("invalid session id")).toBe(false);
  });
});

describe("recoverDeadDesktopUiWebview", () => {
  const deps = (probe: () => Promise<unknown>, running: boolean) => ({
    probe: vi.fn(probe),
    isRunning: vi.fn(async () => running),
    stopApplication: vi.fn(async () => undefined),
    relaunch: vi.fn(async () => undefined),
  });

  it("does nothing when the probe answers", async () => {
    const live = deps(async () => true, true);
    await expect(recoverDeadDesktopUiWebview(live)).resolves.toBe(false);
    expect(live.relaunch).not.toHaveBeenCalled();
    expect(live.stopApplication).not.toHaveBeenCalled();
  });

  it("relaunches an app whose process is gone", async () => {
    const dead = deps(() => Promise.reject(new Error("invalid session id")), false);
    await expect(recoverDeadDesktopUiWebview(dead)).resolves.toBe(true);
    expect(dead.stopApplication).not.toHaveBeenCalled();
    expect(dead.relaunch).toHaveBeenCalledOnce();
  });

  it("stops an app that still runs behind a dead webview before relaunching it", async () => {
    const order: string[] = [];
    const dead = deps(() => Promise.reject(new Error("no such window")), true);
    dead.stopApplication.mockImplementation(async () => void order.push("stop"));
    dead.relaunch.mockImplementation(async () => void order.push("relaunch"));
    await expect(recoverDeadDesktopUiWebview(dead)).resolves.toBe(true);
    expect(order).toEqual(["stop", "relaunch"]);
  });

  it("rethrows a probe failure that is not a dead webview, without relaunching", async () => {
    const odd = deps(() => Promise.reject(new Error("TypeError: boom")), true);
    await expect(recoverDeadDesktopUiWebview(odd)).rejects.toThrow("boom");
    expect(odd.relaunch).not.toHaveBeenCalled();
  });

  it("relaunches once: a relaunch that fails is reported, not retried", async () => {
    const dead = deps(() => Promise.reject(new Error("invalid session id")), false);
    dead.relaunch.mockRejectedValue(new Error("never served WebDriver"));
    await expect(recoverDeadDesktopUiWebview(dead)).rejects.toThrow("never served WebDriver");
    expect(dead.relaunch).toHaveBeenCalledOnce();
  });
});
