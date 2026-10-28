// @effect-diagnostics nodeBuiltinImport:off - The manual loop writes recorder logs to the artifact directory.
// @effect-diagnostics globalTimers:off - The manual loop paces its arms with plain waits.
// @effect-diagnostics globalConsole:off - The manual loop prints one summary line per run.
/**
 * Manual packaged loop for #199: what happens to text typed into the composer while the
 * environment connection drops and returns.
 *
 * Not in the default list; run it alone with
 * `BIBCODE_E2E_SPEC=./specs/manual/composer-connection-drop.e2e.ts vp run test:ui:desktop`.
 * BIBCODE_E2E_DROP_ITERATIONS (default 10) sets the runs per arm. Every run appends one line
 * to `<artifacts>/composer-drop-runs.jsonl` with the recorder's timestamped log.
 *
 * The recorder is installed by a page task that returns before any typing, so it observes
 * WebDriver typing instead of overlapping it. It logs editor mutations (text, contenteditable,
 * aria-placeholder), beforeinput/input events, the persisted draft, the Send button's state,
 * window connectivity and visibility events, and every WebSocket close with its stack.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  readProviderInputLog,
  waitForProviderInputLogEntry,
} from "../../support/provider-input-log.ts";
import { desktopUiFixture } from "../../support/test-project.ts";
import {
  ensureMainSidebarOpen,
  mockDesktopUiFolderPicker,
  setDesktopUiWindowSize,
} from "../../support/ui-state.ts";

const artifactDirectory = process.env.BIBCODE_E2E_ARTIFACT_DIR;
const projectPath = process.env.BIBCODE_E2E_PROJECT_PATH;
const providerInputLogPath = process.env.BIBCODE_E2E_PROVIDER_INPUT_LOG;
if (!artifactDirectory || !projectPath || !providerInputLogPath) {
  throw new Error("The packaged desktop composer fixture environment was not prepared.");
}
const preparedArtifactDirectory: string = artifactDirectory;
const preparedProjectPath: string = projectPath;
const preparedProviderInputLogPath: string = providerInputLogPath;
const iterations = Number(process.env.BIBCODE_E2E_DROP_ITERATIONS ?? 10);
const runsLogPath = NodePath.join(preparedArtifactDirectory, "composer-drop-runs.jsonl");

const visibleComposerFormSelector =
  '//*[@data-center-surface-host and @data-visible="true"]//*[@data-chat-composer-form="true"]';

function composerEditor() {
  return browser.$(visibleComposerFormSelector).$('[data-testid="composer-editor"]');
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function ensureFixtureProjectImported(): Promise<void> {
  const appOrigin = await browser.execute(() => window.location.origin);
  await browser.url(`${appOrigin}/#/`);
  await ensureMainSidebarOpen();
  const projectSelector = `//button[@data-sidebar="menu-button"][.//span[normalize-space()="${desktopUiFixture.projectName}"]]`;
  const hasVisibleProject = async () => {
    for (const candidate of await browser.$$(projectSelector)) {
      if (await candidate.isDisplayed()) return true;
    }
    return false;
  };
  if (await hasVisibleProject()) return;
  const projectDataLoading = browser.$("//*[normalize-space()='Project data is still loading']");
  if (await projectDataLoading.isExisting()) {
    await projectDataLoading.waitForDisplayed({ reverse: true });
  }
  const addProject = browser.$('[data-testid="sidebar-add-project-trigger"]');
  await addProject.click();
  await browser.$('[role="dialog"]').waitForExist();
  const browseFolder = browser.$(
    "//button[@data-add-project-action='true'][.//span[normalize-space()='Browse folder']]",
  );
  await browseFolder.waitForDisplayed();
  await mockDesktopUiFolderPicker(preparedProjectPath);
  await browseFolder.click();
  await browser.waitUntil(hasVisibleProject);
}

async function openPrimaryThread(): Promise<void> {
  const projectSelector = `//button[@data-sidebar="menu-button"][.//span[normalize-space()="${desktopUiFixture.projectName}"]]`;
  const primaryWorkspace = browser.$(
    '//*[@data-thread-item="true"][.//span[normalize-space()="main"]]',
  );
  if (!(await primaryWorkspace.isDisplayed())) {
    for (const project of await browser.$$(projectSelector)) {
      if (await project.isDisplayed()) {
        await project.click();
        break;
      }
    }
    await primaryWorkspace.waitForDisplayed();
  }
  await primaryWorkspace.click();
  await composerEditor().waitForDisplayed();
}

/** The same clearing sequence the composer-native-triggers spec uses before it types. */
async function selectAllAndDelete(): Promise<void> {
  const editor = composerEditor();
  await editor.click();
  await browser.execute(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active.dataset.testid !== "composer-editor") {
      throw new Error("The composer editor did not receive focus.");
    }
    const range = document.createRange();
    range.selectNodeContents(active);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  });
  await browser.keys("Backspace");
}

async function clearComposer(): Promise<void> {
  await browser.waitUntil(
    async () => {
      if ((await composerEditor().getText()) === "") return true;
      await selectAllAndDelete();
      return (await composerEditor().getText()) === "";
    },
    { timeout: 30_000, interval: 200, timeoutMsg: "The composer did not clear between runs." },
  );
}

async function clickSendWhenLive(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const send = document.querySelector<HTMLButtonElement>(
          '[data-center-surface-host][data-visible="true"] [data-chat-composer-form="true"] button[aria-label="Send message"]',
        );
        if (!send || send.disabled) return false;
        send.click();
        return true;
      }),
    { timeout: 20_000, interval: 100, timeoutMsg: "Send never became available." },
  );
}

async function currentThreadId(): Promise<string> {
  return browser.execute(() => {
    const match = window.location.hash.match(/\/(?:primary|threads)\/([^/?#]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  });
}

/** Installs the recorder (and the socket harness) and returns before anything is typed. */
async function installRecorder(threadId: string): Promise<void> {
  await browser.execute((threadId: string) => {
    type Entry = Record<string, unknown> & { t: number; type: string };
    const host = window as Window & {
      __b3fRecorder?: { events: Entry[]; reset: () => void; stop: () => void };
      __b3fSockets?: { current: WebSocket | null; close: () => boolean };
    };
    host.__b3fRecorder?.stop();
    let t0 = performance.now();
    const events: Entry[] = [];
    const log = (type: string, data: Record<string, unknown> = {}) => {
      events.push({ t: Math.round(performance.now() - t0), type, ...data });
    };
    const formSelector =
      '[data-center-surface-host][data-visible="true"] [data-chat-composer-form="true"]';
    const editor = () =>
      document.querySelector<HTMLElement>(`${formSelector} [data-testid="composer-editor"]`);
    const draft = () => {
      try {
        const raw = window.localStorage.getItem("bibcode:composer-drafts:v1");
        if (!raw) return null;
        const parsed = JSON.parse(raw) as {
          state?: { draftsByThreadKey?: Record<string, { prompt?: string }> };
        };
        // Every environment-scoped key for this thread id, so a second environment's draft
        // shows up instead of standing in for this one.
        const entries = Object.entries(parsed.state?.draftsByThreadKey ?? {}).filter(
          ([key]) => key.indexOf(":") > 0 && key.slice(key.indexOf(":") + 1) === threadId,
        );
        if (entries.length === 0) return null;
        if (entries.length === 1) return entries[0]![1].prompt ?? "";
        return entries.map(([key, entry]) => `${key}=${entry.prompt ?? ""}`).join(" | ");
      } catch {
        return "<unreadable>";
      }
    };
    let last = "";
    const snapshot = (cause: string) => {
      const target = editor();
      const send = document.querySelector<HTMLButtonElement>(
        `${formSelector} button[aria-label="Send message"]`,
      );
      const state = {
        text: target?.textContent ?? null,
        editable: target?.contentEditable ?? null,
        focused: target !== null && document.activeElement === target,
        placeholder: target?.getAttribute("aria-placeholder") ?? null,
        send: send === null ? "absent" : send.disabled ? "disabled" : "enabled",
        draft: draft(),
        onLine: navigator.onLine,
      };
      const key = JSON.stringify(state);
      if (key === last) return;
      last = key;
      log("state", { cause, ...state });
    };
    const observer = new MutationObserver((records) => {
      const kinds = new Set(records.map((record) => record.type));
      snapshot(`mutation:${[...kinds].join("+")}`);
    });
    const form = document.querySelector(formSelector);
    if (form) {
      observer.observe(form, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["contenteditable", "aria-placeholder", "disabled"],
      });
    }
    const timeline = document.querySelector('[data-center-surface-host][data-visible="true"]');
    let timelineRows = 0;
    const timelineObserver = new MutationObserver(() => {
      const rows = timeline?.querySelectorAll("[data-timeline-row-id]").length ?? 0;
      if (rows !== timelineRows) {
        timelineRows = rows;
        log("timeline-rows", { rows });
      }
    });
    if (timeline) timelineObserver.observe(timeline, { subtree: true, childList: true });
    const onInput = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (target?.dataset?.testid !== "composer-editor") return;
      const input = event as InputEvent;
      log(event.type, { inputType: input.inputType, data: input.data ?? null });
      if (event.type === "input") snapshot("input");
    };
    document.addEventListener("beforeinput", onInput, true);
    document.addEventListener("input", onInput, true);
    const windowEvents = ["online", "offline", "focus", "blur"] as const;
    const onWindow = (event: Event) => log(`window:${event.type}`);
    for (const name of windowEvents) window.addEventListener(name, onWindow);
    const onVisibility = () => log("visibility", { state: document.visibilityState });
    document.addEventListener("visibilitychange", onVisibility);
    const sampler = window.setInterval(() => snapshot("sample"), 25);

    if (host.__b3fSockets === undefined) {
      const Native = window.WebSocket;
      const sockets: { current: WebSocket | null; close: () => boolean } = {
        current: null,
        close: () => {
          if (!sockets.current) return false;
          sockets.current.close();
          return true;
        },
      };
      const isRpc = (url: string | URL) => new URL(String(url), location.href).pathname === "/ws";
      const recorderLog = (type: string, data: Record<string, unknown>) =>
        (
          window as Window & { __b3fRecorder?: { events: Entry[] }; __b3fLog?: typeof log }
        ).__b3fLog?.(type, data);
      const track = (socket: WebSocket) => {
        if (sockets.current === socket) return;
        sockets.current = socket;
        socket.addEventListener("close", (event) =>
          recorderLog("ws:closed", { code: event.code, clean: event.wasClean }),
        );
      };
      const send = Native.prototype.send;
      Native.prototype.send = function (this: WebSocket, data) {
        if (isRpc(this.url)) track(this);
        return send.call(this, data);
      };
      const close = Native.prototype.close;
      Native.prototype.close = function (this: WebSocket, code?: number, reason?: string) {
        if (isRpc(this.url)) {
          recorderLog("ws:close-called", {
            code: code ?? null,
            stack: (new Error().stack ?? "").split("\n").slice(1, 14).join(" | "),
          });
        }
        return close.call(this, code, reason);
      };
      function Harnessed(url: string | URL, protocols?: string | string[]) {
        const socket = new Native(url, protocols);
        if (isRpc(url)) {
          recorderLog("ws:new", {});
          socket.addEventListener("open", () => recorderLog("ws:open", {}), { once: true });
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
      host.__b3fSockets = sockets;
    }
    (window as Window & { __b3fLog?: typeof log }).__b3fLog = log;

    host.__b3fRecorder = {
      events,
      reset: () => {
        events.length = 0;
        last = "";
        t0 = performance.now();
        snapshot("reset");
      },
      stop: () => {
        observer.disconnect();
        timelineObserver.disconnect();
        window.clearInterval(sampler);
        document.removeEventListener("beforeinput", onInput, true);
        document.removeEventListener("input", onInput, true);
        for (const name of windowEvents) window.removeEventListener(name, onWindow);
        document.removeEventListener("visibilitychange", onVisibility);
      },
    };
    snapshot("installed");
  }, threadId);
}

async function resetRecorder(): Promise<void> {
  await browser.execute(() => {
    (window as Window & { __b3fRecorder?: { reset: () => void } }).__b3fRecorder?.reset();
  });
}

async function markRecorder(label: string): Promise<void> {
  await browser.execute((label: string) => {
    (window as Window & { __b3fLog?: (type: string, data: object) => void }).__b3fLog?.("mark", {
      label,
    });
  }, label);
}

async function readRecorder(): Promise<unknown[]> {
  return browser.execute(
    () =>
      (
        window as Window & { __b3fRecorder?: { events: unknown[] } }
      ).__b3fRecorder?.events.slice() ?? [],
  );
}

async function dispatchWindowEvent(name: "offline" | "online", delayMs = 0): Promise<void> {
  await browser.execute(
    (name: string, delayMs: number) => {
      const fire = () => window.dispatchEvent(new Event(name));
      if (delayMs <= 0) fire();
      else window.setTimeout(fire, delayMs);
    },
    name,
    delayMs,
  );
}

async function closeSocketFromPage(delayMs = 0): Promise<void> {
  await browser.execute((delayMs: number) => {
    const sockets = (window as Window & { __b3fSockets?: { close: () => boolean } }).__b3fSockets;
    const fire = () => sockets?.close();
    if (delayMs <= 0) fire();
    else window.setTimeout(fire, delayMs);
  }, delayMs);
}

let neverConnectedShots = 0;

async function waitForConnectedComposer(): Promise<void> {
  const read = () =>
    browser.execute(() => {
      const editor = document.querySelector<HTMLElement>(
        '[data-center-surface-host][data-visible="true"] [data-chat-composer-form="true"] [data-testid="composer-editor"]',
      );
      return {
        connected:
          editor !== null &&
          editor.contentEditable === "true" &&
          !(editor.getAttribute("aria-placeholder") ?? "").includes("is not connected"),
        editable: editor?.contentEditable ?? null,
        placeholder: editor?.getAttribute("aria-placeholder") ?? null,
        hash: window.location.hash,
        onLine: navigator.onLine,
      };
    });
  try {
    await browser.waitUntil(async () => (await read()).connected, {
      timeout: 60_000,
      interval: 100,
    });
  } catch {
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, `never-connected-${(neverConnectedShots += 1)}.png`),
    );
    throw new Error(`The composer never became connected again: ${JSON.stringify(await read())}`);
  }
}

interface RunResult {
  readonly arm: string;
  readonly iteration: number;
  readonly typed: string;
  readonly finalText: string;
  readonly kept: boolean;
  readonly events: unknown[];
}

function recordRun(result: RunResult): void {
  NodeFS.appendFileSync(runsLogPath, `${JSON.stringify(result)}\n`, "utf8");
  console.log(
    `[b3f] arm=${result.arm} iteration=${result.iteration} kept=${result.kept} final=${JSON.stringify(result.finalText)}`,
  );
}

async function finishRun(arm: string, iteration: number, typed: string): Promise<void> {
  await waitForConnectedComposer();
  await sleep(1_500);
  const finalText = await composerEditor().getText();
  const events = await readRecorder();
  recordRun({ arm, iteration, typed, finalText, kept: finalText.includes(typed), events });
  await clearComposer();
  await sleep(500);
}

describe("composer text through a connection drop (manual, #199)", () => {
  const typed = "@README";
  const arms = (process.env.BIBCODE_E2E_DROP_ARMS ?? "a,b,c,d,e").split(",");

  // The harness's beforeTest resets the connection cache and reloads the document before
  // every test, so each test sets up (and installs the recorder) again.
  const setUp = async () => {
    await setDesktopUiWindowSize(1_100, 760);
    await ensureFixtureProjectImported();
    await openPrimaryThread();
    const threadId = await currentThreadId();
    if (threadId.length === 0) throw new Error("The primary thread id was not in the route.");
    await installRecorder(threadId);
    // The socket that predates the harness may not send for a long time; one setup
    // reconnect opens a socket through the harness so the page-close arm can name it.
    await dispatchWindowEvent("offline");
    await sleep(300);
    await dispatchWindowEvent("online");
    await waitForConnectedComposer();
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            (window as Window & { __b3fSockets?: { current: WebSocket | null } }).__b3fSockets
              ?.current != null,
        ),
      { timeout: 60_000, timeoutMsg: "The harness never saw the RPC socket." },
    );
  };

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    it(`records every arm, iteration ${iteration}`, async () => {
      await setUp();
      if (arms.includes("a")) {
        // (a) offline before typing.
        await clearComposer();
        await resetRecorder();
        await dispatchWindowEvent("offline");
        await sleep(200);
        await markRecorder("typing");
        await selectAllAndDelete();
        await composerEditor().addValue(typed);
        await markRecorder("typed");
        await sleep(1_000);
        await dispatchWindowEvent("online");
        await finishRun("a-offline-before-typing", iteration, typed);
      }

      if (arms.includes("b")) {
        // (b) typing goes through the transition: one key at a time, offline after the
        // third key, online 1 s after the last. WebDriver's addValue inserts a whole string
        // in one input event, so it cannot straddle the drop.
        const long = "@README";
        await clearComposer();
        await resetRecorder();
        await selectAllAndDelete();
        await markRecorder("typing");
        // The embedded driver's printable `keys` do not insert text, so each key is one
        // page-side insertText, as an input method would deliver it.
        for (const [index, key] of [...long].entries()) {
          if (index === 3) await dispatchWindowEvent("offline");
          await browser.execute((key: string) => {
            document.execCommand("insertText", false, key);
          }, key);
        }
        await markRecorder("typed");
        await sleep(1_000);
        await dispatchWindowEvent("online");
        await finishRun("b-offline-during-typing", iteration, long);
      }

      if (arms.includes("c")) {
        // (c) typed while connected, then offline and online.
        await clearComposer();
        await resetRecorder();
        await selectAllAndDelete();
        await composerEditor().addValue(typed);
        await markRecorder("typed");
        await sleep(300);
        await dispatchWindowEvent("offline");
        await sleep(1_000);
        await dispatchWindowEvent("online");
        await finishRun("c-offline-after-typing", iteration, typed);
      }

      if (arms.includes("e")) {
        // (e) the socket closes from the page during typing (backoff, then reconnect).
        const long = "@README typed through the socket close";
        await clearComposer();
        await resetRecorder();
        await selectAllAndDelete();
        await closeSocketFromPage(60);
        await markRecorder("typing");
        await composerEditor().addValue(long);
        await markRecorder("typed");
        await finishRun("e-socket-close-during-typing", iteration, long);
      }

      if (arms.includes("d")) {
        // (d) H3 control: no drop; type right after the provider has the send, as the spec does.
        await clearComposer();
        await resetRecorder();
        const baseline = readProviderInputLog(preparedProviderInputLogPath).length;
        await selectAllAndDelete();
        await composerEditor().addValue("$refactor");
        await browser.waitUntil(async () => (await composerEditor().getText()) === "$refactor");
        await clickSendWhenLive();
        await waitForProviderInputLogEntry(
          preparedProviderInputLogPath,
          baseline,
          { provider: "codex", prompt: "$refactor" },
          { timeoutMs: 20_000 },
        );
        await markRecorder("provider-received");
        await selectAllAndDelete();
        await composerEditor().addValue(typed);
        await markRecorder("typed");
        await finishRun("d-no-drop-after-send", iteration, typed);
      }
    });
  }
});
