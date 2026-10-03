// @effect-diagnostics nodeBuiltinImport:off - Test-only ownership of private fixture processes.
// @effect-diagnostics globalTimers:off - Bounded qualification polling and joined cleanup.
// @effect-diagnostics globalDate:off - Qualification deadlines use elapsed wall time.
// @effect-diagnostics globalFetch:off - Only the fixed owned driver endpoint is queried.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { remote } from "webdriverio";
import { classifyQualificationFailure, qualificationProcessRoles } from "./chat-upload-evidence.ts";
import {
  prepareNetworkBeforeBrowser,
  verifyPreparedBrowserOnline,
  NetworkSetupFailure,
  readNetworkCommandResult,
} from "./browser-network.ts";

export type QualificationBrowser = Awaited<ReturnType<typeof remote>>;
export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function bounded<A>(promise: Promise<A>, ms: number): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Owned operation exceeded its bound.")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface QualificationProcess {
  readonly child: NodeChildProcess.ChildProcess;
  readonly done: Promise<void>;
  readonly log: string;
  readonly role: string;
  readonly controlledInput: boolean;
  spawnFailure: ReturnType<typeof classifyQualificationFailure> | null;
}

export class QualificationOwner {
  readonly root: string;
  readonly fixtureRoot: string;
  readonly processes: QualificationProcess[] = [];
  private readonly retired = new Set<QualificationProcess>();
  readonly failures: Array<{
    role: string;
    failure: ReturnType<typeof classifyQualificationFailure>;
  }> = [];
  constructor(root: string, fixtureRoot: string) {
    this.root = root;
    this.fixtureRoot = fixtureRoot;
  }

  spawn(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    role: string,
    controlledInput = false,
  ): QualificationProcess {
    if (!qualificationProcessRoles.some((allowed) => allowed === role))
      throw new Error("Unknown fixture role.");
    const ordinal = this.processes.filter((entry) => entry.role === role).length;
    const log = NodePath.join(
      this.fixtureRoot,
      role + (ordinal === 0 ? "" : `-${ordinal}`) + ".log",
    );
    const fd = NodeFS.openSync(log, "wx", 0o600);
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(command, args, {
        cwd: this.root,
        env,
        stdio: [controlledInput ? "pipe" : "ignore", fd, fd],
      });
    } finally {
      NodeFS.closeSync(fd);
    }
    const entry: QualificationProcess = {
      child,
      log,
      role,
      controlledInput,
      spawnFailure: null,
      done: Promise.resolve(),
    };
    // write callbacks still reject; prevent an EPIPE event escaping owned cleanup.
    child.stdin?.on("error", () => undefined);
    const done = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", (error) => {
        entry.spawnFailure = classifyQualificationFailure(error);
        resolve();
      });
    });
    const owned = Object.assign(entry, { done });
    this.processes.push(owned);
    return owned;
  }

  async until(check: () => Promise<boolean>, timeout = 30_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await check()) return;
      for (const entry of this.processes) {
        if (this.retired.has(entry)) continue;
        if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
          throw new Error("An owned fixture process exited before qualification completed.");
        }
      }
      await delay(100);
    }
    throw new Error("The required live observation did not arrive within its bound.");
  }

  async command(entry: QualificationProcess, input: unknown): Promise<void> {
    if (!entry.controlledInput || !entry.child.stdin)
      throw new Error("Owned command input is unavailable.");
    const line = JSON.stringify(input) + "\n";
    if (Buffer.byteLength(line) > 16 * 1024) throw new Error("Owned command exceeds its bound.");
    await bounded(
      new Promise<void>((resolve, reject) => {
        entry.child.stdin!.write(line, (error) => (error ? reject(error) : resolve()));
      }),
      2_000,
    );
  }

  async json(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<unknown> {
    const entry = this.spawn(command, args, env, "pairing");
    try {
      await bounded(entry.done, 10_000);
      if (entry.child.exitCode !== 0 || NodeFS.statSync(entry.log).size > 32768)
        throw new Error("Owned credential command failed.");
      const line = NodeFS.readFileSync(entry.log, "utf8").trim().split("\n").at(-1);
      if (line === undefined) throw new Error("Owned credential response is unavailable.");
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error("Owned credential response is invalid.");
      }
    } finally {
      await this.stop(entry);
    }
  }

  async stop(entry: QualificationProcess): Promise<void> {
    this.retired.add(entry);
    const { child, done } = entry;
    if (entry.controlledInput && child.exitCode === null && child.signalCode === null) {
      try {
        await this.command(entry, { exit: true });
        await bounded(done, 5_000);
        return;
      } catch {
        /* The same owned signal escalation remains the final fallback. */
      }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await bounded(done, 5_000).catch(async () => {
      child.kill("SIGKILL");
      await bounded(done, 5_000);
    });
  }

  async cleanup(role: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.failures.push({ role, failure: classifyQualificationFailure(error) });
    }
  }

  async close(
    resources: { browser?: () => Promise<void>; proxies?: Array<() => Promise<void>> } = {},
  ): Promise<void> {
    if (resources.browser)
      await this.cleanup("browser", () => bounded(resources.browser!(), 15_000));
    for (const proxy of resources.proxies ?? [])
      await this.cleanup("proxy", () => bounded(proxy(), 5_000));
    for (const entry of this.processes.toReversed())
      await this.cleanup(entry.role, () => this.stop(entry));
  }

  childrenClosed(): boolean {
    return this.processes.every(
      ({ child }) => child.exitCode !== null || child.signalCode !== null,
    );
  }
}

export function ownedBrowserOptions(chrome: string, profile: string, _webOrigin: string) {
  return {
    hostname: "127.0.0.1",
    port: 4915,
    path: "/",
    logLevel: "silent" as const,
    connectionRetryCount: 0,
    connectionRetryTimeout: 30_000,
    waitforTimeout: 30_000,
    transformRequest: (options: RequestInit) => {
      const headers = new Headers(options.headers);
      headers.delete("Content-Length");
      return { ...options, headers };
    },
    capabilities: {
      browserName: "chrome",
      webSocketUrl: false,
      "wdio:enforceWebDriverClassic": true,
      "goog:chromeOptions": {
        binary: chrome,
        args: [
          "--headless=new",
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-background-networking",
          "--disable-component-update",
          "--window-size=1280,960",
          "--user-data-dir=" + profile,
        ],
      },
    },
  };
}

export async function startOwnedBrowserDriver(
  owner: QualificationOwner,
  driver: string,
  webOrigin: string,
) {
  const child = owner.spawn(
    driver,
    ["--port=4915", "--allowed-ips=127.0.0.1", "--allowed-origins=" + webOrigin],
    process.env,
    "driver",
  );
  await owner.until(async () => {
    try {
      const response = await fetch("http://127.0.0.1:4915/status", {
        signal: AbortSignal.timeout(1_000),
      });
      if (!response.ok) return false;
      return ((await response.json()) as { value?: { ready?: boolean } }).value?.ready === true;
    } catch {
      return false;
    }
  });
  return child;
}

export async function openOwnedBrowser(
  owner: QualificationOwner,
  chrome: string,
  driver: string,
  webOrigin: string,
  profile: string,
) {
  const child = await startOwnedBrowserDriver(owner, driver, webOrigin);
  const browser = await bounded(remote(ownedBrowserOptions(chrome, profile, webOrigin)), 45_000);
  return { browser, driver: child };
}

export async function prepareOwnedNetwork(root: string) {
  const startedAt = performance.now();
  const proof = await prepareNetworkBeforeBrowser({
    now: () => performance.now(),
    setup: () =>
      new Promise((resolve, reject) => {
        const python = process.env.BIBCODE_UPLOAD_PYTHON;
        const helper = process.env.BIBCODE_UPLOAD_NETWORK_HELPER;
        if (
          !python ||
          !NodePath.isAbsolute(python) ||
          helper !== NodePath.join(root, "scripts/qualify-chat-uploads.py")
        ) {
          reject(
            new NetworkSetupFailure({
              stage: "helper-config",
              attemptedMutations: 0,
              completedMutations: 0,
              netAdminEffective: null,
              lastCommand: null,
            }),
          );
          return;
        }
        NodeChildProcess.execFile(
          python,
          [helper, "network"],
          {
            env: process.env,
            timeout: 30_000,
            killSignal: "SIGTERM",
            maxBuffer: 4096,
            encoding: "utf8",
          },
          (error, stdout) => {
            try {
              resolve(readNetworkCommandResult(error !== null, stdout));
            } catch (failure) {
              reject(failure);
            }
          },
        );
      }),
  });
  return { proof, startedAt };
}

export async function verifyOwnedBrowserOnline(
  browser: QualificationBrowser,
  prepared: Awaited<ReturnType<typeof prepareOwnedNetwork>>,
) {
  return verifyPreparedBrowserOnline(prepared.proof, {
    readOnline: () =>
      bounded(
        browser.execute(() => navigator.onLine),
        2_000,
      ),
    now: () => performance.now(),
    startedAt: prepared.startedAt,
  });
}
