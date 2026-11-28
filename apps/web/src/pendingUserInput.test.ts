import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  buildPartialPendingUserInputSubmission,
  buildPendingUserInputAnswers,
  clearPendingUserInputDraft,
  countAnsweredPendingUserInputQuestions,
  derivePendingUserInputProgress,
  findFirstUnansweredPendingUserInputQuestionIndex,
  formatUserInputOptionLabel,
  isRecommendedUserInputOption,
  loadPendingUserInputDraft,
  providerSupportsPendingUserInputCancel,
  prunePendingUserInputDraftsForThread,
  resolvePendingUserInputAnswer,
  savePendingUserInputDraft,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInput";

const singleSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "What should the plan target first?",
  options: [
    {
      label: "Orchestration-first",
      description: "Focus on orchestration first",
    },
  ],
  multiSelect: false,
} as const;

const multiSelectQuestion = {
  id: "areas",
  header: "Areas",
  question: "Which areas should this change cover?",
  options: [
    {
      label: "Server",
      description: "Server",
    },
    {
      label: "Web",
      description: "Web",
    },
  ],
  multiSelect: true,
} as const;

describe("resolvePendingUserInputAnswer", () => {
  it("prefers a custom answer over selected options", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionLabels: ["Orchestration-first"],
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });

  it("falls back to the selected option for single-select questions", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionLabels: ["Orchestration-first"],
      }),
    ).toBe("Orchestration-first");
  });

  it("returns all selected labels for multi-select questions", () => {
    expect(
      resolvePendingUserInputAnswer(multiSelectQuestion, {
        selectedOptionLabels: ["Server", "Web"],
      }),
    ).toEqual(["Server", "Web"]);
  });

  it("clears the preset selection when a custom answer is entered", () => {
    expect(
      setPendingUserInputCustomAnswer(
        {
          selectedOptionLabels: ["Server", "Web"],
        },
        "doesn't matter",
      ),
    ).toEqual({
      customAnswer: "doesn't matter",
    });
  });
});

describe("togglePendingUserInputOptionSelection", () => {
  it("toggles options for multi-select questions", () => {
    expect(togglePendingUserInputOptionSelection(multiSelectQuestion, undefined, "Server")).toEqual(
      {
        customAnswer: "",
        selectedOptionLabels: ["Server"],
      },
    );

    expect(
      togglePendingUserInputOptionSelection(
        multiSelectQuestion,
        {
          selectedOptionLabels: ["Server", "Web"],
        },
        "Server",
      ),
    ).toEqual({
      customAnswer: "",
      selectedOptionLabels: ["Web"],
    });
  });
});

describe("buildPendingUserInputAnswers", () => {
  it("returns a canonical answer map for complete prompts", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          singleSelectQuestion,
          {
            id: "compat",
            header: "Compat",
            question: "How strict should compatibility be?",
            options: [
              {
                label: "Keep current envelope",
                description: "Preserve current wire format",
              },
            ],
            multiSelect: false,
          },
        ],
        {
          scope: {
            selectedOptionLabels: ["Orchestration-first"],
          },
          compat: {
            customAnswer: "Keep the current envelope for one release window",
          },
        },
      ),
    ).toEqual({
      scope: "Orchestration-first",
      compat: "Keep the current envelope for one release window",
    });
  });

  it("returns arrays for answered multi-select prompts", () => {
    expect(
      buildPendingUserInputAnswers([multiSelectQuestion], {
        areas: {
          selectedOptionLabels: ["Server", "Web"],
        },
      }),
    ).toEqual({
      areas: ["Server", "Web"],
    });
  });

  it("returns null when any question is unanswered", () => {
    expect(buildPendingUserInputAnswers([singleSelectQuestion], {})).toBeNull();
  });
});

describe("pending user input question progress", () => {
  const questions = [
    singleSelectQuestion,
    {
      id: "compat",
      header: "Compat",
      question: "How strict should compatibility be?",
      options: [
        {
          label: "Keep current envelope",
          description: "Preserve current wire format",
        },
      ],
      multiSelect: false,
    },
  ] as const;

  it("counts only answered questions", () => {
    expect(
      countAnsweredPendingUserInputQuestions(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("finds the first unanswered question", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("returns the last question index when all answers are complete", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
        compat: {
          customAnswer: "Keep it for one release window",
        },
      }),
    ).toBe(1);
  });

  it("derives the active question and advancement state", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        {
          scope: {
            selectedOptionLabels: ["Orchestration-first"],
          },
        },
        0,
      ),
    ).toMatchObject({
      questionIndex: 0,
      activeQuestion: questions[0],
      selectedOptionLabels: ["Orchestration-first"],
      customAnswer: "",
      resolvedAnswer: "Orchestration-first",
      answeredQuestionCount: 1,
      isLastQuestion: false,
      isComplete: false,
      canAdvance: true,
    });
  });

  it("treats multi-select questions as answered when they have selected options", () => {
    expect(
      derivePendingUserInputProgress(
        [multiSelectQuestion],
        {
          areas: {
            selectedOptionLabels: ["Server", "Web"],
          },
        },
        0,
      ),
    ).toMatchObject({
      selectedOptionLabels: ["Server", "Web"],
      resolvedAnswer: ["Server", "Web"],
      canAdvance: true,
      isComplete: true,
    });
  });
});

describe("pending user input Orca helpers and draft persistence (#430)", () => {
  const originalWindow = globalThis.window;
  afterEach(() => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      Object.defineProperty(globalThis, "window", {
        value: originalWindow,
        configurable: true,
        writable: true,
      });
    }
  });

  function installMemoryStorage(): Map<string, string> {
    const store = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return store.size;
      },
      key(index: number) {
        return Array.from(store.keys())[index] ?? null;
      },
      getItem(key: string) {
        return store.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        store.set(key, value);
      },
      removeItem(key: string) {
        store.delete(key);
      },
      clear() {
        store.clear();
      },
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: { localStorage: storage },
    });
    return store;
  }

  it("detects provider-sourced Recommended markers without false positives", () => {
    expect(
      isRecommendedUserInputOption({ label: "Workspace (Recommended)", description: "" }),
    ).toBe(true);
    expect(
      isRecommendedUserInputOption({
        label: "Workspace",
        description: "Keep changes in this repo (recommended)",
      }),
    ).toBe(true);
    expect(isRecommendedUserInputOption({ label: "Global", description: "Install globally" })).toBe(
      false,
    );
    expect(formatUserInputOptionLabel({ label: "Workspace (Recommended)", description: "" })).toBe(
      "Workspace",
    );
    expect(formatUserInputOptionLabel({ label: "Plain option", description: "" })).toBe(
      "Plain option",
    );
  });

  it("reports provider cancel capability accurately", () => {
    expect(providerSupportsPendingUserInputCancel("cursor")).toBe(true);
    expect(providerSupportsPendingUserInputCancel("opencode")).toBe(true);
    expect(providerSupportsPendingUserInputCancel("claudeAgent")).toBe(false);
    expect(providerSupportsPendingUserInputCancel("codex")).toBe(false);
    expect(providerSupportsPendingUserInputCancel("grok")).toBe(false);
    expect(providerSupportsPendingUserInputCancel(null)).toBe(false);
  });

  it("builds partial submissions with skipped or answered disposition", () => {
    const questions = [singleSelectQuestion, multiSelectQuestion];
    expect(buildPartialPendingUserInputSubmission(questions, {}, "skip")).toEqual({
      answers: {},
      disposition: "skipped",
    });
    expect(
      buildPartialPendingUserInputSubmission(
        questions,
        {
          scope: { selectedOptionLabels: ["Orchestration-first"] },
        },
        "skip",
      ),
    ).toEqual({
      answers: { scope: "Orchestration-first" },
      disposition: "skipped",
    });
    expect(
      buildPartialPendingUserInputSubmission(
        questions,
        {
          scope: { selectedOptionLabels: ["Orchestration-first"] },
          areas: { selectedOptionLabels: ["Server"] },
        },
        "submit",
      ),
    ).toEqual({
      answers: { scope: "Orchestration-first", areas: ["Server"] },
      disposition: "answered",
    });
  });

  it("persists, reloads, clears, and prunes question drafts by thread and request", () => {
    const store = installMemoryStorage();
    savePendingUserInputDraft("env:thread-1", "req-a", {
      scope: { selectedOptionLabels: ["Orchestration-first"] },
      notes: { customAnswer: "keep strict" },
    });
    savePendingUserInputDraft("env:thread-1", "req-b", {
      scope: { selectedOptionLabels: ["Other"] },
    });

    const loaded = loadPendingUserInputDraft("env:thread-1", "req-a");
    expect(loaded).toEqual({
      scope: { selectedOptionLabels: ["Orchestration-first"] },
      notes: { customAnswer: "keep strict" },
    });

    // Reopening after reload lands on the first unanswered question while keeping prior picks.
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(
        [singleSelectQuestion, multiSelectQuestion],
        loaded ?? {},
      ),
    ).toBe(1);

    prunePendingUserInputDraftsForThread("env:thread-1", new Set(["req-a"]));
    expect(loadPendingUserInputDraft("env:thread-1", "req-a")).toEqual(loaded);
    expect(loadPendingUserInputDraft("env:thread-1", "req-b")).toBeNull();

    clearPendingUserInputDraft("env:thread-1", "req-a");
    expect(store.size).toBe(0);
  });
});
