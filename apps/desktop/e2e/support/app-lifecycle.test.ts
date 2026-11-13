// @effect-diagnostics nodeBuiltinImport:off - The hook-order test reads the WDIO configuration as text.
// @effect-diagnostics globalTimers:off - The deadline tests time their steps with fake timers.
import * as NodeFS from "node:fs";

import { parseSync } from "vite-plus";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DESKTOP_UI_RECOVERY_DEADLINE_MS,
  DESKTOP_UI_TEST_TIMEOUT_MS,
  type RecoveryDeadline,
  dispatchDesktopUiApplicationExit,
  isDeadDesktopUiWebviewError,
  isFinalDesktopUiSpec,
  recoverDeadDesktopUiWebview,
  startRecoveryDeadline,
  tolerateDeadDesktopUiWebview,
  withinRecoveryDeadline,
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
    // WebKitGTK after its web process was killed (Linux lab, 2026-11-12).
    'javascript error: WebDriverError: Unsupported result type when running "execute/sync" with method "POST"',
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
    relaunch: vi.fn(async (_deadline: RecoveryDeadline) => undefined),
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

describe("recovery deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const after = <T>(ms: number, value: T): Promise<T> =>
    new Promise((resolve) => setTimeout(() => resolve(value), ms));
  const dead = () => Promise.reject(new Error("invalid session id"));

  it("a probe that never answers fails at the deadline and relaunches nothing", async () => {
    const relaunch = vi.fn(async (_deadline: RecoveryDeadline) => undefined);
    const recovery = recoverDeadDesktopUiWebview({
      probe: () => new Promise(() => undefined),
      isRunning: async () => true,
      stopApplication: async () => undefined,
      relaunch,
    });
    const outcome = expect(recovery).rejects.toThrow(
      "The webview recovery ran out of its 100000 ms during probe.",
    );
    await vi.advanceTimersByTimeAsync(100_000);
    await outcome;
    expect(relaunch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the stop and the relaunch share one deadline", async () => {
    let remainingAtRelaunch = -1;
    const recovery = recoverDeadDesktopUiWebview({
      probe: dead,
      isRunning: async () => true,
      stopApplication: () => after(60_000, undefined),
      relaunch: (deadline) => {
        remainingAtRelaunch = deadline.remainingMs();
        return after(50_000, undefined);
      },
    });
    const outcome = expect(recovery).rejects.toThrow(
      "The webview recovery ran out of its 100000 ms during relaunch.",
    );
    await vi.advanceTimersByTimeAsync(100_000);
    await outcome;
    expect(remainingAtRelaunch).toBeGreaterThanOrEqual(39_000);
    expect(remainingAtRelaunch).toBeLessThanOrEqual(40_000);
    // The abandoned relaunch settles at 110 s.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a recovery whose steps fit completes", async () => {
    const recovery = recoverDeadDesktopUiWebview({
      probe: dead,
      isRunning: async () => true,
      stopApplication: () => after(10_000, undefined),
      relaunch: () => after(30_000, undefined),
    });
    await vi.advanceTimersByTimeAsync(40_000);
    await expect(recovery).resolves.toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an operation that settles first clears its timer", async () => {
    await expect(
      withinRecoveryDeadline(startRecoveryDeadline(1_000), "step", async () => 7),
    ).resolves.toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the recovery deadline leaves room in the test allowance", () => {
    expect(DESKTOP_UI_RECOVERY_DEADLINE_MS).toBeLessThanOrEqual(
      DESKTOP_UI_TEST_TIMEOUT_MS - 20_000,
    );
  });

  it("relaunches again when the webview dies a second time in the same worker", async () => {
    const relaunch = vi.fn(async (_deadline: RecoveryDeadline) => undefined);
    const deps = {
      probe: dead,
      isRunning: async () => false,
      stopApplication: async () => undefined,
      relaunch,
    };
    await expect(recoverDeadDesktopUiWebview(deps, startRecoveryDeadline())).resolves.toBe(true);
    await expect(recoverDeadDesktopUiWebview(deps, startRecoveryDeadline())).resolves.toBe(true);
    expect(relaunch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("tolerateDeadDesktopUiWebview", () => {
  it("failure evidence tolerates a dead webview", async () => {
    await expect(
      tolerateDeadDesktopUiWebview(() => Promise.reject(new Error("Unsupported result type"))),
    ).resolves.toBeUndefined();
    await expect(
      tolerateDeadDesktopUiWebview(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    await expect(tolerateDeadDesktopUiWebview(async () => 7)).resolves.toBe(7);
  });
});

describe("wdio.conf.ts hooks", () => {
  // Read as text: importing the configuration throws without a packaged binary. The installed
  // TypeScript 7 has no compiler API, so the oxc parser Vite+ ships reads it.
  const text = NodeFS.readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");
  const parsed = parseSync("wdio.conf.ts", text, { lang: "ts" });

  interface AstNode {
    readonly type: string;
    readonly start: number;
    readonly end: number;
    readonly [key: string]: unknown;
  }
  const isNode = (value: unknown): value is AstNode =>
    typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";
  const children = (node: AstNode): AstNode[] =>
    Object.values(node).flatMap((value) =>
      Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : [],
    );
  // Visits every node with its ancestors, nearest last.
  const walk = (node: AstNode, visit: (node: AstNode, ancestors: AstNode[]) => void) => {
    const go = (current: AstNode, ancestors: AstNode[]): void => {
      visit(current, ancestors);
      for (const child of children(current)) go(child, [...ancestors, current]);
    };
    go(node, []);
  };
  const sourceOf = (node: AstNode): string => text.slice(node.start, node.end);

  const hookBody = (name: string): AstNode => {
    let body: AstNode | undefined;
    walk(parsed.program as unknown as AstNode, (node, ancestors) => {
      const declarator = ancestors.at(-2);
      if (
        node.type === "Property" &&
        sourceOf(node.key as AstNode) === name &&
        isNode(node.value) &&
        node.value.type === "ArrowFunctionExpression" &&
        isNode(node.value.body) &&
        node.value.body.type === "BlockStatement" &&
        declarator?.type === "VariableDeclarator" &&
        sourceOf(declarator.id as AstNode) === "config"
      ) {
        body = node.value.body;
      }
    });
    if (body === undefined) throw new Error(`The exported config has no ${name} hook.`);
    return body;
  };
  const callee = (call: AstNode): string => sourceOf(call.callee as AstNode);

  it("parses the configuration", () => {
    expect(parsed.errors).toEqual([]);
  });

  it.each(["beforeTest", "before"])(
    "the %s hook registers the probe before any browser command",
    (name) => {
      const first = (hookBody(name).body as AstNode[])[0];
      expect(first?.type).toBe("ExpressionStatement");
      expect(first === undefined ? undefined : sourceOf(first)).toBe(
        "await ensureLiveDesktopUiWebview();",
      );
    },
  );

  it("the afterTest hook collects failure evidence through the tolerance", () => {
    const evidence: { readonly call: string; readonly tolerated: boolean }[] = [];
    walk(hookBody("afterTest"), (node, ancestors) => {
      if (
        node.type === "CallExpression" &&
        ["browser.saveScreenshot", "browser.getPageSource"].includes(callee(node))
      ) {
        evidence.push({
          call: callee(node),
          tolerated: ancestors.some(
            (ancestor) =>
              ancestor.type === "CallExpression" &&
              callee(ancestor) === "tolerateDeadDesktopUiWebview",
          ),
        });
      }
    });
    expect(evidence.toSorted((a, b) => a.call.localeCompare(b.call))).toEqual([
      { call: "browser.getPageSource", tolerated: true },
      { call: "browser.saveScreenshot", tolerated: true },
    ]);
  });
});
