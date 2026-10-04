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

export interface OwnedDriverReadiness {
  attempts: number;
  attemptsCapped: boolean;
  lastHttpStatus: "success" | "client-error" | "server-error" | "redirect" | "other" | null;
  ready: boolean | null;
  body: "not-read" | "decoded" | "malformed" | "invalid-json" | "unreadable";
  failure: "fetch" | "response" | "body" | "predicate" | null;
  errorClass:
    | "Error"
    | "TypeError"
    | "SyntaxError"
    | "RangeError"
    | "DOMException"
    | "other"
    | null;
  driverExited: boolean | null;
  driverSpawn: "none" | "failed" | null;
}

/** Exact closed readiness metadata only; never request/response or exception values. */
export function projectOwnedDriverReadiness(input: unknown): OwnedDriverReadiness | null {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
    const keys = [
      "attempts",
      "attemptsCapped",
      "lastHttpStatus",
      "ready",
      "body",
      "failure",
      "errorClass",
      "driverExited",
      "driverSpawn",
    ];
    const ownKeys = Reflect.ownKeys(input);
    if (
      ownKeys.length !== keys.length ||
      !ownKeys.every((key) => typeof key === "string" && keys.includes(key))
    )
      return null;
    const values: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null;
      values[key] = descriptor.value;
    }
    const choices = (key: string, allowed: string[], nullable = true) =>
      (nullable && values[key] === null) ||
      (typeof values[key] === "string" && allowed.includes(values[key]));
    if (
      typeof values.attempts !== "number" ||
      !Number.isInteger(values.attempts) ||
      values.attempts < 0 ||
      values.attempts > 1024 ||
      typeof values.attemptsCapped !== "boolean" ||
      !choices("lastHttpStatus", [
        "success",
        "client-error",
        "server-error",
        "redirect",
        "other",
      ]) ||
      !(values.ready === null || typeof values.ready === "boolean") ||
      !choices("body", ["not-read", "decoded", "malformed", "invalid-json", "unreadable"], false) ||
      !choices("failure", ["fetch", "response", "body", "predicate"]) ||
      !choices("errorClass", [
        "Error",
        "TypeError",
        "SyntaxError",
        "RangeError",
        "DOMException",
        "other",
      ]) ||
      !(values.driverExited === null || typeof values.driverExited === "boolean") ||
      !choices("driverSpawn", ["none", "failed"])
    )
      return null;
    return values as unknown as OwnedDriverReadiness;
  } catch {
    return null;
  }
}

function readinessErrorClass(error: unknown): OwnedDriverReadiness["errorClass"] {
  try {
    if (typeof DOMException !== "undefined" && error instanceof DOMException) return "DOMException";
    if (error === null || typeof error !== "object") return "other";
    const descriptor =
      Object.getOwnPropertyDescriptor(error, "name") ??
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(error), "name");
    return descriptor &&
      Object.hasOwn(descriptor, "value") &&
      ["Error", "TypeError", "SyntaxError", "RangeError"].includes(descriptor.value)
      ? descriptor.value
      : "other";
  } catch {
    return "other";
  }
}

export async function startOwnedBrowserDriver(
  owner: QualificationOwner,
  driver: string,
  webOrigin: string,
  observeReadiness?: (value: OwnedDriverReadiness | null) => void,
) {
  const child = owner.spawn(
    driver,
    ["--port=4915", "--allowed-ips=127.0.0.1", "--allowed-origins=" + webOrigin],
    process.env,
    "driver",
  );
  const observation: OwnedDriverReadiness = {
    attempts: 0,
    attemptsCapped: false,
    lastHttpStatus: null,
    ready: null,
    body: "not-read",
    failure: null,
    errorClass: null,
    driverExited: null,
    driverSpawn: null,
  };
  const observe = () => {
    if (!observeReadiness) return;
    try {
      const own = (object: object, key: string) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
      };
      const driverProcess = own(child, "child");
      const exit =
        driverProcess !== null && typeof driverProcess === "object"
          ? own(driverProcess, "exitCode")
          : undefined;
      const signal =
        driverProcess !== null && typeof driverProcess === "object"
          ? own(driverProcess, "signalCode")
          : undefined;
      const spawn = own(child, "spawnFailure");
      observation.driverExited =
        (exit === null ||
          (typeof exit === "number" && Number.isInteger(exit) && exit >= 0 && exit <= 255)) &&
        (signal === null || typeof signal === "string")
          ? exit !== null || signal !== null
          : null;
      observation.driverSpawn =
        spawn === null
          ? "none"
          : spawn !== undefined && typeof spawn === "object"
            ? "failed"
            : null;
      observeReadiness(projectOwnedDriverReadiness(observation));
    } catch {
      /* Optional observation never controls readiness or original failure. */
    }
  };
  try {
    await owner.until(async () => {
      if (observation.attempts === 1024) observation.attemptsCapped = true;
      observation.attempts = Math.min(1024, observation.attempts + 1);
      observation.ready = null;
      observation.body = "not-read";
      observation.failure = null;
      observation.errorClass = null;
      let stage: OwnedDriverReadiness["failure"] = "fetch";
      try {
        const response = await fetch("http://127.0.0.1:4915/status", {
          signal: AbortSignal.timeout(1_000),
        });
        stage = "response";
        const ok = response.ok;
        if (observeReadiness) {
          try {
            const status = response.status;
            if (Number.isInteger(status) && status >= 100 && status <= 599)
              observation.lastHttpStatus =
                status >= 200 && status < 300
                  ? "success"
                  : status >= 400 && status < 500
                    ? "client-error"
                    : status >= 500
                      ? "server-error"
                      : status >= 300
                        ? "redirect"
                        : "other";
          } catch {
            /* Status metadata cannot replace the original ok/body predicate. */
          }
        }
        if (!ok) return false;
        stage = "body";
        observation.body = "unreadable";
        const body = (await response.json()) as { value?: { ready?: boolean } };
        stage = "predicate";
        const ready = body.value?.ready;
        observation.ready = typeof ready === "boolean" ? ready : null;
        observation.body = typeof ready === "boolean" ? "decoded" : "malformed";
        return ready === true;
      } catch (error) {
        observation.failure = stage;
        if (observeReadiness) observation.errorClass = readinessErrorClass(error);
        if (stage === "body" && observation.errorClass === "SyntaxError")
          observation.body = "invalid-json";
        else if (stage === "predicate") observation.body = "malformed";
        return false;
      } finally {
        observe();
      }
    });
  } finally {
    observe();
  }
  return child;
}

export async function openOwnedBrowser(
  owner: QualificationOwner,
  chrome: string,
  driver: string,
  webOrigin: string,
  profile: string,
  observeReadiness?: (value: OwnedDriverReadiness | null) => void,
  observeStage?: (value: "driver-readiness" | "session-create") => void,
) {
  try {
    observeStage?.("driver-readiness");
  } catch {
    /* Optional stage sinks never control browser startup. */
  }
  const child = await startOwnedBrowserDriver(owner, driver, webOrigin, observeReadiness);
  try {
    observeStage?.("session-create");
  } catch {
    /* Preserve the original session result or failure. */
  }
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
