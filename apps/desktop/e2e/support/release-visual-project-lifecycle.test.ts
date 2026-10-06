// @effect-diagnostics nodeBuiltinImport:off - Only immutable source JSON fixtures are read by hermetic QA tests.
import { describe, expect, it, vi } from "vite-plus/test";
import {
  lifecycleScreenshotName,
  projectLifecycleCapture,
  projectLifecycleAssertion,
  validateProjectLifecycleJoins,
  projectLifecycleScenes,
  runProjectLifecycleScene,
  validateProjectLifecycleWitness,
  createProjectLifecycleSourceJoins,
  createProjectLifecycleBrowserFlows,
  selectLifecycleCodexWorkspace,
  type ProjectLifecycleBrowserFlowInput,
  type ProjectLifecycleSourceJoinInput,
  type ProjectLifecycleFlowInput,
  type ProjectLifecycleScene,
} from "./release-visual-project-lifecycle.ts";
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeHttp from "node:http";
import { attach } from "webdriverio";
import { classifyQualificationFailure } from "./chat-upload-evidence.ts";

const common = {
  themeMatched: true,
  selectedMatched: true,
  expectedTextMatched: true,
  targetInView: true,
  credentialAbsent: true,
  bootShellAbsent: true,
};
const facts = {
  "worktree-remove-busy": {
    singleRemovalDialog: true,
    runningReason: true,
    destructiveDisabled: true,
    reasonLinked: true,
    checkoutIdentityMatched: true,
  },
  "project-clone-progress": {
    singleCloneForm: true,
    cloneRunning: true,
    cancelEnabled: true,
    inputsRetained: true,
    inputsDisabled: true,
  },
  "git-trust-refusal": {
    singleTrustAlert: true,
    quotedTrustCommand: true,
    retryEnabled: true,
    operationsDisabled: true,
    disabledReasons: true,
  },
};
const witness = (scene: ProjectLifecycleScene) => ({ ...common, ...facts[scene] });

describe("existing project lifecycle originals", () => {
  it("keeps exactly the three approved rows and fixed original names", () => {
    expect(projectLifecycleScenes).toEqual([
      "worktree-remove-busy",
      "project-clone-progress",
      "git-trust-refusal",
    ]);
    for (const scene of projectLifecycleScenes) {
      for (const theme of ["light", "dark"] as const) {
        expect(lifecycleScreenshotName(scene, theme)).toBe(`${scene}-${theme}.png`);
        const record = {
          scene,
          theme,
          file: `${scene}-${theme}.png`,
          witness: witness(scene),
          width: 1280,
          height: 960,
          nonBlank: true,
          sha256: "a".repeat(64),
        };
        expect(projectLifecycleCapture(record)).toEqual(record);
      }
    }
  });

  it.each(projectLifecycleScenes)(
    "refuses missing, false, foreign or active fields for %s",
    (scene) => {
      const valid = witness(scene);
      expect(validateProjectLifecycleWitness(scene, valid)).toEqual(valid);
      for (const key of Object.keys(valid)) {
        const missing = { ...valid } as Record<string, unknown>;
        delete missing[key];
        expect(() => validateProjectLifecycleWitness(scene, missing)).toThrow();
        expect(() => validateProjectLifecycleWitness(scene, { ...valid, [key]: false })).toThrow();
      }
      expect(() =>
        validateProjectLifecycleWitness(scene, { ...valid, privatePath: "inert" }),
      ).toThrow();
      const getter = vi.fn(() => true);
      const active = { ...valid };
      Object.defineProperty(active, "themeMatched", { enumerable: true, get: getter });
      expect(() => validateProjectLifecycleWitness(scene, active)).toThrow();
      expect(getter).not.toHaveBeenCalled();
      const trap = vi.fn();
      expect(() =>
        validateProjectLifecycleWitness(scene, new Proxy(valid, { ownKeys: trap })),
      ).toThrow();
      expect(trap).not.toHaveBeenCalled();
    },
  );

  it("refuses unknown rows, themes, dimensions, hashes and mismatched original names", () => {
    expect(() => lifecycleScreenshotName("other", "light")).toThrow();
    expect(() => lifecycleScreenshotName("worktree-remove-busy", "system")).toThrow();
    const record = {
      scene: "project-clone-progress",
      theme: "light",
      file: "project-clone-progress-light.png",
      witness: witness("project-clone-progress"),
      width: 1280,
      height: 960,
      nonBlank: true,
      sha256: "b".repeat(64),
    };
    for (const changed of [
      { width: 960 },
      { height: 800 },
      { file: "project-clone-progress-dark.png" },
      { sha256: "not-a-digest" },
      { nonBlank: false },
      { unrelated: true },
    ])
      expect(() => projectLifecycleCapture({ ...record, ...changed })).toThrow();
  });
});

function flow(scene: ProjectLifecycleScene) {
  const calls: string[] = [];
  const invoke = (name: string) =>
    vi.fn(async () => {
      calls.push(name);
    });
  const input = {
    scene,
    theme: "light" as "light" | "dark",
    verifyOwnedIdentity: invoke("identity"),
    step: (phase: string) => {
      calls.push(phase);
    },
    capture: invoke("capture"),
    busy: {
      openIdleRemovalDialog: invoke("busy-open-idle"),
      startHeldTurn: invoke("busy-start-owned-turn"),
      verifyRunningAndRefused: invoke("busy-real-source-refusal"),
      closeRemovalDialog: invoke("busy-close-publicly"),
      stopAndJoinTurn: invoke("busy-stop-and-join"),
      verifyCheckoutRetained: invoke("busy-retained-checkout"),
    },
    clone: {
      openAndSubmit: invoke("clone-public-submit"),
      verifySingleHeldTransfer: invoke("clone-real-transfer-source"),
      cancelPublicly: invoke("clone-public-cancel"),
      verifyCancelledAndJoined: invoke("clone-cancelled-and-joined"),
      verifyInputsAndOriginRetained: invoke("clone-inputs-and-origin-retained"),
    },
    trust: {
      selectOwnedGitManager: invoke("trust-public-select"),
      removeOwnedExemption: invoke("trust-private-policy-refusal"),
      refreshAndVerifyUntrusted: invoke("trust-real-server-status"),
      restoreOwnedExemption: invoke("trust-restore-private-policy"),
      refreshAndVerifyReadable: invoke("trust-restored-source"),
    },
  } satisfies ProjectLifecycleFlowInput;
  return { input, calls };
}

describe("genuine source/public action joins", () => {
  it("preserves the source adapter receiver for verification and joined cleanup", async () => {
    const { input } = flow("worktree-remove-busy");
    input.busy.verifyRunningAndRefused = vi.fn(async function (this: unknown) {
      expect(this).toBe(input.busy);
    });
    input.busy.stopAndJoinTurn = vi.fn(async function (this: unknown) {
      expect(this).toBe(input.busy);
    });
    await expect(runProjectLifecycleScene(input)).resolves.toMatchObject({ joinedCleanup: true });
  });
  it.each(["light", "dark"] as const)(
    "requires a live source proof around each %s original",
    async (theme) => {
      for (const scene of projectLifecycleScenes) {
        const { input, calls } = flow(scene);
        input.theme = theme;
        expect(await runProjectLifecycleScene(input)).toEqual({
          scene,
          theme,
          existingRowOnly: true,
          completeGroup: false,
          joinedCleanup: true,
        });
        const capture = calls.indexOf("capture");
        const proof = calls.indexOf(
          scene === "worktree-remove-busy"
            ? "busy-real-source-refusal"
            : scene === "project-clone-progress"
              ? "clone-real-transfer-source"
              : "trust-real-server-status",
        );
        expect(proof).toBeGreaterThan(0);
        expect(proof).toBeLessThan(capture);
        expect(calls[capture - 1]).toBe("identity");
        expect(calls[capture + 1]).toBe("identity");
      }
    },
  );

  it.each(projectLifecycleScenes)(
    "joins its admitted resource after failed capture in %s",
    async (scene) => {
      const { input, calls } = flow(scene);
      const original = new Error("Inert original capture refusal.");
      input.capture.mockRejectedValue(original);
      await expect(runProjectLifecycleScene(input)).rejects.toBe(original);
      const cleanup =
        scene === "worktree-remove-busy"
          ? "busy-stop-and-join"
          : scene === "project-clone-progress"
            ? "clone-cancelled-and-joined"
            : "trust-restore-private-policy";
      expect(calls).toContain(cleanup);
    },
  );

  it("stops an ambiguously admitted turn when start rejects and never captures it", async () => {
    const { input, calls } = flow("worktree-remove-busy");
    input.busy.startHeldTurn.mockRejectedValue(new Error("Inert starting failure."));
    await expect(runProjectLifecycleScene(input)).rejects.toThrow();
    expect(calls).toContain("busy-stop-and-join");
    expect(calls).not.toContain("capture");
  });

  it("does not return success after a cancellation/join or trust restoration failure", async () => {
    const clone = flow("project-clone-progress");
    clone.input.clone.verifyCancelledAndJoined.mockRejectedValue(new Error("Inert join failure."));
    await expect(runProjectLifecycleScene(clone.input)).rejects.toThrow();
    const trust = flow("git-trust-refusal");
    trust.input.trust.restoreOwnedExemption.mockRejectedValue(new Error("Inert restore failure."));
    await expect(runProjectLifecycleScene(trust.input)).rejects.toThrow();
  });

  it("refuses stale/foreign source before opening any public flow", async () => {
    const { input, calls } = flow("project-clone-progress");
    input.verifyOwnedIdentity.mockRejectedValue(new Error("Inert identity refusal."));
    await expect(runProjectLifecycleScene(input)).rejects.toThrow();
    expect(input.verifyOwnedIdentity).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
  });
});

function sourcePorts(scene: ProjectLifecycleScene) {
  const model = JSON.parse(
    NodeFS.readFileSync(
      new NodeURL.URL(
        "../../../../packages/contracts/fixtures/http-orchestration/full-read-model.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const before = {
    ...model.threads[0],
    id: "owned-thread",
    projectId: "owned-project",
    kind: scene === "worktree-remove-busy" ? "workspace" : "default",
    worktreePath: scene === "worktree-remove-busy" ? "/owned/managed" : null,
    branch: scene === "worktree-remove-busy" ? "codex/delivery-retry-light" : null,
    archivedAt: null,
    deletedAt: null,
    session: null,
    latestTurn: null,
    messages: [],
    activities: [],
    checkpoints: [],
    proposedPlans: [],
    modelSelection: { instanceId: "codex", model: "gpt-5.3-codex" },
  };
  let thread: Record<string, unknown> = before,
    trust = false,
    serial = 0;
  const now = model.updatedAt;
  const inputs: Array<{
    provider: "codex";
    kind: "start";
    prompt: string;
    turnId: string;
    recordedAt: string;
  }> = [];
  let settle!: (value: unknown) => void, fail!: (error: unknown) => void;
  const attached = new Promise((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // Retain the original promise while a missing implementation is under the RED counterfactual.
  void attached.catch(() => {});
  const destination = "/owned/clone-parent/lifecycle-origin";
  const fixture = {
    primaryCheckout: "/owned/primary",
    trustCheckout: "/owned/visual trust 'checkout",
    cloneUrl: "https://visual.invalid/lifecycle-origin.git",
    cloneParent: "/owned/clone-parent",
    verifyCloneConfiguration: vi.fn(async () => {}),
    heldTransferReady: vi.fn(async () => true),
    verifyHeldTransferOwner: vi.fn(async () => ({
      phase: "real-pack-held",
      forwardedBytes: 4096,
      totalBytes: 5000,
      packSha256: "a".repeat(64),
      delegateReaped: true,
    })),
    verifyHeldTransferReaped: vi.fn(async () => {}),
    verifyTrustRefusal: vi.fn(async () => {}),
    verifyTargetExemptionRemoved: vi.fn(async () => {}),
  };
  const input = {
    owner: {
      until: async (read: () => Promise<boolean>) => {
        if (!(await read())) throw new Error("Inert expected source observation missing.");
      },
    },
    binding: {
      scene,
      theme: "light",
      origin: "http://127.0.0.1:4885",
      projectId: "owned-project",
      threadId: "owned-thread",
      cwd:
        scene === "git-trust-refusal"
          ? fixture.trustCheckout
          : scene === "project-clone-progress"
            ? fixture.primaryCheckout
            : "/owned/managed",
      branch: scene === "worktree-remove-busy" ? before.branch : "main",
      title: "Owned workspace",
      cloneUrl: fixture.cloneUrl,
      cloneParent: fixture.cloneParent,
    },
    fixture,
    serverPid: 42,
    rpc: {
      snapshot: vi.fn(async () => ({
        ...model,
        threads: [thread],
        projects: [
          {
            ...model.projects[0],
            id: "owned-project",
            deletedAt: null,
            workspaceRoot: scene === "git-trust-refusal" ? fixture.trustCheckout : "/owned/primary",
          },
        ],
      })),
      dispatch: vi.fn(async (command: Record<string, unknown>) => {
        if (command.type === "thread.turn.start") {
          const message = command.message as { messageId: string; text: string };
          inputs.push({
            provider: "codex",
            kind: "start",
            prompt: message.text,
            turnId: "owned-turn",
            recordedAt: now,
          });
          thread = {
            ...before,
            session: {
              threadId: before.id,
              providerName: "codex",
              providerInstanceId: "codex",
              status: "running",
              runtimeMode: "full-access",
              activeTurnId: "owned-turn",
              lastError: null,
              updatedAt: now,
            },
            latestTurn: {
              turnId: "owned-turn",
              state: "running",
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              assistantMessageId: null,
            },
            messages: [
              {
                id: message.messageId,
                turnId: null,
                role: "user",
                text: message.text,
                attachments: [],
                streaming: false,
                createdAt: now,
                updatedAt: now,
                delivery: {
                  state: "delivered",
                  provider: "codex",
                  providerInstanceId: "codex",
                  mode: "start",
                },
              },
            ],
          };
        } else
          thread = {
            ...thread,
            session: {
              ...(thread.session as Record<string, unknown>),
              status: "stopped",
              activeTurnId: null,
            },
            latestTurn: {
              ...(thread.latestTurn as Record<string, unknown>),
              state: "interrupted",
              completedAt: now,
            },
          };
        return { sequence: 1 };
      }),
      removalPlan: vi.fn(async () => ({
        planToken: "owned-plan",
        generation: 1,
        availability: "present",
        registered: true,
        locked: false,
        trackedChangeCount: 0,
        untrackedFileCount: 0,
        pruneImpact: [],
      })),
      remove: vi.fn(async () => {
        throw {
          _tag: "WorktreeRemovalError",
          reason: "session-running",
          message: "Owned session is running.",
        };
      }),
      attachClone: vi.fn(() => attached),
      refreshStatus: vi.fn(async () => ({
        isRepo: !trust,
        repositoryUnavailableReason: trust ? "untrusted" : undefined,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        pr: null,
      })),
    },
    newCommandId: () => "owned-command-" + ++serial,
    nowIsoDate: () => now,
    readNativeInputs: () => inputs,
    verifyProviderLive: vi.fn(async () => {}),
    verifyProviderReaped: vi.fn(async () => {}),
    verifyCheckoutRetained: vi.fn(async () => {}),
    verifyFixtureInputsRetained: vi.fn(async () => {}),
    verifyServerOwned: vi.fn(async () => {}),
  };
  return {
    input: input as unknown as ProjectLifecycleSourceJoinInput,
    raw: input,
    settle,
    fail,
    destination,
    setTrust: (value: boolean) => {
      trust = value;
    },
    foreign: () => {
      thread = { ...thread, projectId: "foreign-project" };
    },
  };
}

it("joins the actual typed start/native input/live removal refusal and stopped provider", async () => {
  const { input, raw } = sourcePorts("worktree-remove-busy"),
    join = createProjectLifecycleSourceJoins(input);
  await join.startHeldTurn();
  await join.verifyRunningAndRefused();
  await join.verifyRunningAndRefused();
  expect(raw.rpc.remove).toHaveBeenCalledTimes(1);
  expect(raw.rpc.remove).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: "owned-project",
      threadId: "owned-thread",
      mode: "delete-git-worktree",
      expectedGeneration: 1,
      planToken: "owned-plan",
      forceDirty: false,
      confirmRepositoryWidePrune: false,
    }),
  );
  await join.stopAndJoinTurn();
  expect(raw.verifyProviderLive).toHaveBeenCalled();
  expect(raw.verifyProviderReaped).toHaveBeenCalledOnce();
});
it("rejects a foreign or nonlive busy source before any removal request", async () => {
  const { input, raw, foreign } = sourcePorts("worktree-remove-busy"),
    join = createProjectLifecycleSourceJoins(input);
  foreign();
  await expect(join.startHeldTurn()).rejects.toThrow();
  expect(raw.rpc.dispatch).not.toHaveBeenCalled();
  expect(raw.rpc.remove).not.toHaveBeenCalled();
});
it("joins only the exact active clone and requires its typed public cancelled terminal outcome", async () => {
  const { input, raw, fail, destination } = sourcePorts("project-clone-progress"),
    join = createProjectLifecycleSourceJoins(input);
  await join.verifySingleHeldTransfer();
  expect(raw.rpc.attachClone).toHaveBeenCalledExactlyOnceWith({
    url: input.fixture.cloneUrl,
    parentDir: input.fixture.cloneParent,
    attach: true,
  });
  await join.verifySingleHeldTransfer();
  expect(raw.rpc.attachClone).toHaveBeenCalledOnce();
  fail({
    _tag: "GitCloneOperationError",
    reason: "cancelled",
    destination,
    message: "Owned clone cancelled.",
  });
  await join.verifyCancelledAndJoined();
  expect(raw.fixture.verifyHeldTransferReaped).toHaveBeenCalledOnce();
  expect(raw.verifyFixtureInputsRetained).toHaveBeenCalled();
});
it("refuses an absent join-only clone and a foreign terminal destination without starting a transfer", async () => {
  const first = sourcePorts("project-clone-progress"),
    join = createProjectLifecycleSourceJoins(first.input);
  first.fail({
    _tag: "GitCloneOperationError",
    reason: "not-in-progress",
    destination: first.destination,
    message: "Owned clone absent.",
  });
  await expect(join.verifySingleHeldTransfer()).rejects.toThrow();
  expect(first.raw.rpc.attachClone).toHaveBeenCalledExactlyOnceWith({
    url: first.input.fixture.cloneUrl,
    parentDir: first.input.fixture.cloneParent,
    attach: true,
  });
  const second = sourcePorts("project-clone-progress"),
    other = createProjectLifecycleSourceJoins(second.input);
  await other.verifySingleHeldTransfer();
  second.fail({
    _tag: "GitCloneOperationError",
    reason: "cancelled",
    destination: "/owned/foreign",
    message: "Owned inert foreign outcome.",
  });
  await expect(other.verifyCancelledAndJoined()).rejects.toThrow();
  expect(second.raw.fixture.verifyHeldTransferReaped).not.toHaveBeenCalled();
});
it("requires protected target refusal plus decoded server Git state without a standalone forced-ownership command", async () => {
  const { input, raw, setTrust } = sourcePorts("git-trust-refusal"),
    join = createProjectLifecycleSourceJoins(input);
  setTrust(true);
  await join.refreshAndVerifyUntrusted();
  expect(raw.fixture.verifyTrustRefusal).not.toHaveBeenCalled();
  expect(raw.fixture.verifyTargetExemptionRemoved).toHaveBeenCalledOnce();
  expect(raw.rpc.refreshStatus).toHaveBeenCalledExactlyOnceWith({
    cwd: input.fixture.trustCheckout,
  });
  setTrust(false);
  await join.refreshAndVerifyReadable();
  expect(raw.verifyFixtureInputsRetained).toHaveBeenCalled();
});

function browserFlow(scene: ProjectLifecycleScene, count = 1) {
  const calls: string[] = [],
    values = new Map<string, string>();
  const initial = sourcePorts(scene),
    source = Object.fromEntries(
      [
        "verifyIdleRemovalContext",
        "startHeldTurn",
        "verifyRunningAndRefused",
        "stopAndJoinTurn",
        "verifySingleHeldTransfer",
        "verifyCancelledAndJoined",
        "refreshAndVerifyUntrusted",
        "refreshAndVerifyReadable",
        "verifyCheckoutRetained",
        "verifyFixtureInputsRetained",
      ].map((name) => [
        name,
        vi.fn(async () => {
          calls.push(name);
        }),
      ]),
    );
  let dialog = false;
  const browser = {
    $: (selector: string) => ({
      waitForDisplayed: async () => {},
      waitForEnabled: async () => {},
      waitForExist: async () => {},
      isFocused: async () => true,
      isExisting: async () => dialog,
      isDisplayed: async () => dialog,
      isEnabled: async () => true,
      getValue: async () => values.get(selector) ?? "",
      getAttribute: async () => null,
      setValue: async (value: string) => {
        values.set(selector, value);
        calls.push("fill");
      },
      click: async (options?: unknown) => {
        calls.push(options ? "context-menu" : "click:" + selector);
        if (selector.includes("Delete Worktree") || selector.includes('normalize-space()="Clone"'))
          dialog = true;
        if (selector.includes("Cancel")) dialog = false;
      },
    }),
    $$: async () => ({ length: Promise.resolve(count) }),
    keys: async (value: unknown) => {
      calls.push("key:" + String(value));
    },
  };
  const fixture = {
    ...initial.raw.fixture,
    setTargetTrust: vi.fn(async (target: string, allow: boolean) => {
      expect(target).toBe(initial.raw.fixture.trustCheckout);
      calls.push(allow ? "restore-exemption" : "remove-exemption");
    }),
  };
  const input = {
    browser,
    owner: {
      until: async (read: () => Promise<boolean>) => {
        expect(await read()).toBe(true);
      },
    },
    binding:
      scene === "git-trust-refusal"
        ? { ...initial.input.binding, title: "visual trust 'checkout" }
        : initial.input.binding,
    fixture,
    source,
    verifyOwnedIdentity: vi.fn(async () => {
      calls.push("identity");
    }),
    selectTrustProject: vi.fn(async () => {
      calls.push("public-trust-select");
    }),
  };
  return {
    input: input as unknown as ProjectLifecycleBrowserFlowInput,
    calls,
    source,
    fixture,
    values,
  };
}
it("opens only the idle actual removal menu/dialog and never clicks destructive deletion", async () => {
  const { input, calls, source } = browserFlow("worktree-remove-busy"),
    flow = createProjectLifecycleBrowserFlows(input);
  await flow.busy.openIdleRemovalDialog();
  await flow.busy.startHeldTurn();
  await flow.busy.verifyRunningAndRefused();
  await flow.busy.closeRemovalDialog();
  await flow.busy.stopAndJoinTurn();
  expect(source.verifyIdleRemovalContext).toHaveBeenCalled();
  expect(source.startHeldTurn).toHaveBeenCalledOnce();
  expect(source.stopAndJoinTurn).toHaveBeenCalledOnce();
  expect(calls.some((x) => x.includes("Delete Worktree"))).toBe(true);
  expect(
    calls.some((x) => x.includes("Delete Git worktree and remove") && x.startsWith("click:")),
  ).toBe(false);
});
it("submits exactly one public owned clone and joins public Cancel with retained inputs", async () => {
  const { input, calls, source } = browserFlow("project-clone-progress"),
    flow = createProjectLifecycleBrowserFlows(input);
  await flow.clone.openAndSubmit();
  await flow.clone.verifySingleHeldTransfer();
  await flow.clone.cancelPublicly();
  await flow.clone.verifyCancelledAndJoined();
  await flow.clone.verifyInputsAndOriginRetained();
  expect(calls.filter((x) => x.includes('normalize-space()="Clone"'))).toHaveLength(1);
  expect(calls.filter((x) => x.includes("Cancel clone"))).toHaveLength(1);
  expect(source.verifyCancelledAndJoined).toHaveBeenCalledOnce();
  expect(source.verifyFixtureInputsRetained).toHaveBeenCalled();
});
it("selects the owned public Git context and restores only the target exemption", async () => {
  const { input, calls, source, fixture } = browserFlow("git-trust-refusal"),
    flow = createProjectLifecycleBrowserFlows(input);
  await flow.trust.selectOwnedGitManager();
  await flow.trust.removeOwnedExemption();
  await flow.trust.refreshAndVerifyUntrusted();
  await flow.trust.restoreOwnedExemption();
  await flow.trust.refreshAndVerifyReadable();
  expect(calls).toContain("public-trust-select");
  expect(fixture.setTargetTrust).toHaveBeenNthCalledWith(1, input.fixture.trustCheckout, false);
  expect(fixture.setTargetTrust).toHaveBeenNthCalledWith(2, input.fixture.trustCheckout, true);
  expect(source.refreshAndVerifyUntrusted).toHaveBeenCalledOnce();
  expect(source.refreshAndVerifyReadable).toHaveBeenCalledOnce();
});

it("refuses malformed/proxy public snapshots and never starts an owned turn from them", async () => {
  for (const mode of ["proxy", "getter", "malformed"]) {
    const { input, raw } = sourcePorts("worktree-remove-busy"),
      reads = vi.fn();
    const value =
      mode === "proxy"
        ? new Proxy({}, { ownKeys: reads })
        : mode === "getter"
          ? Object.defineProperty({}, "threads", { enumerable: true, get: reads })
          : {};
    raw.rpc.snapshot.mockResolvedValue(value as never);
    const source = createProjectLifecycleSourceJoins(input);
    await expect(source.startHeldTurn()).rejects.toThrow();
    expect(reads).not.toHaveBeenCalled();
    expect(raw.rpc.dispatch).not.toHaveBeenCalled();
  }
});
it("refuses a nonlive owned provider before attempting real worktree removal", async () => {
  const { input, raw } = sourcePorts("worktree-remove-busy"),
    source = createProjectLifecycleSourceJoins(input);
  await source.startHeldTurn();
  raw.verifyProviderLive.mockRejectedValue(new Error("Inert owned provider gone."));
  await expect(source.verifyRunningAndRefused()).rejects.toThrow();
  expect(raw.rpc.remove).not.toHaveBeenCalled();
});
it("never admits successful removal or an unrelated server refusal as busy retention", async () => {
  for (const mode of ["success", "other-reason"]) {
    const { input, raw } = sourcePorts("worktree-remove-busy"),
      source = createProjectLifecycleSourceJoins(input);
    await source.startHeldTurn();
    if (mode === "success") raw.rpc.remove.mockResolvedValue(undefined as never);
    else
      raw.rpc.remove.mockRejectedValue({
        _tag: "WorktreeRemovalError",
        reason: "stale-plan",
        message: "Inert stale plan.",
      });
    await expect(source.verifyRunningAndRefused()).rejects.toThrow();
    await source.stopAndJoinTurn();
    expect(raw.verifyProviderReaped).toHaveBeenCalledOnce();
  }
});
it("refuses a completed rather than publicly cancelled clone and a foreign clone context", async () => {
  const first = sourcePorts("project-clone-progress"),
    source = createProjectLifecycleSourceJoins(first.input);
  await source.verifySingleHeldTransfer();
  first.settle({ path: first.destination });
  await expect(source.verifyCancelledAndJoined()).rejects.toThrow();
  const second = sourcePorts("project-clone-progress");
  second.foreign();
  const foreign = createProjectLifecycleSourceJoins(second.input);
  await expect(foreign.verifySingleHeldTransfer()).rejects.toThrow();
  expect(second.raw.rpc.attachClone).not.toHaveBeenCalled();
});

it.each(projectLifecycleScenes.flatMap((scene) => [0, 2].map((count) => ({ scene, count }))))(
  "refuses public $scene control cardinality $count through the WebdriverIO promised length",
  async ({ scene, count }) => {
    const { input, calls, source } = browserFlow(scene, count),
      flow = createProjectLifecycleBrowserFlows(input);
    const action =
      scene === "worktree-remove-busy"
        ? () => flow.busy.openIdleRemovalDialog()
        : scene === "project-clone-progress"
          ? () => flow.clone.openAndSubmit()
          : () => flow.trust.selectOwnedGitManager();
    await expect(action()).rejects.toThrow();
    expect(calls.some((call) => call.startsWith("click:") || call === "key:Enter")).toBe(false);
    expect(source.startHeldTurn).not.toHaveBeenCalled();
    expect(source.verifySingleHeldTransfer).not.toHaveBeenCalled();
  },
);

it("joins only three closed row proofs per theme and exactly six standard original captures", () => {
  const assertions = ["light", "dark"].map((theme) =>
      projectLifecycleAssertion(
        theme,
        projectLifecycleScenes.map((scene) => ({
          scene,
          theme,
          existingRowOnly: true,
          completeGroup: false,
          joinedCleanup: true,
        })),
      ),
    ),
    captures = ["light", "dark"].flatMap((theme) =>
      projectLifecycleScenes.map((scene) => ({
        scene,
        theme,
        file: lifecycleScreenshotName(scene, theme),
        witness: { ...common, ...facts[scene] },
        width: 1280,
        height: 960,
        nonBlank: true,
        sha256: "a".repeat(64),
      })),
    );
  expect(validateProjectLifecycleJoins(captures, assertions)).toEqual({
    existingRowsOnly: true,
    completeGroup: false,
    originalCount: 6,
  });
  for (const bad of [
    captures.slice(1),
    [...captures, captures[0]],
    captures.map((value, index) => (index === 0 ? { ...value, width: 960 } : value)),
  ])
    expect(() => validateProjectLifecycleJoins(bad, assertions)).toThrow();
  for (const bad of [assertions.slice(1), [...assertions, assertions[0]]])
    expect(() => validateProjectLifecycleJoins(captures, bad)).toThrow();
});
it.each([
  "missing",
  "duplicate",
  "other-theme",
  "cleanup-pending",
  "complete-group",
  "extra-field",
])("refuses %s lifecycle row closure", (mode) => {
  const rows = projectLifecycleScenes.map((scene) => ({
    scene,
    theme: "light",
    existingRowOnly: true,
    completeGroup: false,
    joinedCleanup: true,
  }));
  if (mode === "missing") rows.pop();
  if (mode === "duplicate") rows[2] = rows[0]!;
  if (mode === "other-theme") rows[0]!.theme = "dark";
  if (mode === "cleanup-pending") rows[0]!.joinedCleanup = false;
  if (mode === "complete-group") rows[0]!.completeGroup = true;
  const input =
    mode === "extra-field"
      ? rows.map((value, index) => (index === 0 ? { ...value, path: "inert-private" } : value))
      : rows;
  expect(() => projectLifecycleAssertion("light", input)).toThrow();
});

it("uses the actual public Codex model controls only while the decoded owned workspace is empty", async () => {
  const fixture = sourcePorts("worktree-remove-busy"),
    before = await fixture.raw.rpc.snapshot(),
    calls: string[] = [];
  const after = structuredClone(before);
  after.threads[0].modelSelection = { instanceId: "codex", model: "gpt-5.4" };
  let selected = false;
  const input = {
    browser: {
      $$: async () => ({ length: Promise.resolve(1) }),
      $: (selector: string) => ({
        waitForDisplayed: async () => {},
        waitForEnabled: async () => {},
        click: async () => {
          calls.push(selector);
          if (selector.includes('data-model-picker-instance-id="codex"')) selected = true;
        },
        getAttribute: async () => (selected ? "Codex · GPT-5.4" : "Claude · Opus 5"),
      }),
    },
    owner: { until: async (read: () => Promise<boolean>) => expect(await read()).toBe(true) },
    readSnapshot: async () => (selected ? after : before),
    projectPath: fixture.input.fixture.primaryCheckout,
    threadId: fixture.input.binding.threadId,
    cwd: fixture.input.binding.cwd,
    branch: fixture.input.binding.branch,
    verifyOwnedIdentity: vi.fn(async () => {}),
    step: () => {},
  };
  await selectLifecycleCodexWorkspace(
    input as unknown as Parameters<typeof selectLifecycleCodexWorkspace>[0],
  );
  expect(calls).toHaveLength(2);
  expect(calls[1]).toContain('data-model-picker-instance-id="codex"');
  expect(input.verifyOwnedIdentity).toHaveBeenCalled();
});
it.each(["history", "session", "foreign-project", "duplicate", "foreign-branch"])(
  "refuses %s workspace before the first model control action",
  async (mode) => {
    const f = sourcePorts("worktree-remove-busy"),
      model = await f.raw.rpc.snapshot();
    if (mode === "history")
      model.threads[0].messages = [
        {
          id: "stale",
          role: "user",
          text: "Old message",
          turnId: null,
          streaming: false,
          attachments: [],
          createdAt: model.updatedAt,
          updatedAt: model.updatedAt,
        },
      ];
    if (mode === "session")
      model.threads[0].session = {
        threadId: model.threads[0].id,
        providerName: "codex",
        providerInstanceId: "codex",
        status: "ready",
        activeTurnId: null,
        lastError: null,
        runtimeMode: "full-access",
        updatedAt: model.updatedAt,
      };
    if (mode === "foreign-project") model.projects[0].workspaceRoot = "/owned/foreign";
    if (mode === "duplicate") model.threads.push({ ...model.threads[0] });
    if (mode === "foreign-branch") model.threads[0].branch = "foreign";
    const click = vi.fn(async () => {}),
      input = {
        browser: {
          $: () => ({ waitForDisplayed: async () => {}, waitForEnabled: async () => {}, click }),
          $$: async () => ({ length: Promise.resolve(1) }),
        },
        owner: { until: async () => {} },
        readSnapshot: async () => model,
        projectPath: f.input.fixture.primaryCheckout,
        threadId: f.input.binding.threadId,
        cwd: f.input.binding.cwd,
        branch: f.input.binding.branch,
        verifyOwnedIdentity: async () => {},
        step: () => {},
      };
    await expect(
      selectLifecycleCodexWorkspace(
        input as unknown as Parameters<typeof selectLifecycleCodexWorkspace>[0],
      ),
    ).rejects.toThrow();
    expect(click).not.toHaveBeenCalled();
  },
);

it("waits boundedly for the actual held pack before sending the join-only request", async () => {
  const f = sourcePorts("project-clone-progress");
  f.raw.fixture.heldTransferReady.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const until = vi.fn(async (read: () => Promise<boolean>) => {
    expect(await read()).toBe(false);
    expect(f.raw.rpc.attachClone).not.toHaveBeenCalled();
    expect(await read()).toBe(true);
  });
  const source = createProjectLifecycleSourceJoins({ ...f.input, owner: { until } });
  await source.verifySingleHeldTransfer();
  expect(until).toHaveBeenCalledOnce();
  expect(f.raw.rpc.attachClone).toHaveBeenCalledOnce();
});
it("refuses a missing or malformed held pack without sending any clone request", async () => {
  for (const mode of ["missing", "malformed"]) {
    const f = sourcePorts("project-clone-progress");
    if (mode === "missing") f.raw.fixture.heldTransferReady.mockResolvedValue(false);
    else
      f.raw.fixture.heldTransferReady.mockRejectedValue(new Error("Inert malformed pack proof."));
    const source = createProjectLifecycleSourceJoins(f.input);
    await expect(source.verifySingleHeldTransfer()).rejects.toThrow();
    expect(f.raw.rpc.attachClone).not.toHaveBeenCalled();
  }
});

/** Installed Classic SDK on an inert protocol port; no browser, provider or app is launched. */
async function attachLifecycleSelectorPort() {
  const selectors: Array<{ using: string; value: string }> = [];
  let dialogOpen = true,
    cancellationClicks = 0;
  const server = NodeHttp.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      const payload = raw ? JSON.parse(raw) : {};
      const url = request.url ?? "";
      if (url.endsWith("/window")) {
        response.end(JSON.stringify({ value: "owned-inert-window" }));
        return;
      }
      if (url.endsWith("/element") || url.endsWith("/elements")) {
        selectors.push({ using: payload.using, value: payload.value });
        if (payload.using === "css selector" && payload.value.includes(" button=")) {
          response.statusCode = 400;
          response.end(
            JSON.stringify({
              value: {
                error: "invalid selector",
                message: "Inert invalid CSS selector.",
                stacktrace: "",
              },
            }),
          );
          return;
        }
        const element = { "element-6066-11e4-a52e-4f735466cecf": "owned-inert-control" };
        response.end(
          JSON.stringify({
            value: url.endsWith("/elements") ? (dialogOpen ? [element] : []) : element,
          }),
        );
        return;
      }
      if (url.endsWith("/click")) {
        if (selectors.at(-1)?.value.includes('normalize-space()="Cancel')) {
          dialogOpen = false;
          cancellationClicks++;
        }
        response.end(JSON.stringify({ value: null }));
        return;
      }
      if (["/displayed", "/enabled", "/execute/sync"].some((suffix) => url.endsWith(suffix))) {
        response.end(JSON.stringify({ value: dialogOpen }));
        return;
      }
      response.end(JSON.stringify({ value: null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Inert protocol address refused.");
  try {
    const browser = await attach({
      sessionId: "owned-inert-session",
      capabilities: {
        browserName: "chrome",
        webSocketUrl: false,
        "wdio:enforceWebDriverClassic": true,
      },
      hostname: "127.0.0.1",
      port: address.port,
      logLevel: "silent",
      connectionRetryCount: 0,
      transformRequest: (options: RequestInit) => {
        const headers = new Headers(options.headers);
        headers.delete("Content-Length");
        return { ...options, headers };
      },
      options: { waitforTimeout: 20, waitforInterval: 1 },
    });
    return {
      browser,
      selectors,
      cancellationClicks: () => cancellationClicks,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  } catch (error) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}
it.each(["ordinary", "original-error"] as const)(
  "uses real SDK scoped dialog buttons and preserves the original failure: %s",
  async (mode) => {
    const port = await attachLifecycleSelectorPort(),
      f = browserFlow("worktree-remove-busy");
    const original = new Error("Inert original running-source refusal."),
      cleanup: string[] = [];
    const running = vi.fn(async () => {
      if (mode === "original-error") throw original;
    });
    const start = vi.fn(async () => {}),
      stop = vi.fn(async () => {});
    try {
      const flows = createProjectLifecycleBrowserFlows({
        ...f.input,
        browser: port.browser,
        source: {
          ...f.input.source,
          startHeldTurn: start,
          stopAndJoinTurn: stop,
          verifyRunningAndRefused: running,
        },
      });
      const execute = runProjectLifecycleScene({
        scene: "worktree-remove-busy",
        theme: "light",
        verifyOwnedIdentity: f.input.verifyOwnedIdentity,
        step: () => {},
        ...flows,
        capture: async () => {},
        observeCleanupFailure: (role) => cleanup.push(role),
      });
      if (mode === "ordinary")
        await expect(execute).resolves.toMatchObject({ joinedCleanup: true });
      else await expect(execute).rejects.toBe(original);
      expect(start).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
      expect(cleanup).toEqual([]);
      expect(port.cancellationClicks()).toBe(1);
      expect(
        port.selectors.some(
          (value) => value.using === "css selector" && value.value.includes(" button="),
        ),
      ).toBe(false);
      for (const label of ["Delete Git worktree and remove", "Cancel"]) {
        expect(
          port.selectors.some(
            (value) =>
              value.using === "xpath" &&
              value.value ===
                '//*[@data-slot="dialog-popup" and @role="dialog"]//button[normalize-space()="' +
                  label +
                  '"]',
          ),
        ).toBe(true);
      }
    } finally {
      await port.close();
    }
  },
);
it("uses the actual SDK scoped clone cancellation and keeps invalid-selector attribution closed", async () => {
  const port = await attachLifecycleSelectorPort(),
    f = browserFlow("project-clone-progress");
  try {
    const flows = createProjectLifecycleBrowserFlows({ ...f.input, browser: port.browser });
    await flows.clone.cancelPublicly();
    expect(port.cancellationClicks()).toBe(1);
    expect(
      port.selectors.some(
        (value) =>
          value.using === "xpath" &&
          value.value ===
            '//*[@data-slot="dialog-popup" and @role="dialog"]//button[normalize-space()="Cancel clone"]',
      ),
    ).toBe(true);
    await expect(
      port.browser.findElement(
        "css selector",
        '[data-slot="dialog-popup"][role="dialog"] button=Cancel',
      ),
    ).rejects.toMatchObject({ name: "invalid selector" });
    const error = await port.browser
      .findElement("css selector", '[data-slot="dialog-popup"][role="dialog"] button=Cancel')
      .catch((failure: unknown) => failure);
    expect(classifyQualificationFailure(error)).toMatchObject({
      kind: "unclassified",
      errorClass: null,
    });
  } finally {
    await port.close();
  }
});
