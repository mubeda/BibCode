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

let relaunched: NodeChildProcess.ChildProcess | null = null;
let relaunchCount = 0;

/**
 * Starts the packaged app again after a closing case ended it, with the launcher's environment
 * and port, and opens a new WebDriver session on it. The WDIO service only restarts the app
 * between spec files, so each closing case of one spec gets its own app session here.
 */
export async function relaunchDesktopUiApplication(): Promise<void> {
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
  const started = Date.now();
  while (runningBinaryPids(appBinaryPath).length > 0) {
    if (Date.now() - started > 30_000) {
      throw new Error("The previous packaged app was still exiting after 30 s.");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
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
  const launched = Date.now();
  while (!(await isDesktopUiApplicationRunning(port))) {
    if (relaunched.exitCode !== null) {
      throw new Error(`The relaunched packaged app exited with ${relaunched.exitCode}.`);
    }
    if (Date.now() - launched > 90_000) {
      throw new Error("The relaunched packaged app never served WebDriver.");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  try {
    await browser.reloadSession();
  } catch (error) {
    // The service copies the old session's mocks onto the new one after it opens; the new app
    // never had them, and each spec installs the mocks it needs again.
    if (!(error instanceof Error) || !error.message.startsWith("Mock updates failed")) throw error;
  }
  // Drop the old app's mocks, or every later mock call retries them against the new app.
  await browser.tauri.restoreAllMocks();
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const host = window as Window & { readonly wdioTauri?: { readonly execute?: unknown } };
        return typeof host.wdioTauri?.execute === "function";
      }),
    { timeoutMsg: "The relaunched app's Tauri WebDriver plugin did not initialize." },
  );
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
