// @effect-diagnostics nodeBuiltinImport:off - The lifecycle helper relaunches and observes the packaged app.
// @effect-diagnostics globalTimers:off - The helper polls the native process between WebDriver sessions.
// @effect-diagnostics globalDate:off - The standalone helper bounds its native-process waits.
// @effect-diagnostics globalFetch:off - The helper probes the embedded WebDriver server's status.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { resolveDesktopAppPath, type DesktopUiPlatform } from "./app-path.ts";

interface DesktopUiApplicationHost {
  readonly __TAURI__?: {
    readonly core?: {
      readonly invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  };
}

/** The bundle identifier of `tauri.e2e.conf.json`, never the user's own BiBCode. */
export const DESKTOP_UI_BUNDLE_IDENTIFIER = "com.bibcode.desktop.e2e";

function desktopUiSpecFileName(path: string): string | undefined {
  return path.replaceAll("\\", "/").split(/[?#]/, 1)[0]?.split("/").at(-1);
}

export function isFinalDesktopUiSpec(
  currentSpecs: ReadonlyArray<string>,
  configuredSpecs: ReadonlyArray<string>,
): boolean {
  const finalSpec = configuredSpecs.at(-1);
  if (finalSpec === undefined) return false;
  const finalSpecFileName = desktopUiSpecFileName(finalSpec);
  return currentSpecs.some((spec) => desktopUiSpecFileName(spec) === finalSpecFileName);
}

export async function dispatchDesktopUiApplicationExit(
  host: DesktopUiApplicationHost = window as unknown as DesktopUiApplicationHost,
): Promise<boolean> {
  const invoke = host.__TAURI__?.core?.invoke;
  if (invoke === undefined) return false;

  // Disarms the close question first, so an edit a spec left unsaved cannot hold the exit.
  await invoke("desktop_e2e_prepare_for_exit");
  void invoke("plugin:window|close", { label: "main" }).catch(() => undefined);
  return true;
}

function webDriverPort(environment: NodeJS.ProcessEnv = process.env): number {
  return Number(environment.BIBCODE_E2E_WEBDRIVER_PORT ?? 4_445);
}

/** Whether the packaged app's embedded WebDriver server answers, so the app is running. */
export async function isDesktopUiApplicationRunning(
  port: number = webDriverPort(),
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Ends the app at teardown. An app a closing case already ended is accepted as done. */
export async function requestDesktopUiApplicationExit(): Promise<void> {
  if (!(await isDesktopUiApplicationRunning())) return;
  let requested: boolean;
  try {
    requested = await browser.execute(dispatchDesktopUiApplicationExit as () => Promise<boolean>);
  } catch (error) {
    // The exit can tear the page down under the request.
    if (!(await isDesktopUiApplicationRunning())) return;
    throw error;
  }
  if (!requested) {
    throw new Error("The Tauri bridge was unavailable during desktop UI application shutdown.");
  }
}

/** The process that owns the WebDriver port: the running packaged app. */
export function desktopUiApplicationPid(port: number = webDriverPort()): number {
  const output = NodeChildProcess.execFileSync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { encoding: "utf8" },
  ).trim();
  const pid = Number(output.split("\n")[0]);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`No packaged app listens on WebDriver port ${port}.`);
  }
  return pid;
}

/** Every TCP port `pid` listens on, the embedded BiBCode server's among them. */
export function desktopUiListeningPorts(pid: number): number[] {
  let output: string;
  try {
    output = NodeChildProcess.execFileSync(
      "lsof",
      ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"],
      { encoding: "utf8" },
    );
  } catch {
    return [];
  }
  return [...output.matchAll(/^n.*:(\d+)$/gm)].map((match) => Number(match[1]));
}

/** Processes running exactly this packaged binary: only the isolated e2e install. */
function runningBinaryPids(appBinaryPath: string): number[] {
  try {
    return NodeChildProcess.execFileSync("pgrep", ["-f", "-x", appBinaryPath], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    // pgrep exits 1 when nothing matches.
    return [];
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Waits until the process is gone; returns how long that took. */
export async function waitForDesktopUiApplicationExit(
  pid: number,
  timeoutMs: number,
): Promise<number> {
  const started = Date.now();
  while (isProcessAlive(pid)) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`The packaged app (pid ${pid}) was still running after ${timeoutMs} ms.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return Date.now() - started;
}

function runSystemEvents(script: string): string {
  return NodeChildProcess.execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
}

/**
 * Chooses a native menu item of the packaged app, the way a person does: the native close and
 * quit protocol, with the backend still running. The process is picked by its bundle identifier,
 * so the user's own BiBCode is never touched.
 */
export async function chooseDesktopUiMenuItem(itemPrefix: string): Promise<void> {
  if (desktopUiPlatform() !== "mac") {
    throw new Error("Native menu items are only driven on macOS.");
  }
  // The service updates every registered mock after each command; once the item ends the app,
  // that update fails the case, so drop the mocks first.
  await browser.tauri.restoreAllMocks();
  // A freshly launched app publishes its menu bar to accessibility a moment after it serves.
  for (let attempt = 1; ; attempt += 1) {
    try {
      clickDesktopUiMenuItem(itemPrefix);
      return;
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

function clickDesktopUiMenuItem(itemPrefix: string): void {
  runSystemEvents(
    [
      'tell application "System Events"',
      `  tell (first application process whose bundle identifier is "${DESKTOP_UI_BUNDLE_IDENTIFIER}")`,
      // The menu bar belongs to the active app; a relaunched copy starts in the background.
      "    set frontmost to true",
      // macOS shows the first submenu (BiBCode's File menu) as the app menu, under the app's
      // name, so the bar item is found by the item it holds rather than by its title.
      "    repeat with barItem in menu bar items of menu bar 1",
      `      if exists (first menu item of menu 1 of barItem whose name starts with "${itemPrefix}") then`,
      `        click (first menu item of menu 1 of barItem whose name starts with "${itemPrefix}")`,
      "        return",
      "      end if",
      "    end repeat",
      `    error "No menu item starts with ${itemPrefix}."`,
      "  end tell",
      "end tell",
    ].join("\n"),
  );
}

/** Asks the main window to close through its native Close Window item, with the backend up. */
export function requestDesktopUiWindowClose(): Promise<void> {
  return chooseDesktopUiMenuItem("Close Window");
}

export function chooseDesktopUiQuit(): Promise<void> {
  return chooseDesktopUiMenuItem("Quit");
}

export function desktopUiPlatform(environment: NodeJS.ProcessEnv = process.env): DesktopUiPlatform {
  const configured = environment.BIBCODE_E2E_PLATFORM;
  if (configured === "mac" || configured === "linux" || configured === "win") return configured;
  // oxlint-disable-next-line bibcode/no-global-process-runtime -- The worker follows WDIO's host fallback when no platform was supplied.
  const host = process.platform;
  return host === "darwin" ? "mac" : host === "win32" ? "win" : "linux";
}

/** `mochaOpts.timeout` of `wdio.conf.ts`: the allowance of one test and of each of its hooks. */
export const DESKTOP_UI_TEST_TIMEOUT_MS = 120_000;
/**
 * One bound for the probe, the stop, the relaunch, `reloadSession` and the mock restore, leaving
 * 20 s of the hook's allowance for the rest of `beforeTest`. A single WDIO command may wait
 * `connectionRetryTimeout` (120 s), so every step is raced against this instead.
 */
export const DESKTOP_UI_RECOVERY_DEADLINE_MS = 100_000;

export interface RecoveryDeadline {
  readonly budgetMs: number;
  remainingMs(): number;
}

export function startRecoveryDeadline(
  budgetMs: number = DESKTOP_UI_RECOVERY_DEADLINE_MS,
): RecoveryDeadline {
  const started = Date.now();
  return { budgetMs, remainingMs: () => Math.max(0, budgetMs - (Date.now() - started)) };
}

/**
 * Settles with `operation`, or rejects once the deadline runs out first. A late operation is
 * abandoned, not cancelled: its own caps (bounded by the deadline) end it.
 */
export function withinRecoveryDeadline<T>(
  deadline: RecoveryDeadline,
  step: string,
  operation: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`The webview recovery ran out of its ${deadline.budgetMs} ms during ${step}.`),
        ),
      deadline.remainingMs(),
    );
    // An async wrapper turns a synchronous throw into a rejection, so the timer is still cleared.
    (async () => operation())().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

let relaunched: NodeChildProcess.ChildProcess | null = null;
let relaunchCount = 0;

/**
 * Starts the packaged app again after a closing case ended it, with the launcher's environment
 * and port, and opens a new WebDriver session on it. The WDIO service only restarts the app
 * between spec files, so each closing case of one spec gets its own app session here.
 */
export async function relaunchDesktopUiApplication(
  deadline: RecoveryDeadline = startRecoveryDeadline(),
): Promise<void> {
  const port = webDriverPort();
  if (await isDesktopUiApplicationRunning(port)) {
    throw new Error("The packaged app is still running; it cannot be relaunched.");
  }
  const appBinaryPath = resolveDesktopAppPath({
    platform: desktopUiPlatform(),
    environment: process.env,
  });
  // The single-instance plugin hands a new launch to a copy that is still exiting, which then
  // ends both, so wait until no process runs this packaged binary.
  const exitCapMs = Math.min(30_000, deadline.remainingMs());
  await withinRecoveryDeadline(deadline, "exit wait", async () => {
    const started = Date.now();
    while (runningBinaryPids(appBinaryPath).length > 0) {
      if (Date.now() - started > exitCapMs) {
        throw new Error(`The previous packaged app was still exiting after ${exitCapMs} ms.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  });
  const artifactDirectory = process.env.BIBCODE_E2E_ARTIFACT_DIR;
  if (!artifactDirectory) throw new Error("BIBCODE_E2E_ARTIFACT_DIR is required.");
  relaunchCount += 1;
  // A file, not a pipe: an unread pipe would stall the app's debug logging.
  const log = NodeFS.openSync(
    NodePath.join(artifactDirectory, `relaunched-app-${relaunchCount}.log`),
    "a",
  );
  try {
    relaunched = NodeChildProcess.spawn(appBinaryPath, [], {
      env: { ...process.env, TAURI_WEBDRIVER_PORT: String(port), WDIO_EMBEDDED_SERVER: "true" },
      stdio: ["ignore", log, log],
      detached: false,
    });
  } finally {
    NodeFS.closeSync(log);
  }
  const child = relaunched;
  const serveCapMs = Math.min(90_000, deadline.remainingMs());
  await withinRecoveryDeadline(deadline, "serve wait", async () => {
    const launched = Date.now();
    while (!(await isDesktopUiApplicationRunning(port))) {
      if (child.exitCode !== null) {
        throw new Error(`The relaunched packaged app exited with ${child.exitCode}.`);
      }
      if (Date.now() - launched > serveCapMs) {
        throw new Error("The relaunched packaged app never served WebDriver.");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  });
  await prepareRelaunchedDesktopUiSession(
    {
      reloadSession: async () => {
        try {
          await browser.reloadSession();
        } catch (error) {
          // The service copies the old session's mocks onto the new one after it opens; the new
          // app never had them, and each spec installs the mocks it needs again.
          if (!(error instanceof Error) || !error.message.startsWith("Mock updates failed"))
            throw error;
        }
      },
      probe: () => browser.execute(() => true),
      restoreMocks: () => browser.tauri.restoreAllMocks(),
      waitForPlugin: () =>
        browser.waitUntil(
          () =>
            browser.execute(() => {
              const host = window as Window & {
                readonly wdioTauri?: { readonly execute?: unknown };
              };
              return typeof host.wdioTauri?.execute === "function";
            }),
          {
            timeout: Math.min(20_000, deadline.remainingMs()),
            timeoutMsg: "The relaunched app's Tauri WebDriver plugin did not initialize.",
          },
        ),
    },
    deadline,
  );
}

export interface RelaunchedSessionSteps {
  readonly reloadSession: () => Promise<void>;
  readonly probe: () => Promise<unknown>;
  readonly restoreMocks: () => Promise<unknown>;
  readonly waitForPlugin: () => Promise<unknown>;
}

/** Bounds one step by its own cap, never past the shared deadline. */
function withinStepBound<T>(
  deadline: RecoveryDeadline,
  capMs: number,
  step: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withinRecoveryDeadline(
    startRecoveryDeadline(Math.min(capMs, deadline.remainingMs())),
    step,
    operation,
  );
}

/**
 * The new session after a relaunch. A fresh WebKitGTK webview can hang the first script it gets,
 * so a trivial probe must answer (each try 5 s, all tries 30 s) before any other script; the mock
 * restore then has 10 s. Every bound is also cut to the shared deadline.
 */
export async function prepareRelaunchedDesktopUiSession(
  steps: RelaunchedSessionSteps,
  deadline: RecoveryDeadline,
): Promise<void> {
  await withinRecoveryDeadline(deadline, "reloadSession", steps.reloadSession);
  const answerCapMs = Math.min(30_000, deadline.remainingMs());
  await withinRecoveryDeadline(deadline, "webview answer", async () => {
    const started = Date.now();
    for (;;) {
      const leftMs = answerCapMs - (Date.now() - started);
      let failure: unknown;
      try {
        await withinRecoveryDeadline(
          startRecoveryDeadline(Math.min(5_000, Math.max(0, leftMs))),
          "webview probe",
          steps.probe,
        );
        return;
      } catch (error) {
        failure = error;
      }
      if (Date.now() - started + 250 >= answerCapMs) {
        throw new Error(
          `The relaunched webview did not answer a trivial script within ${answerCapMs} ms: ${String(failure)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  });
  // Drop the old app's mocks, or every later mock call retries them against the new app.
  await withinStepBound(deadline, 10_000, "mock restore", steps.restoreMocks);
  await withinRecoveryDeadline(deadline, "plugin wait", steps.waitForPlugin);
}

/** Ends an app this helper relaunched, if it still runs: only a process this helper started. */
export async function stopRelaunchedDesktopUiApplication(): Promise<void> {
  const child = relaunched;
  relaunched = null;
  if (child?.pid === undefined || child.exitCode !== null) return;
  // The service ends the app it started the same way: teardown already stopped the backend, and
  // the webview may not close its own window.
  child.kill("SIGTERM");
  await waitForDesktopUiApplicationExit(child.pid, 10_000).catch(() => child.kill("SIGKILL"));
}

/**
 * Driver errors that mean the webview or its session is gone, not that a script misbehaved.
 * WebKitGTK answers every script with "Unsupported result type" once its web process has died;
 * the probe's `() => true` cannot produce that from a live page.
 */
export function isDeadDesktopUiWebviewError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /invalid session id|no such (window|session)|session (deleted|not created)|window (was )?already closed|web ?view (not found|crashed|terminated)|unsupported result type|ECONNREFUSED|ECONNRESET|socket hang up/i.test(
      error.message,
    )
  );
}

export interface DeadWebviewRecovery {
  readonly probe: () => Promise<unknown>;
  readonly isRunning: () => Promise<boolean>;
  readonly stopApplication: () => Promise<void>;
  readonly relaunch: (deadline: RecoveryDeadline) => Promise<void>;
}

/**
 * One trivial script before a test. When it fails with a dead-session error, the app is
 * relaunched once (after ending a process that survived its webview), so a webview crash fails
 * only the test that hit it. Every step shares one deadline. Returns whether it relaunched.
 */
export async function recoverDeadDesktopUiWebview(
  deps: DeadWebviewRecovery,
  deadline: RecoveryDeadline = startRecoveryDeadline(),
): Promise<boolean> {
  try {
    await withinRecoveryDeadline(deadline, "probe", deps.probe);
    return false;
  } catch (error) {
    if (!isDeadDesktopUiWebviewError(error)) throw error;
  }
  if (await withinRecoveryDeadline(deadline, "liveness check", deps.isRunning)) {
    await withinRecoveryDeadline(deadline, "stop", deps.stopApplication);
  }
  await withinRecoveryDeadline(deadline, "relaunch", () => deps.relaunch(deadline));
  return true;
}

/**
 * Failure evidence from a webview that may have died. When collecting it fails, one trivial
 * probe (5 s) decides: a webview that fails or misses the probe is dead, and the evidence is
 * dropped whatever the error said; a webview that answers keeps the error, which is then a
 * harness fault. Mocha recorded the test's own failure before `afterTest`, so this can only drop
 * evidence, never an assertion. Throwing here would skip the worker's remaining tests.
 */
export async function tolerateDeadDesktopUiWebview<T>(
  operation: () => Promise<T>,
  probe: () => Promise<unknown> = () => browser.execute(() => true),
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    if (isDeadDesktopUiWebviewError(error)) return undefined;
    try {
      await withinRecoveryDeadline(startRecoveryDeadline(5_000), "evidence probe", probe);
    } catch {
      return undefined;
    }
    throw error;
  }
}

async function stopRunningDesktopUiApplication(): Promise<void> {
  const pid = desktopUiApplicationPid();
  process.kill(pid, "SIGTERM");
  await waitForDesktopUiApplicationExit(pid, 10_000).catch(() => process.kill(pid, "SIGKILL"));
}

/** The per-test probe of the shared app; see {@link recoverDeadDesktopUiWebview}. */
export function ensureLiveDesktopUiWebview(): Promise<boolean> {
  return recoverDeadDesktopUiWebview({
    probe: () => browser.execute(() => true),
    isRunning: () => isDesktopUiApplicationRunning(),
    stopApplication: stopRunningDesktopUiApplication,
    relaunch: relaunchDesktopUiApplication,
  });
}
