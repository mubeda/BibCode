// @effect-diagnostics nodeBuiltinImport:off - Public controller ports are inert; no provider/UI process starts here.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { QualificationOwner } from "./qualification-owner.ts";
import { OrchestrationReadModel } from "../../../../packages/contracts/src/orchestration.ts";
import { EventId } from "../../../../packages/contracts/src/baseSchemas.ts";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import {
  cursorQuestionOptionSelector,
  cursorQuestionSubmitSelector,
  runCursorQuestionVisual,
  successfulCursorQuestionTurn,
  bindPendingCursorQuestion,
  completedPendingCursorQuestion,
} from "./release-visual-cursor-question.ts";
import { cursorQuestionFixturePrompt } from "./release-visual-cursor-question-fixture.ts";

const contractsRequire = NodeModule.createRequire(
  new NodeURL.URL("../../../../packages/contracts/package.json", import.meta.url),
);
const Schema: { decodeUnknownSync: <A>(schema: { readonly Type: A }) => (input: unknown) => A } =
  contractsRequire("effect/Schema");

it("refuses quiescent failed/cancelled/foreign turns without original public completion proof", () => {
  const completed = {
    latestTurn: {
      turnId: "owned-original-turn",
      state: "completed",
      completedAt: "2026-10-05T00:00:00Z",
    },
  };
  expect(successfulCursorQuestionTurn(completed, "owned-original-turn")).toBe(true);
  for (const state of ["error", "interrupted", "running"])
    expect(
      successfulCursorQuestionTurn(
        { latestTurn: { ...completed.latestTurn, state } },
        "owned-original-turn",
      ),
    ).toBe(false);
  expect(successfulCursorQuestionTurn(completed, "other-turn")).toBe(false);
  expect(
    successfulCursorQuestionTurn(
      { latestTurn: { ...completed.latestTurn, completedAt: null } },
      "owned-original-turn",
    ),
  ).toBe(false);
  expect(
    successfulCursorQuestionTurn(
      { userPromptPresent: true, noQuestionOrWorkingOrStop: true },
      "owned-original-turn",
    ),
  ).toBe(false);
});

it("uses only genuine public choices and one explicit Submit, then restores the original selection", async () => {
  const actions: string[] = [];
  const run = () =>
    runCursorQuestionVisual({
      browser: {
        $: (selector: string) => ({
          waitForDisplayed: async () => {
            actions.push("displayed:" + selector);
          },
          waitForEnabled: async () => {
            actions.push("enabled:" + selector);
          },
          click: async () => {
            actions.push("click:" + selector);
          },
        }),
        $$: async () => [{}],
      } as never,
      owner: {
        cleanup: async (_role: string, clean: () => Promise<void>) => {
          await clean();
        },
      } as never,
      verifyOwnedIdentity: async () => {
        actions.push("identity");
      },
      verifyRestoredIdentity: async () => {
        actions.push("identity");
      },
      selectCursor: async () => {
        actions.push("select-cursor");
      },
      restoreOriginal: async () => {
        actions.push("restore-original");
      },
      send: async (prompt) => {
        expect(prompt).toBe(cursorQuestionFixturePrompt);
        actions.push("send");
      },
      capture: async () => {
        actions.push("capture");
      },
      waitOriginalTurnCompleted: async () => {
        actions.push("completed");
      },
      step: () => {},
    });
  await expect(run()).resolves.toMatchObject({
    completeGroup: false,
    twoOrderedQuestions: true,
    explicitSubmit: true,
    providerRestored: true,
  });
  expect(actions.filter((item) => item.startsWith("click:"))).toEqual([
    "click:" + cursorQuestionOptionSelector("Workspace"),
    "click:" + cursorQuestionOptionSelector("Tests"),
    "click:" + cursorQuestionOptionSelector("Docs"),
    "click:" + cursorQuestionSubmitSelector,
  ]);
  expect(actions).toEqual([
    "identity",
    "select-cursor",
    "identity",
    "send",
    ...["Workspace", "Tests", "Docs"].flatMap((label) => {
      const selector = cursorQuestionOptionSelector(label as "Workspace" | "Tests" | "Docs");
      return ["displayed:" + selector, "enabled:" + selector, "click:" + selector];
    }),
    "capture",
    "displayed:" + cursorQuestionSubmitSelector,
    "enabled:" + cursorQuestionSubmitSelector,
    "click:" + cursorQuestionSubmitSelector,
    "completed",
    "identity",
    "restore-original",
    "identity",
  ]);
});

/** Execute the actual qualifier attribution ports without a browser or native process. */
function cursorFailureAttribution() {
  const source = NodeFS.readFileSync(
    new URL("../qualify-delivery-retry.ts", import.meta.url),
    "utf8",
  );
  const namesStart = source.indexOf("  const cursorOriginalFailurePhases = new Set([");
  const namesEnd = source.indexOf("  ]);", namesStart) + "  ]);".length;
  const observerStart = source.indexOf("          observeFailure: (error) => {");
  const observerEnd = source.indexOf("\n          selectCursor:", observerStart);
  const recoverStart = source.indexOf(
    "  } catch (error) {\n    const originalCursorFailure = readCursorOriginalFailure();",
  );
  const recoverEnd = source.indexOf("    const textRowObservation =", recoverStart);
  const resetStart = source.indexOf(
    "        cursorOriginalFailure = null;\n        const proof = await runCursorQuestionVisual(",
  );
  const resetEnd = source.indexOf("        const proof =", resetStart);
  for (const value of [namesStart, observerStart, recoverStart, resetStart])
    expect(value).toBeGreaterThan(0);
  expect(namesEnd).toBeGreaterThan(namesStart);
  expect(observerEnd).toBeGreaterThan(observerStart);
  expect(recoverEnd).toBeGreaterThan(recoverStart);
  expect(resetEnd).toBeGreaterThan(resetStart);
  const getterStart = source.indexOf("  const readCursorOriginalFailure =");
  const getterEnd = source.indexOf("  const cursorOriginalFailurePhases", getterStart);
  expect(getterStart).toBeGreaterThan(0);
  expect(getterEnd).toBeGreaterThan(getterStart);
  const scope = NodeVM.createContext({
    phase: "prepare",
    theme: "light",
    cursorOriginalFailure: null,
    cursorOriginalFailurePhases: NodeVM.runInNewContext(
      source.slice(namesStart, namesEnd) + "\ncursorOriginalFailurePhases",
    ),
    write: () => {},
  });
  NodeVM.runInContext(NodeModule.stripTypeScriptTypes(source.slice(getterStart, getterEnd)), scope);
  const observeFailure = NodeVM.runInContext(
    NodeModule.stripTypeScriptTypes(
      "(" +
        source
          .slice(observerStart, observerEnd)
          .trim()
          .replace(/^observeFailure: /, "")
          .replace(/,$/, "") +
        ")",
    ),
    scope,
  ) as (error: unknown) => void;
  const recover = NodeVM.runInContext(
    NodeModule.stripTypeScriptTypes(
      "error => {" +
        source.slice(recoverStart + "  } catch (error) {".length, recoverEnd) +
        "return phase;}",
    ),
    scope,
  ) as (error: unknown) => string;
  const reset = NodeVM.runInContext(
    NodeModule.stripTypeScriptTypes("() => {" + source.slice(resetStart, resetEnd) + "}"),
    scope,
  ) as () => void;
  return { scope, observeFailure, recover, reset };
}

function cursorFailureDriver(
  attribution: ReturnType<typeof cursorFailureAttribution>,
  original: unknown,
  observeFailure: (error: unknown) => void = attribution.observeFailure,
  closedPhase = true,
) {
  const calls: string[] = [];
  const owner = new QualificationOwner("/owned-source", "/owned-fixture");
  const restore = new Error("Inert timeout.");
  const run = () =>
    runCursorQuestionVisual({
      browser: {
        $: () => ({
          waitForDisplayed: async () => {
            calls.push("displayed");
            throw original;
          },
          waitForEnabled: async () => {},
          click: async () => {},
        }),
        $$: async () => [{}],
      } as never,
      owner,
      verifyOwnedIdentity: async () => {
        calls.push("identity");
      },
      verifyRestoredIdentity: async () => {
        calls.push("identity");
      },
      selectCursor: async () => {
        calls.push("select");
      },
      send: async () => {
        calls.push("send");
      },
      capture: async () => {
        throw new Error("Capture must not be reached.");
      },
      waitOriginalTurnCompleted: async () => {
        throw new Error("Completion must not be reached.");
      },
      restoreOriginal: async () => {
        calls.push("restore");
        attribution.scope.phase = "worktree-select-claude-opus";
        throw restore;
      },
      step: (value) => {
        attribution.scope.phase = closedPhase ? value : "prepare";
      },
      observeFailure,
    });
  return { run, calls, owner };
}

it("preserves the actual original Cursor error phase before real owner cleanup overwrites it", async () => {
  const attribution = cursorFailureAttribution();
  attribution.reset();
  const original = new Error("Inert original timeout.");
  const probe = cursorFailureDriver(attribution, original);
  await expect(probe.run()).rejects.toBe(original);
  expect(attribution.scope.phase).toBe("worktree-select-claude-opus");
  expect(attribution.recover(original)).toBe("visual-cursor-question-first-choice");
  expect(probe.calls).toEqual(["identity", "select", "identity", "send", "displayed", "restore"]);
  expect(probe.owner.failures).toMatchObject([
    { role: "cursor-question-model-restore", failure: { kind: "timeout" } },
  ]);
  expect(probe.owner.processes).toHaveLength(0);
});

it("keeps the original Cursor error and one public restore when optional attribution throws", async () => {
  const attribution = cursorFailureAttribution();
  const original = new Error("Inert original timeout.");
  const probe = cursorFailureDriver(attribution, original, () => {
    throw new Error("Inert unavailable attribution.");
  });
  await expect(probe.run()).rejects.toBe(original);
  expect(probe.calls.filter((value) => value === "restore")).toHaveLength(1);
  expect(probe.owner.failures).toMatchObject([
    { role: "cursor-question-model-restore", failure: { kind: "timeout" } },
  ]);
  expect(attribution.recover(original)).toBe("worktree-select-claude-opus");
});

it("refuses an equal-looking foreign Cursor error when restoring the closed original phase", async () => {
  const attribution = cursorFailureAttribution();
  const original = new Error("Inert original timeout.");
  const probe = cursorFailureDriver(attribution, original);
  await expect(probe.run()).rejects.toBe(original);
  expect(attribution.recover(new Error(original.message))).toBe("worktree-select-claude-opus");
  expect(attribution.recover(original)).toBe("visual-cursor-question-first-choice");
});

it("resets the actual original Cursor record between entries when an exception object is reused", async () => {
  const attribution = cursorFailureAttribution();
  const original = new Error("Inert reused timeout.");
  attribution.reset();
  await expect(cursorFailureDriver(attribution, original).run()).rejects.toBe(original);
  expect(attribution.recover(original)).toBe("visual-cursor-question-first-choice");
  attribution.reset();
  await expect(
    cursorFailureDriver(attribution, original, attribution.observeFailure, false).run(),
  ).rejects.toBe(original);
  expect(attribution.recover(original)).toBe("worktree-select-claude-opus");
});

it.each([false, true])(
  "verifies the original public context separately from the completed Cursor thread (restore failure=%s)",
  async (failRestore) => {
    const owner = new QualificationOwner("/owned-source", "/owned-fixture");
    const calls: string[] = [];
    const original = new Error("Inert original timeout.");
    await expect(
      runCursorQuestionVisual({
        browser: {
          $: () => ({
            waitForDisplayed: async () => {
              throw original;
            },
            waitForEnabled: async () => {},
            click: async () => {},
          }),
          $$: async () => [{}],
        } as never,
        owner,
        verifyOwnedIdentity: async () => {
          calls.push("question-identity");
        },
        selectCursor: async () => {},
        send: async () => {},
        capture: async () => {},
        waitOriginalTurnCompleted: async () => {},
        restoreOriginal: async () => {
          calls.push("navigate-primary");
          if (failRestore) throw new Error("Inert restore timeout.");
        },
        verifyRestoredIdentity: async () => {
          calls.push("original-primary-identity");
        },
        step: () => {},
      }),
    ).rejects.toBe(original);
    expect(calls.filter((value) => value === "navigate-primary")).toHaveLength(1);
    expect(calls.filter((value) => value === "question-identity")).toHaveLength(2);
    expect(calls.includes("original-primary-identity")).toBe(!failRestore);
    expect(owner.failures).toHaveLength(failRestore ? 1 : 0);
    if (failRestore)
      expect(owner.failures[0]).toMatchObject({
        role: "cursor-question-model-restore",
        failure: { kind: "timeout" },
      });
  },
);

it.each([
  "delivery-retry-ui",
  "release-visual-core",
  "release-visual-settings",
  "release-visual-workspace-substates",
  "release-visual-cursor-question",
  "release-visual-project-lifecycle",
])(
  "keeps baseline operations outside the dedicated Cursor and lifecycle selections: %s",
  async (selection) => {
    const source = NodeFS.readFileSync(
      new NodeURL.URL("../qualify-delivery-retry.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("      const baseline = `delivery baseline ${theme}`;");
    const end = source.indexOf("      if (config.selection === ", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const calls: string[] = [];
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function run(){" + source.slice(start, end) + "}\nrun",
      ),
      {
        config: { selection },
        theme: "light",
        surface: "owned-surface",
        form: "owned-form",
        newConversationNotice: "Owned new conversation",
        step: () => {},
        send: async (value: string) => {
          expect(value).toBe("delivery baseline light");
          calls.push("send");
        },
        owner: {
          until: async (read: () => Promise<boolean>) => {
            calls.push("response");
            expect(await read()).toBe(true);
          },
        },
        browser: {
          $: (selector: string) => ({
            getText: async () => "BiBCode deterministic streamed fixture response.",
            isDisplayed: async () => false,
            waitForDisplayed: async () => {
              expect(selector).toContain("Send message");
              calls.push("send-ready");
            },
          }),
        },
        check: (value: boolean) => {
          expect(value).toBe(true);
          calls.push("conversation-check");
        },
      },
    );
    await run();
    expect(calls).toEqual(
      ["release-visual-cursor-question", "release-visual-project-lifecycle"].includes(selection)
        ? []
        : ["send", "response", "send-ready", "conversation-check"],
    );
  },
);

function freshCursorSnapshot(mode: string) {
  const model = JSON.parse(
    NodeFS.readFileSync(
      new NodeURL.URL(
        "../../../../packages/contracts/fixtures/http-orchestration/full-read-model.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const project = {
    ...model.projects[0],
    id: "owned-project",
    title: "Owned project",
    workspaceRoot: "/owned/project",
    deletedAt: null,
  };
  const common = {
    ...model.threads[0],
    projectId: project.id,
    deletedAt: null,
    archivedAt: null,
    messages: [],
    activities: [],
    checkpoints: [],
    proposedPlans: [],
    session: null,
    latestTurn: null,
  };
  const primary = {
    ...common,
    id: "owned-primary",
    kind: "default",
    worktreePath: null,
    branch: "main",
  };
  const question = {
    ...common,
    id: "owned-question",
    kind: "workspace",
    branch: "codex/delivery-retry-light",
    worktreePath: "/owned/managed",
  };
  if (mode === "started")
    question.latestTurn = model.threads[0].latestTurn ?? {
      turnId: "owned-turn",
      state: "running",
      requestedAt: model.updatedAt,
      startedAt: null,
      completedAt: null,
      assistantMessageId: null,
    };
  if (mode === "foreign-path") question.worktreePath = "/owned/foreign";
  if (mode === "foreign-branch") question.branch = "foreign";
  if (mode === "foreign-project") project.workspaceRoot = "/owned/foreign";
  if (mode === "same-context-id") primary.id = question.id;
  const threads =
    mode === "missing-default"
      ? [question]
      : mode === "duplicate-default"
        ? [primary, { ...primary, id: "owned-other-primary" }, question]
        : [primary, question];
  return Schema.decodeUnknownSync(OrchestrationReadModel)({
    ...model,
    projects: [project],
    threads,
  });
}

it.each([
  "empty",
  "started",
  "foreign-path",
  "foreign-branch",
  "foreign-project",
  "missing-default",
  "duplicate-default",
  "same-context-id",
])(
  "admits only the decoded empty managed Cursor thread and its owned original primary context: %s",
  async (mode) => {
    const source = NodeFS.readFileSync(
      new NodeURL.URL("../qualify-delivery-retry.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf('        step("visual-cursor-question-bind-context");');
    const end = source.indexOf("        let originalTurnId:", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function bind(){" + source.slice(start, end) + "return originalContext;}\nbind",
      ),
      {
        step: () => {},
        snapshot: async () => freshCursorSnapshot(mode),
        workspace: {
          threadId: "owned-question",
          path: "/owned/managed",
          branch: "codex/delivery-retry-light",
        },
        context: { projectPath: "/owned/project" },
        check: (value: boolean) => {
          if (!value) throw new Error("Inert owned binding refusal.");
        },
      },
    );
    if (mode === "empty")
      await expect(run()).resolves.toMatchObject({
        environmentId: "local",
        projectId: "owned-project",
        threadId: "owned-primary",
        cwd: "/owned/project",
        branch: "main",
      });
    else await expect(run()).rejects.toThrow("Inert owned binding refusal.");
  },
);

it.each(["before", "send", "running", "pass"])(
  "attributes the actual Cursor send and running-turn awaits separately: %s",
  async (boundary) => {
    const source = NodeFS.readFileSync(
      new URL("../qualify-delivery-retry.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf(
      "          send: async (text) => {",
      source.indexOf("const proof = await runCursorQuestionVisual"),
    );
    const end = source.indexOf("          capture: async () => {", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const original = new Error("Inert Cursor await boundary failure.");
    const phases: string[] = [],
      calls: string[] = [];
    let reads = 0;
    const send = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes("({" + source.slice(start, end) + "}).send"),
      {
        originalTurnId: null,
        pendingCursorBinding: null,
        bindPendingCursorQuestion: () => ({ turnId: "owned-turn" }),
        cursorTurnObservation: null,
        cursorQuestionFixturePrompt,
        step: (phase: string) => phases.push(phase),
        currentThread: async () => {
          calls.push("snapshot");
          if (++reads === 1) {
            if (boundary === "before") throw original;
            return { latestTurn: null, messages: [], activities: [] };
          }
          return {
            modelSelection: { instanceId: "cursor" },
            messages: [{ role: "user", text: cursorQuestionFixturePrompt }],
            latestTurn: { turnId: "owned-turn", state: "running" },
            session: {
              activeTurnId: "owned-turn",
              providerName: "cursor",
              status: "running",
              lastError: null,
            },
          };
        },
        send: async (text: string) => {
          expect(text).toBe(cursorQuestionFixturePrompt);
          calls.push("public-send");
          if (boundary === "send") throw original;
        },
        owner: {
          until: async (check: () => Promise<boolean>) => {
            calls.push("running-turn");
            if (boundary === "running") throw original;
            expect(await check()).toBe(true);
          },
        },
      },
    );
    if (boundary === "pass") await send(cursorQuestionFixturePrompt);
    else await expect(send(cursorQuestionFixturePrompt)).rejects.toBe(original);
    expect(phases.at(-1)).toBe(
      boundary === "before"
        ? "visual-cursor-question-turn-before"
        : boundary === "send"
          ? "visual-cursor-question-send"
          : "visual-cursor-question-turn-running",
    );
    if (boundary === "pass")
      expect(calls).toEqual(["snapshot", "public-send", "running-turn", "snapshot"]);
  },
);

it.each([
  "running",
  "no-turn",
  "same-turn",
  "idle",
  "foreign-active",
  "foreign-provider",
  "session-error",
  "foreign-model",
  "no-message",
])("retains only closed facts from the existing actual running-turn snapshot: %s", async (mode) => {
  const source = NodeFS.readFileSync(
    new NodeURL.URL("../qualify-delivery-retry.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    "          send: async (text) => {",
    source.indexOf("const proof = await runCursorQuestionVisual"),
  );
  const end = source.indexOf("          capture: async () => {", start);
  const scope = {
    originalTurnId: null,
    pendingCursorBinding: null,
    bindPendingCursorQuestion: () => null,
    cursorTurnObservation: null as unknown,
    cursorQuestionFixturePrompt,
    step: () => {},
    currentThread: async () => {
      if (!sampled) {
        sampled = true;
        return {
          latestTurn: mode === "same-turn" ? { turnId: "owned-prior" } : null,
          messages: [],
          activities: [],
        };
      }
      return {
        modelSelection: { instanceId: mode === "foreign-model" ? "claudeAgent" : "cursor" },
        messages:
          mode === "no-message" ? [] : [{ role: "user", text: cursorQuestionFixturePrompt }],
        latestTurn:
          mode === "no-turn"
            ? null
            : {
                turnId: mode === "same-turn" ? "owned-prior" : "owned-current",
                state: mode === "idle" ? "completed" : "running",
              },
        session: {
          providerName: mode === "foreign-provider" ? "claudeAgent" : "cursor",
          activeTurnId: mode === "foreign-active" ? "foreign" : "owned-current",
          status: mode === "session-error" ? "error" : "running",
          lastError: mode === "session-error" ? "private fixture detail" : null,
        },
      };
    },
    send: async () => {},
    owner: {
      until: async (check: () => Promise<boolean>) => {
        await check();
      },
    },
  };
  let sampled = false;
  const send = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes("({" + source.slice(start, end) + "}).send"),
    scope,
  );
  await send(cursorQuestionFixturePrompt);
  expect(scope.cursorTurnObservation).toEqual({
    modelCursor: mode !== "foreign-model",
    turnPresent: mode !== "no-turn",
    newTurn: mode !== "no-turn" && mode !== "same-turn",
    turnRunning: mode !== "no-turn" && mode !== "idle",
    sessionPresent: true,
    sessionCursor: mode !== "foreign-provider",
    activeTurnMatches: mode !== "no-turn" && mode !== "same-turn" && mode !== "foreign-active",
    sessionError: mode === "session-error",
    promptRecorded: mode !== "no-message",
  });
  expect(
    Object.values(scope.cursorTurnObservation as object).every(
      (value) => typeof value === "boolean",
    ),
  ).toBe(true);
  expect(Object.isFrozen(scope.cursorTurnObservation)).toBe(true);
  expect(JSON.stringify(scope.cursorTurnObservation)).not.toMatch(
    /private|fixture|owned-|foreign|claudeAgent/,
  );
});

it.each(["owned", "foreign-error", "foreign-phase", "foreign-selection"])(
  "emits the last Cursor predicate facts only for the exact original failure: %s",
  (mode) => {
    const source = NodeFS.readFileSync(
      new NodeURL.URL("../qualify-delivery-retry.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf(
      "      cursorTurnObservation:",
      source.indexOf('    write("failure", {'),
    );
    const end = source.indexOf("      startupObservation,", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const error = new Error("Inert original Cursor observation failure.");
    const facts = Object.freeze({
      modelCursor: true,
      turnPresent: true,
      newTurn: true,
      turnRunning: false,
      sessionPresent: true,
      sessionCursor: true,
      activeTurnMatches: false,
      sessionError: true,
      promptRecorded: true,
    });
    const result = NodeVM.runInNewContext("({" + source.slice(start, end) + "})", {
      config: {
        selection:
          mode === "foreign-selection" ? "release-visual-core" : "release-visual-cursor-question",
      },
      phase:
        mode === "foreign-phase"
          ? "visual-cursor-question-send"
          : "visual-cursor-question-turn-running",
      originalCursorFailure: {
        error: mode === "foreign-error" ? new Error("Inert other error.") : error,
      },
      error,
      cursorTurnObservation: facts,
    });
    expect(result.cursorTurnObservation).toBe(mode === "owned" ? facts : null);
  },
);

it("clears the actual last Cursor predicate record before each producer entry", () => {
  const source = NodeFS.readFileSync(
    new NodeURL.URL("../qualify-delivery-retry.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("        cursorTurnObservation = null;");
  const end = source.indexOf("        const proof = await runCursorQuestionVisual({", start);
  expect(start).toBeGreaterThan(0);
  const scope = {
    cursorTurnObservation: { sessionError: true } as unknown,
    cursorOriginalFailure: {} as unknown,
  };
  NodeVM.runInNewContext(source.slice(start, end), scope);
  expect(scope.cursorTurnObservation).toBeNull();
  expect(scope.cursorOriginalFailure).toBeNull();
});

function pendingCursorModel(mode = "pending") {
  const model = freshCursorSnapshot("empty");
  const thread = model.threads.find((value) => value.id === "owned-question")!;
  const time = model.updatedAt;
  const requestId = "owned-request",
    turnId = "owned-native-turn";
  const started = {
    id: "started",
    tone: "info",
    kind: "provider.turn",
    summary: "Turn started",
    payload: { eventType: "turn.started" },
    turnId,
    sequence: 1,
    createdAt: time,
  };
  const requested = {
    id: "requested",
    tone: "approval",
    kind: "user-input.requested",
    summary: "Input requested",
    payload: {
      eventType: "user-input.requested",
      requestId,
      questions: [
        {
          id: "first",
          header: "Question",
          question: "Choose the first scope.",
          multiSelect: false,
          options: [
            { label: "Workspace", description: "Workspace" },
            { label: "Project", description: "Project" },
          ],
        },
        {
          id: "later",
          header: "Question",
          question: "Choose the later checks.",
          multiSelect: true,
          options: [
            { label: "Tests", description: "Tests" },
            { label: "Docs", description: "Docs" },
            { label: "Types", description: "Types" },
          ],
        },
      ],
    },
    turnId,
    sequence: 2,
    createdAt: time,
  };
  const message = {
    id: "owned-prompt",
    role: "user",
    text: cursorQuestionFixturePrompt,
    turnId: null,
    streaming: false,
    delivery: {
      state: mode === "completed" ? "delivered" : "sending",
      provider: "cursor",
      providerInstanceId: "cursor",
      mode: "start",
    },
    createdAt: time,
    updatedAt: time,
  };
  const activities: unknown[] = [started, requested];
  if (mode === "completed")
    activities.push(
      {
        id: "resolved",
        tone: "approval",
        kind: "user-input.resolved",
        summary: "Input received",
        payload: {
          eventType: "user-input.resolved",
          requestId,
          answers: { first: "Workspace", later: ["Tests", "Docs"] },
        },
        turnId,
        sequence: 3,
        createdAt: time,
      },
      {
        id: "completed",
        tone: "info",
        kind: "provider.turn",
        summary: "Turn completed",
        payload: { eventType: "turn.completed", state: "completed", stopReason: "end_turn" },
        turnId,
        sequence: 4,
        createdAt: time,
      },
    );
  if (mode === "duplicate") activities.push({ ...requested, id: "duplicate", sequence: 3 });
  if (mode === "foreign-turn") requested.turnId = "foreign";
  if (mode === "wrong-questions") requested.payload.questions[1]!.multiSelect = false;
  const candidate = {
    ...thread,
    modelSelection: { instanceId: "cursor", model: "cursor-fixture" },
    session: {
      threadId: thread.id,
      status: mode === "completed" ? "ready" : "ready",
      providerName: mode === "foreign-provider" ? "claudeAgent" : "cursor",
      providerInstanceId: "cursor",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: time,
    },
    messages: [message],
    activities,
  };
  return Schema.decodeUnknownSync(OrchestrationReadModel)({
    ...model,
    threads: model.threads.map((value) => (value.id === thread.id ? candidate : value)),
  }).threads.find((value) => value.id === thread.id)!;
}
it("binds the actual native question while Cursor delivery is awaiting its response and latestTurn is absent", () => {
  const thread = pendingCursorModel();
  expect(thread.latestTurn).toBeNull();
  const bound = bindPendingCursorQuestion(thread, { messageIds: [], activityIds: [] });
  expect(bound).toEqual({
    threadId: "owned-question",
    messageId: "owned-prompt",
    turnId: "owned-native-turn",
    requestId: "owned-request",
    requestSequence: 2,
  });
  expect(completedPendingCursorQuestion(pendingCursorModel("completed"), bound!)).toBe(true);
  expect(completedPendingCursorQuestion(thread, bound!)).toBe(false);
});
it.each(["duplicate", "foreign-turn", "wrong-questions", "foreign-provider"])(
  "refuses a %s pending Cursor request instead of substituting a running turn",
  (mode) => {
    expect(
      bindPendingCursorQuestion(pendingCursorModel(mode), { messageIds: [], activityIds: [] }),
    ).toBeNull();
  },
);
it("refuses stale pre-send requests and foreign completion joins", () => {
  const thread = pendingCursorModel();
  expect(
    bindPendingCursorQuestion(thread, { messageIds: ["owned-prompt"], activityIds: [] }),
  ).toBeNull();
  expect(
    bindPendingCursorQuestion(thread, { messageIds: [], activityIds: ["requested"] }),
  ).toBeNull();
  const bound = bindPendingCursorQuestion(thread, { messageIds: [], activityIds: [] })!;
  expect(
    completedPendingCursorQuestion(pendingCursorModel("completed"), {
      ...bound,
      turnId: "foreign",
    }),
  ).toBe(false);
  expect(
    completedPendingCursorQuestion(pendingCursorModel("completed"), {
      ...bound,
      requestId: "foreign",
    }),
  ).toBe(false);
});

it("the actual caller admits the native pending question before acknowledgement and preserves exact completion binding", async () => {
  const source = NodeFS.readFileSync(
    new NodeURL.URL("../qualify-delivery-retry.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    "          send: async (text) => {",
    source.indexOf("const proof = await runCursorQuestionVisual"),
  );
  const end = source.indexOf("          capture: async () => {", start);
  let reads = 0;
  const pending = pendingCursorModel();
  const scope = {
    originalTurnId: null as unknown,
    pendingCursorBinding: null as unknown,
    cursorTurnObservation: null,
    cursorQuestionFixturePrompt,
    bindPendingCursorQuestion,
    step: () => {},
    currentThread: async () =>
      ++reads === 1 ? { ...pending, messages: [], activities: [] } : pending,
    send: async () => {},
    owner: { until: async (check: () => Promise<boolean>) => expect(await check()).toBe(true) },
  };
  const send = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes("({" + source.slice(start, end) + "}).send"),
    scope,
  );
  await send(cursorQuestionFixturePrompt);
  expect(scope.originalTurnId).toBe("owned-native-turn");
  expect(scope.pendingCursorBinding).toEqual(
    bindPendingCursorQuestion(pending, { messageIds: [], activityIds: [] }),
  );
  expect(reads).toBe(2);
  const completionStart = source.indexOf("          waitOriginalTurnCompleted: () =>", end);
  const completionEnd = source.indexOf("\n        });", completionStart);
  const completed = pendingCursorModel("completed");
  const completion = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      "({" + source.slice(completionStart, completionEnd) + "}).waitOriginalTurnCompleted",
    ),
    {
      ...scope,
      currentThread: async () => completed,
      completedPendingCursorQuestion,
      bounded: async (value: Promise<unknown>) => value,
      b: () => ({ execute: async () => ({ valid: true }) }),
      readCursorQuestionObservation: () => {},
      validateCursorQuestionWitness: () => {},
      theme: "light",
      origin: "http://127.0.0.1:4885",
      workspace: { threadId: completed.id, branch: completed.branch },
    },
  );
  await completion();
});

it.each([
  "wrong-turn",
  "not-delivered",
  "cancelled",
  "wrong-answer",
  "duplicate-resolved",
  "session-error",
])("refuses incomplete or foreign native Cursor completion: %s", (mode) => {
  const pending = pendingCursorModel(),
    binding = bindPendingCursorQuestion(pending, { messageIds: [], activityIds: [] })!;
  const complete = pendingCursorModel("completed");
  const altered = {
    ...complete,
    messages: complete.messages.map((message) =>
      mode === "wrong-turn"
        ? { ...message, turnId: "foreign" }
        : mode === "not-delivered"
          ? { ...message, delivery: { ...message.delivery!, state: "sending" } }
          : message,
    ),
    activities: complete.activities.map((activity) =>
      mode === "cancelled" && activity.id === "completed"
        ? {
            ...activity,
            payload: { eventType: "turn.completed", state: "interrupted", stopReason: "cancelled" },
          }
        : mode === "wrong-answer" && activity.id === "resolved"
          ? {
              ...activity,
              payload: {
                eventType: "user-input.resolved",
                requestId: binding.requestId,
                answers: { first: "Workspace", later: ["Tests", "Types"] },
              },
            }
          : activity,
    ),
    session:
      mode === "session-error"
        ? { ...complete.session!, status: "error", lastError: "private diagnostic" }
        : complete.session,
  };
  if (mode === "duplicate-resolved")
    altered.activities.push({
      ...complete.activities.find((activity) => activity.id === "resolved")!,
      id: EventId.make("duplicate"),
      sequence: 5,
    });
  const model = freshCursorSnapshot("empty");
  const decoded = Schema.decodeUnknownSync(OrchestrationReadModel)({
    ...model,
    threads: model.threads.map((thread) => (thread.id === complete.id ? altered : thread)),
  }).threads.find((thread) => thread.id === complete.id)!;
  expect(completedPendingCursorQuestion(decoded, binding)).toBe(false);
});

it.each(["resolved-first", "completed-first"])(
  "joins both post-request native events without inventing an emission-order guarantee: %s",
  (mode) => {
    const pending = pendingCursorModel(),
      binding = bindPendingCursorQuestion(pending, { messageIds: [], activityIds: [] })!,
      completed = pendingCursorModel("completed");
    const thread = {
      ...completed,
      activities: completed.activities.map((activity) =>
        activity.id === "completed"
          ? { ...activity, sequence: mode === "completed-first" ? 3 : 4 }
          : activity.id === "resolved"
            ? { ...activity, sequence: mode === "completed-first" ? 4 : 3 }
            : activity,
      ),
    };
    expect(completedPendingCursorQuestion(thread, binding)).toBe(true);
  },
);
it.each(["resolved", "completed"])("refuses a %s event at or before the original request", (id) => {
  const pending = pendingCursorModel(),
    binding = bindPendingCursorQuestion(pending, { messageIds: [], activityIds: [] })!,
    completed = pendingCursorModel("completed");
  expect(
    completedPendingCursorQuestion(
      {
        ...completed,
        activities: completed.activities.map((activity) =>
          activity.id === id ? { ...activity, sequence: 2 } : activity,
        ),
      },
      binding,
    ),
  ).toBe(false);
});

it("refuses a schema-valid Cursor session belonging to another thread before question capture and completion", () => {
  const pending = pendingCursorModel(),
    binding = bindPendingCursorQuestion(pending, { messageIds: [], activityIds: [] })!,
    complete = pendingCursorModel("completed"),
    model = freshCursorSnapshot("empty");
  const foreign = (thread: typeof pending) =>
    Schema.decodeUnknownSync(OrchestrationReadModel)({
      ...model,
      threads: model.threads.map((value) =>
        value.id === thread.id
          ? { ...thread, session: { ...thread.session!, threadId: "foreign-thread" } }
          : value,
      ),
    }).threads.find((value) => value.id === thread.id)!;
  expect(
    bindPendingCursorQuestion(foreign(pending), { messageIds: [], activityIds: [] }),
  ).toBeNull();
  expect(completedPendingCursorQuestion(foreign(complete), binding)).toBe(false);
});

it("joins normal delivered-start messages whose current public projection intentionally has no native turnId", () => {
  const pending = pendingCursorModel(),
    binding = bindPendingCursorQuestion(pending, { messageIds: [], activityIds: [] })!,
    completed = pendingCursorModel("completed"),
    model = freshCursorSnapshot("empty");
  const thread = Schema.decodeUnknownSync(OrchestrationReadModel)({
    ...model,
    threads: model.threads.map((value) =>
      value.id === completed.id
        ? {
            ...completed,
            messages: completed.messages.map((message) => ({
              ...message,
              turnId: null,
              delivery: { ...message.delivery!, mode: "start" },
            })),
          }
        : value,
    ),
  }).threads.find((value) => value.id === completed.id)!;
  expect(completedPendingCursorQuestion(thread, binding)).toBe(true);
});

it("refuses a delivered steering record as proof of the original Cursor start", () => {
  const pending = pendingCursorModel(),
    binding = bindPendingCursorQuestion(pending, { messageIds: [], activityIds: [] })!,
    complete = pendingCursorModel("completed");
  expect(
    completedPendingCursorQuestion(
      {
        ...complete,
        messages: complete.messages.map((message) => ({
          ...message,
          delivery: { ...message.delivery!, mode: "steer" },
        })),
      },
      binding,
    ),
  ).toBe(false);
});

it("requires the exact current delivered-start mode instead of accepting an absent mode", () => {
  const pending = pendingCursorModel(),
    binding = bindPendingCursorQuestion(pending, { messageIds: [], activityIds: [] })!,
    complete = pendingCursorModel("completed"),
    model = freshCursorSnapshot("empty");
  const messages = complete.messages.map((message) => {
    const { mode: ignored, ...delivery } = message.delivery!;
    void ignored;
    return { ...message, delivery };
  });
  const thread = Schema.decodeUnknownSync(OrchestrationReadModel)({
    ...model,
    threads: model.threads.map((value) =>
      value.id === complete.id ? { ...complete, messages } : value,
    ),
  }).threads.find((value) => value.id === complete.id)!;
  expect(completedPendingCursorQuestion(thread, binding)).toBe(false);
});
