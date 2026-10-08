import { createBrowserFollowupProtocolObserver } from "./release-visual-browser-followups-protocol.ts";
import { runBrowserFollowupScene } from "./release-visual-browser-followups-producer.ts";
import {
  withBrowserFollowupSecondWindow,
  withBrowserFollowupResource,
} from "./release-visual-browser-followups-owner.ts";
import { projectBrowserTerminalGuardReason } from "./release-visual-browser-followups-source.ts";
// @effect-diagnostics nodeBuiltinImport:off - Actual caller source executes only on inert ports.
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeEvents from "node:events";
import { TerminalSessionSnapshot } from "../../../../packages/contracts/src/terminal.ts";
import { createBrowserFollowupReplayObserver } from "./release-visual-browser-followups-caller-protocol.ts";
import { createBrowserFollowupReplyGate } from "./release-visual-browser-followups-transport.ts";
import {
  browserInitialCardinality,
  projectBrowserInitialJoin,
} from "./release-visual-browser-followups-protocol.ts";
import { it as test } from "vite-plus/test";
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import * as NodeModule from "node:module";
import {
  bindBrowserFollowupTarget,
  admitBrowserFollowupTerminal,
  createBrowserFollowupNetworkTransition,
  withBrowserFollowupMainWindow,
} from "./release-visual-browser-followups-caller.ts";
import { browserFollowupRows } from "./release-visual-browser-followups.ts";
import { joinBrowserFollowupCleanup } from "./release-visual-browser-followups-caller-resources.ts";
import { pinBrowserFollowupTerminalReplay } from "./release-visual-browser-followups-caller-protocol.ts";
function terminalChainWriter(root: string) {
  const qualifier = NodeFS.readFileSync(
    new URL("../qualify-delivery-retry.ts", import.meta.url),
    "utf8",
  );
  const declaration = qualifier.slice(
    qualifier.indexOf("  let browserInitialFailure:"),
    qualifier.indexOf("  let browserFollowupFixtureSafeToDelete = true;"),
  );
  const callbackStart = qualifier.indexOf(
    "          observeTerminalReceiptFailure: (error, reason) =>",
  );
  const callback = qualifier
    .slice(callbackStart, qualifier.indexOf("          owner,", callbackStart))
    .trim()
    .replace(/^observeTerminalReceiptFailure: /, "")
    .replace(/,$/, "");
  const fieldStart = qualifier.indexOf("      browserTerminalReceiptGuard:");
  const field = qualifier
    .slice(fieldStart, qualifier.indexOf("      browserInitialJoin:", fieldStart))
    .trim()
    .replace(/,$/, "");
  const writeStart = qualifier.indexOf("  const write ="),
    writeEnd = qualifier.indexOf("  const step =", writeStart);
  const context = NodeVM.createContext({
    NodeFS,
    NodePath,
    Object,
    projectBrowserTerminalGuardReason,
    config: { evidence: root, selection: "release-visual-browser-followups" },
    phase: "prepare",
    theme: "light",
  });
  const writer = NodeVM.runInContext(
    NodeModule.stripTypeScriptTypes(
      declaration +
        qualifier.slice(writeStart, writeEnd) +
        "\nconst observe=" +
        callback +
        ";function publish(error){const originalBrowserTerminalReceiptFailure=readBrowserTerminalReceiptFailure();write('failure',{" +
        field +
        "});}({observe,publish,read:readBrowserTerminalReceiptFailure});",
    ),
    context,
  );
  return { writer, context };
}
test.each([
  "owned",
  "bootstrap-close",
  "source-drift",
  "guard-error",
  "guard-undefined",
  "guard-callback",
  "guard-cleanup",
  "guard-success",
])(
  "actual six-row caller composes real ownership boundaries before originals: %s",
  async (mode) => {
    const source = NodeFS.readFileSync(
        new URL("./release-visual-browser-followups-caller.ts", import.meta.url),
        "utf8",
      ),
      begin = source.indexOf("export async function runBrowserFollowupCaller("),
      events: string[] = [],
      rows: string[] = [],
      captures: object[] = [],
      terminal = {
        terminalId: "inert-terminal",
        pid: 123,
        label: "sleep",
        hasRunningSubprocess: true,
      };
    const snapshot = {
      threadId: "inert-thread",
      terminalId: "inert-terminal",
      cwd: "/inert/worktree",
      worktreePath: "/inert/worktree",
      status: "running",
      pid: 123,
      history: "Owned shared terminal output\r\n",
      exitCode: null,
      exitSignal: null,
      label: "sleep",
      hasRunningSubprocess: true,
      updatedAt: "2026-10-06T00:00:00.000Z",
    };
    const original = new Error("inert exact bootstrap failure");
    const guardMode = mode.startsWith("guard-");
    const primary: unknown = mode === "guard-undefined" ? undefined : original;
    const root = guardMode
      ? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "terminal-chain-"))
      : null;
    if (root) NodeFS.chmodSync(root, 0o700);
    const retained = root ? terminalChainWriter(root) : null;
    const actorSnapshot: typeof TerminalSessionSnapshot.Type = {
      ...snapshot,
      status: "running",
      size: { cols: 91, rows: 24, sizeClaim: "first-owner" },
      oscColorResponderActive: false,
      firstAttachmentGrant: false,
    };
    const observer = createBrowserFollowupProtocolObserver({
      png: Buffer.from([1]),
      cwd: snapshot.cwd,
      threadId: snapshot.threadId,
      terminalId: snapshot.terminalId,
      patch: () => "inert",
      slowTransport: () => false,
    });
    const attachActor = (connection: string, claim: string, second: boolean) => {
      observer.observe(connection, "request", {
        _tag: "Request",
        id: "1",
        tag: "terminal.attach",
        payload: {
          threadId: snapshot.threadId,
          terminalId: snapshot.terminalId,
          cwd: snapshot.cwd,
          sizeClaim: claim,
        },
      });
      observer.observe(connection, "reply", {
        _tag: "Chunk",
        requestId: "1",
        values: [
          {
            type: "snapshot",
            snapshot: {
              ...actorSnapshot,
              size: {
                cols: 91,
                rows: 24,
                sizeClaim: second && mode !== "guard-success" ? "second-owner" : "first-owner",
              },
            },
          },
        ],
      });
    };
    if (guardMode) attachActor("first", "first-owner", false);
    let checks = 0,
      selected = "inert-main",
      handles = [selected];
    const appliedSize = (claim: string) => {
      for (const connection of handles.length === 2 ? ["first", "second"] : ["first"])
        observer.observe(connection, "reply", {
          _tag: "Chunk",
          requestId: "1",
          values: [
            {
              type: "resized",
              threadId: snapshot.threadId,
              terminalId: snapshot.terminalId,
              size: { cols: 91, rows: 24, sizeClaim: claim },
            },
          ],
        });
    };
    let reads = 0;
    const prepared = {
      png: { path: "inert-original" },
      verify: async () => {
        events.push("inputs");
      },
      bootstrap: {
        close: async () => {
          events.push("bootstrap-close");
          if (mode === "bootstrap-close") throw original;
        },
      },
      retain: () => {},
      verifyHostedBuild: async () => ({}),
    };
    const network = {
      observer: {
        terminalRestored: () => {
          events.push("reconnect");
          if (guardMode) observer.terminalRestored();
        },
        terminal: () => {
          checks++;
          return observer.terminal();
        },
        fitted: () => observer.fitted(),
        replay: { verify: () => events.push("replay"), throwIfFailed: () => {} },
      },
      close: async () => {},
      proxy: {},
      transport: { throwIfFailed: () => {} },
    };
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(source.slice(begin)).replace(/^export /gm, "") +
        "\nrunBrowserFollowupCaller",
      {
        browserInitialCardinality,
        projectBrowserInitialJoin,
        withBrowserFollowupMainWindow,
        click: NodeVM.runInNewContext(
          NodeModule.stripTypeScriptTypes(
            source.slice(
              source.indexOf("async function click("),
              source.indexOf("/** A real public Terminal"),
            ),
          ) + "\nclick;",
          { refused: () => new Error("inert public control refused") },
        ),
        bindBrowserFollowupTarget,
        prepareBrowserFollowupTerminal: async () => {
          events.push("public-terminal");
          return terminal;
        },
        readBrowserFollowupTerminalBaseline: async () => snapshot,
        pinBrowserFollowupTerminalReplay,
        createBrowserFollowupNetworkTransition,
        startBrowserFollowupReplayNetwork: async () => {
          events.push("network");
          return network;
        },
        readBrowserFollowupTerminalMetadata: async () => [{ ...snapshot }],
        admitBrowserFollowupTerminal,
        NodeFS: { readFileSync: () => new Uint8Array([1]) },
        captureBrowserFollowupScene: async (input: {
          verifySource: () => Promise<void>;
          observation: { scene: string };
        }) => {
          await input.verifySource();
          await input.verifySource();
          return { scene: input.observation.scene };
        },
        browserFollowupRows: guardMode ? ["terminal-shared-size"] : browserFollowupRows,
        withBrowserFollowupSecondWindow,
        withBrowserFollowupResource,
        runBrowserFollowupScene: guardMode
          ? runBrowserFollowupScene
          : async (
              input: {
                verifyOwnedIdentity: () => Promise<void>;
                capture: (
                  scene: string,
                  browser: object,
                  verify: () => Promise<void>,
                ) => Promise<void>;
                browser: object;
              },
              row: string,
            ) => {
              await input.verifyOwnedIdentity();
              rows.push(row);
              await input.capture(row, input.browser, async () => {
                events.push("source");
              });
            },
        refused: () => new Error("inert source refused"),
      },
    ) as (input: object) => Promise<void>;
    const pending = run({
      CI: "true",
      prepared,
      browser: {
        $: (selector: string) => ({
          isDisplayed: async () => true,
          waitForDisplayed: async () => {},
          waitForEnabled: async () => {},
          click: async () => {
            if (guardMode && selector === "button=Fit to this window")
              appliedSize(selected === "inert-main" ? "first-owner" : "second-owner");
          },
        }),
        $$: () => [{ getAttribute: async () => terminal.terminalId }],
        execute: async () => true,
        getWindowHandles: async () => handles,
        getWindowHandle: async () => selected,
        getWindowSize: async () => ({ width: 1280, height: 960 }),
        setWindowSize: async () => {},
        newWindow: async () => {
          handles = ["inert-main", "inert-second"];
          selected = "inert-second";
          attachActor("second", "second-owner", true);
          return { handle: selected };
        },
        switchToWindow: async (handle: string) => {
          selected = handle;
        },
        closeWindow: async () => {
          events.push("second-cleanup");
          observer.connectionClosed("second");
          handles = ["inert-main"];
          selected = "inert-main";
          if (mode === "guard-cleanup") throw new Error("Inert secondary cleanup failure");
        },
        getUrl: async () => "http://127.0.0.1:4885/local/inert-thread",
        getWindowRect: async () => ({ x: 0, y: 0, width: 900, height: 700 }),
        setWindowRect: async () => {},
        url: async () => {},
      },
      owner: {
        until: async (check: () => Promise<boolean>) => {
          if (!(await check())) {
            if (guardMode) throw primary;
            throw new Error("inert observation missing");
          }
        },
      },
      theme: "light",
      accessToken: "inert-access",
      threadId: "inert-thread",
      cwd: "/inert/worktree",
      branch: "inert-branch",
      projectPath: "/inert/project",
      readDescriptor: async () => {
        reads++;
        return {
          ...descriptor,
          serverVersion: "0.8.0",
          ...(mode === "source-drift" && reads > 1 ? { bootId: "changed" } : {}),
        };
      },
      readSnapshot: async () => snapshotModel,
      verifyPhysical: async () => {
        events.push("physical");
      },
      patch: () => "inert",
      viewport: async () => {},
      evidence: "inert",
      captured: new Set(),
      captures,
      publish: () => {},
      step: (phase: string) => {
        if (retained) retained.context.phase = phase;
      },
      ...(guardMode
        ? {
            observeTerminalReceiptFailure: (error: unknown, reason: unknown) => {
              events.push("guard-record");
              NodeAssert.equal(Object.is(error, primary), true);
              retained?.writer.observe(error, reason);
              if (mode === "guard-callback") throw undefined;
            },
          }
        : {}),
      observeUnsafeCleanup: () => {
        events.push("unsafe");
      },
    });
    if (guardMode) {
      if (root === null || retained === null) throw new Error("Inert chain writer unavailable");
      try {
        let failed = false,
          caught: unknown;
        try {
          await pending;
        } catch (error) {
          failed = true;
          caught = error;
        }
        if (mode === "guard-success") {
          NodeAssert.equal(failed, false);
          NodeAssert.equal(retained?.writer.read(), null);
          NodeAssert.equal(events.includes("guard-record"), false);
          NodeAssert.equal(captures.length, 1);
        } else {
          NodeAssert.equal(failed, true);
          NodeAssert.equal(Object.is(caught, primary), true);
          NodeAssert.equal(events.filter((event) => event === "guard-record").length, 1);
          NodeAssert.ok(events.indexOf("guard-record") < events.indexOf("second-cleanup"));
          NodeAssert.equal(checks, 1);
          NodeAssert.equal(captures.length, 0);
          retained?.writer.publish(caught);
          NodeAssert.equal(
            JSON.parse(NodeFS.readFileSync(NodePath.join(root, "failure.json"), "utf8"))
              .browserTerminalReceiptGuard,
            "second-owner-mismatch",
          );
          NodeAssert.equal(
            NodeFS.statSync(NodePath.join(root, "failure.json")).mode & 0o777,
            0o600,
          );
        }
      } finally {
        if (root) NodeFS.rmSync(root, { recursive: true, force: true });
      }
    } else if (mode === "owned") {
      await pending;
      NodeAssert.deepEqual(rows, [...browserFollowupRows]);
      NodeAssert.equal(captures.length, 6);
      NodeAssert.ok(events.indexOf("bootstrap-close") < events.indexOf("network"));
      NodeAssert.ok(events.includes("replay"));
    } else {
      await NodeAssert.rejects(pending, (error) =>
        mode === "bootstrap-close" ? error === original : true,
      );
      NodeAssert.equal(captures.length, 0);
      NodeAssert.equal(rows.length, 0);
    }
  },
);
const descriptor = {
  environmentId: "local",
  bootId: "inert-boot",
  storageInstanceId: "inert-store",
  serverVersion: "0.8.0",
};
const snapshotModel = {
  threads: [
    {
      id: "inert-thread",
      projectId: "inert-project",
      kind: "workspace",
      deletedAt: null,
      worktreePath: "/inert/worktree",
      branch: "inert-branch",
    },
  ],
  projects: [{ id: "inert-project", workspaceRoot: "/inert/project", deletedAt: null }],
};
test("binding keeps actual descriptor/storage/thread/project/worktree identity", () => {
  const target = bindBrowserFollowupTarget({
    descriptor: descriptor as never,
    snapshot: snapshotModel as never,
    threadId: "inert-thread",
    cwd: "/inert/worktree",
    branch: "inert-branch",
    projectPath: "/inert/project",
  });
  NodeAssert.equal(target.projectId, "inert-project");
  NodeAssert.throws(() =>
    bindBrowserFollowupTarget({
      descriptor: { ...descriptor, bootId: "" } as never,
      snapshot: snapshotModel as never,
      threadId: "inert-thread",
      cwd: "/inert/other",
      branch: "inert-branch",
      projectPath: "/inert/project",
    }),
  );
});
test("terminal identity is admitted only from one running typed metadata entry matching DOM ID", () => {
  const value = {
    threadId: "inert-thread",
    terminalId: "inert-terminal",
    cwd: "/inert/worktree",
    worktreePath: "/inert/worktree",
    status: "running",
    pid: 123,
    label: "sleep",
    hasRunningSubprocess: true,
  };
  NodeAssert.equal(
    admitBrowserFollowupTerminal(
      [value] as never,
      "inert-terminal",
      "inert-thread",
      "/inert/worktree",
    ).pid,
    123,
  );
  for (const changed of [
    { ...value, pid: null },
    { ...value, hasRunningSubprocess: false },
    { ...value, label: "printf" },
    { ...value, threadId: "other" },
    { ...value, cwd: "/other" },
    { ...value, label: "foreign\nlabel" },
  ])
    NodeAssert.throws(() =>
      admitBrowserFollowupTerminal(
        [changed] as never,
        "inert-terminal",
        "inert-thread",
        "/inert/worktree",
      ),
    );
  NodeAssert.throws(() =>
    admitBrowserFollowupTerminal(
      [value, value] as never,
      "inert-terminal",
      "inert-thread",
      "/inert/worktree",
    ),
  );
});
test("public endpoint transition joins bootstrap before starting actual observed chain", async () => {
  const order: string[] = [];
  const transition = createBrowserFollowupNetworkTransition({
    bootstrap: {
      close: async () => {
        order.push("bootstrap-close");
      },
    },
    startObserved: async () => {
      order.push("observed-start");
      return {
        close: async () => {
          order.push("observed-close");
        },
      };
    },
    observeUnsafeCleanup: () => order.push("unsafe"),
  });
  const first = transition.activate(),
    second = transition.activate();
  NodeAssert.equal(first, second);
  await first;
  await transition.close();
  await transition.close();
  NodeAssert.deepEqual(order, ["bootstrap-close", "observed-start", "observed-close"]);
});
test("failed bootstrap shutdown prohibits rebind and is retained for all close callers", async () => {
  let starts = 0,
    unsafe = 0;
  const fault = new Error("inert bootstrap-close");
  const transition = createBrowserFollowupNetworkTransition({
    bootstrap: {
      close: async () => {
        throw fault;
      },
    },
    startObserved: async () => {
      starts++;
      return { close: async () => {} };
    },
    observeUnsafeCleanup: () => unsafe++,
  });
  await NodeAssert.rejects(transition.activate(), (error) => error === fault);
  await NodeAssert.rejects(transition.close(), (error) => error === fault);
  NodeAssert.equal(starts, 0);
  NodeAssert.equal(unsafe, 1);
});
test("cleanup racing an activation waits and closes late acquired observed owner", async () => {
  let release!: () => void,
    closed = 0;
  const held = new Promise<void>((resolve) => (release = resolve));
  const transition = createBrowserFollowupNetworkTransition({
    bootstrap: { close: async () => {} },
    startObserved: async () => {
      await held;
      return {
        close: async () => {
          closed++;
        },
      };
    },
    observeUnsafeCleanup: () => {
      throw new Error("inert unexpected unsafe");
    },
  });
  const activation = transition.activate(),
    cleanup = transition.close();
  release();
  await activation;
  await cleanup;
  NodeAssert.equal(closed, 1);
  await NodeAssert.rejects(transition.activate());
});

test.each(["success", "visual", "url", "rect", "both", "identity", "undefined"])(
  "main window lease restores independent resources and preserves original error: %s",
  async (mode) => {
    const original = new Error("inert visual failure"),
      urlFailure = new Error("inert URL restore failure"),
      rectFailure = new Error("inert rectangle restore failure"),
      identityFailure = new Error("inert identity failure"),
      events: string[] = [],
      url = "http://127.0.0.1:4885/local/inert-thread",
      rectangle = { x: 7, y: 8, width: 900, height: 700 };
    let currentUrl = url,
      currentRect = { ...rectangle },
      unsafe = 0;
    const browser = {
      getWindowHandle: async () => "inert-main",
      getWindowHandles: async () => ["inert-main"],
      getUrl: async () => currentUrl,
      getWindowRect: async () => currentRect,
      url: async (next: string) => {
        events.push("url");
        if (["url", "both", "visual", "undefined"].includes(mode))
          throw mode === "undefined" ? undefined : urlFailure;
        currentUrl = next;
      },
      setWindowRect: async (x: number, y: number, width: number, height: number) => {
        events.push("rect");
        if (["rect", "both"].includes(mode)) throw rectFailure;
        currentRect = { x, y, width, height };
      },
    };
    const pending = withBrowserFollowupMainWindow({
      browser: browser as never,
      route: url,
      verifyOwnedIdentity: async () => {
        events.push("identity");
        if (mode === "identity") throw identityFailure;
      },
      observeUnsafeCleanup: () => {
        unsafe++;
      },
      run: async () => {
        events.push("run");
        currentUrl = url + "/settings";
        currentRect = { x: 20, y: 10, width: 1320, height: 1000 };
        if (mode === "visual") throw original;
        return "inert result";
      },
    });
    if (mode === "success") {
      NodeAssert.equal(await pending, "inert result");
      NodeAssert.deepEqual(currentRect, rectangle);
      NodeAssert.equal(currentUrl, url);
      NodeAssert.equal(unsafe, 0);
    } else {
      let caught = false,
        value: unknown;
      try {
        await pending;
      } catch (error) {
        caught = true;
        value = error;
      }
      NodeAssert.equal(caught, true);
      NodeAssert.equal(
        value,
        mode === "visual"
          ? original
          : mode === "rect"
            ? rectFailure
            : mode === "identity"
              ? identityFailure
              : mode === "undefined"
                ? undefined
                : urlFailure,
      );
      NodeAssert.equal(unsafe, 1);
    }
    NodeAssert.ok(events.indexOf("url") < events.indexOf("rect"));
    NodeAssert.ok(events.includes("identity"));
  },
);

test.each(["owned", "main", "hosted", "proxy", "png", "cleanup"])(
  "actual preparation independently unwinds every partial startup resource: %s",
  async (mode) => {
    const source = NodeFS.readFileSync(
        new URL("./release-visual-browser-followups-caller.ts", import.meta.url),
        "utf8",
      ),
      begin = source.indexOf("export async function prepareBrowserFollowupCaller("),
      end = source.indexOf("async function click(", begin),
      events: string[] = [],
      fault = new Error("inert exact startup fault");
    let unsafe = 0;
    const prepare = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(source.slice(begin, end)).replace(/^export /gm, "") +
        "\nprepareBrowserFollowupCaller",
      {
        refused: () => fault,
        readBrowserFollowupBuildRecipe: () => {},
        pinBrowserFollowupExecutable: () => ({ verify: () => {} }),
        pinBrowserFollowupAssets: () => ({}),
        joinBrowserFollowupCleanup,
        startBrowserFollowupAssets: async (input: { port: number }) => {
          events.push("start" + input.port);
          if (
            (mode === "main" && input.port === 4885) ||
            (["hosted", "cleanup"].includes(mode) && input.port === 4893)
          )
            throw fault;
          return {
            close: async () => {
              events.push("close" + input.port);
              if (mode === "cleanup") throw new Error("inert cleanup failure");
            },
            verify: () => {},
          };
        },
        startThrottleProxy: async () => {
          events.push("proxy");
          if (mode === "proxy") throw fault;
          return {
            close: async () => {
              events.push("proxy-close");
            },
          };
        },
        prepareBrowserFollowupPng: () => {
          if (mode === "png") throw fault;
          return { verify: () => {} };
        },
      },
    ) as (input: object) => Promise<{ close: () => Promise<void> }>;
    const pending = prepare({
      CI: "true",
      root: "inert",
      primaryAssets: "inert",
      hostedAssets: "inert",
      source: "inert",
      repository: "inert",
      binary: "inert",
      admitOwner: async () => {},
      verifyInputs: async () => {},
      observeUnsafeCleanup: () => {
        unsafe++;
      },
    });
    if (mode === "owned") {
      const value = await pending;
      await value.close();
      await value.close();
    } else await NodeAssert.rejects(pending, (error) => error === fault);
    const closes = events.filter((value) => value.startsWith("close") || value === "proxy-close");
    NodeAssert.deepEqual(
      closes,
      mode === "main"
        ? []
        : mode === "hosted" || mode === "cleanup"
          ? ["close4885"]
          : mode === "proxy"
            ? ["close4893", "close4885"]
            : ["proxy-close", "close4893", "close4885"],
    );
    NodeAssert.equal(unsafe, mode === "cleanup" ? 1 : 0);
  },
);

test("actual public terminal bootstrap establishes its own raw marker line after Readline teardown", async () => {
  const source = NodeFS.readFileSync(
    new URL("./release-visual-browser-followups-caller.ts", import.meta.url),
    "utf8",
  );
  const begin = source.indexOf("export async function prepareBrowserFollowupTerminal("),
    end = source.indexOf("/** Own only the admitted main handle.", begin);
  const snapshot = {
    threadId: "inert-thread",
    terminalId: "inert-terminal",
    cwd: "/inert/worktree",
    worktreePath: "/inert/worktree",
    status: "running",
    pid: 123,
    exitCode: null,
    exitSignal: null,
    label: "sleep",
    hasRunningSubprocess: true,
    updatedAt: "2026-10-06T00:00:00.000Z",
    history: "",
  };
  const keys: string[] = [],
    order: string[] = [];
  const element = {
    isDisplayed: async () => true,
    waitForDisplayed: async () => {},
    getAttribute: async () => snapshot.terminalId,
  };
  const prepare = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(source.slice(begin, end)).replace(/^export /gm, "") +
      "\nprepareBrowserFollowupTerminal",
    {
      click: async () => {
        order.push("public-click");
      },
      refused: () => new Error("Inert terminal refused"),
      admitBrowserFollowupTerminal,
      readBrowserFollowupTerminalMetadata: async () => {
        order.push("metadata");
        return [snapshot];
      },
    },
  );
  const result = await prepare({
    browser: {
      $: () => element,
      $$: () => [element],
      execute: async () => true,
      keys: async (value: string) => {
        keys.push(value);
        order.push(value === "Enter" ? "enter" : "command");
      },
    },
    owner: {
      until: async (check: () => Promise<boolean>) => NodeAssert.equal(await check(), true),
    },
    accessToken: "inert-access",
    threadId: snapshot.threadId,
    cwd: snapshot.cwd,
    observeUnsafeCleanup: () => {
      throw new Error("Unexpected cleanup refusal");
    },
  });
  NodeAssert.deepEqual(keys, [
    "printf '\\nOwned shared terminal output\\n'; /bin/sleep 600",
    "Enter",
  ]);
  NodeAssert.equal(order.filter((value) => value === "command").length, 1);
  NodeAssert.ok(
    order.indexOf("command") < order.indexOf("enter") &&
      order.indexOf("enter") < order.indexOf("metadata"),
  );
  NodeAssert.equal(result.pid, snapshot.pid);
  const raw = {
    ...snapshot,
    history: "command echo\r\n\x1b[?2004l\r\r\nOwned shared terminal output\r\n",
  };
  const pinned = pinBrowserFollowupTerminalReplay(
    raw as never,
    snapshot.threadId,
    snapshot.terminalId,
    snapshot.cwd,
  );
  NodeAssert.equal(pinned.pid, result.pid);
  NodeAssert.equal(pinned.history, raw.history);
  for (const history of [
    "",
    "printf 'Owned shared terminal output\\n'; /bin/sleep 600\r\n",
    "command echo\r\n\x1b[?2004l\rOwned shared terminal output\r\n",
  ])
    NodeAssert.throws(() =>
      pinBrowserFollowupTerminalReplay(
        { ...snapshot, history } as never,
        snapshot.threadId,
        snapshot.terminalId,
        snapshot.cwd,
      ),
    );
});

test.each(["pending", "transport-error", "replay-error", "undefined-error"])(
  "actual reconnect predicate preserves pending or owned permanent state: %s",
  async (mode) => {
    const source = NodeFS.readFileSync(
      new URL("./release-visual-browser-followups-caller.ts", import.meta.url),
      "utf8",
    );
    const start = source.lastIndexOf(
      "      await input.owner.until(async () => {",
      source.indexOf("          network.observer.terminalRestored();"),
    );
    const end = source.indexOf("      // Initial reconnect admission ends here.", start);
    NodeAssert.equal(start > 0 && end > start, true);
    const original =
      mode === "undefined-error"
        ? undefined
        : Object.freeze(new Error("inert permanent owner error"));
    let polls = 0,
      healthyChecks = 0;
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function run(input,network){" + source.slice(start, end) + "}run;",
      ),
      {},
    );
    const network = {
      transport: {
        throwIfFailed: () => {
          healthyChecks++;
          if (mode === "transport-error" || mode === "undefined-error") throw original;
        },
      },
      observer: {
        terminalRestored: () => {
          throw original;
        },
        replay: {
          throwIfFailed: () => {
            healthyChecks++;
            if (mode === "replay-error") throw original;
          },
        },
      },
    };
    const input = {
      owner: {
        until: async (check: () => Promise<boolean>) => {
          for (let i = 0; i < 2; i++) {
            polls++;
            NodeAssert.equal(await check(), false);
          }
        },
      },
    };
    if (mode === "pending") {
      await run(input, network);
      NodeAssert.equal(polls, 2);
      NodeAssert.equal(healthyChecks >= 4, true);
    } else {
      await NodeAssert.rejects(run(input, network), (value) => value === original);
      NodeAssert.equal(polls, 1);
    }
  },
);

test.each([
  "owned",
  "foreign-same",
  "foreign-different",
  "wrong-mount",
  "duplicate",
  "no-focus",
  "transport-error",
  "replay-error",
  "undefined-error",
])(
  "actual initial reconnect sequence focuses only its pinned public terminal: %s",
  async (mode) => {
    const source = NodeFS.readFileSync(
      new URL("./release-visual-browser-followups-caller.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf(
      "      terminalWindow =",
      source.indexOf('input.step("visual-browser-followups-observed-reconnect")'),
    );
    const oldStart = source.indexOf(
      "      const network = await transition.activate();",
      source.indexOf('input.step("visual-browser-followups-observed-reconnect")'),
    );
    const end = source.indexOf("      // Initial reconnect admission ends here.", oldStart);
    NodeAssert.equal(oldStart > 0 && end > oldStart, true);
    const clickStart = source.indexOf("async function click("),
      clickEnd = source.indexOf("/** A real public Terminal", clickStart);
    const original =
      mode === "undefined-error"
        ? undefined
        : Object.freeze(new Error("inert first owner failure"));
    const deadline = new Error("inert unchanged observation bound");
    let clicks = 0,
      focused = false,
      ready = !mode.startsWith("foreign"),
      polls = 0;
    class Textarea {
      classList = { contains: (value: string) => value === "xterm-helper-textarea" };
    }
    const textarea = new Textarea();
    const mount = {
      getAttribute: async () => (mode === "wrong-mount" ? "other-terminal" : "inert-terminal"),
      contains: (value: unknown) => value === textarea,
    };
    const domMount = {
      getAttribute: () => (mode === "wrong-mount" ? "other-terminal" : "inert-terminal"),
      contains: mount.contains,
    };
    const document = {
      get activeElement() {
        return focused ? textarea : null;
      },
      querySelectorAll: () => (mode === "duplicate" ? [domMount, domMount] : [domMount]),
    };
    const screen = {
      waitForDisplayed: async () => {},
      waitForEnabled: async () => {},
      click: async () => {
        clicks++;
        if (mode !== "no-focus") focused = true;
        ready = true;
      },
    };
    const network = {
      transport: {
        throwIfFailed: () => {
          if (mode === "transport-error" || mode === "undefined-error") throw original;
        },
      },
      observer: {
        replay: {
          throwIfFailed: () => {
            if (mode === "replay-error") throw original;
          },
        },
        terminalRestored: () => {
          if (!ready) throw deadline;
        },
      },
    };
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        source.slice(clickStart, clickEnd) +
          "\nasync function initial(input,terminal,transition){let terminalWindow;let waitingOn; const initialUi = {};" +
          source.slice(start >= 0 ? start : oldStart, end) +
          "}\ninitial;",
      ),
      {
        browserInitialCardinality,
        document,
        HTMLTextAreaElement: Textarea,
        refused: () => new Error("inert public mount refused"),
      },
    );
    const input = {
      browser: {
        getWindowHandle: async () => "inert-main",
        getWindowHandles: async () => ["inert-main"],
        $$: (selector: string) =>
          selector.endsWith(".xterm-screen")
            ? [screen]
            : mode === "duplicate"
              ? [mount, mount]
              : [mount],
        $: () => screen,
        execute: async (fn: (id: string) => boolean, id: string) => fn(id),
      },
      owner: {
        until: async (check: () => Promise<boolean>) => {
          for (let i = 0; i < 2; i++) {
            polls++;
            if (await check()) return;
          }
          throw deadline;
        },
      },
    };
    const pending = run(input, { terminalId: "inert-terminal" }, { activate: async () => network });
    if (["owned", "foreign-same", "foreign-different"].includes(mode)) {
      await pending;
      NodeAssert.equal(clicks, 1);
      NodeAssert.equal(focused, true);
    } else {
      let caught = false,
        error: unknown;
      try {
        await pending;
      } catch (value) {
        caught = true;
        error = value;
      }
      NodeAssert.equal(caught, true);
      if (["transport-error", "replay-error", "undefined-error"].includes(mode)) {
        NodeAssert.equal(error, original);
        NodeAssert.equal(clicks, 0);
      } else NodeAssert.equal(clicks, mode === "no-focus" ? 1 : 0);
    }
    NodeAssert.equal(polls <= 4, true);
  },
);

test.each([
  "bootstrap",
  "focus",
  "config",
  "attach",
  "snapshot",
  "claim",
  "partial",
  "callback-undefined",
  "original-undefined",
])(
  "complete initial caller captures one closed failure before joined retirement: %s",
  async (mode) => {
    const source = NodeFS.readFileSync(
      new URL("./release-visual-browser-followups-caller.ts", import.meta.url),
      "utf8",
    );
    const begin = source.indexOf("export async function runBrowserFollowupCaller(");
    const events: string[] = [];
    const snapshot = {
      threadId: "inert-thread",
      terminalId: "inert-terminal",
      cwd: "/inert/worktree",
      worktreePath: "/inert/worktree",
      status: "running",
      pid: 123,
      sequence: 1,
      history: "Owned shared terminal output\r\n",
      size: { cols: 80, rows: 24, sizeClaim: "current-claim" },
    };
    const original =
      mode === "original-undefined" ? undefined : new Error("inert exact initial failure");
    let captured = false,
      receipt: unknown,
      callbacks = 0,
      projectionClosed = false;
    const prepared = {
      png: { path: "inert" },
      verify: async () => {},
      bootstrap: {
        close: async () => {
          events.push("bootstrap");
          if (["bootstrap", "original-undefined"].includes(mode)) throw original;
        },
      },
      retain: () => {},
      verifyHostedBuild: async () => ({}),
    };
    const clickStart = source.indexOf("async function click("),
      clickEnd = source.indexOf("/** A real public Terminal", clickStart);
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(source.slice(begin)).replace(/^export /gm, "") +
        "\nrunBrowserFollowupCaller",
      {
        browserInitialCardinality,
        projectBrowserInitialJoin,
        withBrowserFollowupMainWindow,
        bindBrowserFollowupTarget,
        admitBrowserFollowupTerminal,
        pinBrowserFollowupTerminalReplay,
        prepareBrowserFollowupTerminal: async () => ({
          terminalId: snapshot.terminalId,
          pid: 123,
          label: "sleep",
          hasRunningSubprocess: true,
        }),
        readBrowserFollowupTerminalBaseline: async () => snapshot,
        createBrowserFollowupNetworkTransition,
        NodeFS: { readFileSync: () => new Uint8Array([1]) },
        click: NodeVM.runInNewContext(
          NodeModule.stripTypeScriptTypes(source.slice(clickStart, clickEnd)) + "\nclick",
          { refused: () => original },
        ),
        refused: () => original,
        startBrowserFollowupReplayNetwork: async (input: {
          registerInitialOwners?: (value: object) => void;
          observeInitialFailure?: (error: unknown) => void;
        }) => {
          input.registerInitialOwners?.({
            protocol: () => ({
              closed: projectionClosed,
              failed: false,
              attachRequests: mode === "attach" ? "none" : "one",
              snapshots: mode === "snapshot" ? "none" : "one",
              configAttachments: mode === "config" ? "none" : "one",
              resizeRequests: "none",
              sizeOwner: mode === "claim" ? "foreign-claim" : "current-attach",
            }),
          });
          if (mode === "partial") {
            input.observeInitialFailure?.(original);
            projectionClosed = true;
            throw original;
          }
          input.registerInitialOwners?.({
            replay: () => ({
              closed: projectionClosed,
              failed: false,
              snapshots: "one",
              configSnapshots: mode === "config" ? "none" : "one",
            }),
            transport: () => ({
              closed: projectionClosed,
              failed: false,
              upgradedWires: "one",
              configWires: mode === "config" ? "none" : "one",
            }),
          });
          return {
            transport: { throwIfFailed: () => {} },
            observer: {
              terminalRestored: () => {
                throw original;
              },
              replay: { throwIfFailed: () => {}, verify: () => {} },
            },
            close: async () => {
              projectionClosed = true;
            },
          };
        },
      },
    );
    const screen = {
      isDisplayed: async () => true,
      waitForDisplayed: async () => {},
      waitForEnabled: async () => {},
      click: async () => events.push("click"),
    };
    const input = {
      CI: "true",
      prepared,
      browser: {
        $: () => screen,
        $$: () => [{ getAttribute: async () => snapshot.terminalId }],
        execute: async () => mode !== "focus",
        getWindowHandle: async () => "inert-main",
        getWindowHandles: async () => ["inert-main"],
        getUrl: async () => "http://127.0.0.1:4885/local/inert-thread",
        getWindowRect: async () => ({ x: 0, y: 0, width: 900, height: 700 }),
        url: async () => events.push("restore-url"),
        setWindowRect: async () => events.push("restore-size"),
      },
      owner: {
        until: async (check: () => Promise<boolean>) => {
          if (!(await check())) throw original;
        },
      },
      theme: "light",
      accessToken: "inert",
      threadId: snapshot.threadId,
      cwd: snapshot.cwd,
      branch: "inert-branch",
      projectPath: "/inert/project",
      readDescriptor: async () => descriptor,
      readSnapshot: async () => snapshotModel,
      verifyPhysical: async () => {},
      patch: () => "",
      viewport: async () => {},
      evidence: "inert",
      captured: new Set(),
      captures: [],
      publish: () => {},
      step: () => {},
      observeUnsafeCleanup: () => {},
      observeInitialFailure: (error: unknown, value: unknown) => {
        callbacks++;
        captured = true;
        receipt = value;
        events.push("capture");
        NodeAssert.equal(error, original);
        if (mode === "callback-undefined") throw undefined;
      },
    };
    let failed = false,
      failure: unknown;
    try {
      await run(input);
    } catch (error) {
      failed = true;
      failure = error;
    }
    NodeAssert.equal(failed, true);
    NodeAssert.equal(failure, original);
    NodeAssert.equal(captured, true);
    NodeAssert.equal(callbacks, 1);
    NodeAssert.ok(events.indexOf("capture") < events.indexOf("restore-url"));
    const closed = receipt as {
      waitingOn: string;
      protocol: { closed: boolean } | null;
      replay: unknown;
      transport: unknown;
    };
    NodeAssert.equal(
      closed.waitingOn,
      ["bootstrap", "partial", "original-undefined"].includes(mode)
        ? "before-focus"
        : mode === "focus"
          ? "focus-predicate"
          : "receipt-predicate",
    );
    if (["bootstrap", "original-undefined"].includes(mode)) NodeAssert.equal(closed.protocol, null);
    if (mode === "partial") {
      NodeAssert.equal(closed.protocol?.closed, false);
      NodeAssert.equal(closed.replay, null);
      NodeAssert.equal(closed.transport, null);
    }
    NodeAssert.equal(JSON.stringify(receipt).includes("inert"), false);
  },
);

test.each([
  ["undefined", undefined, false, false],
  ["string", "driver-value", false, false],
  ["empty-string", "", false, false],
  ["number", 42, false, false],
  ["zero", 0, false, false],
  ["boolean-false", false, false, false],
  ["boolean-true", true, false, false],
  ["original-undefined", false, false, true],
  ["success", true, true, false],
  ["truthy-success", "driver-value", true, false],
] as const)(
  "actual focus return and real owners retain closed writer facts without coercion: %s",
  async (_mode, rawFocus, success, undefinedError) => {
    const caller = NodeFS.readFileSync(
      new URL("./release-visual-browser-followups-caller.ts", import.meta.url),
      "utf8",
    );
    const qualifier = NodeFS.readFileSync(
      new URL("../qualify-delivery-retry.ts", import.meta.url),
      "utf8",
    );
    const networkSource = NodeFS.readFileSync(
      new URL("./release-visual-browser-followups-network.ts", import.meta.url),
      "utf8",
    );
    const Schema = NodeModule.createRequire(
      new URL("../../../../packages/contracts/package.json", import.meta.url),
    )("effect/Schema");
    const snapshot = Schema.decodeUnknownSync(Schema.toCodecJson(TerminalSessionSnapshot))({
      threadId: "inert-thread",
      terminalId: "inert-terminal",
      cwd: "/inert/worktree",
      worktreePath: "/inert/worktree",
      status: "running",
      pid: 123,
      sequence: 1,
      history: "Owned shared terminal output\r\n",
      exitCode: null,
      exitSignal: null,
      label: "Terminal 1",
      updatedAt: "2026-10-06T00:00:00.000Z",
      size: { cols: 80, rows: 24, sizeClaim: "current-claim" },
    });
    const original = undefinedError
      ? undefined
      : Object.freeze(new Error("Inert original initial failure."));
    const events: string[] = [],
      readiness: unknown[] = [],
      closes: Array<() => Promise<void>> = [];
    let waits = 0,
      callbacks = 0,
      executes = 0;
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "initial-ui-facts-"));
    NodeFS.chmodSync(root, 0o700);
    try {
      const writerContext = NodeVM.createContext({
        NodeFS,
        NodePath,
        config: { evidence: root, selection: "release-visual-browser-followups" },
        phase: "prepare",
        theme: "light",
        projectBrowserInitialJoin,
        classifyQualificationFailure: () => ({ kind: "unclassified" }),
        cursorTurnObservation: null,
        startupObservation: null,
        importObservation: null,
        worktreeObservation: null,
        createRefObservation: null,
        textRowObservation: null,
        gitProjectDirectoryFailureFacts: () => null,
        gitProjectTabFailureFacts: () => null,
        projectGitProjectTabInterception: () => null,
        resolveSettingsVisualFailureScene: () => null,
        createRefClearObservation: null,
        browserDriverReadiness: null,
        browserReadinessStage: null,
        browserSessionObservation: null,
        prViewportObservation: null,
        modelClickObservation: null,
      });
      const declaration = qualifier.slice(
        qualifier.indexOf("  let browserInitialFailure:"),
        qualifier.indexOf("  let browserFollowupFixtureSafeToDelete = true;"),
      );
      const writeStart = qualifier.indexOf("  const write ="),
        writeEnd = qualifier.indexOf("  const step =", writeStart);
      const callbackStart = qualifier.indexOf("          observeInitialFailure: (error, value) =>");
      const callbackEnd = qualifier.indexOf("          browser,", callbackStart);
      const callback = qualifier
        .slice(callbackStart, callbackEnd)
        .trim()
        .replace(/^observeInitialFailure: /, "")
        .replace(/,$/, "");
      const failureStart = qualifier.indexOf('    write("failure", {'),
        failureEnd = qualifier.indexOf("\n  } finally {", failureStart);
      NodeAssert.ok(writeStart > 0 && callbackStart > 0 && failureEnd > failureStart);
      const writer = NodeVM.runInContext(
        NodeModule.stripTypeScriptTypes(
          declaration +
            qualifier.slice(writeStart, writeEnd) +
            "\nconst observe = " +
            callback +
            ";\nfunction publish(error){ const originalCursorFailure=null; const originalBrowserInitialFailure=readBrowserInitialFailure();" +
            qualifier.slice(failureStart, failureEnd) +
            "\n}\n({observe,publish,read:readBrowserInitialFailure});",
        ),
        writerContext,
      );
      const retainStart = networkSource.indexOf("function retainNetworkClose("),
        retainEnd = networkSource.indexOf("/** One concrete", retainStart);
      const transportStart = networkSource.indexOf(
        "export async function startBrowserFollowupTransport(",
      );
      const startTransport = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(
          networkSource.slice(retainStart, retainEnd) + networkSource.slice(transportStart),
        ).replace(/^export /gm, "") + "\nstartBrowserFollowupTransport;",
        {
          browserInitialCardinality,
          createBrowserFollowupReplyGate,
          refused: () => original,
          NodeNet: {
            createServer: () => {
              const server = new NodeEvents.EventEmitter();
              return Object.assign(server, {
                listen: (_port: number, _host: string, ready: () => void) => {
                  ready();
                  return server;
                },
                close: (done: (error?: Error) => void) => {
                  done();
                  return server;
                },
              });
            },
          },
        },
      );
      const begin = caller.indexOf("export async function runBrowserFollowupCaller(");
      const clickStart = caller.indexOf("async function click("),
        clickEnd = caller.indexOf("/** A real public Terminal", clickStart);
      const run = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(caller.slice(begin)).replace(/^export /gm, "") +
          "\nrunBrowserFollowupCaller;",
        {
          browserInitialCardinality,
          projectBrowserInitialJoin,
          withBrowserFollowupMainWindow,
          bindBrowserFollowupTarget,
          admitBrowserFollowupTerminal,
          pinBrowserFollowupTerminalReplay,
          createBrowserFollowupNetworkTransition,
          browserFollowupRows: [],
          NodeFS: { readFileSync: () => new Uint8Array([1]) },
          refused: () => original,
          click: NodeVM.runInNewContext(
            NodeModule.stripTypeScriptTypes(caller.slice(clickStart, clickEnd)) + "\nclick;",
            { refused: () => original },
          ),
          prepareBrowserFollowupTerminal: async () => ({
            terminalId: snapshot.terminalId,
            pid: snapshot.pid,
            label: "sleep",
            hasRunningSubprocess: true,
          }),
          readBrowserFollowupTerminalBaseline: async () => snapshot,
          startBrowserFollowupReplayNetwork: async (
            input: Parameters<typeof createBrowserFollowupReplayObserver>[0],
          ) => {
            const observer = createBrowserFollowupReplayObserver(input);
            const transport = await startTransport({
              CI: "true",
              listenPort: 4894,
              targetPort: 4897,
              observer,
              registerInitialOwners: input.registerInitialOwners,
              observeInitialFailure: input.observeInitialFailure,
            });
            observer.observe("connection-1", "request", {
              _tag: "Request",
              id: "1",
              tag: "subscribeServerConfig",
              payload: {},
            });
            observer.observe("connection-1", "request", {
              _tag: "Request",
              id: "2",
              tag: "terminal.attach",
              payload: {
                threadId: snapshot.threadId,
                terminalId: snapshot.terminalId,
                cwd: snapshot.cwd,
                worktreePath: snapshot.cwd,
                sizeClaim: "current-claim",
              },
            });
            observer.observe("connection-1", "reply", {
              _tag: "Chunk",
              requestId: "2",
              values: [
                {
                  type: "snapshot",
                  snapshot: {
                    ...snapshot,
                    size: {
                      cols: 80,
                      rows: 24,
                      sizeClaim: success ? "current-claim" : "another-window-claim",
                    },
                  },
                },
              ],
            });
            return { observer, transport, close: transport.close };
          },
        },
      );
      const screen = {
        waitForDisplayed: async () => {},
        waitForEnabled: async () => {},
        click: async () => events.push("click"),
      };
      const pending = run({
        CI: "true",
        prepared: {
          png: { path: "inert" },
          verify: async () => {},
          bootstrap: { close: async () => {} },
          retain: (resource: { close: () => Promise<void> }) => closes.push(resource.close),
          verifyHostedBuild: async () => ({}),
        },
        browser: {
          $: () => screen,
          $$: () => [{ getAttribute: async () => snapshot.terminalId }],
          execute: async () => {
            executes++;
            return rawFocus;
          },
          getWindowHandle: async () => "inert-main",
          getWindowHandles: async () => ["inert-main"],
          getUrl: async () => "http://127.0.0.1:4885/local/inert-thread",
          getWindowRect: async () => ({ x: 0, y: 0, width: 900, height: 700 }),
          url: async () => events.push("restore"),
          setWindowRect: async () => events.push("cleanup"),
        },
        owner: {
          until: async (check: () => Promise<unknown>) => {
            waits++;
            const value = await check();
            if (waits === 2) readiness.push(value);
            if (!value) throw original;
          },
        },
        theme: "light",
        accessToken: "inert",
        threadId: snapshot.threadId,
        cwd: snapshot.cwd,
        branch: "inert-branch",
        projectPath: "/inert/project",
        readDescriptor: async () => descriptor,
        readSnapshot: async () => snapshotModel,
        verifyPhysical: async () => {},
        patch: () => "",
        viewport: async () => {},
        evidence: root,
        captured: new Set(),
        captures: [],
        publish: () => {
          throw new Error("Unexpected scene publication.");
        },
        step: (phase: string) => {
          writerContext.phase = phase;
        },
        observeUnsafeCleanup: () => {},
        observeInitialFailure: (error: unknown, value: unknown) => {
          callbacks++;
          NodeAssert.equal(error, original);
          events.push("capture");
          writer.observe(error, value);
          if (undefinedError) throw undefined;
        },
      });
      let failed = false,
        caught: unknown;
      try {
        await pending;
      } catch (error) {
        failed = true;
        caught = error;
      }
      NodeAssert.equal(executes, 1);
      NodeAssert.equal(readiness.length, 1);
      NodeAssert.equal(readiness[0], rawFocus);
      NodeAssert.equal(waits, rawFocus ? 3 : 2);
      if (success) {
        NodeAssert.equal(failed, false);
        NodeAssert.equal(callbacks, 0);
        NodeAssert.equal(writer.read(), null);
        NodeAssert.equal(NodeFS.existsSync(NodePath.join(root, "failure.json")), false);
      } else {
        NodeAssert.equal(failed, true);
        NodeAssert.equal(caught, original);
        NodeAssert.equal(callbacks, 1);
        NodeAssert.ok(events.indexOf("capture") < events.indexOf("cleanup"));
        NodeAssert.equal(writer.read().error, original);
        NodeAssert.notEqual(writer.read().value, null);
        const first = writer.read().value;
        writer.observe(new Error("Inert later error."), first);
        NodeAssert.equal(writer.read().error, original);
        writer.publish(caught);
        const file = NodePath.join(root, "failure.json");
        NodeAssert.equal(NodeFS.statSync(file).mode & 0o777, 0o600);
        const bytes = NodeFS.readFileSync(file);
        NodeAssert.ok(bytes.length <= 1024 * 1024);
        const retained = JSON.parse(bytes.toString("utf8")).browserInitialJoin;
        NodeAssert.deepEqual(retained, {
          waitingOn: rawFocus ? "receipt-predicate" : "focus-predicate",
          ui: {
            windows: "one",
            mounts: "one",
            pinnedMountMatched: true,
            screenClickCompleted: true,
            activeTextareaOwned: typeof rawFocus === "boolean" ? rawFocus : null,
          },
          protocol: {
            closed: false,
            failed: false,
            attachRequests: "one",
            snapshots: "one",
            configAttachments: "one",
            resizeRequests: "none",
            sizeOwner: "foreign-claim",
          },
          replay: { closed: false, failed: false, snapshots: "one", configSnapshots: "one" },
          transport: { closed: false, failed: false, upgradedWires: "none", configWires: "none" },
          sizeOwner: "foreign-claim",
        });
        NodeAssert.equal(
          /inert-thread|another-window-claim|driver-value/.test(JSON.stringify(retained)),
          false,
        );
        NodeAssert.ok(Object.isFrozen(first) && Object.isFrozen(first.ui));
        for (const close of closes) await close();
        NodeAssert.deepEqual(
          JSON.parse(NodeFS.readFileSync(file, "utf8")).browserInitialJoin,
          retained,
        );
      }
    } finally {
      for (const close of closes) await close();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

test.each(["chat-staged-attachment", "terminal-shared-size"])(
  "actual delegated witness wait keeps first-row attribution local: %s",
  async (scene) => {
    const source = NodeFS.readFileSync(
      new URL("./release-visual-browser-followups-caller.ts", import.meta.url),
      "utf8",
    );
    const begin = source.indexOf("      const capture = async (");
    const end = source.indexOf("      const cancelled = async", begin);
    NodeAssert.ok(begin > 0 && end > begin);
    const actualCapture = await import("./release-visual-browser-followups.ts");
    for (const original of [new Error("Inert exact witness deadline."), undefined]) {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "browser-witness-phase-"));
      const phases: string[] = ["visual-browser-followups-" + scene];
      const captured = new Set<string>(),
        captures: object[] = [];
      let screenshots = 0,
        sourceJoins = 0,
        published = 0;
      const input = {
        theme: "light",
        threadId: "inert-thread",
        evidence: root,
        captured,
        captures,
        step: (phase: string) => phases.push(phase),
        publish: () => {
          published++;
        },
        owner: {
          until: async (predicate: () => Promise<boolean>, timeout?: number) => {
            NodeAssert.equal(timeout, undefined);
            NodeAssert.equal(await predicate(), false);
            throw original;
          },
        },
      };
      const capture = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(source.slice(begin, end)) + "\ncapture",
        {
          input,
          binding: { projectId: "inert-project" },
          terminal: { terminalId: "inert-terminal", label: "sleep" },
          captureBrowserFollowupScene: actualCapture.captureBrowserFollowupScene,
        },
      ) as (scene: string, browser: object, verify: () => Promise<void>) => Promise<void>;
      const browser = {
        ownedIsAlertOpen: async () => false,
        execute: async () => ({}),
        takeScreenshot: async () => {
          screenshots++;
          return "";
        },
      };
      try {
        let failed = false,
          caught: unknown;
        try {
          await capture(scene, browser, async () => {
            sourceJoins++;
          });
        } catch (error) {
          failed = true;
          caught = error;
        }
        NodeAssert.equal(failed, true);
        NodeAssert.equal(caught, original);
        NodeAssert.equal(
          phases.at(-1),
          "visual-browser-followups-" +
            scene +
            (scene === "chat-staged-attachment" || scene === "terminal-shared-size"
              ? "-capture-witness-wait"
              : ""),
        );
        NodeAssert.equal(sourceJoins, 1);
        NodeAssert.equal(screenshots, 0);
        NodeAssert.equal(published, 0);
        NodeAssert.equal(captured.size, 0);
        NodeAssert.deepEqual(captures, []);
        NodeAssert.deepEqual(NodeFS.readdirSync(root), []);
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }
  },
);

test.each(["owned", "wrong-handle", "wrong-terminal", "duplicate-mount", "extra-window"])(
  "original pointer callback retains exact pinned %s binding",
  async (mode) => {
    const source = NodeFS.readFileSync(
      new URL("./release-visual-browser-followups-caller.ts", import.meta.url),
      "utf8",
    );
    const begin = source.indexOf("      const originalTerminalWindow ="),
      end = source.indexOf("      const route =", begin),
      clickBegin = source.indexOf("async function click("),
      clickEnd = source.indexOf("/** A real public Terminal", clickBegin);
    NodeAssert.ok(begin > 0 && end > begin);
    let clicks = 0;
    const mounts = Array.from({ length: mode === "duplicate-mount" ? 2 : 1 }, () => ({
      getAttribute: async () => (mode === "wrong-terminal" ? "foreign" : "owned-terminal"),
    }));
    const browser = {
      getWindowHandle: async () => (mode === "wrong-handle" ? "foreign" : "main"),
      getWindowHandles: async () => (mode === "extra-window" ? ["main", "foreign"] : ["main"]),
      $$: (selector: string) => (selector.endsWith(".xterm-screen") ? [{}] : mounts),
      $: () => ({
        waitForDisplayed: async () => {},
        waitForEnabled: async () => {},
        click: async () => {
          clicks++;
        },
      }),
    };
    const callbacks = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        source.slice(clickBegin, clickEnd) + source.slice(begin, end),
      ) + "\n({restoreOriginalSizeOwner})",
      {
        input: { browser },
        terminalWindow: "main",
        terminal: { terminalId: "owned-terminal" },
        refused: () => new Error("Inert pinned focus refused."),
      },
    ) as { restoreOriginalSizeOwner: () => Promise<void> };
    if (mode === "owned") {
      await callbacks.restoreOriginalSizeOwner();
      NodeAssert.equal(clicks, 1);
    } else {
      await NodeAssert.rejects(callbacks.restoreOriginalSizeOwner());
      NodeAssert.equal(clicks, 0);
    }
  },
);

test.each([new Error("Inert exact primary"), undefined])(
  "actual private terminal writer admits only phase theme and exact primary identity",
  (primary) => {
    const qualifier = NodeFS.readFileSync(
      new URL("../qualify-delivery-retry.ts", import.meta.url),
      "utf8",
    );
    const declaration = qualifier.slice(
      qualifier.indexOf("  let browserInitialFailure:"),
      qualifier.indexOf("  let browserFollowupFixtureSafeToDelete = true;"),
    );
    const callbackStart = qualifier.indexOf(
      "          observeTerminalReceiptFailure: (error, reason) =>",
    );
    const callback = qualifier
      .slice(callbackStart, qualifier.indexOf("          owner,", callbackStart))
      .trim()
      .replace(/^observeTerminalReceiptFailure: /, "")
      .replace(/,$/, "");
    const fieldStart = qualifier.indexOf("      browserTerminalReceiptGuard:");
    const field = qualifier
      .slice(fieldStart, qualifier.indexOf("      browserInitialJoin:", fieldStart))
      .trim()
      .replace(/,$/, "");
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "browser-terminal-writer-"));
    NodeFS.chmodSync(root, 0o700);
    const phase = "visual-browser-followups-terminal-shared-size-terminal-receipt-wait";
    const context = NodeVM.createContext({
      NodeFS,
      NodePath,
      Object,
      projectBrowserTerminalGuardReason,
      config: { evidence: root, selection: "release-visual-browser-followups" },
      phase,
      theme: "light",
    });
    const writeStart = qualifier.indexOf("  const write ="),
      writeEnd = qualifier.indexOf("  const step =", writeStart);
    const writer = NodeVM.runInContext(
      NodeModule.stripTypeScriptTypes(
        declaration +
          qualifier.slice(writeStart, writeEnd) +
          "\nconst observe=" +
          callback +
          ";function publish(error){const originalBrowserTerminalReceiptFailure=readBrowserTerminalReceiptFailure();write('failure',{" +
          field +
          "});}({observe,publish});",
      ),
      context,
    );
    try {
      writer.observe(primary, "second-owner-mismatch");
      writer.publish(primary);
      const read = () =>
        JSON.parse(NodeFS.readFileSync(NodePath.join(root, "failure.json"), "utf8"))
          .browserTerminalReceiptGuard;
      NodeAssert.equal(read(), "second-owner-mismatch");
      NodeAssert.equal(NodeFS.statSync(NodePath.join(root, "failure.json")).mode & 0o777, 0o600);
      writer.publish(new Error("Different primary"));
      NodeAssert.equal(read(), null);
      context.theme = "dark";
      writer.publish(primary);
      NodeAssert.equal(read(), null);
      context.theme = "light";
      context.phase = "later";
      writer.publish(primary);
      NodeAssert.equal(read(), null);
      const malformedContext = NodeVM.createContext({ ...context, phase });
      const malformed = NodeVM.runInContext(
        NodeModule.stripTypeScriptTypes(
          declaration +
            qualifier.slice(writeStart, writeEnd) +
            "\nconst observe=" +
            callback +
            ";function publish(error){const originalBrowserTerminalReceiptFailure=readBrowserTerminalReceiptFailure();write('failure',{" +
            field +
            "});}({observe,publish});",
        ),
        malformedContext,
      );
      malformed.observe(primary, { message: "private" });
      malformed.publish(primary);
      NodeAssert.equal(read(), "private-unknown");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
