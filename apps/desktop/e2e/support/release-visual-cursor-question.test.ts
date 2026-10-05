// @effect-diagnostics nodeBuiltinImport:off - Public controller ports are inert; no provider/UI process starts here.
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
