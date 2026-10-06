// @effect-diagnostics nodeBuiltinImport:off - Public schemas and inert snapshots only.
import * as NodeModule from "node:module";
import { OrchestrationReadModel } from "../../../../packages/contracts/src/orchestration.ts";
import { expect, it } from "vite-plus/test";
import {
  qualifiedProviderChatScenes,
  readProviderChatBinding,
  validateProviderChatJoins,
  runProviderChatVisual,
  type ProviderChatProducerInput,
} from "./release-visual-provider-chat-producer.ts";
import type { ProviderChatNativeInput } from "./release-visual-provider-chat-turns.ts";
import { readVisualViewport } from "./release-visual-observation.ts";
import {
  projectProviderChatCapture,
  providerChatScreenshotName,
  providerChatViewport,
} from "./release-visual-provider-chat.ts";
const Schema = NodeModule.createRequire(
  new URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
const time = "2026-10-05T00:00:00.000Z";
const workspace = {
  path: "/owned/managed",
  branch: "codex/delivery-retry-light",
  commonDirectory: "/owned/project/.git",
};
function snapshot(mode = "valid"): OrchestrationReadModel {
  const host = {
    id: "host",
    projectId: "project",
    title: "Host",
    kind: "workspace",
    branch: workspace.branch,
    worktreePath: workspace.path,
    modelSelection: { instanceId: "claudeAgent", model: "opus" },
    runtimeMode: "full-access",
    latestTurn: null,
    createdAt: time,
    updatedAt: time,
    deletedAt: null,
    messages: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
  const panel = {
    ...host,
    id: "panel",
    title: "Panel",
    kind: "panel",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  };
  return Schema.decodeUnknownSync(OrchestrationReadModel)({
    snapshotSequence: 0,
    updatedAt: time,
    projects: [
      {
        id: "project",
        title: "Owned",
        workspaceRoot: "/owned/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: time,
        updatedAt: time,
        deletedAt: mode === "deleted-project" ? time : null,
      },
    ],
    threads: [
      host,
      {
        ...panel,
        ...(mode === "foreign-path" ? { worktreePath: "/foreign" } : {}),
        ...(mode === "wrong-kind" ? { kind: "workspace" } : {}),
        ...(mode === "foreign-provider"
          ? { modelSelection: { instanceId: "claudeAgent", model: "opus" } }
          : {}),
        ...(mode === "deleted-panel" ? { deletedAt: time } : {}),
      },
      ...(mode === "duplicate" ? [panel] : []),
    ],
  });
}
const binding = (model = snapshot()) =>
  readProviderChatBinding({
    snapshot: model,
    hostThreadId: "host",
    targetThreadId: "panel",
    projectPath: "/owned/project",
    workspace,
    provider: "codex",
  });
it("admits one decoded host and publicly created Codex panel on the exact managed identity", () => {
  expect(binding()).toMatchObject({
    host: { id: "host", kind: "workspace" },
    target: { id: "panel", kind: "panel" },
  });
});
/** Inert browser/public snapshot ports run the actual producer; they do not qualify rendered pixels. */
function caller(mode = "valid") {
  let model: OrchestrationReadModel = Schema.decodeUnknownSync(OrchestrationReadModel)({
    ...snapshot(),
    threads: [snapshot().threads[0]],
  });
  let active = "host",
    draft = "",
    armed = false,
    changed = false,
    serial = 0,
    unsafe = 0;
  let dimensions = { width: 1280, height: 960 };
  const inputs: ProviderChatNativeInput[] = [],
    captures: string[] = [],
    actions: string[] = [];
  const update = (
    id: string,
    change: (value: OrchestrationReadModel["threads"][number]) => object,
  ) => {
    model = Schema.decodeUnknownSync(OrchestrationReadModel)({
      ...model,
      threads: model.threads.map((value) => (value.id === id ? change(value) : value)),
    });
  };
  const get = () => model.threads.find((value) => value.id === active)!;
  const browser = {
    $$: () => ({ length: 1 }),
    $: (selector: string) => ({
      waitForDisplayed: async () => {},
      waitForEnabled: async () => {},
      moveTo: async () => {},
      isDisplayed: async () => false,
      getText: async () => draft,
      click: async () => {
        actions.push(selector);
        if (selector.includes('normalize-space()="Codex"'))
          model = Schema.decodeUnknownSync(OrchestrationReadModel)({
            ...model,
            threads: [
              ...model.threads,
              snapshot(mode === "foreign-panel" ? "foreign-path" : "valid").threads[1],
            ],
          });
        if (selector.includes("chat:panel") && selector.includes("tab-activation"))
          active = "panel";
        if (selector.includes("thread-card-button-host")) active = "host";
        if (selector.includes('aria-label^="Close "'))
          update("panel", (value) => ({ ...value, deletedAt: time }));
        if (selector.includes("data-queued-message-cancel")) {
          const current = get(),
            queued = current.messages.find((value) => value.delivery?.state === "queued")!;
          draft = queued.text;
          update(active, (value) => ({
            ...value,
            messages: value.messages.filter((message) => message.id !== queued.id),
          }));
        }
        if (selector.includes("Dismiss and skip"))
          update(active, (value) => ({
            ...value,
            messages: value.messages.map((message) =>
              message.delivery?.reason === "modelSelectionRefused"
                ? {
                    ...message,
                    delivery: { ...message.delivery, state: "dismissed", reason: undefined },
                  }
                : message,
            ),
          }));
        if (selector.includes("Send message")) {
          const prompt = draft;
          draft = "";
          const current = get(),
            instance = current.modelSelection.instanceId,
            id = "message-" + ++serial,
            turnId = "native-" + serial;
          if (instance !== "codex" && instance !== "claudeAgent")
            throw new Error("Inert provider refused.");
          const provider = instance === "codex" ? "codex" : "claudeAgent";
          const held = prompt.includes("[[slow]]"),
            queued = prompt.startsWith("Owned visual message waiting"),
            failed = armed && !queued;
          const message = {
            id,
            role: "user",
            text: prompt,
            turnId: failed || queued ? null : turnId,
            streaming: false,
            createdAt: time,
            updatedAt: time,
            delivery: {
              state: failed ? "failed" : queued ? "queued" : "delivered",
              provider,
              providerInstanceId: provider,
              mode: "start",
              ...(failed ? { reason: "modelSelectionRefused" } : {}),
            },
          };
          const assistant = {
            id: "assistant-" + serial,
            role: "assistant",
            text: "BiBCode deterministic streamed fixture response.",
            turnId,
            streaming: held,
            createdAt: time,
            updatedAt: time,
          };
          if (!failed && !queued)
            inputs.push({ provider, kind: "start", prompt, turnId, recordedAt: time });
          if (mode === "native-mismatch" && held)
            inputs[inputs.length - 1] = { ...inputs[inputs.length - 1]!, turnId: "foreign-native" };
          if (prompt === "Owned visual markdown and plan") changed = true;
          update(active, (value) => ({
            ...value,
            messages: [...value.messages, message, ...(!failed && !queued ? [assistant] : [])],
            latestTurn:
              failed || queued
                ? value.latestTurn
                : {
                    turnId,
                    state: held ? "running" : "completed",
                    requestedAt: time,
                    startedAt: time,
                    completedAt: held ? null : time,
                    assistantMessageId: assistant.id,
                  },
            session: {
              threadId: active,
              providerName: provider,
              providerInstanceId: provider,
              runtimeMode: "full-access",
              status: held ? "running" : "ready",
              activeTurnId: held ? turnId : null,
              lastError: null,
              updatedAt: time,
            },
            ...(changed && provider === "claudeAgent"
              ? {
                  proposedPlans: [
                    {
                      id: "plan",
                      turnId,
                      planMarkdown: "# Owned visual plan",
                      implementedAt: null,
                      implementationThreadId: null,
                      createdAt: time,
                      updatedAt: time,
                    },
                  ],
                  checkpoints: [
                    {
                      turnId,
                      checkpointTurnCount: 1,
                      checkpointRef: "refs/bibcode/checkpoints/host/turn/1",
                      status: "ready",
                      files: [
                        { path: "visual-chat.ts", kind: "modified", additions: 1, deletions: 1 },
                      ],
                      assistantMessageId: assistant.id,
                      completedAt: time,
                    },
                  ],
                }
              : {}),
          }));
        }
      },
    }),
    keys: async (value: string | string[]) => {
      if (value === "Backspace") draft = "";
      else if (typeof value === "string" && value !== "Escape") draft += value;
    },
    execute: async (fn: unknown) =>
      fn === readVisualViewport
        ? { ...dimensions, devicePixelRatio: 1 }
        : typeof fn === "function" && fn.name === "readOwnedCodexVisualSelection"
          ? { contextMatched: true, codexModelMatched: true, highSelected: true }
          : true,
    getWindowSize: async () => dimensions,
    setWindowSize: async (width: number, height: number) => {
      dimensions = { width, height };
    },
  } as unknown as ProviderChatProducerInput["browser"];
  const args: ProviderChatProducerInput = {
    browser,
    owner: {
      until: async (predicate) => {
        for (let i = 0; i < 3; i++) if (await predicate()) return;
        throw new Error("Inert predicate unsatisfied.");
      },
    },
    theme: "light",
    origin: "http://127.0.0.1:4885",
    hostThreadId: "host",
    projectPath: "/owned/project",
    workspace,
    snapshot: async () => model,
    readInputs: () => inputs.slice(),
    verifyWorktree: () => {},
    verifyMedia: (expected) => {
      if (changed !== expected) throw new Error("Inert media mismatch.");
    },
    withRefusedModel: async (run) => {
      armed = true;
      try {
        await run();
      } finally {
        armed = false;
      }
    },
    withManagedWorkspaceLoss: async (readBinding, run) => {
      expect((await readBinding()).target.id).toBe("panel");
      update("panel", (value) => ({
        ...value,
        latestTurn: { ...value.latestTurn!, state: "error", completedAt: time },
        session: { ...value.session!, status: "error", activeTurnId: null },
        messages: value.messages.map((message) =>
          message.role === "assistant"
            ? { ...message, streaming: false }
            : message.delivery?.state === "queued"
              ? { ...message, delivery: { ...message.delivery, held: true } }
              : message,
        ),
      }));
      await run({ kind: "provider-chat-registered-managed-loss" });
    },
    verifyLoss: (scope, binding) => {
      expect(scope.kind).toBe("provider-chat-registered-managed-loss");
      expect(binding.host.id).toBe("host");
      expect(binding.target.id).toBe("panel");
    },
    capture: async (scene, verify) => {
      await verify();
      if (mode === "post-image-mismatch" && scene === "chat-held-workspace-loss")
        inputs.push(inputs[inputs.length - 1]!);
      await verify();
      captures.push(scene);
    },
    observeUnsafeCleanup: () => {
      unsafe++;
    },
    step: () => {},
  };
  return { args, captures, actions, inputs, model: () => model, unsafe: () => unsafe };
}
it("runs all seven actual caller rows, joins exact turn/FIFO/media, and restores only its panel", async () => {
  const f = caller();
  await expect(runProviderChatVisual(f.args)).resolves.toMatchObject({
    completeGroup: false,
    ownedPanelClosed: true,
    originalHostRestored: true,
  });
  expect(f.captures).toEqual(qualifiedProviderChatScenes);
  expect(f.actions.filter((value) => value.includes('normalize-space()="Codex"'))).toHaveLength(1);
  expect(f.actions.findIndex((value) => value.includes("data-queued-message-cancel"))).toBeLessThan(
    f.actions.findIndex((value) => value.includes("Dismiss and skip")),
  );
  expect(f.model().threads.find((value) => value.id === "panel")?.deletedAt).toBe(time);
  expect(f.unsafe()).toBe(0);
});
it.each(["foreign-panel", "native-mismatch", "post-image-mismatch"])(
  "refuses an actual caller source mismatch before retaining that original: %s",
  async (mode) => {
    const f = caller(mode);
    await expect(runProviderChatVisual(f.args)).rejects.toThrow();
    expect(f.captures).not.toContain(
      mode === "foreign-panel" ? "activity-narrow" : "chat-held-workspace-loss",
    );
  },
);
it("preserves the exact original caller exception while failed restoration stays fatal", async () => {
  const f = caller(),
    original = new Error("Inert original capture refusal.");
  let failed = false;
  f.args.capture = async () => {
    failed = true;
    throw original;
  };
  f.args.verifyWorktree = () => {
    if (failed) throw new Error("Inert restoration refusal.");
  };
  await expect(runProviderChatVisual(f.args)).rejects.toBe(original);
  expect(f.unsafe()).toBe(1);
  expect(f.captures).toEqual([]);
});
it("refuses duplicate public action controls before sending or retaining an original", async () => {
  const f = caller();
  Object.defineProperty(f.args.browser, "$$", { value: () => ({ length: 2 }) });
  await expect(runProviderChatVisual(f.args)).rejects.toThrow();
  expect(f.inputs).toEqual([]);
  expect(f.captures).toEqual([]);
});
it.each([
  "foreign-path",
  "wrong-kind",
  "foreign-provider",
  "deleted-panel",
  "deleted-project",
  "duplicate",
])("refuses unsupported public panel binding: %s", (mode) =>
  expect(() => binding(snapshot(mode))).toThrow(),
);
function joins() {
  const fields: Record<string, string[]> = {
    "composer-command-menu": ["selectedSuggestion", "suggestionDescription", "draftRetained"],
    "context-popover": ["usageCounts", "contextMeter", "instanceNamed"],
    "mcp-popover": ["longName", "statuses", "unavailableExplanation"],
    "chat-markdown-plan": [
      "markdownRendered",
      "codeControls",
      "tableControls",
      "planVisible",
      "planSteps",
      "changedFiles",
      "imageLoaded",
      "draftRetained",
    ],
    "activity-narrow": [
      "expandedDock",
      "actorVisible",
      "toolVisible",
      "elapsedVisible",
      "noComposerOverlap",
    ],
    "chat-refused-model": [
      "refusalNotice",
      "correctionGuidance",
      "queueHeld",
      "noRetry",
      "draftRetained",
      "instanceNamed",
    ],
    "chat-held-workspace-loss": [
      "partialReply",
      "queueHeld",
      "workingEnded",
      "draftRetained",
      "worktreeWarning",
    ],
  };
  const captures = ["light", "dark"].flatMap((theme) =>
    qualifiedProviderChatScenes.map((scene) =>
      projectProviderChatCapture({
        scene,
        theme,
        file: providerChatScreenshotName(scene, theme),
        ...providerChatViewport(scene),
        nonBlank: true,
        sha256: "a".repeat(64),
        witness: Object.fromEntries(
          [
            "themeMatched",
            "selectedMatched",
            "expectedTextMatched",
            "targetInView",
            "credentialAbsent",
            "bootShellAbsent",
            "providerMatched",
            "unrelatedModalAbsent",
            ...fields[scene]!,
          ].map((key) => [key, true]),
        ),
      }),
    ),
  );
  const assertions = ["light", "dark"].map((theme) => ({
    theme,
    providerChatOnly: true,
    completeGroup: false,
    hostAndOwnedPanelJoined: true,
    nativeTurnsJoined: true,
    checkpointFileJoined: true,
    assetBytesJoined: true,
    refusalFifoJoined: true,
    registeredLossJoined: true,
    lossFifoJoined: true,
    noAutomaticResend: true,
    ownedPanelClosed: true,
    originalHostRestored: true,
  }));
  return { captures, assertions };
}
it("joins exactly seven scene originals per theme to closed incomplete-group assertions", () => {
  const j = joins();
  expect(() => validateProviderChatJoins(j.captures, j.assertions)).not.toThrow();
});
it.each(["duplicate", "missing", "question", "complete", "foreign-field", "false-proof"])(
  "refuses incorrect provider evidence joins: %s",
  (mode) => {
    const j = joins();
    const captures =
      mode === "duplicate"
        ? [...j.captures.slice(0, -1), j.captures[0]]
        : mode === "missing"
          ? j.captures.slice(1)
          : mode === "question"
            ? [...j.captures.slice(0, -1), { scene: "question-multiselect", theme: "dark" }]
            : j.captures;
    const assertions = j.assertions.map((value, index) =>
      index === 0
        ? {
            ...value,
            ...(mode === "complete" ? { completeGroup: true } : {}),
            ...(mode === "foreign-field" ? { path: "/private" } : {}),
            ...(mode === "false-proof" ? { lossFifoJoined: false } : {}),
          }
        : value,
    );
    expect(() => validateProviderChatJoins(captures, assertions)).toThrow();
  },
);
