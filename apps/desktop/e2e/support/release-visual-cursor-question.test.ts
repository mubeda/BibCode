// @effect-diagnostics nodeBuiltinImport:off - Public controller ports are inert; no provider/UI process starts here.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { QualificationOwner } from "./qualification-owner.ts";
import { expect, it } from "vite-plus/test";
import {
  cursorQuestionOptionSelector,
  cursorQuestionSubmitSelector,
  runCursorQuestionVisual,
  successfulCursorQuestionTurn,
} from "./release-visual-cursor-question.ts";
import { cursorQuestionFixturePrompt } from "./release-visual-cursor-question-fixture.ts";

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
