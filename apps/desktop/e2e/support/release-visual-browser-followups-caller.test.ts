import { it as test } from "vite-plus/test";
import * as NodeAssert from "node:assert/strict";
// @effect-diagnostics nodeBuiltinImport:off - Actual caller source executes only on inert ports.
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
test.each(["owned", "bootstrap-close", "source-drift"])(
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
        terminalRestored: () => events.push("reconnect"),
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
        withBrowserFollowupMainWindow,
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
        browserFollowupRows,
        runBrowserFollowupScene: async (
          input: {
            verifyOwnedIdentity: () => Promise<void>;
            capture: (scene: string, browser: object, verify: () => Promise<void>) => Promise<void>;
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
        $: () => ({ isDisplayed: async () => false }),
        getWindowHandles: async () => ["inert-main"],
        getWindowHandle: async () => "inert-main",
        getUrl: async () => "http://127.0.0.1:4885/local/inert-thread",
        getWindowRect: async () => ({ x: 0, y: 0, width: 900, height: 700 }),
        setWindowRect: async () => {},
        url: async () => {},
      },
      owner: {
        until: async (check: () => Promise<boolean>) => {
          if (!(await check())) throw new Error("inert observation missing");
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
      step: () => {},
      observeUnsafeCleanup: () => {
        events.push("unsafe");
      },
    });
    if (mode === "owned") {
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
    const start = source.indexOf(
      "      await input.owner.until(async () => {",
      source.indexOf('input.step("visual-browser-followups-observed-reconnect")'),
    );
    const end = source.indexOf("      const verifyIdentity =", start);
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
