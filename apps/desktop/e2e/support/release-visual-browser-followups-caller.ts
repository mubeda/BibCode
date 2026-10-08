import type { BrowserTerminalGuardReason } from "./release-visual-browser-followups-source.ts";
// @effect-diagnostics nodeBuiltinImport:off - CI-only concrete caller composes existing physical/RPC/capture owners.
// @effect-diagnostics globalFetch:off - Current authenticated contracts on fixed owned loopback only.
// @effect-diagnostics globalTimers:off - One bounded current-contract metadata subscription, joined before returning.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import type { QualificationBrowser, QualificationOwner } from "./qualification-owner.ts";
import type { ExecutionEnvironmentDescriptor } from "../../../../packages/contracts/src/environment.ts";
import type { OrchestrationReadModel } from "../../../../packages/contracts/src/orchestration.ts";

import { type TerminalSummary } from "../../../../packages/contracts/src/terminal.ts";
import { startThrottleProxy } from "../../../../scripts/throttle-proxy.ts";
import { prepareBrowserFollowupPng } from "./release-visual-browser-followups-fixture.ts";
import {
  startBrowserFollowupReplayNetwork,
  readBrowserFollowupTerminalBaseline,
  readBrowserFollowupTerminalMetadata,
  pinBrowserFollowupTerminalReplay,
} from "./release-visual-browser-followups-caller-protocol.ts";
import {
  withBrowserFollowupSlowUpload,
  withBrowserFollowupSecondWindow,
  withBrowserFollowupHeldReply,
  withBrowserFollowupHostedEntry,
  withBrowserFollowupResource,
} from "./release-visual-browser-followups-owner.ts";
import { runBrowserFollowupScene } from "./release-visual-browser-followups-producer.ts";
import {
  browserFollowupRows,
  captureBrowserFollowupScene,
  type BrowserFollowupScene,
  type BrowserFollowupObservation,
  projectBrowserFollowupCapture,
} from "./release-visual-browser-followups.ts";
import {
  pinBrowserFollowupAssets,
  pinBrowserFollowupExecutable,
  startBrowserFollowupAssets,
  ownBrowserFollowupLink,
  joinBrowserFollowupCleanup,
} from "./release-visual-browser-followups-caller-resources.ts";
import {
  browserInitialCardinality,
  projectBrowserInitialJoin,
  type BrowserInitialJoin,
  type BrowserInitialOwners,
  type BrowserInitialCardinality,
} from "./release-visual-browser-followups-protocol.ts";
const refused = () => new Error("Owned browser follow-up caller refused.");
/** The controller's physical worktree verifier remains authoritative; this closes the public descriptor/snapshot join. */
export function bindBrowserFollowupTarget(input: {
  descriptor: ExecutionEnvironmentDescriptor;
  snapshot: OrchestrationReadModel;
  threadId: string;
  cwd: string;
  branch: string;
  projectPath: string;
}) {
  const descriptor = input.descriptor,
    threads = input.snapshot.threads.filter(
      (value) =>
        value.id === input.threadId &&
        value.deletedAt === null &&
        value.kind === "workspace" &&
        value.worktreePath === input.cwd &&
        value.branch === input.branch,
    );
  const thread = threads[0],
    projects = thread
      ? input.snapshot.projects.filter(
          (value) =>
            value.id === thread.projectId &&
            value.deletedAt === null &&
            value.workspaceRoot === input.projectPath,
        )
      : [];
  if (
    descriptor.environmentId !== "local" ||
    !descriptor.bootId ||
    !descriptor.storageInstanceId ||
    !descriptor.serverVersion ||
    threads.length !== 1 ||
    projects.length !== 1 ||
    ![input.threadId, thread?.projectId].every(
      (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value),
    )
  )
    throw refused();
  return Object.freeze({
    environmentId: "local",
    bootId: descriptor.bootId,
    storageInstanceId: descriptor.storageInstanceId,
    serverVersion: descriptor.serverVersion,
    threadId: input.threadId,
    projectId: thread!.projectId,
    cwd: input.cwd,
    branch: input.branch,
    projectPath: input.projectPath,
  });
}
export function admitBrowserFollowupTerminal(
  values: readonly TerminalSummary[],
  terminalId: string,
  threadId: string,
  cwd: string,
) {
  const matches = values.filter(
    (value) =>
      value.threadId === threadId &&
      value.terminalId === terminalId &&
      value.cwd === cwd &&
      value.worktreePath === cwd &&
      value.status === "running" &&
      value.hasRunningSubprocess === true &&
      value.label === "sleep" &&
      value.pid !== null,
  );
  if (
    values.filter((value) => value.threadId === threadId).length !== 1 ||
    matches.length !== 1 ||
    !Number.isInteger(matches[0]!.pid) ||
    !/^[-A-Za-z0-9 ]{1,64}$/.test(matches[0]!.label) ||
    !/^[-A-Za-z0-9._:]{1,128}$/.test(terminalId)
  )
    throw refused();
  return Object.freeze({
    terminalId,
    threadId,
    cwd,
    pid: matches[0]!.pid!,
    label: matches[0]!.label,
  });
}
/** One endpoint, one ordinary reconnect. Never mutate an observer's identity or expose two public proxies at once. */
export function createBrowserFollowupNetworkTransition<
  A extends { close: () => Promise<void> },
>(input: {
  bootstrap: { close: () => Promise<void> };
  startObserved: () => Promise<A>;
  observeUnsafeCleanup: () => void;
}) {
  let activation: Promise<A> | undefined,
    observed: A | undefined,
    closing = false,
    unsafe = false;
  const markUnsafe = () => {
    if (unsafe) return;
    unsafe = true;
    try {
      input.observeUnsafeCleanup();
    } catch {
      /* preserve error */
    }
  };
  const closeBootstrap = joinBrowserFollowupCleanup([input.bootstrap.close], markUnsafe);
  const activate = (): Promise<A> => {
    if (closing) return Promise.reject(refused());
    if (activation) return activation;
    activation = Promise.resolve().then(async () => {
      await closeBootstrap();
      observed = await input.startObserved();
      return observed;
    });
    return activation;
  };
  const cleanup = joinBrowserFollowupCleanup(
    [
      async () => {
        closing = true;
        let failed = false,
          original: unknown;
        if (activation)
          try {
            await activation;
          } catch (error) {
            failed = true;
            original = error;
          }
        try {
          if (observed) await observed.close();
          else await closeBootstrap();
        } catch (error) {
          if (!failed) original = error;
          failed = true;
        }
        if (failed) throw original;
      },
    ],
    markUnsafe,
  );
  return {
    activate,
    close: () => {
      closing = true;
      return cleanup();
    },
  };
}
/** Existing private input copies, unchanged Source SHA and actual SDK source are joined with their build recipe. */
export function readBrowserFollowupBuildRecipe(input: {
  primaryAssets: string;
  hostedAssets: string;
  source: string;
  repository: string;
}) {
  const read = (root: string, mode: "primary" | "hosted") => {
    const path = NodePath.join(root, "qualified-browser-build.json"),
      stat = NodeFS.lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      NodeFS.realpathSync(path) !== path ||
      stat.size > 8192
    )
      throw refused();
    const value = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    const keys = [
      "schema",
      "mode",
      "source",
      "sdkSourceSha256",
      "backendHttp",
      "backendWs",
      "devServerUrl",
      "hostedOrigin",
      "probeEntry",
    ];
    if (
      Object.keys(value).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(value, key)) ||
      value.schema !== 1 ||
      value.mode !== mode ||
      value.source !== input.source ||
      value.hostedOrigin !== "http://127.0.0.1:4893" ||
      value.backendHttp !== (mode === "primary" ? "http://127.0.0.1:4887" : "") ||
      value.backendWs !== (mode === "primary" ? "ws://127.0.0.1:4887" : "") ||
      value.devServerUrl !== (mode === "primary" ? "http://127.0.0.1:4885" : "") ||
      value.probeEntry !== (mode === "hosted" ? "qualified-hosted-mode.js" : null)
    )
      throw refused();
    return value;
  };
  const primary = read(input.primaryAssets, "primary"),
    hosted = read(input.hostedAssets, "hosted"),
    source = NodePath.join(input.repository, "apps/web/src/hostedPairing.ts");
  const hash = NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(source)).digest("hex");
  if (
    NodeFS.realpathSync(source) !== source ||
    NodeFS.lstatSync(source).isSymbolicLink() ||
    primary.sdkSourceSha256 !== hash ||
    hosted.sdkSourceSha256 !== hash ||
    !NodeFS.statSync(NodePath.join(input.hostedAssets, "qualified-hosted-mode.js")).isFile()
  )
    throw refused();
}
/** Start before the controller's existing descriptor/pair/workspace flow. Guarded Rust owns raw4897, not the UI port. */
export async function prepareBrowserFollowupCaller(input: {
  CI: string | undefined;
  root: string;
  primaryAssets: string;
  hostedAssets: string;
  source: string;
  repository: string;
  binary: string;
  admitOwner: () => Promise<void>;
  verifyInputs: () => Promise<void>;
  observeUnsafeCleanup: () => void;
}) {
  if (input.CI !== "true") throw refused();
  await input.admitOwner();
  await input.verifyInputs();
  readBrowserFollowupBuildRecipe(input);
  const executable = pinBrowserFollowupExecutable(input.binary);
  const primaryPin = pinBrowserFollowupAssets(input.primaryAssets),
    hostedPin = pinBrowserFollowupAssets(input.hostedAssets),
    resources: Array<() => Promise<void>> = [];
  const close = joinBrowserFollowupCleanup(resources, input.observeUnsafeCleanup);
  try {
    const main = await startBrowserFollowupAssets({
      CI: input.CI,
      port: 4885,
      pin: primaryPin,
      observeUnsafeCleanup: input.observeUnsafeCleanup,
    });
    resources.push(main.close);
    const hosted = await startBrowserFollowupAssets({
      CI: input.CI,
      port: 4893,
      pin: hostedPin,
      observeUnsafeCleanup: input.observeUnsafeCleanup,
    });
    resources.push(hosted.close);
    const proxy = await startThrottleProxy({
      listenHost: "127.0.0.1",
      listenPort: 4887,
      targetHost: "127.0.0.1",
      targetPort: 4897,
    });
    const bootstrapClose = joinBrowserFollowupCleanup([proxy.close], input.observeUnsafeCleanup);
    resources.push(bootstrapClose);
    const png = prepareBrowserFollowupPng(input.root);
    const verify = async () => {
      await input.admitOwner();
      await input.verifyInputs();
      executable.verify();
      readBrowserFollowupBuildRecipe(input);
      main.verify();
      hosted.verify();
      png.verify();
    };
    return {
      png,
      bootstrap: { close: bootstrapClose },
      verify,
      verifyHostedBuild: async () => {
        await verify();
        return {
          genuineHostedBuild: true,
          backendConfigAbsent: true,
          sameSourceMatched: true,
        } as const;
      },
      retain: (resource: { close: () => Promise<void> }) => resources.push(resource.close),
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch {
      /* original startup refusal wins */
    }
    throw error;
  }
}
async function click(browser: QualificationBrowser, selector: string) {
  const control = browser.$(selector);
  await control.waitForDisplayed();
  await control.waitForEnabled();
  if ((await browser.$$(selector).length) !== 1) throw refused();
  await control.click();
}
/** A real public Terminal surface creates the ID. The caller reads its DOM mount and actual metadata; it never sets a store. */
export async function prepareBrowserFollowupTerminal(input: {
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until">;
  accessToken: string;
  threadId: string;
  cwd: string;
  observeUnsafeCleanup: () => void;
}) {
  const browser = input.browser,
    bar = browser.$("[data-right-panel-tabbar]");
  if (!(await bar.isDisplayed())) await click(browser, 'button[aria-label^="Toggle right panel"]');
  await bar.waitForDisplayed();
  const empty = '//button[.//span[normalize-space()="Terminal"] and not(@aria-disabled="true")]';
  if (await browser.$(empty).isDisplayed()) await click(browser, empty);
  else {
    await click(browser, 'button[aria-label="Add panel surface"]');
    await click(browser, '//*[@role="menuitem" and normalize-space()="Terminal"]');
  }
  const mount = "[data-preview-panel-mode] [data-terminal-xterm-mount]";
  await browser.$(mount).waitForDisplayed();
  if ((await browser.$$(mount).length) !== 1) throw refused();
  const terminalId = await browser.$(mount).getAttribute("data-terminal-xterm-mount");
  if (!terminalId) throw refused();
  await click(browser, mount + " .xterm-screen");
  await input.owner.until(() =>
    browser.execute(
      () =>
        document.activeElement?.classList.contains("xterm-helper-textarea") === true &&
        document.activeElement.closest("[data-preview-panel-mode]") !== null,
    ),
  );
  await browser.keys("printf '\\nOwned shared terminal output\\n'; /bin/sleep 600");
  await browser.keys("Enter");
  let bound: ReturnType<typeof admitBrowserFollowupTerminal> | undefined;
  await input.owner.until(async () => {
    const values = await readBrowserFollowupTerminalMetadata(
      input.accessToken,
      input.observeUnsafeCleanup,
    );
    try {
      bound = admitBrowserFollowupTerminal(values, terminalId, input.threadId, input.cwd);
      return true;
    } catch {
      return false;
    }
  });
  if (!bound) throw refused();
  return bound;
}
/** Own only the admitted main handle. Independent restores retain every cleanup error and the original visual failure. */
export async function withBrowserFollowupMainWindow<A>(input: {
  browser: QualificationBrowser;
  route: string;
  verifyOwnedIdentity: () => Promise<void>;
  observeUnsafeCleanup: () => void;
  run: () => Promise<A>;
}): Promise<A> {
  const browser = input.browser,
    original = await browser.getWindowHandle();
  const verifyWindow = async () => {
    const handles = await browser.getWindowHandles();
    if (
      handles.length !== 1 ||
      handles[0] !== original ||
      (await browser.getWindowHandle()) !== original
    )
      throw refused();
  };
  await verifyWindow();
  const url = await browser.getUrl(),
    rectangle = await browser.getWindowRect();
  if (
    url !== input.route ||
    ![rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isSafeInteger) ||
    rectangle.width <= 0 ||
    rectangle.height <= 0
  )
    throw refused();
  const cleanup = joinBrowserFollowupCleanup(
    [
      input.verifyOwnedIdentity,
      async () => {
        await verifyWindow();
        const current = await browser.getWindowRect();
        if (
          (await browser.getUrl()) !== url ||
          !(["x", "y", "width", "height"] as const).every((key) => current[key] === rectangle[key])
        )
          throw refused();
      },
      async () => {
        await verifyWindow();
        await browser.setWindowRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
      },
      async () => {
        await verifyWindow();
        await browser.url(url);
      },
    ],
    input.observeUnsafeCleanup,
  );
  let failed = false,
    originalFailure: unknown,
    result: A | undefined;
  try {
    result = await input.run();
  } catch (error) {
    failed = true;
    originalFailure = error;
  }
  try {
    await cleanup();
  } catch (error) {
    if (!failed) {
      failed = true;
      originalFailure = error;
    }
  }
  if (failed) throw originalFailure;
  return result as A;
}
/** The only runtime invocation: six existing producers compose their already-reviewed owners, proofs and original capturer. */
export async function runBrowserFollowupCaller(input: {
  CI: string | undefined;
  prepared: Awaited<ReturnType<typeof prepareBrowserFollowupCaller>>;
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until">;
  theme: "light" | "dark";
  accessToken: string;
  threadId: string;
  cwd: string;
  branch: string;
  projectPath: string;
  readDescriptor: () => Promise<ExecutionEnvironmentDescriptor>;
  readSnapshot: () => Promise<OrchestrationReadModel>;
  verifyPhysical: () => Promise<void>;
  patch: () => string;
  viewport: (
    browser: QualificationBrowser,
    width: 1280,
    height: 960,
    wait?: {
      row: "chat-staged-attachment" | "terminal-shared-size";
      step: (phase: string) => void;
    },
  ) => Promise<void>;
  evidence: string;
  captured: Set<string>;
  captures: Array<ReturnType<typeof projectBrowserFollowupCapture>>;
  publish: () => void;
  step: (phase: string) => void;
  observeUnsafeCleanup: () => void;
  observeInitialFailure?: (error: unknown, value: BrowserInitialJoin | null) => void;
  observeTerminalReceiptFailure?: (error: unknown, reason: BrowserTerminalGuardReason) => void;
}) {
  if (input.CI !== "true") throw refused();
  let cleanupBinding: ReturnType<typeof bindBrowserFollowupTarget> | undefined;
  return withBrowserFollowupMainWindow({
    browser: input.browser,
    route: "http://127.0.0.1:4885/local/" + encodeURIComponent(input.threadId),
    observeUnsafeCleanup: input.observeUnsafeCleanup,
    verifyOwnedIdentity: async () => {
      await input.prepared.verify();
      await input.verifyPhysical();
      if (cleanupBinding) {
        const current = bindBrowserFollowupTarget({
          ...input,
          descriptor: await input.readDescriptor(),
          snapshot: await input.readSnapshot(),
        });
        if (JSON.stringify(current) !== JSON.stringify(cleanupBinding)) throw refused();
      }
    },
    run: async () => {
      await input.prepared.verify();
      await input.verifyPhysical();
      const binding = bindBrowserFollowupTarget({
        ...input,
        descriptor: await input.readDescriptor(),
        snapshot: await input.readSnapshot(),
      });
      cleanupBinding = binding;
      input.step("visual-browser-followups-terminal-bootstrap");
      const terminal = await prepareBrowserFollowupTerminal(input);
      let baseline: ReturnType<typeof pinBrowserFollowupTerminalReplay> | undefined;
      await input.owner.until(async () => {
        const snapshot = await readBrowserFollowupTerminalBaseline({
          ...input,
          terminalId: terminal.terminalId,
        });
        if (
          snapshot.pid !== terminal.pid ||
          snapshot.threadId !== input.threadId ||
          snapshot.terminalId !== terminal.terminalId ||
          snapshot.cwd !== input.cwd ||
          snapshot.status !== "running"
        )
          throw refused();
        if (!/(?:^|\r?\n)Owned shared terminal output\r?\n/.test(snapshot.history)) return false;
        baseline = pinBrowserFollowupTerminalReplay(
          snapshot,
          input.threadId,
          terminal.terminalId,
          input.cwd,
        );
        return true;
      });
      if (!baseline) throw refused();
      const initialOwners: BrowserInitialOwners = {};
      const initialUi: {
        windows: BrowserInitialCardinality | null;
        mounts: BrowserInitialCardinality | null;
        pinnedMountMatched: boolean | null;
        screenClickCompleted: boolean;
        activeTextareaOwned: boolean | null;
      } = {
        windows: null,
        mounts: null,
        pinnedMountMatched: null,
        screenClickCompleted: false,
        activeTextareaOwned: null,
      };
      let waitingOn: BrowserInitialJoin["waitingOn"] = "before-focus",
        initialActive = true,
        initialCaptured = false;
      const captureInitialFailure = (error: unknown) => {
        if (!initialActive || initialCaptured) return;
        initialCaptured = true;
        const read = <A>(project: (() => A) | undefined): A | null => {
          try {
            return project?.() ?? null;
          } catch {
            return null;
          }
        };
        const protocol = read(initialOwners.protocol);
        const value = projectBrowserInitialJoin({
          waitingOn,
          ui: initialUi,
          protocol,
          replay: read(initialOwners.replay),
          transport: read(initialOwners.transport),
          sizeOwner: protocol?.sizeOwner ?? "unknown",
        });
        try {
          input.observeInitialFailure?.(error, value);
        } catch {
          /* Original initial failure wins, including undefined. */
        }
      };
      let initialNetwork: Awaited<ReturnType<typeof startBrowserFollowupReplayNetwork>>;
      let terminalWindow: string | undefined;
      try {
        const transition = createBrowserFollowupNetworkTransition({
          bootstrap: input.prepared.bootstrap,
          startObserved: () =>
            startBrowserFollowupReplayNetwork({
              CI: input.CI,
              baseline: baseline!,
              slowTransport: () => false,
              png: NodeFS.readFileSync(input.prepared.png.path),
              cwd: input.cwd,
              threadId: input.threadId,
              terminalId: terminal.terminalId,
              patch: input.patch,
              observeUnsafeCleanup: input.observeUnsafeCleanup,
              registerInitialOwners: (owners) => Object.assign(initialOwners, owners),
              observeInitialFailure: captureInitialFailure,
            }),
          observeUnsafeCleanup: input.observeUnsafeCleanup,
        });
        input.prepared.retain(transition);
        input.step("visual-browser-followups-observed-reconnect");
        terminalWindow = await input.browser.getWindowHandle();
        const network = await transition.activate();
        network.transport.throwIfFailed();
        network.observer.replay.throwIfFailed();
        const terminalWindows = await input.browser.getWindowHandles();
        initialUi.windows = browserInitialCardinality(terminalWindows.length);
        if (
          terminalWindows.length !== 1 ||
          terminalWindows[0] !== terminalWindow ||
          (await input.browser.getWindowHandle()) !== terminalWindow
        )
          throw refused();
        const terminalMount = "[data-preview-panel-mode] [data-terminal-xterm-mount]";
        const terminalMounts = input.browser.$$(terminalMount);
        const terminalMountCount = await terminalMounts.length;
        initialUi.mounts = browserInitialCardinality(terminalMountCount);
        if (terminalMountCount !== 1) throw refused();
        initialUi.pinnedMountMatched =
          (await terminalMounts[0]!.getAttribute("data-terminal-xterm-mount")) ===
          terminal.terminalId;
        if (!initialUi.pinnedMountMatched) throw refused();
        await click(input.browser, terminalMount + " .xterm-screen");
        initialUi.screenClickCompleted = true;
        waitingOn = "focus-predicate";
        await input.owner.until(async () => {
          network.transport.throwIfFailed();
          network.observer.replay.throwIfFailed();
          const activeTextareaOwned = await input.browser.execute((terminalId: string) => {
            const mounts = document.querySelectorAll<HTMLElement>(
              "[data-preview-panel-mode] [data-terminal-xterm-mount]",
            );
            const active = document.activeElement;
            return (
              mounts.length === 1 &&
              mounts[0]!.getAttribute("data-terminal-xterm-mount") === terminalId &&
              active instanceof HTMLTextAreaElement &&
              active.classList.contains("xterm-helper-textarea") &&
              mounts[0]!.contains(active)
            );
          }, terminal.terminalId);
          initialUi.activeTextareaOwned =
            typeof activeTextareaOwned === "boolean" ? activeTextareaOwned : null;
          return activeTextareaOwned;
        });
        waitingOn = "receipt-predicate";
        await input.owner.until(async () => {
          network.transport.throwIfFailed();
          network.observer.replay.throwIfFailed();
          try {
            network.observer.terminalRestored();
            return true;
          } catch {
            network.transport.throwIfFailed();
            network.observer.replay.throwIfFailed();
            return false;
          }
        });
        // Initial reconnect admission ends here.
        initialNetwork = network;
      } catch (error) {
        captureInitialFailure(error);
        initialActive = false;
        throw error;
      }
      initialActive = false;
      const network = initialNetwork;
      const verifyIdentity = async () => {
        await input.prepared.verify();
        await input.verifyPhysical();
        network.observer.replay.verify();
        const current = bindBrowserFollowupTarget({
          ...input,
          descriptor: await input.readDescriptor(),
          snapshot: await input.readSnapshot(),
        });
        if (JSON.stringify(current) !== JSON.stringify(binding)) throw refused();
        const live = admitBrowserFollowupTerminal(
          await readBrowserFollowupTerminalMetadata(input.accessToken, input.observeUnsafeCleanup),
          terminal.terminalId,
          input.threadId,
          input.cwd,
        );
        if (live.pid !== terminal.pid) throw refused();
      };
      const originalTerminalWindow = terminalWindow;
      if (!originalTerminalWindow) throw refused();
      const focusOriginalTerminal = async (windowCount: 1 | 2) => {
        const windows = await input.browser.getWindowHandles();
        if (
          windows.length !== windowCount ||
          !windows.includes(originalTerminalWindow) ||
          (await input.browser.getWindowHandle()) !== originalTerminalWindow
        )
          throw refused();
        const mount = "[data-preview-panel-mode] [data-terminal-xterm-mount]";
        const mounts = input.browser.$$(mount);
        if (
          (await mounts.length) !== 1 ||
          (await mounts[0]!.getAttribute("data-terminal-xterm-mount")) !== terminal.terminalId
        )
          throw refused();
        await click(input.browser, mount + " .xterm-screen");
      };
      const prepareOriginalSizeOwner = async () => {
        const selected = await input.browser.getWindowHandle();
        const windows = await input.browser.getWindowHandles();
        if (
          selected === originalTerminalWindow ||
          windows.length !== 2 ||
          !windows.includes(selected) ||
          !windows.includes(originalTerminalWindow)
        )
          throw refused();
        await withBrowserFollowupResource({
          run: async () => {
            await input.browser.switchToWindow(originalTerminalWindow);
            await focusOriginalTerminal(2);
          },
          cleanup: async () => {
            const current = await input.browser.getWindowHandles();
            if (
              current.length !== 2 ||
              !current.includes(selected) ||
              !current.includes(originalTerminalWindow)
            )
              throw refused();
            await input.browser.switchToWindow(selected);
          },
          observeUnsafeCleanup: input.observeUnsafeCleanup,
        });
      };
      const restoreOriginalSizeOwner = () => focusOriginalTerminal(1);
      const route = "http://127.0.0.1:4885/local/" + encodeURIComponent(input.threadId);
      const capture = async (
        scene: BrowserFollowupScene,
        browser: QualificationBrowser,
        verifySource: () => Promise<void>,
      ) => {
        const observation: BrowserFollowupObservation = {
          scene,
          theme: input.theme,
          origin: scene.startsWith("hosted-pair-")
            ? "http://127.0.0.1:4893"
            : "http://127.0.0.1:4885",
          environmentId: "local",
          threadId: input.threadId,
          projectId: binding.projectId,
          terminalId: terminal.terminalId,
          terminalLabel: terminal.label,
          environmentLabel: "Local",
          hostedHost: "127.0.0.1:4887",
        };
        const receipt = await captureBrowserFollowupScene({
          browser,
          owner:
            scene === "chat-staged-attachment" || scene === "terminal-shared-size"
              ? {
                  until: async (predicate, timeout) => {
                    input.step(
                      scene === "chat-staged-attachment"
                        ? "visual-browser-followups-chat-staged-attachment-capture-witness-wait"
                        : "visual-browser-followups-terminal-shared-size-capture-witness-wait",
                    );
                    await input.owner.until(predicate, timeout);
                    input.step(
                      scene === "chat-staged-attachment"
                        ? "visual-browser-followups-chat-staged-attachment"
                        : "visual-browser-followups-terminal-shared-size",
                    );
                  },
                }
              : input.owner,
          evidence: input.evidence,
          captured: input.captured,
          observation,
          verifySource,
        });
        input.captures.push(receipt);
        input.publish();
      };
      const cancelled = async () => {
        await input.owner.until(async () => {
          try {
            network.observer.cancelled();
            return true;
          } catch {
            return false;
          }
        });
      };
      const cancelOwnedStage = async () => {
        const control = input.browser.$(
          '//p[@role="status" and contains(normalize-space(),"Uploading 1 attachment")]/parent::*//button[normalize-space()="Cancel"]',
        );
        if (await control.isDisplayed()) {
          await control.waitForEnabled();
          await control.click();
          await cancelled();
        }
        if (network.observer.stagePending()) throw refused();
      };
      for (const row of browserFollowupRows)
        await runBrowserFollowupScene(
          {
            ...(input.observeTerminalReceiptFailure
              ? { observeTerminalReceiptFailure: input.observeTerminalReceiptFailure }
              : {}),
            browser: input.browser,
            owner: input.owner,
            verifyOwnedIdentity: verifyIdentity,
            viewport: input.viewport,
            capture,
            step: input.step,
            observeUnsafeCleanup: input.observeUnsafeCleanup,
            upload: {
              withSlowTransport: (run) =>
                withBrowserFollowupSlowUpload(
                  {
                    png: input.prepared.png,
                    proxy: network.proxy,
                    readProtocolReceipt: network.observer.upload,
                    verifyCancelled: cancelled,
                    cancelOwnedStage,
                    observeUnsafeCleanup: input.observeUnsafeCleanup,
                  },
                  run,
                ),
            },
            terminal: {
              withSecondWindow: (run) =>
                withBrowserFollowupSecondWindow(
                  {
                    browser: input.browser,
                    owner: input.owner,
                    threadRoute: route,
                    label: terminal.label,
                    readTerminalReceipt: network.observer.terminal,
                    prepareOriginalSizeOwner,
                    restoreOriginalSizeOwner,
                    verifyFit: network.observer.fitted,
                    verifyRestored: network.observer.terminalRestored,
                    observeUnsafeCleanup: input.observeUnsafeCleanup,
                  },
                  run,
                ),
            },
            sourceControl: { verify: async () => network.observer.diff() },
            slow: {
              withHeldReply: (run) =>
                withBrowserFollowupHeldReply(
                  {
                    transport: network.transport,
                    owner: input.owner,
                    observeUnsafeCleanup: input.observeUnsafeCleanup,
                  },
                  run,
                ),
            },
            hosted: {
              withOwnedEntry: async (mode, run) => {
                const link = await ownBrowserFollowupLink({
                  accessToken: input.accessToken,
                  idempotencyKey:
                    "browser-followup-" + input.theme + "-" + mode + "-" + NodeCrypto.randomUUID(),
                  observeUnsafeCleanup: input.observeUnsafeCleanup,
                });
                input.prepared.retain(link);
                return withBrowserFollowupResource({
                  run: () =>
                    withBrowserFollowupHostedEntry(
                      {
                        mode,
                        theme: input.theme,
                        browser: input.browser,
                        owner: input.owner,
                        token: link.token,
                        verifyHostedBuild: input.prepared.verifyHostedBuild,
                        verifyOwnedUnsubmittedLink: link.verify,
                        revokeOwnedUnsubmittedLink: link.close,
                        observeUnsafeCleanup: input.observeUnsafeCleanup,
                      },
                      run,
                    ),
                  cleanup: link.close,
                  observeUnsafeCleanup: input.observeUnsafeCleanup,
                });
              },
            },
          },
          row,
        );
    },
  });
}
