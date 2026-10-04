// @effect-diagnostics nodeBuiltinImport:off - Synthetic PNG and inert WebDriver boundary only; no browser or server starts.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import * as NodeZlib from "node:zlib";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  captureVisualScene,
  type VisualCaptureInput,
  type CoreBranchCaptureFailureRecord,
} from "./release-visual-core.ts";
import * as CoreCapture from "./release-visual-core.ts";
import { readVisualWitness, observeVisualNameClear } from "./release-visual-observation.ts";

function png() {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    out.write(type, 4);
    data.copy(out, 8);
    out.writeUInt32BE(NodeZlib.crc32(out.subarray(4, -4)), out.length - 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1280, 0);
  header.writeUInt32BE(960, 4);
  header[8] = 8;
  header[9] = 2;
  const data = Buffer.alloc((1280 * 3 + 1) * 960);
  for (let y = 0; y < 960; y++) {
    data.fill(y % 256, y * 3841 + 1, (y + 1) * 3841);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(data)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const proof = {
  themeMatched: true,
  selectedMatched: true,
  expectedTextMatched: true,
  targetInView: true,
  credentialAbsent: true,
  bootShellAbsent: true,
  singlePalette: true,
  filteredAction: true,
  singleActiveRow: true,
  inputFocused: true,
};
const branchFailureProof = {
  themeMatched: true,
  selectedMatched: true,
  expectedTextMatched: false,
  targetInView: true,
  credentialAbsent: true,
  bootShellAbsent: true,
  currentBranch: false,
  remoteBranch: true,
  occupiedBranch: true,
  renameDeleteControls: true,
};
const captureOwnership = {
  source: "a".repeat(40),
  scene: "git-branch-menu",
  theme: "light",
  origin: "http://127.0.0.1:4885",
  threadId: "owned",
  branch: "codex/delivery-retry-light",
} as const;
const managedOwnership = {
  theme: captureOwnership.theme,
  origin: captureOwnership.origin,
  threadId: captureOwnership.threadId,
  branch: captureOwnership.branch,
};
const currentOwnership = {
  ...captureOwnership,
  phase: "visual-git-branch-menu",
};
function projectBranchFailure(value: unknown) {
  return Reflect.get(CoreCapture, "projectCoreBranchCaptureFailureWitness")?.(value) ?? null;
}
function createBranchFailureObserver(
  records: WeakMap<object, CoreBranchCaptureFailureRecord>,
  ownership: unknown = captureOwnership,
  managed: unknown = managedOwnership,
) {
  return (
    Reflect.get(CoreCapture, "createCoreBranchCaptureFailureObserver")?.(
      records,
      ownership,
      managed,
    ) ?? (() => {})
  );
}
function readBranchFailure(
  records: WeakMap<object, CoreBranchCaptureFailureRecord>,
  error: unknown,
  current: unknown = currentOwnership,
) {
  return (
    Reflect.get(CoreCapture, "readCoreBranchCaptureFailureFacts")?.(records, error, current) ?? null
  );
}
function boundary() {
  const evidence = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "visual-evidence-test-"));
  const bytes = png();
  const browser = {
    isAlertOpen: vi.fn(async () => false),
    execute: vi.fn(async (read: unknown): Promise<Record<string, boolean>> => {
      expect(read).toBe(readVisualWitness);
      return proof;
    }),
    takeScreenshot: vi.fn(async () => bytes.toString("base64")),
  };
  const input = {
    scene: "command-palette",
    theme: "light",
    origin: "http://127.0.0.1:4885",
    threadId: "owned",
    branch: "codex/delivery-retry-light",
    evidence,
    browser,
    captured: new Set<string>(),
    owner: {
      until: async (read: () => Promise<boolean>) => {
        if (!(await read())) throw new Error("Owned observation timeout.");
      },
    },
  } as unknown as VisualCaptureInput;
  return {
    input,
    browser,
    bytes,
    close: () => NodeFS.rmSync(evidence, { recursive: true, force: true }),
  };
}
describe("original visual capture boundary", () => {
  it("retains the actual post-screenshot refusal without a third witness read or a PNG", async () => {
    const f = boundary();
    const records = new WeakMap<object, CoreBranchCaptureFailureRecord>();
    const admitted = { ...branchFailureProof, expectedTextMatched: true, currentBranch: true };
    const refused = { ...admitted, targetInView: false };
    const observe = vi.fn(createBranchFailureObserver(records));
    Object.assign(f.input, { scene: "git-branch-menu", observeFailure: observe });
    f.browser.execute.mockResolvedValueOnce(admitted).mockResolvedValueOnce(refused);
    try {
      const failure = await captureVisualScene(f.input).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(observe).toHaveBeenCalledWith(failure, refused);
      expect(readBranchFailure(records, failure)).toEqual({
        scene: "git-branch-menu",
        theme: "light",
        witness: refused,
      });
      expect(f.browser.execute).toHaveBeenCalledTimes(2);
      expect(f.browser.takeScreenshot).toHaveBeenCalledTimes(1);
      expect(f.input.captured.size).toBe(0);
      expect(NodeFS.readdirSync(f.input.evidence)).toEqual([]);
    } finally {
      f.close();
    }
  });
  it("reports the last existing branch witness only after the original capture fails", async () => {
    const f = boundary();
    const original = new Error("Inert original observation timeout.");
    const records = new WeakMap<object, CoreBranchCaptureFailureRecord>();
    const last = { ...branchFailureProof, currentBranch: true, remoteBranch: false };
    Object.assign(f.input, {
      scene: "git-branch-menu",
      observeFailure: createBranchFailureObserver(records),
    });
    f.browser.execute.mockResolvedValueOnce(branchFailureProof).mockResolvedValueOnce(last);
    f.input.owner.until = async (read) => {
      expect(await read()).toBe(false);
      expect(readBranchFailure(records, original)).toBeNull();
      expect(await read()).toBe(false);
      throw original;
    };
    try {
      await expect(captureVisualScene(f.input)).rejects.toBe(original);
      expect(readBranchFailure(records, original)).toEqual({
        scene: "git-branch-menu",
        theme: "light",
        witness: last,
      });
      expect(f.browser.execute).toHaveBeenCalledTimes(2);
      expect(f.browser.takeScreenshot).not.toHaveBeenCalled();
      expect(NodeFS.readdirSync(f.input.evidence)).toEqual([]);
      expect(readBranchFailure(records, new Error(original.message))).toBeNull();
    } finally {
      f.close();
    }
  });
  it.each(["before-read", "unsafe-latest", "observer-fault"])(
    "preserves the original capture failure with unavailable diagnostics: %s",
    async (mode) => {
      const f = boundary();
      const original = new Error("Inert original capture failure.");
      const observed = vi.fn(() => {
        if (mode === "observer-fault") throw new Error("Inert observer fault.");
      });
      Object.assign(f.input, { scene: "git-branch-menu", observeFailure: observed });
      if (mode === "before-read") f.browser.isAlertOpen.mockRejectedValue(original);
      else {
        f.browser.execute.mockResolvedValue(
          mode === "unsafe-latest"
            ? { ...branchFailureProof, credentialAbsent: false }
            : branchFailureProof,
        );
        f.input.owner.until = async (read) => {
          expect(await read()).toBe(false);
          throw original;
        };
      }
      try {
        await expect(captureVisualScene(f.input)).rejects.toBe(original);
        expect(observed).toHaveBeenCalledWith(
          original,
          mode === "observer-fault" ? branchFailureProof : null,
        );
        expect(f.browser.execute).toHaveBeenCalledTimes(mode === "before-read" ? 0 : 1);
        expect(f.browser.takeScreenshot).not.toHaveBeenCalled();
      } finally {
        f.close();
      }
    },
  );
  it("writes original bytes only after both read-only witnesses pass and refuses a duplicate", async () => {
    const f = boundary();
    try {
      const capture = await captureVisualScene(f.input);
      expect(capture).toMatchObject({
        scene: "command-palette",
        theme: "light",
        file: "command-palette-light.png",
        width: 1280,
        height: 960,
        nonBlank: true,
        witness: proof,
      });
      expect(
        NodeFS.readFileSync(NodePath.join(f.input.evidence, "command-palette-light.png")),
      ).toEqual(f.bytes);
      expect(f.browser.execute).toHaveBeenCalledTimes(2);
      await expect(captureVisualScene(f.input)).rejects.toThrow();
      expect(f.browser.takeScreenshot).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(capture)).not.toMatch(/owned|4885|delivery-retry/);
    } finally {
      f.close();
    }
  });
  it.each(["invalid-scene", "alert", "before", "after", "driver"])(
    "retains no PNG after %s failure",
    async (failure) => {
      const f = boundary();
      try {
        if (failure === "invalid-scene") f.input.scene = "native-share-refresh" as never;
        if (failure === "alert") f.browser.isAlertOpen.mockResolvedValue(true);
        if (failure === "before")
          f.browser.execute.mockResolvedValue({ ...proof, credentialAbsent: false });
        if (failure === "after")
          f.browser.execute
            .mockResolvedValueOnce(proof)
            .mockResolvedValue({ ...proof, selectedMatched: false });
        if (failure === "driver")
          f.browser.takeScreenshot.mockRejectedValue(new Error("private-token"));
        await expect(captureVisualScene(f.input)).rejects.toThrow();
        expect(NodeFS.readdirSync(f.input.evidence)).toEqual([]);
        expect(f.input.captured.size).toBe(0);
        if (["invalid-scene", "alert", "before"].includes(failure))
          expect(f.browser.takeScreenshot).not.toHaveBeenCalled();
      } finally {
        f.close();
      }
    },
  );
});

describe("closed core branch capture failure facts", () => {
  it("snapshots only safe data and deletes prior facts when the same error receives an unsafe witness", () => {
    const records = new WeakMap<object, CoreBranchCaptureFailureRecord>();
    const error = new Error("Inert capture failure.");
    const observe = createBranchFailureObserver(records);
    const value = { ...branchFailureProof };
    observe(error, value);
    value.currentBranch = true;
    expect(readBranchFailure(records, error)?.witness.currentBranch).toBe(false);
    observe(error, { ...value, credentialAbsent: false });
    expect(readBranchFailure(records, error)).toBeNull();
  });
  it("refuses ownership and record accessors without invoking them, and tolerates reflection faults", () => {
    let reads = 0;
    const accessor = (value: object, key: string) => {
      Object.defineProperty(value, key, {
        enumerable: true,
        get() {
          reads++;
          return "private";
        },
      });
      return value;
    };
    const records = new WeakMap<object, CoreBranchCaptureFailureRecord>();
    const error = new Error("Inert capture failure.");
    createBranchFailureObserver(records, accessor({ ...captureOwnership }, "source"))(
      error,
      branchFailureProof,
    );
    createBranchFailureObserver(
      records,
      captureOwnership,
      accessor({ ...managedOwnership }, "threadId"),
    )(error, branchFailureProof);
    expect(
      readBranchFailure(records, error, accessor({ ...currentOwnership }, "source")),
    ).toBeNull();
    WeakMap.prototype.set.call(
      records,
      error,
      accessor({ ownership: captureOwnership, witness: branchFailureProof }, "witness"),
    );
    expect(readBranchFailure(records, error)).toBeNull();
    const fault = vi.spyOn(Reflect, "ownKeys").mockImplementation(() => {
      throw new Error("Inert reflection fault.");
    });
    try {
      expect(projectBranchFailure(branchFailureProof)).toBeNull();
    } finally {
      fault.mockRestore();
    }
    expect(reads).toBe(0);
  });
  it.each(["error", "records", "stored-record"])(
    "refuses native proxies on the %s association boundary before a trap",
    (boundary) => {
      let traps = 0;
      const records = new WeakMap<object, CoreBranchCaptureFailureRecord>();
      const error = new Error("Inert capture failure.");
      const revoked = <T extends object>(value: T) => {
        const proxy = Proxy.revocable(value, {
          get() {
            traps++;
            throw new Error("Inert proxy access.");
          },
          ownKeys() {
            traps++;
            throw new Error("Inert reflection access.");
          },
        });
        proxy.revoke();
        return proxy.proxy;
      };
      const observedError = boundary === "error" ? revoked(error) : error;
      const observedRecords = boundary === "records" ? revoked(records) : records;
      if (boundary === "stored-record")
        records.set(error, revoked({ ownership: captureOwnership, witness: branchFailureProof }));
      else createBranchFailureObserver(observedRecords)(observedError, branchFailureProof);
      expect(readBranchFailure(observedRecords, observedError)).toBeNull();
      expect(traps).toBe(0);
    },
  );
  it("retains a frozen complete boolean witness with failed scene facts", () => {
    const result = projectBranchFailure(branchFailureProof);
    expect(result).toEqual(branchFailureProof);
    expect(Object.isFrozen(result)).toBe(true);
  });
  it.each([
    "missing",
    "extra",
    "symbol",
    "getter",
    "inherited",
    "hidden",
    "non-boolean",
    "credential",
    "theme",
    "selection",
    "boot",
  ])("refuses unsafe or malformed own fields without reading accessors: %s", (mode) => {
    let value: object = { ...branchFailureProof };
    let reads = 0;
    if (mode === "missing") Reflect.deleteProperty(value, "remoteBranch");
    if (mode === "extra") Object.assign(value, { private: "inert secret" });
    if (mode === "symbol") Object.assign(value, { [Symbol("private")]: true });
    if (mode === "getter")
      Object.defineProperty(value, "remoteBranch", {
        enumerable: true,
        get() {
          reads++;
          return true;
        },
      });
    if (mode === "inherited") {
      value = Object.create(branchFailureProof);
    }
    if (mode === "hidden")
      Object.defineProperty(value, "remoteBranch", { enumerable: false, value: true });
    if (mode === "non-boolean") Object.assign(value, { remoteBranch: "private" });
    for (const [failure, key] of [
      ["credential", "credentialAbsent"],
      ["theme", "themeMatched"],
      ["selection", "selectedMatched"],
      ["boot", "bootShellAbsent"],
    ])
      if (mode === failure) Object.assign(value, { [key!]: false });
    expect(projectBranchFailure(value)).toBeNull();
    expect(reads).toBe(0);
  });
  it.each(["live", "spoofing", "throwing", "revoked"])(
    "rejects native witness and ownership proxies before every trap: %s",
    (mode) => {
      let traps = 0;
      const wrap = (value: object) => {
        const proxy = Proxy.revocable(value, {
          get(target, key, receiver) {
            traps++;
            return Reflect.get(target, key, receiver);
          },
          ownKeys(target) {
            traps++;
            if (mode === "throwing") throw new Error("Inert reflection fault.");
            return Reflect.ownKeys(target);
          },
          getOwnPropertyDescriptor(target, key) {
            traps++;
            return mode === "spoofing"
              ? { enumerable: true, configurable: true, value: true }
              : Reflect.getOwnPropertyDescriptor(target, key);
          },
        });
        if (mode === "revoked") proxy.revoke();
        return proxy.proxy;
      };
      const error = new Error("Inert capture failure.");
      const records = new WeakMap<object, CoreBranchCaptureFailureRecord>();
      expect(projectBranchFailure(wrap(branchFailureProof))).toBeNull();
      createBranchFailureObserver(records, wrap(captureOwnership))(error, branchFailureProof);
      createBranchFailureObserver(
        records,
        captureOwnership,
        wrap(managedOwnership),
      )(error, branchFailureProof);
      expect(readBranchFailure(records, error, wrap(currentOwnership))).toBeNull();
      expect(readBranchFailure(records, error)).toBeNull();
      expect(traps).toBe(0);
    },
  );
  it("joins the original capture error to current private source, managed identity, scene and theme", () => {
    const error = new Error("Inert capture failure.");
    const records = new WeakMap<object, CoreBranchCaptureFailureRecord>();
    createBranchFailureObserver(records)(error, branchFailureProof);
    expect(readBranchFailure(records, error)).toEqual({
      scene: "git-branch-menu",
      theme: "light",
      witness: branchFailureProof,
    });
    for (const patch of [
      { source: "b".repeat(40) },
      { threadId: "other" },
      { branch: "codex/delivery-retry-dark", theme: "dark" },
      { scene: "git-history-stashes" },
      { phase: "visual-git-history-stashes" },
      { origin: "http://inert.invalid" },
    ])
      expect(readBranchFailure(records, error, { ...currentOwnership, ...patch })).toBeNull();
    const records2 = new WeakMap<object, CoreBranchCaptureFailureRecord>();
    createBranchFailureObserver(records2, captureOwnership, {
      ...managedOwnership,
      threadId: "other",
    })(error, branchFailureProof);
    expect(readBranchFailure(records2, error)).toBeNull();
    expect(JSON.stringify(readBranchFailure(records, error))).not.toMatch(
      /owned|delivery-retry|4885|aaaa|private/,
    );
  });
});

import { runVisualCore, type VisualCoreInput } from "./release-visual-core.ts";
it.each([
  "ok",
  "start-reject",
  "start-unadmitted",
  "finish-reject",
  "clear-reject",
  "callback-reject",
  "clear-and-callback-reject",
])(
  "observes the public keyboard clear before typing the ref without replacing its failure: %s",
  async (mode) => {
    const order: string[] = [];
    let admission: string | undefined;
    const snapshots: unknown[] = [];
    const stopped = new Error("Inert capture stop.");
    const clearFailure = new Error("Inert original clear failure.");
    const callbackFailure = new Error("Inert unavailable observation callback.");
    const clearRejected = mode === "clear-reject" || mode === "clear-and-callback-reject";
    const snapshot = {
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
    const input = {
      browser: {
        $$: () => ({ length: Promise.resolve(1) }),
        $: (selector: string) => ({
          elementId: "owned-name",
          isFocused: async () => true,
          waitForDisplayed: async () => {},
          waitForEnabled: async () => {},
          click: async () => {},
          setValue: async (value: string) => {
            expect(selector).not.toContain('placeholder="Worktree name"');
            expect(value).toBe("visual-held");
            order.push("type-exact-ref");
          },
        }),
        keys: async (value: string | string[]) => {
          if (Array.isArray(value) && value[0] === "Control") {
            expect(value).toEqual(["Control", "a"]);
            order.push("select-owned-name");
          } else if (value === "Backspace") {
            order.push("delete-owned-name");
            if (clearRejected) throw clearFailure;
          }
        },
        execute: async (
          read: unknown,
          value: { operation: string; admission: string; admitted?: boolean },
        ) => {
          expect(read).toBe(observeVisualNameClear);
          expect(value).toMatchObject({
            origin: "http://127.0.0.1:4885",
            threadId: "owned",
            operation: value.operation,
          });
          expect(value.admission).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
          );
          if (value.operation === "start") {
            admission = value.admission;
            expect(value).not.toHaveProperty("admitted");
          } else {
            expect(value.admission).toBe(admission);
            expect(value.admitted).toBe(true);
          }
          order.push(value.operation + "-observer");
          if (
            (mode === "start-reject" && value.operation === "start") ||
            (mode === "finish-reject" && value.operation === "finish")
          )
            throw new Error("Inert unavailable observation.");
          return value.operation === "start" ? mode !== "start-unadmitted" : snapshot;
        },
      },
      owner: {
        until: async (read: () => Promise<boolean>) => {
          expect(await read()).toBe(true);
        },
      },
      threadId: "owned",
      branch: "codex/delivery-retry-light",
      step: () => {},
      verifyManaged: async () => {},
      openWorktreeDialog: async () => {},
      recordClearObservation: (value: unknown) => {
        snapshots.push(value);
        order.push("record-closed-observation");
        if (mode === "callback-reject" || mode === "clear-and-callback-reject")
          throw callbackFailure;
      },
      capture: async (scene: string) => {
        if (scene === "worktree-create-ref") throw stopped;
      },
    } as unknown as VisualCoreInput;
    await expect(runVisualCore(input)).rejects.toBe(clearRejected ? clearFailure : stopped);
    expect(snapshots).toEqual([
      mode === "start-reject" || mode === "start-unadmitted" || mode === "finish-reject"
        ? null
        : snapshot,
    ]);
    expect(order).toEqual([
      "start-observer",
      "select-owned-name",
      "delete-owned-name",
      ...(mode === "start-reject" || mode === "start-unadmitted" ? [] : ["finish-observer"]),
      "record-closed-observation",
      ...(clearRejected ? [] : ["type-exact-ref"]),
    ]);
  },
);
it.each(["missing", "duplicate", "focus-lost", "replacement"])(
  "refuses keyboard deletion when the exact owned name proof fails: %s",
  async (mode) => {
    let focused = true;
    const gestures: unknown[] = [];
    const captures: string[] = [];
    const sourceInput = vi.fn(async () => {});
    const name = {
      elementId: "owned-name",
      isFocused: async () => focused,
      waitForDisplayed: async () => {},
      waitForEnabled: async () => {},
    };
    const input = {
      browser: {
        $$: (selector: string) => ({
          length: Promise.resolve(
            selector.includes('placeholder="Worktree name"')
              ? mode === "missing"
                ? 0
                : mode === "duplicate"
                  ? 2
                  : 1
              : 1,
          ),
        }),
        $: (selector: string) =>
          selector.includes('placeholder="Worktree name"')
            ? name
            : {
                isFocused: async () => true,
                waitForDisplayed: async () => {},
                waitForEnabled: async () => {},
                click: async () => {},
                setValue: sourceInput,
              },
        keys: async (value: string | string[]) => {
          if (Array.isArray(value) && value[0] === "Control") {
            gestures.push(value);
            if (mode === "focus-lost") focused = false;
            if (mode === "replacement") name.elementId = "replacement";
          } else if (value === "Backspace") gestures.push(value);
        },
      },
      owner: {
        until: async (read: () => Promise<boolean>) => {
          expect(await read()).toBe(true);
        },
      },
      threadId: "owned",
      branch: "codex/delivery-retry-light",
      step: () => {},
      verifyManaged: async () => {},
      openWorktreeDialog: async () => {},
      capture: async (scene: string) => {
        captures.push(scene);
      },
    } as unknown as VisualCoreInput;
    await expect(runVisualCore(input)).rejects.toThrow("Visual public control refused.");
    expect(gestures).toEqual(mode === "missing" || mode === "duplicate" ? [] : [["Control", "a"]]);
    expect(sourceInput).not.toHaveBeenCalled();
    expect(captures).toEqual(["workspace-composite", "workspace-card-menu"]);
  },
);
it("checks the shared managed-worktree identity before the first exact scene and propagates capture failure", async () => {
  const order: string[] = [];
  const stopped = new Error("fixture capture stopped");
  const input = {
    browser: {},
    owner: {},
    threadId: "owned",
    branch: "codex/delivery-retry-light",
    step: (phase: string) => order.push(phase),
    verifyManaged: async () => {
      order.push("verified-managed");
    },
    capture: async (scene: string) => {
      order.push(scene);
      throw stopped;
    },
  } as unknown as VisualCoreInput;
  await expect(runVisualCore(input)).rejects.toBe(stopped);
  expect(order).toEqual(["verified-managed", "visual-workspace-composite", "workspace-composite"]);
});
it.each([true, false])(
  "runs only the eight fixed scenes and requires the supported image proof: loaded=%s",
  async (imageLoaded) => {
    const calls: string[] = [],
      captures: string[] = [];
    const element = (selector: string): object => ({
      waitForDisplayed: async () => {},
      waitForEnabled: async () => {},
      elementId: "owned-element",
      isFocused: async () => true,
      isDisplayed: async () => selector !== "[data-right-panel-tabbar]",
      click: async () => {
        calls.push(`click:${selector}`);
      },
      setValue: async (value: string) => {
        calls.push(`input:${selector}:${value}`);
      },
      moveTo: async () => {
        calls.push(`hover:${selector}`);
      },
      scrollIntoView: async () => {
        calls.push(`scroll:${selector}`);
      },
      getText: async () => "Owned visual review draft",
      shadow$: (next: string) => element(selector + " >> " + next),
    });
    const input = {
      browser: {
        $: element,
        $$: () => ({ length: Promise.resolve(1) }),
        keys: async (key: unknown) => {
          calls.push(`key:${JSON.stringify(key)}`);
        },
        execute: async (read: { name: string }) => {
          if (read.name === "readVisualWorkingImageSelected") {
            calls.push("read-working-image-binary");
            return true;
          }
          if (read.name === "readVisualImageLoaded") {
            calls.push("read-supported-commit-image");
            return imageLoaded;
          }
          return { x: 0, y: 0 };
        },
      },
      owner: {
        until: async (read: () => Promise<boolean>) => {
          if (!(await read())) throw new Error("Inert required image load did not arrive.");
        },
      },
      threadId: "owned",
      branch: "codex/delivery-retry-light",
      step: () => {},
      verifyManaged: async () => {
        calls.push("verify-managed");
      },
      openWorktreeDialog: async () => {
        calls.push("shared-worktree-opener");
      },
      partialStageMatches: () => {
        calls.push("read-actual-partial-stage");
        return true;
      },
      capture: async (scene: string) => {
        calls.push(`capture:${scene}`);
        captures.push(scene);
      },
    } as unknown as VisualCoreInput;
    if (!imageLoaded) {
      await expect(runVisualCore(input)).rejects.toThrow(
        "Inert required image load did not arrive.",
      );
      expect(captures).toEqual([
        "workspace-composite",
        "workspace-card-menu",
        "worktree-create-ref",
      ]);
      expect(calls).toContain("read-working-image-binary");
      expect(calls).toContain(
        'click:[aria-label="Repository history"] [aria-label="Changed files"] button[data-changed-file-path="visual-swatch.png"]',
      );
      expect(calls).not.toContain("read-actual-partial-stage");
      return;
    }
    const result = await runVisualCore(input);
    expect(captures).toEqual([
      "workspace-composite",
      "workspace-card-menu",
      "worktree-create-ref",
      "git-changes-diff",
      "git-history-stashes",
      "git-branch-menu",
      "files-editor-comment",
      "command-palette",
    ]);
    expect(calls.filter((call) => call === "shared-worktree-opener")).toHaveLength(1);
    expect(calls).not.toContain(
      'input:[data-slot="dialog-popup"][role="dialog"] input[placeholder="Worktree name"]:',
    );
    expect(calls).toContain('key:["Control","a"]');
    expect(calls).toContain('key:"Backspace"');
    expect(calls.indexOf('key:["Control","a"]')).toBeLessThan(calls.indexOf('key:"Backspace"'));
    expect(calls.indexOf('key:"Backspace"')).toBeLessThan(
      calls.indexOf("capture:worktree-create-ref"),
    );
    expect(calls).not.toContain(
      'click://*[@data-slot="dialog-popup"]//button[normalize-space()="visual-held"]',
    );

    expect(calls).toContain('key:["Shift","F10"]');
    const commitImage =
      'click:[aria-label="Repository history"] [aria-label="Changed files"] button[data-changed-file-path="visual-swatch.png"]';
    expect(calls.indexOf("read-working-image-binary")).toBeLessThan(calls.indexOf(commitImage));
    expect(calls.indexOf(commitImage)).toBeLessThan(calls.indexOf("read-supported-commit-image"));
    expect(calls.indexOf("read-supported-commit-image")).toBeLessThan(
      calls.indexOf("read-actual-partial-stage"),
    );
    expect(calls.indexOf("read-actual-partial-stage")).toBeLessThan(
      calls.indexOf("capture:git-changes-diff"),
    );
    expect(calls).toContain('scroll:button[aria-label="Select stash stash@{11}"]');
    expect(result).toEqual({
      managedIdentityMatched: true,
      partialStageVerified: true,
      imageDiffInspected: true,
      dialogCancelled: true,
      draftRetained: true,
      noCommandExecuted: true,
      unpictured: ["git-image-diff", "files-context-menu", "workspace-terminal-and-other-chat"],
    });
  },
);

const partialAwaitCalls = [
  "changes-tab-displayed",
  "changes-tab-enabled",
  "changes-tab-click",
  "text-row-displayed",
  "text-row-enabled",
  "text-row-click",
  "first-run-displayed",
  "first-run-enabled",
  "first-run-click",
  "stage-submit-displayed",
  "stage-submit-enabled",
  "stage-submit-click",
  "index-proof",
  "index-read",
  "staged-area-displayed",
  "staged-area-enabled",
  "staged-area-click",
];

function partialAwaitReplay(failed?: string, observerThrows = false) {
  const source = NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "release-visual-core.ts"),
    "utf8",
  );
  const start = source.indexOf(
    "  const { browser, owner, step } = input;",
    source.indexOf("export async function runVisualCore"),
  );
  const end = source.indexOf("  const focus = async", start);
  const bodyStart = source.indexOf('  step("visual-partial-stage");', end);
  const bodyEnd = source.indexOf('  await capture("git-changes-diff");', bodyStart);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  const replay = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      "async function replay(input) {\n" +
        source.slice(start, end) +
        source.slice(bodyStart, bodyEnd) +
        "\n}\nreplay",
    ),
  ) as (input: unknown) => Promise<void>;
  const calls: string[] = [],
    phases: string[] = [];
  const error = new Error("Inert original partial-stage await failure.");
  const action = (operation: string) => {
    calls.push(operation);
    if (operation === failed) throw error;
  };
  const controls: Record<string, string> = {
    '//button[@role="tab" and normalize-space()="Changes"]': "changes-tab",
    '[role="option"][data-path="pierre-step5.ts"]': "text-row",
    'aside[aria-label="Partial staging selection gutter"] button[aria-label="Toggle changed-line run starting at line 1"]':
      "first-run",
    '//aside[@aria-label="Partial staging selection gutter"]//button[normalize-space()="Stage selected lines"]':
      "stage-submit",
    '//section[@aria-label="Diff for pierre-step5.ts"]//button[normalize-space()="Staged"]':
      "staged-area",
  };
  return {
    calls,
    phases,
    error,
    run: () =>
      replay({
        browser: {
          $: (selector: string) => {
            const control = controls[selector];
            expect(control).toBeDefined();
            return {
              waitForDisplayed: async () => action(control + "-displayed"),
              waitForEnabled: async () => action(control + "-enabled"),
              click: async () => action(control + "-click"),
            };
          },
        },
        owner: {
          until: async (read: () => Promise<boolean>) => {
            action("index-proof");
            expect(await read()).toBe(true);
          },
        },
        partialStageMatches: () => {
          action("index-read");
          return true;
        },
        step: (phase: string) => {
          phases.push(phase);
          if (observerThrows && phase.startsWith("visual-partial-stage-"))
            throw new Error("Inert optional attribution failure.");
        },
      }),
  };
}

describe("partial-stage last-await attribution", () => {
  it.each(partialAwaitCalls)(
    "preserves the original %s failure at its exact existing boundary",
    async (failed) => {
      const replay = partialAwaitReplay(failed, true);
      await expect(replay.run()).rejects.toBe(replay.error);
      expect(replay.calls).toEqual(
        partialAwaitCalls.slice(0, partialAwaitCalls.indexOf(failed) + 1),
      );
      expect(replay.phases.at(-1)).toBe(
        "visual-partial-stage-" + (failed === "index-read" ? "index-proof" : failed),
      );
    },
  );
  it.each([false, true])(
    "keeps original action order and success with throwing attribution=%s",
    async (throws) => {
      const replay = partialAwaitReplay(undefined, throws);
      await expect(replay.run()).resolves.toBeUndefined();
      expect(replay.calls).toEqual(partialAwaitCalls);
      expect(replay.phases[0]).toBe("visual-partial-stage");
      expect(replay.phases.at(-1)).toBe("visual-partial-stage-staged-area-click");
    },
  );
});
