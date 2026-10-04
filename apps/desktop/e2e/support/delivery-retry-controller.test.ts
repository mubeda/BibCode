// @effect-diagnostics nodeBuiltinImport:off - Execute the inert import boundary without a live browser.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  deliveryConfiguration,
  projectVisualCreateRefObservation,
  runOwnedGitProjectCommand,
  verifyOwnedGitProjectSource,
  readOwnedGitProjectSnapshot,
  createSettingsCaptureFailureObserver,
  readSettingsCaptureFailureFacts,
  type SettingsCaptureFailureRecord,
} from "../qualify-delivery-retry.ts";
import { deliveryScenes, deliveryThemes } from "./delivery-retry-evidence.ts";
import { classifyQualificationFailure } from "./chat-upload-evidence.ts";
import { bounded, projectOwnedDriverReadiness } from "./qualification-owner.ts";
import {
  readDeliveryImportObservation,
  projectDeliveryImportObservation,
} from "./delivery-import-observation.ts";
import { resolveWorktreeCreateInput } from "../../../web/src/components/CreateWorktreeDialog.logic.ts";
import { readSelectedDeliveryWorktree } from "./delivery-retry-workspace.ts";
import { prepareDesktopUiTestContext } from "./test-project.ts";
import {
  projectVisualNameClearObservation,
  readVisualWitness,
  readVisualTextRowFailure,
  projectVisualTextRowFailure,
} from "./release-visual-observation.ts";

const environment = {
  CI: "true",
  BIBCODE_UPLOAD_SOURCE: "a".repeat(40),
  BIBCODE_UPLOAD_NETNS: "net:[owned]",
  BIBCODE_UPLOAD_FIXTURE: "/owned/fixture",
  BIBCODE_UPLOAD_EVIDENCE: "/owned/evidence",
  BIBCODE_UPLOAD_SERVER: "/owned/bibcode",
  BIBCODE_DELIVERY_UI_WEB: "/owned/web",
  BIBCODE_UPLOAD_CHROME: "/owned/chrome",
  BIBCODE_UPLOAD_DRIVER: "/owned/driver",
};

const createRefFacts = {
  themeMatched: true,
  selectedMatched: true,
  expectedTextMatched: false,
  targetInView: true,
  credentialAbsent: true,
  bootShellAbsent: true,
  singleDialog: true,
  exactRef: true,
  derivedName: false,
  reuseBlocked: true,
  agentControl: true,
  advancedControl: true,
};

const textRowFacts = {
  layout: null,
  changesActive: true,
  globalTextRows: "one",
  scopedTextRows: "one",
  firstMatchVisible: false,
  listBoxPresent: true,
  listBoxPositiveSize: true,
  listBoxVisible: true,
  emptyPresent: false,
  loadingPresent: false,
  errorPresent: false,
  filterPresent: false,
};

const settingsFailureFacts = {
  themeMatched: true,
  selectedMatched: true,
  expectedTextMatched: false,
  targetInView: false,
  credentialAbsent: true,
  bootShellAbsent: true,
  gitAvailable: true,
  gitVersionVisible: false,
  hostingUnavailable: true,
  availabilityReasons: true,
  fetchIntervalVisible: false,
  scanSettled: true,
};

it("binds actual failure facts to the exact error and immutable scene/theme/owned identity", () => {
  const records = new WeakMap<object, SettingsCaptureFailureRecord>();
  const first = new Error("inert light failure"),
    second = new Error("inert dark failure");
  const ownership = {
    scene: "settings-source-control" as const,
    theme: "light" as const,
    origin: "http://127.0.0.1:4885",
    threadId: "owned-light",
    branch: "codex/delivery-retry-light",
  };
  const light = createSettingsCaptureFailureObserver(records, ownership);
  const dark = createSettingsCaptureFailureObserver(records, {
    ...ownership,
    theme: "dark",
    threadId: "owned-dark",
    branch: "codex/delivery-retry-dark",
  });
  light(first, settingsFailureFacts);
  dark(second, settingsFailureFacts);
  expect(
    readSettingsCaptureFailureFacts(records, first, "visual-settings-source-control", "light"),
  ).toEqual({ scene: "settings-source-control", theme: "light", witness: settingsFailureFacts });
  expect(
    readSettingsCaptureFailureFacts(records, second, "visual-settings-source-control", "dark"),
  ).toMatchObject({ theme: "dark" });
  for (const [error, phase, theme] of [
    [new Error(first.message), "visual-settings-source-control", "light"],
    [first, "visual-settings-source-control-open", "light"],
    [first, "visual-settings-source-control", "dark"],
  ] as const)
    expect(readSettingsCaptureFailureFacts(records, error, phase, theme)).toBeNull();
  expect(records.get(first)!.ownership).toEqual(ownership);
  expect(Object.isFrozen(records.get(first)!.ownership)).toBe(true);
  expect(Object.isFrozen(records.get(first)!.witness)).toBe(true);
  expect(
    JSON.stringify(
      readSettingsCaptureFailureFacts(records, first, "visual-settings-source-control", "light"),
    ),
  ).not.toMatch(/owned-|http|branch/);
  light(first, null);
  expect(
    readSettingsCaptureFailureFacts(records, first, "visual-settings-source-control", "light"),
  ).toBeNull();
  light(first, settingsFailureFacts);
  dark(first, settingsFailureFacts);
  expect(
    readSettingsCaptureFailureFacts(records, first, "visual-settings-source-control", "light"),
  ).toBeNull();
  expect(
    readSettingsCaptureFailureFacts(records, first, "visual-settings-source-control", "dark"),
  ).toMatchObject({ theme: "dark" });
});

it.each(["null", "extra", "getter", "proxy", "unsafe", "foreign-owner"])(
  "leaves invalid settings capture observations unassociated: %s",
  (mode) => {
    const records = new WeakMap<object, SettingsCaptureFailureRecord>();
    const error = new Error("inert original failure");
    let value: unknown = { ...settingsFailureFacts },
      reads = 0;
    if (mode === "null") value = null;
    if (mode === "extra") Object.assign(value as object, { raw: "private" });
    if (mode === "unsafe") Object.assign(value as object, { selectedMatched: false });
    if (mode === "getter")
      Object.defineProperty(value, "gitAvailable", {
        enumerable: true,
        get() {
          reads++;
          throw new Error("private");
        },
      });
    if (mode === "proxy") {
      const p = Proxy.revocable(value as object, {});
      p.revoke();
      value = p.proxy;
    }
    const observe = createSettingsCaptureFailureObserver(records, {
      scene: "settings-source-control",
      theme: "light",
      origin: mode === "foreign-owner" ? "outside" : "http://127.0.0.1:4885",
      threadId: "owned",
      branch: "codex/delivery-retry-light",
    });
    expect(() => observe(error, value)).not.toThrow();
    expect(records.has(error)).toBe(false);
    expect(reads).toBe(0);
  },
);

it("refuses a native proxy safety spoof through the same-error observer and failure reader", () => {
  const records = new WeakMap<object, SettingsCaptureFailureRecord>();
  const error = new Error("inert original capture failure");
  const observe = createSettingsCaptureFailureObserver(records, {
    scene: "settings-source-control",
    theme: "light",
    origin: "http://127.0.0.1:4885",
    threadId: "owned",
    branch: "codex/delivery-retry-light",
  });
  const unsafe = { ...settingsFailureFacts, credentialAbsent: false };
  let traps = 0;
  const proxy = new Proxy(unsafe, {
    ownKeys(value) {
      traps++;
      return Reflect.ownKeys(value);
    },
    getOwnPropertyDescriptor(value, key) {
      traps++;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return key === "credentialAbsent" ? { ...descriptor, value: true } : descriptor;
    },
  });
  observe(error, settingsFailureFacts);
  expect(
    readSettingsCaptureFailureFacts(records, error, "visual-settings-source-control", "light"),
  ).toEqual({ scene: "settings-source-control", theme: "light", witness: settingsFailureFacts });
  observe(error, unsafe);
  expect(records.has(error)).toBe(false);
  observe(error, settingsFailureFacts);
  expect(() => observe(error, proxy)).not.toThrow();
  expect(
    readSettingsCaptureFailureFacts(records, error, "visual-settings-source-control", "light"),
  ).toBeNull();
  expect(records.has(error)).toBe(false);
  expect(traps).toBe(0);
});

it.each(["transparent", "spoofing", "throwing", "revoked"])(
  "refuses native %s ownership proxies before copying or reading them",
  (mode) => {
    const records = new WeakMap<object, SettingsCaptureFailureRecord>();
    const error = new Error("inert original capture failure");
    const target = {
      scene: "settings-source-control" as const,
      theme: "light" as const,
      origin: mode === "spoofing" ? "outside" : "http://127.0.0.1:4885",
      threadId: "owned",
      branch: "codex/delivery-retry-light",
    };
    let traps = 0;
    const revocable = Proxy.revocable(target, {
      ownKeys(value) {
        traps++;
        if (mode === "throwing") throw new Error("inert proxy trap");
        return Reflect.ownKeys(value);
      },
      getOwnPropertyDescriptor(value, key) {
        traps++;
        return Object.getOwnPropertyDescriptor(value, key);
      },
      get(value, key, receiver) {
        traps++;
        return key === "origin" && mode === "spoofing"
          ? "http://127.0.0.1:4885"
          : Reflect.get(value, key, receiver);
      },
    });
    if (mode === "revoked") revocable.revoke();
    let observe: ReturnType<typeof createSettingsCaptureFailureObserver> | undefined;
    expect(() => {
      observe = createSettingsCaptureFailureObserver(records, revocable.proxy);
    }).not.toThrow();
    expect(typeof observe).toBe("function");
    expect(() => observe!(error, settingsFailureFacts)).not.toThrow();
    expect(
      readSettingsCaptureFailureFacts(records, error, "visual-settings-source-control", "light"),
    ).toBeNull();
    expect(traps).toBe(0);
  },
);

it("executes the original failure writer and entire joined cleanup with same-error settings facts", async () => {
  const records = new WeakMap<object, SettingsCaptureFailureRecord>();
  const error = new Error("inert original capture failure");
  createSettingsCaptureFailureObserver(records, {
    scene: "settings-source-control",
    theme: "light",
    origin: "http://127.0.0.1:4885",
    threadId: "owned",
    branch: "codex/delivery-retry-light",
  })(error, settingsFailureFacts);
  const start = controller.lastIndexOf("  } catch (error) {");
  const end = controller.indexOf("  return success ? 0 : 1;", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const events: string[] = [],
    writes: Array<Record<string, unknown>> = [];
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      "async function fail() { try { throw original;" + controller.slice(start, end) + "}\nfail",
    ),
    {
      original: error,
      phase: "visual-settings-source-control",
      theme: "light",
      success: false,
      settingsCaptureFailures: records,
      readSettingsCaptureFailureFacts,
      browser: {
        deleteSession: async () => {
          events.push("delete-session");
        },
      },
      classifyQualificationFailure: (current: unknown) => {
        expect(current).toBe(error);
        return classifyQualificationFailure(current);
      },
      createRefClearObservation: null,
      owner: {
        processes: [],
        failures: [],
        childrenClosed: () => true,
        close: async (options: { browser?: () => Promise<void> }) => {
          events.push("close");
          await options.browser?.();
          events.push("closed");
        },
      },
      config: { source: "a".repeat(40), selection: "release-visual-settings" },
      captures: [],
      assertions: [],
      networkProofs: [],
      write: (name: string, value: Record<string, unknown>) => {
        events.push(name);
        writes.push(value);
      },
    },
  ) as () => Promise<void>;
  await run();
  expect(events).toEqual(["failure", "close", "delete-session", "closed", "result"]);
  expect(writes[0]!.settingsCaptureFailureFacts).toEqual({
    scene: "settings-source-control",
    theme: "light",
    witness: settingsFailureFacts,
  });
  expect(writes[1]!.childProcessesClosed).toBe(true);
  expect(JSON.stringify(writes)).not.toMatch(/inert original|owned|http|branch/);
});

describe("closed text-row failure boundary", () => {
  it.each(["verified", "selected-rejected", "git-rejected"])(
    "binds the input only after the real existing core identity callback: %s",
    async (mode) => {
      const coreStart = controller.indexOf('if (config.selection === "release-visual-core")');
      const start = controller.indexOf("          verifyManaged: async () => {", coreStart);
      const end = controller.indexOf("          partialStageMatches:", start);
      expect(start).toBeGreaterThan(coreStart);
      expect(end).toBeGreaterThan(start);
      const workspace = {
        threadId: "owned-thread",
        branch: "codex/delivery-retry-light",
        path: "/owned/worktree",
        commonDirectory: "/owned/common",
      };
      const calls: string[] = [];
      const invoke = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(
          "let textRowObservationInput = { old: true }; const verify = ({" +
            controller.slice(start, end) +
            "}).verifyManaged; async () => { let failed = false; try { await verify(); } catch { failed = true; } return { input: textRowObservationInput, failed }; }",
        ),
        {
          theme: "light",
          origin: "http://127.0.0.1:4885",
          workspace,
          visualInput: { fixture: "owned" },
          owner: {
            until: async (predicate: () => Promise<boolean>) => {
              calls.push("selected");
              if (!(await predicate())) throw new Error("private selected identity");
            },
          },
          b: () => ({
            execute: async (reader: unknown, input: unknown) => {
              expect(reader).toBe(readSelectedDeliveryWorktree);
              expect(input).toEqual({
                origin: "http://127.0.0.1:4885",
                branch: workspace.branch,
                boundThreadId: workspace.threadId,
              });
              return { threadId: mode === "selected-rejected" ? "foreign" : workspace.threadId };
            },
          }),
          readSelectedDeliveryWorktree,
          readOwnedDeliveryWorktree: () => {
            calls.push("git");
            return {
              path: mode === "git-rejected" ? "/foreign" : workspace.path,
              branch: workspace.branch,
              commonDirectory: workspace.commonDirectory,
            };
          },
          check: (value: boolean) => {
            if (!value) throw new Error("private Git identity");
          },
        },
      ) as () => Promise<{ input: unknown; failed: boolean }>;
      const result = await invoke();
      expect(result.failed).toBe(mode !== "verified");
      expect(result.input).toEqual(
        mode === "verified"
          ? {
              theme: "light",
              origin: "http://127.0.0.1:4885",
              threadId: workspace.threadId,
              branch: workspace.branch,
            }
          : null,
      );
      expect(calls).toEqual(mode === "selected-rejected" ? ["selected"] : ["selected", "git"]);
    },
  );

  it.each([
    "record",
    "wrong-phase",
    "absent",
    "unverified",
    "malformed",
    "accessor",
    "proxy",
    "reject",
    "timeout",
  ])("contains the actual one bounded read and joins original cleanup: %s", async (mode) => {
    vi.useFakeTimers();
    try {
      const writes: Record<string, unknown>[] = [],
        bounds: number[] = [],
        events: string[] = [];
      const getter = vi.fn(() => {
        throw new Error("private getter");
      });
      const accessor = { ...textRowFacts };
      Object.defineProperty(accessor, "changesActive", { enumerable: true, get: getter });
      const revoked = Proxy.revocable(textRowFacts, {});
      revoked.revoke();
      const originalError = new Error(
        "The required live observation did not arrive within its bound.",
      );
      const classify = vi.fn((error: unknown) => {
        expect(error).toBe(originalError);
        return classifyQualificationFailure(error);
      });
      const observationInput = {
        theme: "light",
        origin: "http://127.0.0.1:4885",
        threadId: "owned-thread",
        branch: "codex/delivery-retry-light",
      };
      let finishRead: (value: unknown) => void = () => {};
      let reads = 0;
      const helperStart = controller.indexOf("  async function readTextRowFailureObservation()");
      const helperEnd = controller.indexOf(
        "  async function readImportFailureObservation()",
        helperStart,
      );
      const catchStart = controller.lastIndexOf("  } catch (error) {");
      const finallyEnd = controller.indexOf("  return success ? 0 : 1;", catchStart);
      expect(helperStart).toBeGreaterThan(0);
      const run = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(
          controller.slice(helperStart, helperEnd) +
            "\nasync function fail() { try { throw error;" +
            controller.slice(catchStart, finallyEnd) +
            "}\nfail",
        ),
        {
          browser:
            mode === "absent"
              ? undefined
              : {
                  execute: async (reader: unknown, input: unknown) => {
                    reads++;
                    expect(reader).toBe(readVisualTextRowFailure);
                    expect(input).toEqual(observationInput);
                    if (mode === "reject") throw new Error("private driver error");
                    if (mode === "timeout")
                      return new Promise((resolve) => {
                        finishRead = resolve;
                      });
                    return mode === "malformed"
                      ? { ...textRowFacts, raw: "private" }
                      : mode === "accessor"
                        ? accessor
                        : mode === "proxy"
                          ? revoked.proxy
                          : textRowFacts;
                  },
                  deleteSession: async () => {
                    events.push("delete-session");
                  },
                },
          textRowObservationInput: mode === "unverified" ? null : observationInput,
          phase:
            mode === "wrong-phase"
              ? "visual-partial-stage-text-row-enabled"
              : "visual-partial-stage-text-row-displayed",
          theme: "light",
          error: originalError,
          success: false,
          config: { source: "a".repeat(40), selection: "release-visual-core" },
          captures: [],
          assertions: [],
          networkProofs: [],
          bounded: (promise: Promise<unknown>, ms: number) => {
            bounds.push(ms);
            return bounded(promise, ms);
          },
          readVisualTextRowFailure,
          projectVisualTextRowFailure,
          classifyQualificationFailure: classify,
          owner: {
            processes: [],
            failures: [],
            childrenClosed: () => true,
            close: async (options: { browser?: () => Promise<void> }) => {
              events.push("close");
              await options.browser?.();
              events.push("closed");
            },
          },
          write: (name: string, value: Record<string, unknown>) => {
            events.push(name);
            writes.push(value);
          },
          createRefClearObservation: null,
        },
      ) as () => Promise<void>;
      const pending = run();
      if (mode === "timeout") await vi.advanceTimersByTimeAsync(2_001);
      await pending;
      expect(writes[0]?.textRowObservation).toEqual(mode === "record" ? textRowFacts : null);
      expect(writes[0]?.failure).toMatchObject({ kind: "observation-timeout" });
      expect(classify).toHaveBeenCalledTimes(1);
      expect(getter).not.toHaveBeenCalled();
      const skipped = ["wrong-phase", "absent", "unverified"].includes(mode);
      expect(reads).toBe(skipped ? 0 : 1);
      expect(bounds).toEqual(skipped ? [] : [2_000]);
      expect(events).toEqual(
        mode === "absent"
          ? ["failure", "close", "closed", "result"]
          : ["failure", "close", "delete-session", "closed", "result"],
      );
      expect(writes[1]?.childProcessesClosed).toBe(true);
      expect(JSON.stringify(writes)).not.toMatch(/private|owned-thread|http|pierre/);
      const receipt = JSON.stringify(writes);
      finishRead({ raw: "private late response" });
      await Promise.resolve();
      expect(JSON.stringify(writes)).toBe(receipt);
    } finally {
      vi.useRealTimers();
    }
  });
});

function createRefFailureBoundary(
  options: {
    response?: unknown;
    phase?: string;
    noBrowser?: boolean;
    noInput?: boolean;
    pending?: boolean;
    reject?: boolean;
    clearObservation?: unknown;
    readiness?: unknown;
    readinessStage?: unknown;
    importObservation?: unknown;
  } = {},
) {
  const writes: Array<Record<string, unknown>> = [];
  let reads = 0;
  let finishRead: (value: unknown) => void = () => {};
  const observationInput = {
    scene: "worktree-create-ref",
    theme: "light",
    origin: "http://127.0.0.1:4885",
    threadId: "owned-thread",
    branch: "codex/delivery-retry-light",
  };
  const projectorStart = controller.indexOf("export function projectVisualCreateRefObservation(");
  const projectorEnd = controller.indexOf(
    "export async function runDeliveryRetryQualification(",
    projectorStart,
  );
  const helperStart = controller.indexOf("  async function readCreateRefFailureObservation()");
  const helperEnd = controller.indexOf(
    "  async function readImportFailureObservation()",
    helperStart,
  );
  const catchStart = controller.lastIndexOf("  } catch (error) {");
  const catchEnd = controller.indexOf("  } finally {", catchStart);
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      (projectorStart < 0
        ? ""
        : controller.slice(projectorStart, projectorEnd).replace("export ", "")) +
        (helperStart < 0 ? "" : controller.slice(helperStart, helperEnd)) +
        "\nasync function fail() {" +
        controller.slice(catchStart + "  } catch (error) {".length, catchEnd) +
        "\n}\nfail",
    ),
    {
      browser: options.noBrowser
        ? undefined
        : {
            execute: async (reader: unknown, input: unknown) => {
              reads++;
              expect(reader).toBe(readVisualWitness);
              expect(input).toEqual(observationInput);
              if (options.reject) throw new Error("private-driver-value");
              if (options.pending)
                return new Promise((resolve) => {
                  finishRead = resolve;
                });
              return Object.hasOwn(options, "response") ? options.response : createRefFacts;
            },
          },
      phase: options.phase ?? "visual-worktree-create-ref",
      theme: "light",
      createRefObservationInput: options.noInput ? null : observationInput,
      createRefClearObservation: options.clearObservation ?? null,
      browserDriverReadiness: options.readiness ?? null,
      browserReadinessStage: options.readinessStage ?? null,
      error: new Error("The required live observation did not arrive within its bound."),
      bounded,
      projectOwnedDriverReadiness,
      readVisualWitness,
      classifyQualificationFailure,
      readStartupFailureObservation: async () => null,
      readImportFailureObservation: async () => options.importObservation ?? null,
      readWorktreeFailureObservation: async () => null,
      write: (_name: string, value: Record<string, unknown>) => writes.push(value),
    },
  ) as () => Promise<void>;
  return { run, writes, reads: () => reads, finishRead: (value: unknown) => finishRead(value) };
}

describe("closed create-ref failure facts", () => {
  it("projects the actual clear-observation callback before storing failure metadata", () => {
    const start = controller.indexOf("          recordClearObservation: (value) => {");
    const end = controller.indexOf("          capture: async (scene) => {", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const record = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "let createRefClearObservation = null; const record = ({" +
          controller.slice(start, end) +
          "}).recordClearObservation; (value) => { record(value); return createRefClearObservation; }",
      ),
      { projectVisualNameClearObservation },
    ) as (value: unknown) => unknown;
    const valid = {
      nameCount: "one",
      sameInput: true,
      emptyBefore: false,
      emptyAfter: true,
      inputEvents: "none",
      changeEvents: "one",
      trustedInputEvents: "none",
      trustedChangeEvents: "none",
      observerClosed: true,
    };
    expect(record(valid)).toEqual(valid);
    expect(record(null)).toBeNull();
    expect(record({ ...valid, rawInput: "private-input-canary" })).toBeNull();
    const accessor = { ...valid };
    const read = vi.fn(() => "private-input-canary");
    Object.defineProperty(accessor, "emptyAfter", { enumerable: true, get: read });
    expect(record(accessor)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
  it("retains the already closed clear-command facts only at the exact ref boundary", async () => {
    const clearObservation = {
      nameCount: "one",
      sameInput: true,
      emptyBefore: false,
      emptyAfter: true,
      inputEvents: "none",
      changeEvents: "one",
      trustedInputEvents: "none",
      trustedChangeEvents: "none",
      observerClosed: true,
    };
    const f = createRefFailureBoundary({ clearObservation });
    await f.run();
    expect(f.writes[0]?.createRefClearObservation).toEqual(clearObservation);
    const unrelated = createRefFailureBoundary({
      clearObservation,
      phase: "visual-git-changes-diff",
    });
    await unrelated.run();
    expect(unrelated.writes[0]?.createRefClearObservation).toBeNull();
  });
  it("retains the failing exact scene facts without turning them into capture approval", async () => {
    const f = createRefFailureBoundary();
    await f.run();
    expect(f.writes[0]?.createRefObservation).toEqual(createRefFacts);
    expect(f.writes[0]?.failure).toMatchObject({ kind: "observation-timeout" });
    expect(f.reads()).toBe(1);
    expect(JSON.stringify(f.writes)).not.toMatch(/4885|owned-thread|private-driver-value/);
  });
  it.each([
    null,
    [],
    { ...createRefFacts, rawError: "private-driver-value" },
    { ...createRefFacts, derivedName: "private-input" },
    { ...createRefFacts, advancedControl: undefined },
  ])("refuses missing, malformed or extra witness fields", async (response) => {
    const f = createRefFailureBoundary({ response });
    await f.run();
    expect(f.writes[0]?.createRefObservation).toBeNull();
    expect(f.writes[0]?.failure).toMatchObject({ kind: "observation-timeout" });
    expect(JSON.stringify(f.writes)).not.toMatch(/private/);
  });
  it.each([{ noBrowser: true }, { noInput: true }, { phase: "visual-git-changes-diff" }])(
    "does not read outside the exact attempted create-ref capture",
    async (options) => {
      const f = createRefFailureBoundary(options);
      await f.run();
      expect(f.writes[0]?.createRefObservation).toBeNull();
      expect(f.reads()).toBe(0);
    },
  );
  it("keeps the original failure when the diagnostic read rejects", async () => {
    const f = createRefFailureBoundary({ reject: true });
    await f.run();
    expect(f.writes[0]?.createRefObservation).toBeNull();
    expect(f.writes[0]?.failure).toMatchObject({ kind: "observation-timeout" });
    expect(JSON.stringify(f.writes)).not.toMatch(/private-driver/);
  });
  it("bounds a pending diagnostic and ignores its late private result", async () => {
    vi.useFakeTimers();
    try {
      const f = createRefFailureBoundary({ pending: true });
      const pending = f.run();
      await vi.advanceTimersByTimeAsync(2_001);
      await pending;
      expect(f.writes[0]?.createRefObservation).toBeNull();
      const receipt = JSON.stringify(f.writes);
      f.finishRead({ rawError: "private-driver-value" });
      await Promise.resolve();
      expect(JSON.stringify(f.writes)).toBe(receipt);
      expect(f.reads()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("import failure receipt boundary", () => {
  it("retains import-only facts without changing the original failure or adding another read", async () => {
    const facts = {
      safeLocation: true,
      route: "root",
      modalPresent: false,
      modalDisplayed: null,
      pathPresent: false,
      pathDisabled: null,
      submitPresent: false,
      submitDisabled: null,
      composerPresent: false,
      composerDisplayed: null,
      primaryCardCount: "one",
      primaryCardSelected: false,
      errorCategory: null,
    };
    const f = createRefFailureBoundary({ phase: "import-wait-composer", importObservation: facts });
    await f.run();
    expect(f.writes[0]?.importObservation).toEqual(facts);
    expect(f.writes[0]?.failure).toMatchObject({ kind: "observation-timeout" });
    expect(f.reads()).toBe(0);
    const other = createRefFailureBoundary({ phase: "baseline", importObservation: facts });
    await other.run();
    expect(other.writes[0]?.importObservation).toBeNull();
    expect(other.reads()).toBe(0);
  });
  it.each(["record", "reject", "malformed", "accessor", "proxy", "absent"])(
    "contains the actual optional read at import failure: %s",
    async (mode) => {
      const facts = {
        safeLocation: true,
        route: "root",
        modalPresent: false,
        modalDisplayed: null,
        pathPresent: false,
        pathDisabled: null,
        submitPresent: false,
        submitDisabled: null,
        composerPresent: false,
        composerDisplayed: null,
        primaryCardCount: "one",
        primaryCardSelected: false,
        errorCategory: null,
      };
      let reads = 0;
      const bounds: number[] = [],
        writes: Record<string, unknown>[] = [];
      const getter = vi.fn(() => {
        throw new Error("private field getter");
      });
      const accessor = { ...facts };
      Object.defineProperty(accessor, "route", { enumerable: true, get: getter });
      const revoked = Proxy.revocable(facts, {});
      revoked.revoke();
      const helperStart = controller.indexOf("  async function readImportFailureObservation()");
      const helperEnd = controller.indexOf(
        "  async function readWorktreeFailureObservation()",
        helperStart,
      );
      const catchStart = controller.lastIndexOf("  } catch (error) {");
      const catchEnd = controller.indexOf("  } finally {", catchStart);
      const originalError = new Error(
        "The required live observation did not arrive within its bound.",
      );
      const classify = vi.fn((error: unknown) => {
        expect(error).toBe(originalError);
        return classifyQualificationFailure(error);
      });
      const run = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(
          controller.slice(helperStart, helperEnd) +
            "\nasync function failure(){" +
            controller.slice(catchStart + "  } catch (error) {".length, catchEnd) +
            "}\nfailure",
        ),
        {
          browser:
            mode === "absent"
              ? undefined
              : {
                  execute: async (reader: unknown, input: unknown) => {
                    reads++;
                    expect(reader).toBe(readDeliveryImportObservation);
                    expect(input).toBe("http://127.0.0.1:4885");
                    if (mode === "reject") throw new Error("private driver error");
                    return mode === "malformed"
                      ? { ...facts, raw: "private payload" }
                      : mode === "accessor"
                        ? accessor
                        : mode === "proxy"
                          ? revoked.proxy
                          : facts;
                  },
                },
          bounded: (promise: Promise<unknown>, ms: number) => {
            bounds.push(ms);
            return bounded(promise, ms);
          },
          readDeliveryImportObservation,
          projectDeliveryImportObservation,
          phase: "import-wait-composer",
          theme: "light",
          origin: "http://127.0.0.1:4885",
          error: originalError,
          classifyQualificationFailure: classify,
          write: (_name: string, value: Record<string, unknown>) => writes.push(value),
        },
      ) as () => Promise<void>;
      await run();
      expect(writes).toHaveLength(1);
      expect(writes[0]?.importObservation).toEqual(mode === "record" ? facts : null);
      expect(writes[0]?.failure).toMatchObject({ kind: "observation-timeout" });
      expect(classify).toHaveBeenCalledTimes(1);
      expect(getter).not.toHaveBeenCalled();
      expect(reads).toBe(mode === "absent" ? 0 : 1);
      expect(bounds).toEqual(mode === "absent" ? [] : [2_000]);
      expect(JSON.stringify(writes)).not.toMatch(/private|http/);
    },
  );
  it("joins original failure reporting after the two-second read bound and ignores a late result", async () => {
    vi.useFakeTimers();
    try {
      let finish: (value: unknown) => void = () => {};
      const writes: Record<string, unknown>[] = [];
      const start = controller.indexOf("  async function readImportFailureObservation()");
      const end = controller.indexOf("  async function readWorktreeFailureObservation()", start);
      const catchStart = controller.lastIndexOf("  } catch (error) {");
      const catchEnd = controller.indexOf("  } finally {", catchStart);
      const execute = vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const run = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(
          controller.slice(start, end) +
            "\nasync function failure(){" +
            controller.slice(catchStart + "  } catch (error) {".length, catchEnd) +
            "}\nfailure",
        ),
        {
          browser: { execute },
          bounded,
          readDeliveryImportObservation,
          projectDeliveryImportObservation,
          phase: "import-wait-composer",
          theme: "light",
          origin: "http://127.0.0.1:4885",
          error: new Error("The required live observation did not arrive within its bound."),
          classifyQualificationFailure,
          write: (_name: string, value: Record<string, unknown>) => writes.push(value),
        },
      ) as () => Promise<void>;
      const pending = run();
      await vi.advanceTimersByTimeAsync(2_001);
      await pending;
      expect(writes[0]?.importObservation).toBeNull();
      expect(writes[0]?.failure).toMatchObject({ kind: "observation-timeout" });
      const receipt = JSON.stringify(writes);
      finish({ private: "late payload" });
      await Promise.resolve();
      expect(JSON.stringify(writes)).toBe(receipt);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("closed browser startup failure facts", () => {
  const ready = {
    attempts: 2,
    attemptsCapped: false,
    lastHttpStatus: "success",
    ready: true,
    body: "decoded",
    failure: null,
    errorClass: null,
    driverExited: false,
    driverSpawn: "none",
  };
  it.each(["driver-readiness", "session-create", "online-proof"])(
    "retains closed existing status facts only in browser phase, stage=%s",
    async (stage) => {
      const f = createRefFailureBoundary({
        phase: "browser",
        readiness: ready,
        readinessStage: stage,
      });
      await f.run();
      expect(f.writes[0]?.browserDriverReadiness).toEqual(ready);
      expect(f.writes[0]?.browserReadinessStage).toBe(stage);
      expect(f.writes[0]?.failure).toMatchObject({ kind: "observation-timeout" });
      expect(f.reads()).toBe(0);
      const other = createRefFailureBoundary({
        phase: "pair-issue-credential",
        readiness: ready,
        readinessStage: stage,
      });
      await other.run();
      expect(other.writes[0]?.browserDriverReadiness).toBeNull();
      expect(other.writes[0]?.browserReadinessStage).toBeNull();
      expect(other.reads()).toBe(0);
    },
  );
  it("quarantines malformed/accessor/proxy metadata and keeps the original failure", async () => {
    const read = vi.fn(() => "private receipt");
    const accessor = { ...ready };
    Object.defineProperty(accessor, "ready", { enumerable: true, get: read });
    const revoked = Proxy.revocable(ready, {});
    revoked.revoke();
    for (const readiness of [
      null,
      { ...ready, rawBody: "private receipt" },
      accessor,
      revoked.proxy,
    ]) {
      const f = createRefFailureBoundary({
        phase: "browser",
        readiness,
        readinessStage: "private-stage",
      });
      await f.run();
      expect(f.writes[0]?.browserDriverReadiness).toBeNull();
      expect(f.writes[0]?.browserReadinessStage).toBeNull();
      expect(f.writes[0]?.failure).toMatchObject({ kind: "observation-timeout" });
      expect(f.reads()).toBe(0);
      expect(JSON.stringify(f.writes)).not.toMatch(/private|http|owned-thread/);
    }
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["ready", "session-failure", "online-failure"])(
    "uses only the existing open/online calls and marks online proof for %s",
    async (outcome) => {
      const start = controller.indexOf('      step("browser");');
      const end = controller.indexOf('      step("pair-issue-credential");', start);
      const calls: string[] = [],
        child = {},
        browser = {},
        network = {},
        proofs: unknown[] = [];
      const originalFailure = new Error("Inert original startup failure.");
      const run = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(
          "async function run() { let browserDriverReadiness = null, browserReadinessStage = null, browser; try {" +
            controller.slice(start, end) +
            "return {browserDriverReadiness, browserReadinessStage}; } catch (error) { return {browserDriverReadiness, browserReadinessStage, error}; }}\nrun",
        ),
        {
          owner: {},
          config: { chrome: "/owned/chrome", driver: "/owned/driver" },
          origin: "http://127.0.0.1:4885",
          runRoot: "/owned",
          NodePath,
          network,
          networkProofs: proofs,
          step: (phase: string) => calls.push(phase),
          projectOwnedDriverReadiness,
          openOwnedBrowser: async (...args: unknown[]) => {
            calls.push("open");
            expect(args.slice(1, 5)).toEqual([
              "/owned/chrome",
              "/owned/driver",
              "http://127.0.0.1:4885",
              "/owned/profile",
            ]);
            (args[6] as (value: unknown) => void)("driver-readiness");
            (args[5] as (value: unknown) => void)(ready);
            (args[6] as (value: unknown) => void)("session-create");
            if (outcome === "session-failure") throw originalFailure;
            return { browser, driver: child };
          },
          verifyOwnedBrowserOnline: async (...args: unknown[]) => {
            calls.push("online");
            expect(args).toEqual([browser, network]);
            if (outcome === "online-failure") throw originalFailure;
            return { after: true };
          },
        },
      ) as () => Promise<{
        browserDriverReadiness: unknown;
        browserReadinessStage: unknown;
        error?: unknown;
      }>;
      const result = await run();
      expect(result.browserDriverReadiness).toEqual(ready);
      expect(result.browserReadinessStage).toBe(
        outcome === "session-failure" ? "session-create" : "online-proof",
      );
      expect(result.error).toBe(outcome === "ready" ? undefined : originalFailure);
      expect(calls).toEqual(
        outcome === "session-failure" ? ["browser", "open"] : ["browser", "open", "online"],
      );
      expect(proofs).toHaveLength(outcome === "ready" ? 1 : 0);
    },
  );
});

describe.each(["projector", "failure-seam"])("create-ref descriptor admission: %s", (consumer) => {
  async function project(input: unknown): Promise<unknown> {
    if (consumer === "projector") {
      let output: unknown;
      let threw = false;
      try {
        output = projectVisualCreateRefObservation(input);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      return output;
    }
    const f = createRefFailureBoundary({ response: input });
    await f.run();
    expect(f.writes[0]?.failure).toMatchObject({ kind: "observation-timeout" });
    expect(f.reads()).toBe(1);
    return f.writes[0]?.createRefObservation;
  }

  it.each(Object.keys(createRefFacts))(
    "refuses the %s accessor without invoking it",
    async (key) => {
      let reads = 0;
      const input = { ...createRefFacts };
      Object.defineProperty(input, key, {
        enumerable: true,
        get: () => {
          reads++;
          return reads === 1 ? true : "inert-private-canary";
        },
      });
      const output = await project(input);
      expect(reads).toBe(0);
      expect(output === null).toBe(true);
    },
  );

  it.each(Object.keys(createRefFacts))(
    "refuses inherited %s even with a replacement extra own key",
    async (key) => {
      const input = Object.assign(Object.create({ [key]: true }), createRefFacts) as Record<
        string,
        unknown
      >;
      delete input[key];
      input.extra = false;
      expect((await project(input)) === null).toBe(true);
    },
  );

  it.each(Object.keys(createRefFacts))("requires %s to be enumerable own data", async (key) => {
    const input = { ...createRefFacts };
    Object.defineProperty(input, key, { enumerable: false });
    expect((await project(input)) === null).toBe(true);
  });

  it.each([
    "symbol",
    "hidden-extra",
    "extra",
    "array",
    "revoked",
    "own-keys-throw",
    "descriptor-throw",
  ])("returns null locally for %s input", async (mode) => {
    let input: object = { ...createRefFacts };
    if (mode === "symbol") Object.defineProperty(input, Symbol("extra"), { value: true });
    if (mode === "hidden-extra") Object.defineProperty(input, "extra", { value: true });
    if (mode === "extra") Object.assign(input, { extra: true });
    if (mode === "array") input = Object.assign([], createRefFacts);
    if (mode === "revoked") {
      const revocable = Proxy.revocable(input, {});
      revocable.revoke();
      input = revocable.proxy;
    }
    if (mode === "own-keys-throw")
      input = new Proxy(input, {
        ownKeys: () => {
          throw new Error("Inert reflection refusal.");
        },
      });
    if (mode === "descriptor-throw")
      input = new Proxy(input, {
        getOwnPropertyDescriptor: () => {
          throw new Error("Inert reflection refusal.");
        },
      });
    expect((await project(input)) === null).toBe(true);
  });

  it.each([true, false])(
    "admits all %s enumerable data facts including a null prototype",
    async (value) => {
      const facts = Object.fromEntries(Object.keys(createRefFacts).map((key) => [key, value]));
      expect(await project(facts)).toEqual(facts);
      expect(await project(Object.assign(Object.create(null), facts))).toEqual(facts);
    },
  );

  it("snapshots each own descriptor once without reading original values", async () => {
    let ownKeyReads = 0;
    let propertyReads = 0;
    const descriptorReads = new Map<PropertyKey, number>();
    const input = new Proxy(
      { ...createRefFacts },
      {
        ownKeys: (target) => {
          ownKeyReads++;
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor: (target, key) => {
          descriptorReads.set(key, (descriptorReads.get(key) ?? 0) + 1);
          if (descriptorReads.get(key) !== 1)
            throw new Error("Inert duplicate descriptor refusal.");
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        get: (_target, key) => {
          // Promise resolution probes then before the projector sees the input.
          if (key === "then") return undefined;
          propertyReads++;
          throw new Error("Inert original value refusal.");
        },
      },
    );
    const output = await project(input);
    expect(propertyReads).toBe(0);
    expect(ownKeyReads).toBe(1);
    expect([...descriptorReads.keys()].sort()).toEqual(Object.keys(createRefFacts).sort());
    expect([...descriptorReads.values()]).toEqual(Array.from({ length: 12 }, () => 1));
    expect(output).toEqual(createRefFacts);
  });
});

describe("delivery controller admission", () => {
  it("admits only the fixed settings selector through the same namespace fence", () => {
    expect(
      deliveryConfiguration(
        { ...environment, BIBCODE_DELIVERY_UI_SELECTION: "release-visual-settings" },
        () => "net:[owned]",
      ).selection,
    ).toBe("release-visual-settings");
    expect(() =>
      deliveryConfiguration(
        { ...environment, BIBCODE_DELIVERY_UI_SELECTION: "release-visual-settings" },
        () => "net:[other]",
      ),
    ).toThrow("Owned delivery qualification namespace refused.");
  });
  it("consumes only explicit owned inputs and has a finite six-image manifest", () => {
    expect(deliveryConfiguration(environment, () => "net:[owned]")).toEqual({
      source: "a".repeat(40),
      selection: "delivery-retry-ui",
      fixture: "/owned/fixture",
      evidence: "/owned/evidence",
      binary: "/owned/bibcode",
      assets: "/owned/web",
      chrome: "/owned/chrome",
      driver: "/owned/driver",
    });
    expect(
      deliveryThemes.flatMap((theme) => deliveryScenes.map((scene) => `${scene}-${theme}.png`)),
    ).toEqual([
      "uncertain-light.png",
      "retry-cancelled-light.png",
      "new-conversation-light.png",
      "uncertain-dark.png",
      "retry-cancelled-dark.png",
      "new-conversation-dark.png",
    ]);
  });
  it.each(Object.keys(environment))("refuses missing %s before namespace access", (key) => {
    const missing: NodeJS.ProcessEnv = { ...environment };
    delete missing[key];
    let reads = 0;
    expect(() =>
      deliveryConfiguration(missing, () => {
        reads += 1;
        return "net:[owned]";
      }),
    ).toThrow(/configuration refused/);
    expect(reads).toBe(0);
  });
  it("accepts the fixed visual batch and rejects unknown selectors before any namespace read", () => {
    expect(
      deliveryConfiguration(
        { ...environment, BIBCODE_DELIVERY_UI_SELECTION: "release-visual-core" },
        () => "net:[owned]",
      ).selection,
    ).toBe("release-visual-core");
    for (const selection of ["", "full", "release-visual-full", "../controller.ts"]) {
      let reads = 0;
      expect(() =>
        deliveryConfiguration({ ...environment, BIBCODE_DELIVERY_UI_SELECTION: selection }, () => {
          reads++;
          return "net:[owned]";
        }),
      ).toThrow(/configuration refused/);
      expect(reads).toBe(0);
    }
  });
  it("refuses a different or unavailable namespace with closed errors", () => {
    expect(() => deliveryConfiguration(environment, () => "net:[foreign]")).toThrow(
      "Owned delivery qualification namespace refused.",
    );
    expect(() =>
      deliveryConfiguration(environment, () => {
        throw new Error("private-namespace-path");
      }),
    ).toThrow("Owned delivery qualification namespace refused.");
  });
});

const controller = NodeFS.readFileSync(
  new URL("../qualify-delivery-retry.ts", import.meta.url),
  "utf8",
);
const surface = '[data-center-surface-host][data-visible="true"]';
const composer = `${surface} [data-testid="composer-editor"]`;
const form = `${surface} [data-chat-composer-form="true"]`;
const trigger = `${form} [data-chat-provider-model-picker="true"]`;
const exactModel =
  '[data-model-picker-content="true"] [data-model-picker-instance-id="claudeAgent"][data-model-picker-model-slug="opus"]';
const project = "/private-owned-workspace";

function worktreeOpeningBoundary(
  options: {
    fail?: string;
    focusAfterTabs?: number;
    initiallyFocused?: boolean;
    loseFocusAfterEnabled?: boolean;
    finalCount?: number;
  } = {},
) {
  const calls: string[] = [];
  const phases: string[] = [];
  const keys: string[] = [];
  let tabs = 0;
  let countReads = 0;
  let focused = options.initiallyFocused ?? false;
  let displayed = false;
  let enabled = false;
  const failure = new Error("private-target?token=private-token timed out");
  const hit = async (name: string, args: unknown[] = []) => {
    expect(args).toEqual([]);
    calls.push(name);
    if (name === options.fail) throw failure;
  };
  const browser = {
    $$: (selector: string) => {
      expect(selector).toBe('button[aria-label^="New worktree in "]');
      return {
        length: hit("count").then(() => (++countReads === 1 ? 1 : (options.finalCount ?? 1))),
      };
    },
    $: (selector: string) => {
      expect(selector).toBe('button[aria-label^="New worktree in "]');
      return {
        isFocused: async () => {
          await hit("focused");
          return focused;
        },
        waitForDisplayed: async (...args: unknown[]) => {
          await hit("displayed", args);
          // Actual compiled CSS requires focus-within when hover does not expose this strip.
          if (!focused) throw failure;
          displayed = true;
        },
        waitForEnabled: async (...args: unknown[]) => {
          await hit("enabled", args);
          enabled = true;
          if (options.loseFocusAfterEnabled) focused = false;
        },
      };
    },
    keys: async (key: string) => {
      keys.push(key);
      if (key === "Tab") {
        await hit("tab");
        focused = ++tabs === (options.focusAfterTabs ?? 2);
      } else {
        expect(key).toBe("Enter");
        expect(focused && displayed && enabled).toBe(true);
        await hit("enter");
      }
    },
  };
  const helpersStart = controller.indexOf("  const step =");
  const helpersEnd = controller.indexOf("  const row =", helpersStart);
  const openingStart = controller.indexOf(
    "    const create =",
    controller.indexOf("  async function openWorktreeDialog("),
  );
  const openingEnd = controller.indexOf("\n  }", openingStart);
  expect(openingStart).toBeGreaterThan(0);
  expect(openingEnd).toBeGreaterThan(openingStart);
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      'let phase = "setup"; const theme = "light";\n' +
        controller.slice(helpersStart, helpersEnd) +
        "\nasync function open() {\n" +
        controller.slice(openingStart, openingEnd) +
        "\n}\nopen",
    ),
    {
      browser,
      write: (_name: string, value: { phase: string }) => phases.push(value.phase),
      owner: {
        until: async (read: () => Promise<boolean>, ...options: unknown[]) => {
          expect(options).toEqual([]);
          for (let attempt = 0; attempt < 3; attempt++) if (await read()) return;
          throw failure;
        },
      },
    },
  ) as () => Promise<void>;
  return { run, calls, phases, keys, failure };
}

describe("exact worktree opening attribution", () => {
  it("uses public keyboard focus and Enter when hover does not expose the action", async () => {
    const f = worktreeOpeningBoundary();
    await f.run();
    expect(f.keys).toEqual(["Tab", "Tab", "Enter"]);
    expect(f.calls).toEqual([
      "count",
      "focused",
      "tab",
      "focused",
      "focused",
      "tab",
      "focused",
      "displayed",
      "enabled",
      "count",
      "focused",
      "enter",
    ]);
  });

  it.each([
    ["count", "worktree-open-count"],
    ["focused", "worktree-open-focus"],
    ["tab", "worktree-open-focus"],
    ["displayed", "worktree-open-displayed"],
    ["enabled", "worktree-open-enabled"],
    ["enter", "worktree-open-enter"],
  ])(
    "retains the failing public %s await without retry or private data",
    async (fail, expected) => {
      const f = worktreeOpeningBoundary({ fail });
      await expect(f.run()).rejects.toBe(f.failure);
      expect(f.calls.at(-1)).toBe(fail);
      expect(f.phases.at(-1)).toBe(expected);
      const retained = { phase: f.phases.at(-1), failure: classifyQualificationFailure(f.failure) };
      expect(retained.failure.kind).toBe("timeout");
      expect(JSON.stringify(retained)).not.toMatch(/private|token=/);
      expect(f.keys.filter((key) => key === "Enter")).toHaveLength(fail === "enter" ? 1 : 0);
    },
  );

  it("keeps an already focused action and sends only Enter after readiness", async () => {
    const f = worktreeOpeningBoundary({ initiallyFocused: true });
    await f.run();
    expect(f.keys).toEqual(["Enter"]);
    expect(f.calls).toEqual([
      "count",
      "focused",
      "displayed",
      "enabled",
      "count",
      "focused",
      "enter",
    ]);
  });

  it("stops at the existing focus-search bound without activation", async () => {
    const f = worktreeOpeningBoundary({ focusAfterTabs: 99 });
    await expect(f.run()).rejects.toBe(f.failure);
    expect(f.phases.at(-1)).toBe("worktree-open-focus");
    expect(f.keys).toEqual(["Tab", "Tab", "Tab"]);
    expect(f.calls).not.toContain("displayed");
  });

  it.each([{ loseFocusAfterEnabled: true }, { finalCount: 0 }, { finalCount: 2 }])(
    "refuses stale focus or changed control ownership before Enter: %j",
    async (options) => {
      const f = worktreeOpeningBoundary(options);
      await expect(f.run()).rejects.toThrow("Owned delivery qualification assertion failed.");
      expect(f.phases.at(-1)).toBe("worktree-open-focus-confirm");
      expect(f.keys).toEqual(["Tab", "Tab"]);
    },
  );
});

it("targets the selected managed worktree, preserving the primary Git anchor during loss", async () => {
  const start = controller.indexOf('      step("workspace-loss");');
  const end = controller.indexOf('      step("uncertain");', start);
  expect(start).toBeGreaterThan(0);
  const calls: string[] = [];
  const selected = {
    path: "/private-owned-root/worktrees/selected",
    threadId: "owned-thread",
    branch: "codex/delivery-retry-light",
    commonDirectory: "/private-owned-root/project/.git",
  };
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      "async function loss() {" + controller.slice(start, end) + "}\nloss",
    ),
    {
      step: (name: string) => calls.push(name),
      runRoot: "/private-owned-root",
      context: { projectPath: "/private-owned-root/project" },
      workspace: selected,
      id: "owned-message",
      row: () => "owned-message-row",
      check: (value: unknown) => expect(value).toBe(true),
      NodeFS: {
        statSync: (path: string) => {
          expect(["/private-owned-root/project", selected.commonDirectory]).toContain(path);
          return { isDirectory: () => true };
        },
      },
      withUnavailableWorkspace: async (
        root: string,
        path: string,
        observe: () => Promise<void>,
      ) => {
        expect(root).toBe("/private-owned-root");
        expect(path).toBe(selected.path);
        await observe();
        calls.push("restored");
      },
      owner: {
        until: async (read: () => Promise<boolean>) => {
          expect(await read()).toBe(true);
        },
      },
      browser: {
        $: () => ({
          isExisting: async () => true,
          getText: async () =>
            "Delivery uncertain\nThe worktree directory is missing. Git registration remains.",
        }),
      },
    },
  );
  await run();
  expect(calls).toContain("restored");
});

it.each([
  "selected",
  "no-project",
  "ambiguous-project",
  "no-selected-card",
  "unsafe-git",
  "wrong-tooltip",
  "selection-changed",
])("creates and binds a real managed-worktree UI flow before delivery: %s", async (mode) => {
  const phases: string[] = [],
    clicks: string[] = [];
  let createFocused = false,
    dialogOpened = false,
    branchHovered = false,
    modelSelected = false,
    created = false,
    named = false;
  const identity = {
    path: "/owned/run/worktrees/selected",
    branch: "codex/delivery-retry-light",
    commonDirectory: "/owned/run/project/.git",
  };
  const selectedReader = () => null;
  const click = async (selector: string) => {
    expect(dialogOpened).toBe(true);
    clicks.push(selector);
    if (selector.includes("starts-with")) {
      expect(named).toBe(true);
      created = true;
    }
  };
  const browser = {
    $$: () => ({
      length: Promise.resolve(mode === "no-project" ? 0 : mode === "ambiguous-project" ? 2 : 1),
    }),
    $: (selector: string) => ({
      moveTo: async () => {
        branchHovered = true;
      },
      isFocused: async () => createFocused,
      waitForDisplayed: async (options?: { reverse?: boolean }) => {
        if (options?.reverse) expect(created).toBe(true);
      },
      waitForEnabled: async () => {},
      click: () => click(selector),
      setValue: async (value: string) => {
        expect(dialogOpened).toBe(true);
        const resolved = resolveWorktreeCreateInput({
          mode: "smart",
          nameText: value,
          selectedBranchRefName: null,
          githubItem: null,
          advancedBaseBranchOverride: null,
          defaultBaseBranch: "main",
        });
        expect(resolved?.branchName).toBe(identity.branch);
        expect(resolved?.title).toBe("codex/delivery retry light");
        named = true;
      },
    }),
    keys: async (key: string) => {
      if (key === "Tab") createFocused = true;
      else {
        expect(key).toBe("Enter");
        expect(createFocused).toBe(true);
        dialogOpened = true;
      }
    },
    execute: async (read: unknown, input: unknown) => {
      if (read === selectedReader) {
        expect(created).toBe(true);
        expect(input).toEqual({
          origin: "http://127.0.0.1:4885",
          branch: identity.branch,
          boundThreadId: modelSelected ? "owned-thread" : null,
        });
        return mode === "no-selected-card"
          ? null
          : { threadId: modelSelected && mode === "selection-changed" ? "other" : "owned-thread" };
      }
      expect(branchHovered).toBe(true);
      expect(input).toBe("Worktree: selected (codex/delivery-retry-light)");
      const observe = NodeVM.runInNewContext(
        "(" + (read as (input: unknown) => boolean).toString() + ")",
        {
          document: {
            querySelectorAll: (selector: string) =>
              selector === '[data-slot="tooltip-popup"]'
                ? [
                    {
                      getClientRects: () => [{}],
                      textContent: mode === "wrong-tooltip" ? "other" : input,
                    },
                  ]
                : [],
          },
        },
      );
      return observe(input);
    },
  };
  const start = controller.indexOf("  async function openWorktreeDialog(");
  const end = controller.indexOf("  async function type(", start);
  expect(start).toBeGreaterThan(0);
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(controller.slice(start, end) + "\ncreateOwnedWorkspace"),
    {
      theme: "light",
      origin: "http://127.0.0.1:4885",
      config: { fixture: "/owned" },
      NodePath: { join: (...parts: string[]) => parts.join("/"), basename: () => "selected" },
      step: (name: string) => phases.push(name),
      b: () => browser,
      check: (value: unknown) => {
        if (!value) throw new Error("Owned refusal.");
      },
      click,
      owner: {
        until: async (read: () => Promise<boolean>) => {
          if (!(await read())) throw new Error("Owned refusal.");
        },
      },
      readSelectedDeliveryWorktree: selectedReader,
      readOwnedDeliveryWorktree: (input: Record<string, unknown>) => {
        expect(input).toMatchObject({
          root: "/owned/run",
          project: "/owned/run/project",
          home: "/owned/run/home",
          git: "/owned/bin/git",
          branch: identity.branch,
        });
        if (mode === "unsafe-git") throw new Error("Owned refusal.");
        return identity;
      },
      selectClaudeModel: async (scope: string) => {
        expect(scope).toBe("worktree");
        modelSelected = true;
      },
    },
  );
  const execute = () =>
    run(
      { projectPath: "/owned/run/project", fixtureUserHomePath: "/owned/run/home" },
      "/owned/run",
    );
  if (mode === "selected") {
    expect(await execute()).toEqual({ ...identity, threadId: "owned-thread" });
    expect(phases.at(-1)).toBe("worktree-ready");
    expect(modelSelected).toBe(true);
    expect(clicks).toHaveLength(1);
  } else {
    await expect(execute()).rejects.toThrow("Owned refusal.");
    if (mode === "no-project" || mode === "ambiguous-project") expect(clicks).toEqual([]);
  }
  expect(phases.every((phase) => /^worktree-[a-z-]+$/.test(phase))).toBe(true);
});

describe.each(["visual", "pre-loss", "recovery"])(
  "bound workspace controller read: %s",
  (phase) => {
    it.each(["owned-thread", "replaced-thread"])(
      "retains the captured card ID after its title changes: %s",
      async (selectedId) => {
        const workspace = { branch: "codex/delivery-retry-light", threadId: "owned-thread" };
        const anchor =
          phase === "visual"
            ? "          verifyManaged: async () => {"
            : phase === "pre-loss"
              ? '        step("workspace-verify-identity");'
              : '        step("workspace-wait-recovered");';
        const opening = controller.indexOf(anchor);
        const start = phase === "visual" ? opening + anchor.length : opening;
        const end = controller.indexOf(
          phase === "visual"
            ? "            check("
            : phase === "pre-loss"
              ? "        check(\n          JSON.stringify("
              : "        check(\n          readOwnedDeliveryWorktree(",
          start,
        );
        expect(opening).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const read = NodeVM.runInNewContext("(" + readSelectedDeliveryWorktree.toString() + ")", {
          location: {
            origin: "http://127.0.0.1:4885",
            pathname: "/local/" + selectedId,
            search: "",
            hash: "",
          },
          document: {
            querySelectorAll: () => [
              {
                getAttribute: (name: string) =>
                  name === "data-testid" ? "thread-card-button-" + selectedId : "owned-branch",
              },
            ],
            querySelector: () => ({
              querySelector: () => ({ textContent: "delivery baseline light" }),
            }),
            getElementById: () => ({ querySelector: () => ({ textContent: workspace.branch }) }),
          },
        });
        const browser = {
          execute: async (reader: unknown, input: unknown) => {
            expect(reader).toBe(readSelectedDeliveryWorktree);
            expect(input).toEqual({
              origin: "http://127.0.0.1:4885",
              branch: workspace.branch,
              boundThreadId: workspace.threadId,
            });
            return read(input);
          },
          $: () => ({ isExisting: async () => false }),
        };
        const run = NodeVM.runInNewContext(
          NodeModule.stripTypeScriptTypes(
            "async function verify() {" + controller.slice(start, end) + "}\nverify",
          ),
          {
            origin: "http://127.0.0.1:4885",
            workspace,
            readSelectedDeliveryWorktree,
            step: () => {},
            check: (value: unknown) => {
              if (!value) throw new Error("Owned refusal.");
            },
            owner: {
              until: async (observe: () => Promise<boolean>) => {
                if (!(await observe())) throw new Error("Owned refusal.");
              },
            },
            browser,
            b: () => browser,
          },
        ) as () => Promise<void>;
        if (selectedId === "owned-thread") await expect(run()).resolves.toBeUndefined();
        else await expect(run()).rejects.toThrow("Owned refusal.");
      },
    );
  },
);

describe.each(["delivery-retry-ui", "release-visual-core"])(
  "selector fixture construction: %s",
  (selection) => {
    it("preserves every provider byte and the server PATH while omitting only the visual Cursor editor", () => {
      const root = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "visual-editor-")),
      );
      try {
        // Pre-existing test-owned metadata avoids launching Git: this test only
        // exercises the ordinary fixture's filesystem construction and selection.
        NodeFS.mkdirSync(NodePath.join(root, "projects with spaces/BiBCode UI Fixture/.git"), {
          recursive: true,
        });
        const env = {
          BIBCODE_E2E_RUN_ROOT: root,
          BIBCODE_E2E_ARTIFACT_DIR: NodePath.join(root, "private"),
          BIBCODE_E2E_PLATFORM: "linux",
          PATH: "/owned/original-tools",
        };
        const context = prepareDesktopUiTestContext(env);
        const before = new Map(
          NodeFS.readdirSync(context.shimDirectory).map((name) => [
            name,
            NodeFS.readFileSync(NodePath.join(context.shimDirectory, name)),
          ]),
        );
        expect(before.has("cursor")).toBe(true);
        expect(before.has("cursor-agent")).toBe(true);
        expect(before.has("claude")).toBe(true);
        const start = controller.indexOf("      const context = prepareDesktopUiTestContext(env);");
        const end = controller.indexOf("      delete childEnv.BIBCODE_HERMETIC_GUARD;", start);
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
        const construct = NodeVM.runInNewContext(
          NodeModule.stripTypeScriptTypes(
            "function prepare() {" + controller.slice(start, end) + "\nreturn childEnv; }\nprepare",
          ),
          {
            env,
            runRoot: root,
            config: { selection, fixture: "/owned/fixture" },
            NodeFS,
            NodePath,
            prepareDesktopUiTestContext: () => context,
            prepareVisualProject: () => {},
          },
        ) as () => NodeJS.ProcessEnv;
        const childEnv = construct();
        expect(NodeFS.existsSync(NodePath.join(context.shimDirectory, "cursor"))).toBe(
          selection === "delivery-retry-ui",
        );
        expect(NodeFS.readdirSync(context.shimDirectory)).toEqual(
          [...before.keys()].filter(
            (name) => selection !== "release-visual-core" || name !== "cursor",
          ),
        );
        for (const [name, bytes] of before) {
          if (selection === "release-visual-core" && name === "cursor") continue;
          expect(NodeFS.readFileSync(NodePath.join(context.shimDirectory, name))).toEqual(bytes);
        }
        expect(childEnv.PATH).toBe(
          context.shimDirectory + NodePath.delimiter + "/owned/fixture/bin",
        );
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    });
  },
);

function importBoundary(
  options: {
    selectedLabel?: string | null;
    delayedLabel?: boolean;
    typePath?: boolean;
    fail?: string;
  } = {},
) {
  const phases: string[] = [];
  const calls: string[] = [];
  let pathReady = !options.typePath;
  let selected = false;
  let labelReads = 0;
  const invoke = (operation: string) => {
    calls.push(operation);
    if (options.fail === operation) throw new Error("private-path?capability=private-token");
  };
  const browser = {
    $: (selector: string) => ({
      waitForDisplayed: async () => invoke(`display:${selector}`),
      waitForEnabled: async () => invoke(`enabled:${selector}`),
      click: async () => {
        invoke(`click:${selector}`);
        if (selector === "button=Type a path instead") pathReady = true;
        if (selector.includes('[data-model-picker-instance-id="claudeAgent"]')) selected = true;
      },
      isDisplayed: async () => {
        invoke(`visible:${selector}`);
        return selector !== "#add-project-host-path" || pathReady;
      },
      isExisting: async () => pathReady,
      setValue: async (value: string) => {
        invoke(`set:${selector}`);
        if (!pathReady || value !== project) throw new Error("Unexpected import input.");
      },
      // Production ProviderModelPicker renders a model-only label. Provider identity
      // is in aria-label; ModelListRow owns the exact instance/slug attributes.
      getText: async () => "Opus 5",
      getAttribute: async (name: string) => {
        invoke(`attribute:${selector}:${name}`);
        if (selector !== trigger || name !== "aria-label" || !selected) return null;
        if (options.delayedLabel && labelReads++ === 0) return "Codex · GPT-5";
        return options.selectedLabel === undefined ? "Claude · Opus 5" : options.selectedLabel;
      },
    }),
  };
  const start = controller.indexOf("  async function importProject(");
  const end = controller.indexOf("  async function type(", start);
  const helpersStart = controller.indexOf("  const step =");
  const helpersEnd = controller.indexOf("  const row =", helpersStart);
  if (start < 0 || end < start || helpersStart < 0 || helpersEnd < helpersStart)
    throw new Error("Missing controller import boundary.");
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      'let phase = "import"; const theme = "light";\n' +
        controller.slice(helpersStart, helpersEnd) +
        controller.slice(start, end) +
        "\nimportProject",
    ),
    {
      browser,
      composer,
      form,
      write: (_name: string, value: { phase: string }) => phases.push(value.phase),
      owner: {
        until: async (probe: () => Promise<boolean>, timeout = 30_000) => {
          expect(timeout).toBe(30_000);
          for (let attempt = 0; attempt < 2; attempt++) if (await probe()) return;
          throw new Error("The required live observation did not arrive within its bound.");
        },
      },
    },
  ) as (project: string) => Promise<void>;
  return { run: () => run(project), phases, calls };
}

describe("delivery import through public controls", () => {
  it("accepts the selected Claude model when its visible text is only the model name", async () => {
    const f = importBoundary();
    await f.run();
    expect(f.calls).toContain(`click:${exactModel}`);
    expect(f.calls).toContain(`attribute:${trigger}:aria-label`);
  });

  it.each([null, "Codex · Opus 5", "Claude · Sonnet 5", "private-unexpected-label"])(
    "refuses missing or different selection: %s",
    async (selectedLabel) => {
      const f = importBoundary({ selectedLabel });
      await expect(f.run()).rejects.toThrow();
      expect(f.phases.at(-1)).toBe("import-verify-claude-opus");
      expect(JSON.stringify(f.phases)).not.toContain("private");
    },
  );

  it("waits for the selected public label and the fallback path input without changing bounds", async () => {
    const f = importBoundary({ delayedLabel: true, typePath: true });
    await f.run();
    expect(f.calls.indexOf("display:#add-project-host-path")).toBeLessThan(
      f.calls.indexOf("set:#add-project-host-path"),
    );
    expect(f.calls.filter((call) => call === `attribute:${trigger}:aria-label`)).toHaveLength(2);
  });

  it.each([
    ['click:[data-testid="sidebar-add-project-trigger"]', "import-open-project-menu"],
    [
      "click://button[@data-add-project-action='true'][.//span[normalize-space()='Browse folder']]",
      "import-browse-folder",
    ],
    ["visible:#add-project-host-path", "import-path-choice"],
    ["click:button=Type a path instead", "import-type-path"],
    ["display:#add-project-host-path", "import-path-ready"],
    ["set:#add-project-host-path", "import-fill-path"],
    ["click:button=Open project", "import-submit-project"],
    [`display:${composer}`, "import-wait-composer"],
    [`click:${trigger}`, "import-open-model-picker"],
    [`click:${exactModel}`, "import-select-claude-opus"],
    [`attribute:${trigger}:aria-label`, "import-verify-claude-opus"],
  ])("retains only the closed failing import subphase: %s", async (fail, expectedPhase) => {
    const f = importBoundary({ fail, typePath: true });
    let error: unknown;
    try {
      await f.run();
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeDefined();
    expect(f.phases.at(-1)).toBe(expectedPhase);
    expect(f.calls.at(-1)).toBe(fail);
    const retained = JSON.stringify({
      phase: f.phases.at(-1),
      failure: classifyQualificationFailure(error),
    });
    expect(retained).not.toMatch(/private|capability|workspace/);
  });
});

function pairingBoundary(
  options: { fail?: string; theme?: "light" | "dark"; grant?: unknown } = {},
) {
  const phases: string[] = [];
  const calls: string[] = [];
  const invoke = (operation: string) => {
    calls.push(operation);
    if (options.fail === operation) throw new Error("private-path?token=private-token timed out");
  };
  const theme = options.theme ?? "light";
  let dark = false;
  const browser = {
    url: async (url: string) => {
      invoke("navigate");
      expect(url).toBe("http://127.0.0.1:4885/pair");
    },
    $: (selector: string) => ({
      waitForDisplayed: async () => invoke(`display:${selector}`),
      waitForEnabled: async () => invoke(`enabled:${selector}`),
      click: async () => {
        invoke(`click:${selector}`);
        if (selector.includes('@role="option"')) dark = theme === "dark";
      },
      setValue: async (value: string) => {
        invoke("fill-token");
        expect(value).toBe("private-one-use-token");
      },
    }),
    execute: async (callback: (dark: boolean) => boolean, value: boolean) => {
      invoke("observe-theme");
      return callback(value);
    },
  };
  const grantStart = controller.indexOf("      const grant =");
  const start = controller.lastIndexOf("      step(", grantStart);
  const end = controller.indexOf(
    '      if (config.selection === "release-visual-git-project") {',
    start,
  );
  const themeStart = controller.indexOf("  async function setTheme()");
  const themeEnd = controller.indexOf("  async function importProject(", themeStart);
  const helpersStart = controller.indexOf("  const step =");
  const helpersEnd = controller.indexOf("  const row =", helpersStart);
  if ([grantStart, start, end, themeStart, themeEnd, helpersStart, helpersEnd].some((n) => n < 0))
    throw new Error("Missing controller pairing boundary.");
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      'let phase = "pair";\n' +
        controller.slice(helpersStart, helpersEnd) +
        controller.slice(themeStart, themeEnd) +
        "\nasync function pair(){\n" +
        controller.slice(start, end) +
        "\n}\npair",
    ),
    {
      browser,
      theme,
      origin: "http://127.0.0.1:4885",
      config: { binary: "/private-bibcode" },
      context: { stateRoot: "/private-state" },
      childEnv: { PRIVATE_TOKEN: "private-token" },
      document: { documentElement: { classList: { contains: () => dark } } },
      write: (_name: string, value: { phase: string }) => phases.push(value.phase),
      owner: {
        json: async (_binary: string, args: string[]) => {
          invoke("issue-credential");
          expect(args).toEqual(["pairing", "issue", "--base-dir", "/private-state", "--json"]);
          return options.grant === undefined
            ? { credential: "private-one-use-token" }
            : options.grant;
        },
        until: async (probe: () => Promise<boolean>, timeout = 30_000) => {
          expect(timeout).toBe(30_000);
          if (!(await probe())) throw new Error("Theme did not apply.");
        },
      },
    },
  ) as () => Promise<void>;
  return { run, phases, calls };
}

describe("closed pairing and theme attribution", () => {
  it.each([
    ["issue-credential", "pair-issue-credential"],
    ["navigate", "pair-navigate"],
    ["display:#pairing-token", "pair-wait-token"],
    ["fill-token", "pair-fill-token"],
    ["click:button=Continue", "pair-submit"],
    ['display:[data-testid="sidebar-add-project-trigger"]', "pair-wait-sidebar"],
    [
      'display:[data-testid="environment-rail-local"] [data-status="connected"]',
      "pair-wait-connected",
    ],
    ['click:[data-testid="environment-rail-manage"]', "theme-open-settings"],
    ["click:button=General", "theme-open-general"],
    ['click:[aria-label="Theme preference"]', "theme-open-preference"],
    ['click://*[@role="option" and normalize-space()="Light"]', "theme-select"],
    ["observe-theme", "theme-wait-applied"],
    ["click:button=Remote Servers", "theme-open-remote-servers"],
    ["click:button=Back", "theme-back"],
  ])(
    "identifies the last attempted boundary without retaining private errors: %s",
    async (fail, phase) => {
      const f = pairingBoundary({ fail });
      let error: unknown;
      try {
        await f.run();
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeDefined();
      expect(f.calls.at(-1)).toBe(fail);
      expect(f.phases.at(-1)).toBe(phase);
      expect(
        JSON.stringify({ phase: f.phases.at(-1), failure: classifyQualificationFailure(error) }),
      ).not.toMatch(/private|credential=|token=/);
    },
  );

  it("identifies a refused credential shape before any navigation or token entry", async () => {
    const f = pairingBoundary({ grant: null });
    await expect(f.run()).rejects.toThrow("Owned pairing credential unavailable.");
    expect(f.calls).toEqual(["issue-credential"]);
    expect(f.phases.at(-1)).toBe("pair-check-credential");
  });

  it.each(["light", "dark"] as const)(
    "preserves successful public actions and theme observation: %s",
    async (theme) => {
      const f = pairingBoundary({ theme });
      await f.run();
      expect(f.calls).toContain(
        `click://*[@role="option" and normalize-space()="${theme === "light" ? "Light" : "Dark"}"]`,
      );
      expect(f.calls.at(-1)).toBe("click:button=Back");
      expect(f.phases.at(-1)).toBe("theme-back");
    },
  );
});

function startupFailureBoundary(
  options: {
    phase?: string;
    location?: { origin?: string; pathname?: string; search?: string; hash?: string };
    noBrowser?: boolean;
    token?: boolean;
    pending?: boolean;
    themeControl?: boolean;
    dark?: boolean;
    response?: unknown;
    read?: "reject" | "pending";
  } = {},
) {
  const writes: Array<{ startupObservation?: unknown }> = [];
  let reads = 0;
  let queries = 0;
  let finishRead: (value: unknown) => void = () => {
    throw new Error("No pending observation.");
  };
  class Input {
    disabled = false;
    form = {
      querySelector: (selector: string) =>
        selector === 'button[type="submit"]'
          ? new Button()
          : selector === ".text-destructive"
            ? {}
            : null,
    };
    get value(): never {
      throw new Error("Credential value must not be read.");
    }
  }
  class Button {
    disabled = false;
  }
  const browser = {
    execute: async (callback: (origin: string) => unknown, expectedOrigin: string) => {
      reads++;
      if (options.read === "reject")
        throw new Error("private-webdriver-message?token=private-token");
      if (options.read === "pending")
        return new Promise((resolve) => {
          finishRead = resolve;
        });
      if (Object.hasOwn(options, "response")) return options.response;
      return callback(expectedOrigin);
    },
  };
  const start = controller.lastIndexOf("  } catch (error) {");
  const end = controller.indexOf("  } finally {", start);
  const helperStart = controller.indexOf("  async function readStartupFailureObservation()");
  const helperEnd = controller.indexOf(
    "  async function readCreateRefFailureObservation()",
    helperStart,
  );
  const projectorStart = controller.indexOf("export function projectDeliveryStartupObservation(");
  const projectorEnd = controller.indexOf("export function projectVisualCreateRefObservation(");
  if (start < 0 || end < start) throw new Error("Missing controller failure boundary.");
  const projector =
    projectorStart < 0 ? "" : controller.slice(projectorStart, projectorEnd).replace("export ", "");
  const helper = helperStart < 0 ? "" : controller.slice(helperStart, helperEnd);
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      projector +
        helper +
        "\nasync function failure(){" +
        controller.slice(start + "  } catch (error) {".length, end) +
        "}\nfailure",
    ),
    {
      browser: options.noBrowser ? undefined : browser,
      phase: options.phase ?? "pair-wait-sidebar",
      theme: "light",
      origin: "http://127.0.0.1:4885",
      error: new Error("private-path?credential=private-token timed out"),
      bounded,
      classifyQualificationFailure,
      write: (_name: string, value: { startupObservation?: unknown }) => writes.push(value),
      location: {
        origin: "http://127.0.0.1:4885",
        pathname: "/pair",
        search: "",
        hash: "",
        ...options.location,
      },
      navigator: { onLine: true },
      HTMLInputElement: Input,
      HTMLButtonElement: Button,
      document: {
        readyState: "complete",
        documentElement: { classList: { contains: () => options.dark === true } },
        querySelector: (selector: string) => {
          queries++;
          if (selector === "#pairing-token") return options.token === false ? null : new Input();
          if (selector === "h1")
            return {
              textContent: options.pending
                ? "Pairing with this environment"
                : "private-unexpected-page-heading",
            };
          if (selector === '[aria-label="Theme preference"]')
            return options.themeControl ? {} : null;
          return null;
        },
      },
    },
  ) as () => Promise<void>;
  return {
    run,
    writes,
    reads: () => reads,
    queries: () => queries,
    finishRead: (value: unknown) => finishRead(value),
  };
}

describe("closed failure-only startup observation", () => {
  it("retains known pairing controls and an error-presence boolean without credential/text values", async () => {
    const f = startupFailureBoundary();
    await f.run();
    expect(f.writes[0]?.startupObservation).toEqual({
      safeLocation: true,
      route: "pair",
      readyState: "complete",
      online: true,
      tokenInputPresent: true,
      tokenInputDisabled: false,
      submitPresent: true,
      submitDisabled: false,
      pairingErrorPresent: true,
      pendingHeadingPresent: false,
      sidebarPresent: false,
      primaryConnected: false,
      themeControlPresent: false,
      darkTheme: false,
    });
    expect(f.reads()).toBe(1);
    expect(JSON.stringify(f.writes)).not.toMatch(/private|http|token=/);
  });

  it("distinguishes the actual pending heading and selected theme route using closed facts", async () => {
    const pending = startupFailureBoundary({ token: false, pending: true });
    await pending.run();
    expect(pending.writes[0]?.startupObservation).toMatchObject({
      tokenInputPresent: false,
      pendingHeadingPresent: true,
    });
    const theme = startupFailureBoundary({
      phase: "theme-wait-applied",
      token: false,
      themeControl: true,
      dark: true,
      location: { pathname: "/settings/general" },
    });
    await theme.run();
    expect(theme.writes[0]?.startupObservation).toMatchObject({
      route: "settings-general",
      themeControlPresent: true,
      darkTheme: true,
    });
  });

  it.each([
    { origin: "https://private-host" },
    { search: "?token=private-token" },
    { hash: "#private-token" },
  ])("refuses unexpected locations before any DOM read: %j", async (location) => {
    const f = startupFailureBoundary({ location });
    await f.run();
    expect(f.queries()).toBe(0);
    const observed = f.writes[0]?.startupObservation as Record<string, unknown>;
    expect(observed?.safeLocation).toBe(false);
    expect(
      Object.entries(observed)
        .filter(([key]) => key !== "safeLocation")
        .every(([, value]) => value === null),
    ).toBe(true);
    expect(JSON.stringify(f.writes)).not.toContain("private");
  });

  it.each([{ safeLocation: true }, { safeLocation: false }, { safeLocation: [true] }])(
    "projects malformed or extra WebDriver values to unknown rather than retaining them: %j",
    async ({ safeLocation }) => {
      const f = startupFailureBoundary({
        response: {
          route: "/pair?token=private-token",
          online: "private-token",
          safeLocation,
          readyState: "private-ready",
          extra: "private-body",
        },
      });
      await f.run();
      const observed = f.writes[0]?.startupObservation as Record<string, unknown>;
      expect(observed.safeLocation).toBe(typeof safeLocation === "boolean" ? safeLocation : null);
      expect(
        Object.entries(observed)
          .filter(([key]) => key !== "safeLocation")
          .every(([, value]) => value === null),
      ).toBe(true);
      expect(JSON.stringify(f.writes)).not.toContain("private");
    },
  );

  it.each([{ phase: "baseline" }, { noBrowser: true }, { read: "reject" as const }])(
    "does not let missing or failed diagnostics obstruct failure reporting: %j",
    async (options) => {
      const f = startupFailureBoundary(options);
      await f.run();
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0]?.startupObservation).toBeNull();
      expect(f.reads()).toBe(options.read ? 1 : 0);
      expect(JSON.stringify(f.writes)).not.toContain("private");
    },
  );

  it("bounds the read at two seconds and never publishes its late result", async () => {
    vi.useFakeTimers();
    try {
      const f = startupFailureBoundary({ read: "pending" });
      const running = f.run();
      await vi.advanceTimersByTimeAsync(2000);
      await running;
      expect(f.writes[0]?.startupObservation).toBeNull();
      f.finishRead({ raw: "private-late-body" });
      await Promise.resolve();
      expect(f.writes).toHaveLength(1);
      expect(JSON.stringify(f.writes)).not.toContain("private");
    } finally {
      vi.useRealTimers();
    }
  });
});

function worktreeFailureBoundary(
  options: {
    count?: number;
    noHeader?: boolean;
    hidden?: boolean;
    disabled?: boolean;
    covered?: boolean;
    notHovered?: boolean;
    dialog?: boolean;
    picker?: boolean;
    visibilityUnavailable?: boolean;
    location?: { origin?: string; search?: string; hash?: string };
    phase?: string;
    noBrowser?: boolean;
    response?: unknown;
    read?: "reject" | "pending";
  } = {},
) {
  const writes: Array<{ worktreeObservation?: unknown; failure?: { kind: string } }> = [];
  let reads = 0,
    queries = 0;
  let finishRead: (value: unknown) => void = () => {
    throw new Error("No pending read.");
  };
  class Element {
    readonly kind: string;
    constructor(kind: string) {
      this.kind = kind;
    }
    get textContent(): never {
      throw new Error("No page text reads.");
    }
    checkVisibility(input: unknown) {
      expect(input).toEqual({
        contentVisibilityAuto: true,
        opacityProperty: true,
        visibilityProperty: true,
      });
      return !options.hidden;
    }
    getBoundingClientRect() {
      return { left: this.kind === "header" ? 0 : 100, top: 0, width: 20, height: 20 };
    }
    contains(value: unknown) {
      return value === this;
    }
    matches(selector: string) {
      expect(selector).toBe(":hover");
      return !options.notHovered;
    }
  }
  const header = new Element("header");
  class Button extends Element {
    disabled = options.disabled === true;
    get value(): never {
      throw new Error("No input value reads.");
    }
    closest(selector: string) {
      expect(selector).toBe('div[class~="group/project-header"]');
      return options.noHeader ? null : header;
    }
  }
  const button = new Button("create");
  const dialog = new Element("dialog"),
    picker = new Element("picker");
  if (options.visibilityUnavailable)
    for (const node of [header, button, dialog, picker])
      Object.defineProperty(node, "checkVisibility", { value: undefined });
  const browser = {
    execute: async (callback: (origin: string) => unknown, expectedOrigin: string) => {
      reads++;
      if (options.read === "reject") throw new Error("private-driver-error");
      if (options.read === "pending")
        return new Promise((resolve) => {
          finishRead = resolve;
        });
      if (Object.hasOwn(options, "response")) return options.response;
      return callback(expectedOrigin);
    },
  };
  const projectorStart = controller.indexOf("export function projectDeliveryWorktreeObservation(");
  const projectorEnd = controller.indexOf("export function projectDeliveryStartupObservation(");
  const helperStart = controller.indexOf("  async function readWorktreeFailureObservation()");
  const helperEnd = controller.indexOf("  async function setTheme()", helperStart);
  const catchStart = controller.lastIndexOf("  } catch (error) {");
  const catchEnd = controller.indexOf("  } finally {", catchStart);
  const projector =
    projectorStart < 0 ? "" : controller.slice(projectorStart, projectorEnd).replace("export ", "");
  const helper = helperStart < 0 ? "" : controller.slice(helperStart, helperEnd);
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      projector +
        helper +
        "\nasync function fail() {" +
        controller.slice(catchStart + "  } catch (error) {".length, catchEnd) +
        "\n}\nfail",
    ),
    {
      browser: options.noBrowser ? undefined : browser,
      phase: options.phase ?? "worktree-open-displayed",
      theme: "light",
      origin: "http://127.0.0.1:4885",
      error: new Error("private-original-error timed out"),
      bounded,
      classifyQualificationFailure,
      write: (_name: string, value: { worktreeObservation?: unknown }) => writes.push(value),
      HTMLButtonElement: Button,
      location: {
        origin: "http://127.0.0.1:4885",
        search: "",
        hash: "",
        ...options.location,
        get href(): never {
          throw new Error("No URL reads.");
        },
        get pathname(): never {
          throw new Error("No route reads.");
        },
      },
      document: {
        get body(): never {
          throw new Error("No body reads.");
        },
        querySelectorAll: (selector: string) => {
          queries++;
          if (selector === 'button[aria-label^="New worktree in "]')
            return Array.from({ length: options.count ?? 1 }, () => button);
          if (selector === '[data-slot="dialog-popup"][role="dialog"]')
            return options.dialog ? [dialog] : [];
          if (selector === '[data-model-picker-content="true"]')
            return options.picker ? [picker] : [];
          throw new Error("Unexpected DOM query.");
        },
        elementFromPoint: (x: number) => {
          queries++;
          return options.covered ? {} : x < 50 ? header : button;
        },
      },
    },
  ) as () => Promise<void>;
  return {
    run,
    writes,
    reads: () => reads,
    queries: () => queries,
    finishRead: (value: unknown) => finishRead(value),
  };
}

describe("closed worktree-opening failure facts", () => {
  it.each([
    "worktree-open-focus",
    "worktree-open-focus-confirm",
    "worktree-open-enter",
    "worktree-open-displayed",
  ])("samples closed DOM facts once after %s", async (phase) => {
    const f = worktreeFailureBoundary({
      phase,
      hidden: true,
      disabled: true,
      covered: true,
      notHovered: true,
      dialog: true,
      picker: true,
    });
    await f.run();
    expect(f.writes[0]?.worktreeObservation).toEqual({
      safeLocation: true,
      createCount: "one",
      headerHovered: false,
      headerVisible: false,
      headerHitTarget: false,
      createVisible: false,
      createEnabled: false,
      createHitTarget: false,
      dialogVisible: false,
      modelPickerVisible: false,
    });
    expect(f.reads()).toBe(1);
    expect(f.writes[0]?.failure?.kind).toBe("timeout");
    expect(JSON.stringify(f.writes)).not.toMatch(/private|http|token=|new-worktree/);
  });

  it("distinguishes a visible public dialog and picker from absent controls", async () => {
    const f = worktreeFailureBoundary({ dialog: true, picker: true, noHeader: true });
    await f.run();
    expect(f.writes[0]?.worktreeObservation).toMatchObject({
      createCount: "one",
      headerHovered: null,
      headerVisible: null,
      headerHitTarget: null,
      createVisible: true,
      createEnabled: true,
      createHitTarget: true,
      dialogVisible: true,
      modelPickerVisible: true,
    });
  });

  it.each([
    [0, "none"],
    [2, "multiple"],
  ] as const)("does not choose an arbitrary button from count %s", async (count, category) => {
    const f = worktreeFailureBoundary({ count });
    await f.run();
    expect(f.writes[0]?.worktreeObservation).toEqual({
      safeLocation: true,
      createCount: category,
      headerHovered: null,
      headerVisible: null,
      headerHitTarget: null,
      createVisible: null,
      createEnabled: null,
      createHitTarget: null,
      dialogVisible: false,
      modelPickerVisible: false,
    });
  });

  it("keeps unavailable visibility unknown instead of substituting WebDriver state", async () => {
    const f = worktreeFailureBoundary({ visibilityUnavailable: true, dialog: true, picker: true });
    await f.run();
    expect(f.writes[0]?.worktreeObservation).toMatchObject({
      headerVisible: null,
      createVisible: null,
      dialogVisible: null,
      modelPickerVisible: null,
    });
  });

  it.each([{ origin: "https://private" }, { search: "?private" }, { hash: "#private" }])(
    "refuses foreign or credential-bearing locations before DOM reads: %j",
    async (location) => {
      const f = worktreeFailureBoundary({ location });
      await f.run();
      expect(f.queries()).toBe(0);
      const value = f.writes[0]?.worktreeObservation as Record<string, unknown>;
      expect(value?.safeLocation).toBe(false);
      expect(
        Object.entries(value)
          .filter(([key]) => key !== "safeLocation")
          .every(([, value]) => value === null),
      ).toBe(true);
      expect(JSON.stringify(f.writes)).not.toContain("private");
    },
  );

  it.each([true, false, "private"] as const)(
    "projects only finite types for safe location %s",
    async (safeLocation) => {
      const f = worktreeFailureBoundary({
        response: {
          safeLocation,
          createCount: "private",
          headerHovered: "private",
          createEnabled: "private",
          extra: "private",
        },
      });
      await f.run();
      const value = f.writes[0]?.worktreeObservation as Record<string, unknown>;
      expect(value?.safeLocation).toBe(typeof safeLocation === "boolean" ? safeLocation : null);
      expect(
        Object.entries(value)
          .filter(([key]) => key !== "safeLocation")
          .every(([, value]) => value === null),
      ).toBe(true);
      expect(JSON.stringify(f.writes)).not.toContain("private");
    },
  );

  it.each([
    { noBrowser: true },
    { phase: "worktree-git-identity" },
    { phase: "worktree-open-model-picker" },
    { read: "reject" as const },
  ])("preserves failure without missing/non-opening/failed observations: %j", async (options) => {
    const f = worktreeFailureBoundary(options);
    await f.run();
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.worktreeObservation).toBeNull();
    expect(f.writes[0]?.failure?.kind).toBe("timeout");
    expect(f.reads()).toBe(options.read ? 1 : 0);
  });

  it("uses the existing two-second bound and never republishes a late observation", async () => {
    vi.useFakeTimers();
    try {
      const f = worktreeFailureBoundary({ read: "pending" });
      const running = f.run();
      await vi.advanceTimersByTimeAsync(1999);
      expect(f.writes).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await running;
      expect(f.writes[0]?.worktreeObservation).toBeNull();
      expect(f.writes[0]?.failure?.kind).toBe("timeout");
      f.finishRead({ raw: "private-late-data" });
      await Promise.resolve();
      expect(f.writes).toHaveLength(1);
      expect(JSON.stringify(f.writes)).not.toContain("private");
    } finally {
      vi.useRealTimers();
    }
  });
});

it.each([0, 1, "error", "overflow", "missing-status", "foreign-cwd"])(
  "executes only the admitted bounded private Git port with inert spawn: %s",
  (mode) => {
    const fixtureRoot = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "visual-git-port-")),
    );
    const root = NodePath.join(fixtureRoot, "light"),
      home = NodePath.join(root, "home"),
      bin = NodePath.join(fixtureRoot, "bin"),
      cwd = NodePath.join(root, "rich");
    NodeFS.mkdirSync(home, { recursive: true });
    NodeFS.mkdirSync(bin);
    NodeFS.mkdirSync(cwd);
    const git = NodePath.join(bin, "git");
    NodeFS.writeFileSync(git, "inert owned executable", { mode: 0o700 });
    let calls = 0;
    try {
      const invoke = () =>
        runOwnedGitProjectCommand(
          { root, fixtureRoot, home, git },
          mode === "foreign-cwd" ? fixtureRoot : cwd,
          ["merge", "visual-conflict"],
          (command, args, options) => {
            calls++;
            expect(command).toBe(git);
            expect(args).toEqual([
              "-C",
              cwd,
              "-c",
              "core.fsmonitor=false",
              "-c",
              "core.hooksPath=/dev/null",
              "-c",
              "user.name=BiBCode UI Fixture",
              "-c",
              "user.email=fixture@example.test",
              "merge",
              "visual-conflict",
            ]);
            expect(options).toMatchObject({
              shell: false,
              timeout: 5000,
              killSignal: "SIGKILL",
              maxBuffer: 65536,
              stdio: ["ignore", "pipe", "pipe"],
            });
            expect(options.env).toEqual({
              HOME: home,
              PATH: bin,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_SYSTEM: "/dev/null",
              GIT_TERMINAL_PROMPT: "0",
              LC_ALL: "C",
            });
            if (mode === "error")
              return { error: new Error("private native error"), status: null, stdout: "private" };
            return {
              status: mode === "missing-status" ? null : mode === 1 ? 1 : 0,
              stdout: mode === "overflow" ? "x".repeat(65537) : "owned output",
            };
          },
        );
      if (typeof mode === "number")
        expect(invoke()).toEqual({ status: mode, stdout: "owned output" });
      else expect(invoke).toThrow("Owned Git/project command refused.");
      expect(calls).toBe(mode === "foreign-cwd" ? 0 : 1);
    } finally {
      NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  },
);
it.each(["main", "wrong-ref", "symlink", "ordinary", "ordinary-git"])(
  "binds the canonical source HEAD while broken config stays independently diagnosed: %s",
  (mode) => {
    const root = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "visual-git-head-")),
      ),
      cwd = NodePath.join(root, "rich"),
      admin = NodePath.join(cwd, ".git");
    NodeFS.mkdirSync(cwd);
    if (mode !== "ordinary") {
      NodeFS.mkdirSync(admin);
      NodeFS.writeFileSync(
        NodePath.join(admin, "HEAD"),
        mode === "wrong-ref" ? "ref: refs/heads/other\n" : "ref: refs/heads/main\n",
      );
      NodeFS.writeFileSync(NodePath.join(admin, "config"), "[owned broken metadata\n");
    }
    if (mode === "symlink") {
      NodeFS.renameSync(NodePath.join(admin, "HEAD"), NodePath.join(admin, "other"));
      NodeFS.symlinkSync(NodePath.join(admin, "other"), NodePath.join(admin, "HEAD"));
    }
    const selection = {
      environmentId: "local",
      projectId: "owned",
      threadId: "thread",
      cwd,
      title: "rich",
      branch: mode.startsWith("ordinary") ? null : "main",
    };
    try {
      const invoke = () => verifyOwnedGitProjectSource(root, selection);
      if (["main", "ordinary"].includes(mode)) expect(invoke).not.toThrow();
      else expect(invoke).toThrow();
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
it("reads only the current typed owned snapshot endpoint and keeps the pairing credential off results", async () => {
  const fetcher = vi.fn(
    async (url: string, options: { headers: { authorization: string }; signal: AbortSignal }) => {
      expect(url).toBe("http://127.0.0.1:4885/api/orchestration/snapshot");
      expect(options.headers).toEqual({ authorization: "Bearer owned-private-test-credential" });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return {
        ok: true,
        json: async () => ({
          snapshotSequence: 0,
          projects: [],
          threads: [],
          updatedAt: "2026-10-04T00:00:00.000Z",
        }),
      };
    },
  );
  vi.stubGlobal("fetch", fetcher);
  try {
    expect(await readOwnedGitProjectSnapshot("owned-private-test-credential")).toEqual({
      snapshotSequence: 0,
      projects: [],
      threads: [],
      updatedAt: "2026-10-04T00:00:00.000Z",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
