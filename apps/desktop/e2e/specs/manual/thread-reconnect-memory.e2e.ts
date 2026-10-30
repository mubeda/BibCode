// @effect-diagnostics nodeBuiltinImport:off - The manual memory spec writes gate files and samples footprint.
// @effect-diagnostics globalDate:off - The manual memory spec timestamps its steps for the report.
// @effect-diagnostics globalTimers:off - The manual memory spec waits on files the operator creates.
/**
 * Manual packaged spec: thread memory across in-page reconnects (#96, #134).
 *
 * Not in the default list; run it alone with
 * `BIBCODE_E2E_SPEC=./specs/manual/thread-reconnect-memory.e2e.ts vp run test:ui:desktop`.
 * The procedure, the gates and the report fields are in docs/testing/macos-desktop.md
 * ("Thread memory across reconnects").
 *
 * It builds a thread of BIBCODE_E2E_MEMORY_PROMPTS prompts (default 100) of 60,000 characters,
 * each starting with a unique `prompt-<n>-` token, answered by the Codex fixture. Then it closes
 * the app's RPC socket from the page: unchanged reconnects first, then changed ones, where a
 * slow turn finishes while the socket is down so the resubscribe gets a whole snapshot.
 *
 * At each measurement point it calls `console.takeHeapSnapshot(<label>)` and, unless
 * BIBCODE_E2E_MEMORY_GATES=0, waits for the operator to create `<artifacts>/memory-gate-<label>.go`
 * after exporting that snapshot from Web Inspector. With BIBCODE_E2E_WEBCONTENT_PID set it also
 * samples that process's footprint after a settle. Every step is appended to
 * `<artifacts>/memory-steps.jsonl`.
 *
 * The harness is installed after the app opened its socket and finds that socket through its
 * next send. That works because the app connects through Effect's
 * `Socket.layerWebSocketConstructorGlobal` (apps/web/src/lib/runtime.ts), which calls
 * `new globalThis.WebSocket(...)` on every connect, so each reconnect sees the harness. It has
 * not run on a packaged app yet: if a reconnect times out with "never opened a new RPC socket",
 * install the harness before the document loads instead.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  readProviderInputLog,
  waitForProviderInputLogEntry,
} from "../../support/provider-input-log.ts";
import { completeDesktopUiSlowTurn, desktopUiFixture } from "../../support/test-project.ts";
import {
  ensureMainSidebarOpen,
  mockDesktopUiFolderPicker,
  setDesktopUiWindowSize,
} from "../../support/ui-state.ts";

const artifactDirectory = process.env.BIBCODE_E2E_ARTIFACT_DIR;
const projectPath = process.env.BIBCODE_E2E_PROJECT_PATH;
const providerInputLogPath = process.env.BIBCODE_E2E_PROVIDER_INPUT_LOG;
if (!artifactDirectory || !projectPath || !providerInputLogPath) {
  throw new Error("The packaged desktop memory fixture environment was not prepared.");
}
const artifacts: string = artifactDirectory;
const project: string = projectPath;
const inputLog: string = providerInputLogPath;

const PROMPTS = Number(process.env.BIBCODE_E2E_MEMORY_PROMPTS ?? 100);
const PROMPT_LENGTH = 60_000;
const UNCHANGED = Number(process.env.BIBCODE_E2E_MEMORY_UNCHANGED ?? 2);
const CHANGED = Number(process.env.BIBCODE_E2E_MEMORY_CHANGED ?? 8);
const GATES = process.env.BIBCODE_E2E_MEMORY_GATES !== "0";
const WEBCONTENT_PID = process.env.BIBCODE_E2E_WEBCONTENT_PID;
const SETTLE_MS = Number(process.env.BIBCODE_E2E_MEMORY_SETTLE_MS ?? 30_000);
const GATE_TIMEOUT_MS = 60 * 60_000;

const visibleSurfaceSelector = '[data-center-surface-host][data-visible="true"]';
const composerFormSelector = `${visibleSurfaceSelector} [data-chat-composer-form="true"]`;
const editorSelector = `${composerFormSelector} [data-testid="composer-editor"]`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function recordStep(step: Record<string, unknown>): void {
  NodeFS.appendFileSync(
    NodePath.join(artifacts, "memory-steps.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), ...step })}\n`,
  );
}

/** `footprint`'s phys_footprint for the WebContent process, the median of three samples. */
function sampleFootprint(): string | null {
  if (WEBCONTENT_PID === undefined) return null;
  const samples: Array<number> = [];
  for (let sample = 0; sample < 3; sample += 1) {
    const output = NodeChildProcess.execFileSync("footprint", ["-p", WEBCONTENT_PID], {
      encoding: "utf8",
    });
    const match = /phys_footprint:\s*([\d.]+)\s*([KMG]B)/u.exec(output);
    if (match === null) throw new Error(`footprint printed no phys_footprint:\n${output}`);
    const scale = { KB: 1 / 1024, MB: 1, GB: 1024 }[match[2] as "KB" | "MB" | "GB"];
    samples.push(Number(match[1]) * scale);
  }
  samples.sort((a, b) => a - b);
  return `${samples[1]!.toFixed(1)} MB`;
}

async function measure(label: string): Promise<void> {
  await sleep(SETTLE_MS);
  const footprint = sampleFootprint();
  await browser.execute((name: string) => {
    const host = console as Console & { takeHeapSnapshot?: (label: string) => void };
    host.takeHeapSnapshot?.(name);
  }, label);
  recordStep({ step: "measure", label, footprint });
  if (!GATES) return;
  const waiting = NodePath.join(artifacts, `memory-gate-${label}.waiting`);
  const go = NodePath.join(artifacts, `memory-gate-${label}.go`);
  NodeFS.writeFileSync(waiting, `${label}\n`);
  const deadline = Date.now() + GATE_TIMEOUT_MS;
  while (!NodeFS.existsSync(go)) {
    if (Date.now() > deadline) throw new Error(`Nobody released memory gate ${label}.`);
    await sleep(1_000);
  }
  NodeFS.rmSync(waiting, { force: true });
}

async function ensureFixtureProjectOpen(): Promise<void> {
  const appOrigin = await browser.execute(() => window.location.origin);
  await browser.url(`${appOrigin}/#/`);
  await ensureMainSidebarOpen();
  const projectButton = `//button[@data-sidebar="menu-button"][.//span[normalize-space()="${desktopUiFixture.projectName}"]]`;
  if (!(await browser.$(projectButton).isExisting())) {
    await browser.$('[data-testid="sidebar-add-project-trigger"]').click();
    const browseFolder = browser.$(
      "//button[@data-add-project-action='true'][.//span[normalize-space()='Browse folder']]",
    );
    await browseFolder.waitForDisplayed();
    await mockDesktopUiFolderPicker(project);
    await browseFolder.click();
    await browser.$(projectButton).waitForDisplayed();
  }
  const primaryWorkspace = browser.$(
    '//*[@data-thread-item="true"][.//span[normalize-space()="main"]]',
  );
  if (!(await primaryWorkspace.isDisplayed())) await browser.$(projectButton).click();
  await primaryWorkspace.waitForDisplayed();
  await primaryWorkspace.click();
  await browser.$(editorSelector).waitForDisplayed();
}

/** Types `text` into the composer in one input event, then sends it with Enter. */
async function send(text: string): Promise<void> {
  const editor = browser.$(editorSelector);
  await editor.click();
  const length = await browser.execute(
    async (value: string, selector: string) => {
      const target = document.activeElement;
      if (!(target instanceof HTMLElement) || target.dataset.testid !== "composer-editor") {
        throw new Error("The composer editor did not receive focus.");
      }
      document.execCommand("insertText", false, value);
      // The editor commits the insertion on a later frame and may replace its node, so re-read it.
      const current = () => document.querySelector<HTMLElement>(selector)?.textContent?.length ?? 0;
      for (let frame = 0; frame < 120 && current() !== value.length; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return current();
    },
    text,
    editorSelector,
  );
  if (length !== text.length) {
    throw new Error(`The composer holds ${length} characters, not ${text.length}.`);
  }
  await browser.keys("Enter");
  await browser.waitUntil(async () => ((await editor.getText()) ?? "") === "", {
    timeoutMsg: "The composer did not clear after sending.",
  });
}

async function sendAndAwaitStart(text: string): Promise<string | undefined> {
  const baseline = readProviderInputLog(inputLog).length;
  await send(text);
  const start = await waitForProviderInputLogEntry(
    inputLog,
    baseline,
    { provider: "codex", prompt: text, kind: "start" },
    { timeoutMs: 60_000 },
  );
  return start.turnId;
}

/**
 * Keeps only the current RPC socket (a closed one would keep its session's listeners), and
 * while blocked points new RPC sockets at a closed port so the app stays disconnected.
 */
async function installReconnectHarness(): Promise<void> {
  await browser.execute(() => {
    const host = window as Window & { __bibcodeMemoryHarness?: unknown };
    if (host.__bibcodeMemoryHarness !== undefined) return;
    const Native = window.WebSocket;
    const state: { current: WebSocket | null; blocked: boolean; opened: number } = {
      current: null,
      blocked: false,
      opened: 0,
    };
    const isRpc = (url: string | URL) => new URL(String(url), location.href).pathname === "/ws";
    const track = (socket: WebSocket) => {
      if (state.current === socket) return;
      state.current = socket;
      socket.addEventListener(
        "close",
        () => {
          if (state.current === socket) state.current = null;
        },
        { once: true },
      );
    };
    // The app's socket predates the harness: the next frame it sends names it.
    const send = Native.prototype.send;
    Native.prototype.send = function (this: WebSocket, data) {
      if (isRpc(this.url)) track(this);
      return send.call(this, data);
    };
    function Harnessed(url: string | URL, protocols?: string | string[]) {
      const rpc = isRpc(url);
      const socket = new Native(rpc && state.blocked ? "ws://127.0.0.1:9/ws" : url, protocols);
      if (rpc && !state.blocked) {
        socket.addEventListener("open", () => (state.opened += 1), { once: true });
        track(socket);
      }
      return socket;
    }
    Harnessed.prototype = Native.prototype;
    Object.assign(Harnessed, {
      CONNECTING: Native.CONNECTING,
      OPEN: Native.OPEN,
      CLOSING: Native.CLOSING,
      CLOSED: Native.CLOSED,
    });
    window.WebSocket = Harnessed as unknown as typeof WebSocket;
    host.__bibcodeMemoryHarness = {
      block: (value: boolean) => {
        state.blocked = value;
      },
      close: () => state.current?.close(),
      opened: () => state.opened,
      tracked: () => state.current !== null,
    };
  });
  // Liveness frames go out every few seconds; wait for one to name the socket.
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          (
            window as Window & { __bibcodeMemoryHarness?: { tracked: () => boolean } }
          ).__bibcodeMemoryHarness?.tracked() === true,
      ),
    { timeout: 60_000, timeoutMsg: "The harness never saw the app's RPC socket send." },
  );
}

/** Drops the connection and keeps it down, lets it return, or reads how many sockets opened. */
function harness(action: "disconnect" | "allow" | "opened"): Promise<number> {
  return browser.execute((name: string) => {
    const value = (
      window as Window & {
        __bibcodeMemoryHarness?: {
          block: (blocked: boolean) => void;
          close: () => void;
          opened: () => number;
        };
      }
    ).__bibcodeMemoryHarness;
    if (value === undefined) throw new Error("The reconnect harness is not installed.");
    if (name === "disconnect") {
      value.block(true);
      value.close();
    } else if (name === "allow") {
      value.block(false);
    }
    return value.opened();
  }, action);
}

async function reconnect(label: string, changed: boolean): Promise<void> {
  const opened = await harness("opened");
  let turnId: string | undefined;
  if (changed) {
    // A slow turn is still running when the socket goes down and finishes before it returns.
    turnId = await sendAndAwaitStart(`[[slow]] reconnect turn ${label}`);
  }
  await harness("disconnect");
  if (changed) {
    if (turnId === undefined) throw new Error("The slow turn has no turn id.");
    completeDesktopUiSlowTurn(project, turnId);
    await sleep(5_000);
  } else {
    await sleep(2_000);
  }
  await harness("allow");
  await browser.waitUntil(async () => (await harness("opened")) > opened, {
    timeout: 120_000,
    timeoutMsg: `Reconnect ${label} never opened a new RPC socket.`,
  });
  recordStep({ step: "reconnect", label, changed });
}

describe("packaged thread memory across reconnects (manual)", function () {
  // Set on the suite: WebdriverIO's test wrapper ignores a timeout set inside the running test.
  this.timeout(6 * 60 * 60_000);
  it("keeps a fixed number of copies of each message", async function () {
    await setDesktopUiWindowSize(1_200, 900);
    await ensureFixtureProjectOpen();
    for (let index = 0; index < PROMPTS; index += 1) {
      await sendAndAwaitStart(`prompt-${index}-`.padEnd(PROMPT_LENGTH, "abcdefghij"[index % 10]));
      recordStep({ step: "prompt", index });
    }
    await sleep(10_000);
    await installReconnectHarness();
    await measure("idle-control");
    for (let index = 1; index <= UNCHANGED; index += 1) {
      await reconnect(`unchanged-${index}`, false);
    }
    await measure("baseline");
    for (let index = 1; index <= CHANGED; index += 1) {
      await reconnect(`changed-${index}`, true);
      if (index === Math.ceil(CHANGED / 2) || index === CHANGED) {
        await measure(`changed-${index}`);
      }
    }
    await browser.refresh();
    await browser.$(editorSelector).waitForDisplayed({ timeout: 120_000 });
    await measure("after-reload");
  });
});
