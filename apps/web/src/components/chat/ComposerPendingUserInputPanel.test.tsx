// @vitest-environment happy-dom

import { ApprovalRequestId, type UserInputQuestion } from "@bibcode/contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PendingUserInput } from "../../session-logic";
import { textSizesBelowTextXs } from "../../test/uiTypography";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

interface MountedTree {
  readonly container: HTMLDivElement;
  readonly root: Root;
}

const mountedTrees: MountedTree[] = [];

function question(
  id: string,
  options: ReadonlyArray<{ label: string; description?: string }>,
  overrides: Partial<UserInputQuestion> = {},
): UserInputQuestion {
  return {
    id,
    header: `Header ${id}`,
    question: `Question ${id}?`,
    options: options.map((option) => ({
      label: option.label,
      description: option.description ?? option.label,
    })),
    multiSelect: false,
    ...overrides,
  };
}

function prompt(...questions: UserInputQuestion[]): PendingUserInput {
  return {
    requestId: ApprovalRequestId.make("request-1"),
    createdAt: "2026-07-14T12:00:00.000Z",
    questions,
  };
}

async function mount(element: ReactElement): Promise<MountedTree> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const mounted = { container, root };
  mountedTrees.push(mounted);
  await act(async () => root.render(element));
  return mounted;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

function optionButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent?.includes(label),
  );
  expect(button).toBeDefined();
  return button!;
}

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof ComposerPendingUserInputPanel>> = {},
): ReactElement {
  return (
    <ComposerPendingUserInputPanel
      pendingUserInputs={[prompt(question("q1", [{ label: "Alpha" }, { label: "Beta" }]))]}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={vi.fn()}
      onAdvance={vi.fn()}
      {...overrides}
    />
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const mounted of mountedTrees.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("ComposerPendingUserInputPanel mounted behavior", () => {
  it("renders nothing without an active prompt or active question", async () => {
    const mounted = await mount(renderPanel({ pendingUserInputs: [] }));
    expect(mounted.container.textContent).toBe("");

    await act(async () => {
      mounted.root.render(renderPanel({ pendingUserInputs: [prompt()] }));
    });
    expect(mounted.container.textContent).toBe("");
  });

  it("renders progress, descriptions, selection state, and shortcuts", async () => {
    const questions = [
      question("q1", [{ label: "Alpha", description: "First choice" }, { label: "Beta" }]),
      question("q2", [{ label: "Gamma" }]),
    ];
    await mount(
      renderPanel({
        pendingUserInputs: [prompt(...questions)],
        answers: { q1: { selectedOptionLabels: ["Beta"] } },
      }),
    );

    expect(document.body.textContent).toContain("Awaiting user input: 2 questions");
    expect(document.body.textContent).toContain("Header q1");
    expect(document.body.textContent).toContain("Question q1?");
    expect(document.body.textContent).toContain("1 of 2");
    expect(document.body.textContent).toContain("First choice");
    expect(document.body.textContent).not.toContain("BetaBeta");
    expect(optionButton("Alpha").querySelector("kbd")?.textContent).toBe("1");
    expect(optionButton("Beta").querySelector("svg")).not.toBeNull();
  });

  it("follows the UI.md typography rules", async () => {
    await mount(
      renderPanel({
        pendingUserInputs: [
          prompt(
            question("q1", [{ label: "Alpha", description: "First choice" }], {
              multiSelect: true,
            }),
            question("q2", [{ label: "Gamma" }]),
          ),
        ],
      }),
    );

    expect(textSizesBelowTextXs(document.body.innerHTML)).toEqual([]);
    // The muted token is already the secondary colour; text must not dim it further.
    expect(document.body.innerHTML).not.toMatch(/text-muted-foreground\/\d+/);
  });

  it("optimistically selects a single option and advances once after the delay", async () => {
    const onToggleOption = vi.fn();
    const onAdvance = vi.fn();
    await mount(renderPanel({ onToggleOption, onAdvance }));

    await click(optionButton("Beta"));
    expect(onToggleOption).toHaveBeenCalledWith("q1", "Beta");
    expect(optionButton("Beta").querySelector("svg")).not.toBeNull();
    expect(onAdvance).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTime(200));
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it("replaces a pending single-select timer and uses the latest advance callback", async () => {
    const firstAdvance = vi.fn();
    const latestAdvance = vi.fn();
    const mounted = await mount(renderPanel({ onAdvance: firstAdvance }));

    await click(optionButton("Alpha"));
    await act(async () => {
      mounted.root.render(renderPanel({ onAdvance: latestAdvance }));
    });
    await click(optionButton("Beta"));
    await act(async () => vi.advanceTimersByTime(200));

    expect(firstAdvance).not.toHaveBeenCalled();
    expect(latestAdvance).toHaveBeenCalledTimes(1);
  });

  it("toggles multi-select options without auto-advancing", async () => {
    const onToggleOption = vi.fn();
    const onAdvance = vi.fn();
    const multi = question("multi", [{ label: "One" }, { label: "Two" }], {
      multiSelect: true,
    });
    await mount(
      renderPanel({
        pendingUserInputs: [prompt(multi)],
        onToggleOption,
        onAdvance,
      }),
    );

    expect(document.body.textContent).toContain("Select one or more options.");
    await click(optionButton("Two"));
    await act(async () => vi.advanceTimersByTime(500));

    expect(onToggleOption).toHaveBeenCalledWith("multi", "Two");
    expect(onAdvance).not.toHaveBeenCalled();
  });

  // The card stays mounted while the user moves through one prompt's questions, so option
  // selection must read the question and callback of the latest render, not the first.
  describe("after the active question or its callbacks change", () => {
    const single = question("q1", [{ label: "Alpha" }, { label: "Beta" }]);
    const multi = question("q2", [{ label: "One" }, { label: "Two" }], { multiSelect: true });

    it("toggles a later multi-select question from the keyboard without auto-advancing", async () => {
      const onToggleOption = vi.fn();
      const onAdvance = vi.fn();
      const props = { pendingUserInputs: [prompt(single, multi)], onToggleOption, onAdvance };
      const mounted = await mount(renderPanel(props));
      await act(async () => mounted.root.render(renderPanel({ ...props, questionIndex: 1 })));
      expect(document.body.textContent).toContain("Select one or more options.");

      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
      });
      await act(async () => vi.advanceTimersByTime(500));

      expect(onToggleOption).toHaveBeenCalledWith("q2", "Two");
      expect(onAdvance).not.toHaveBeenCalled();
    });

    it("toggles a later multi-select question on click without auto-advancing", async () => {
      const onToggleOption = vi.fn();
      const onAdvance = vi.fn();
      const props = { pendingUserInputs: [prompt(single, multi)], onToggleOption, onAdvance };
      const mounted = await mount(renderPanel(props));
      await act(async () => mounted.root.render(renderPanel({ ...props, questionIndex: 1 })));

      await click(optionButton("One"));
      await act(async () => vi.advanceTimersByTime(500));

      expect(onToggleOption).toHaveBeenCalledWith("q2", "One");
      expect(onAdvance).not.toHaveBeenCalled();
    });

    it("calls the latest option callback", async () => {
      const firstToggle = vi.fn();
      const latestToggle = vi.fn();
      const mounted = await mount(renderPanel({ onToggleOption: firstToggle }));
      await act(async () => mounted.root.render(renderPanel({ onToggleOption: latestToggle })));

      await act(async () => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
      });
      await click(optionButton("Beta"));

      expect(firstToggle).not.toHaveBeenCalled();
      expect(latestToggle.mock.calls).toEqual([
        ["q1", "Alpha"],
        ["q1", "Beta"],
      ]);
    });
  });

  it("supports number shortcuts while ignoring modifiers and editable targets", async () => {
    const onToggleOption = vi.fn();
    const onAdvance = vi.fn();
    await mount(renderPanel({ onToggleOption, onAdvance }));

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));
    });
    expect(onToggleOption).toHaveBeenCalledWith("q1", "Beta");

    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "1", ctrlKey: true, bubbles: true }),
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "9", bubbles: true }));
    expect(onToggleOption).toHaveBeenCalledTimes(1);

    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    document.body.append(editable);
    editable.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    expect(onToggleOption).toHaveBeenCalledTimes(1);

    await act(async () => vi.advanceTimersByTime(200));
    expect(onAdvance).toHaveBeenCalledTimes(1);
  });

  it("disables interactions while responding and omits shortcut badges after option nine", async () => {
    const onToggleOption = vi.fn();
    const options = Array.from({ length: 10 }, (_, index) => ({ label: `Option ${index + 1}` }));
    const activePrompt = prompt(question("many", options));
    await mount(
      renderPanel({
        pendingUserInputs: [activePrompt],
        respondingRequestIds: [activePrompt.requestId],
        onToggleOption,
      }),
    );

    expect(optionButton("Option 1").disabled).toBe(true);
    expect(optionButton("Option 10").querySelector("kbd")).toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    expect(onToggleOption).not.toHaveBeenCalled();
  });

  it("clears pending auto-advance work and removes its keydown listener when unmounted", async () => {
    const onAdvance = vi.fn();
    const onToggleOption = vi.fn();
    const addEventListener = vi.spyOn(document, "addEventListener");
    const removeEventListener = vi.spyOn(document, "removeEventListener");
    const mounted = await mount(renderPanel({ onAdvance, onToggleOption }));
    const keydownRegistration = addEventListener.mock.calls.find(([type]) => type === "keydown");
    expect(keydownRegistration).toBeDefined();
    const keydownHandler = keydownRegistration![1];
    await click(optionButton("Alpha"));

    await act(async () => mounted.root.unmount());
    mountedTrees.splice(mountedTrees.indexOf(mounted), 1);
    mounted.container.remove();
    await act(async () => vi.advanceTimersByTime(500));
    onToggleOption.mockClear();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "2", bubbles: true }));

    expect(onAdvance).not.toHaveBeenCalled();
    expect(removeEventListener).toHaveBeenCalledWith("keydown", keydownHandler);
    expect(onToggleOption).not.toHaveBeenCalled();
  });

  it("renders Recommended badges, in-card custom answer input for optionless questions, and navigation/skip/collapse/close controls (#430)", async () => {
    const onToggleOption = vi.fn();
    const onChangeCustomAnswer = vi.fn();
    const onAdvance = vi.fn();
    const onPreviousQuestion = vi.fn();
    const onSkipAndSubmit = vi.fn();
    const onToggleCollapsed = vi.fn();
    const onClose = vi.fn();

    const recommendedQuestion = question("q1", [
      { label: "Workspace (Recommended)", description: "Keep in repo" },
      { label: "Global", description: "Install everywhere" },
    ]);
    const freeformQuestion = question("q2", [], {
      header: "Filename",
      question: "Enter the output file name",
    });

    const mounted = await mount(
      renderPanel({
        pendingUserInputs: [prompt(recommendedQuestion, freeformQuestion)],
        questionIndex: 0,
        canCancel: true,
        onToggleOption,
        onChangeCustomAnswer,
        onAdvance,
        onPreviousQuestion,
        onSkipAndSubmit,
        onToggleCollapsed,
        onClose,
      }),
    );

    expect(document.body.textContent).toContain("Recommended");
    expect(document.body.textContent).not.toContain("Workspace (Recommended)");

    // Skip and submit invokes callback.
    await click(optionButton("Skip and submit"));
    expect(onSkipAndSubmit).toHaveBeenCalledTimes(1);

    // Close button invokes onClose when provider supports cancellation.
    const closeBtn = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Cancel questions"]',
    );
    expect(closeBtn).not.toBeNull();
    await click(closeBtn!);
    expect(onClose).toHaveBeenCalledTimes(1);

    // Non-cancelable providers collapse instead of cancelling on Close.
    await act(async () => {
      mounted.root.render(
        renderPanel({
          pendingUserInputs: [prompt(recommendedQuestion, freeformQuestion)],
          questionIndex: 1,
          canCancel: false,
          answers: {
            q1: { selectedOptionLabels: ["Workspace (Recommended)"] },
            q2: { customAnswer: "report.md" },
          },
          onToggleOption,
          onChangeCustomAnswer,
          onAdvance,
          onPreviousQuestion,
          onSkipAndSubmit,
          onToggleCollapsed,
          onClose,
        }),
      );
    });

    const input = document.querySelector<HTMLInputElement>("input[type='text']");
    expect(input).not.toBeNull();
    expect(input?.placeholder).toBe("Type your answer...");
    // Number shortcut inside the in-card input must not fire option selection.
    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    expect(onToggleOption).not.toHaveBeenCalled();

    // Enter inside the in-card input advances/submits when complete.
    await act(async () => {
      input!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onAdvance).toHaveBeenCalledTimes(1);

    // Back button navigates to previous question.
    await click(optionButton("Back"));
    expect(onPreviousQuestion).toHaveBeenCalledTimes(1);

    // Non-cancelable Close collapses rather than cancelling.
    const collapseCloseBtn = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse questions"]',
    );
    expect(collapseCloseBtn).not.toBeNull();
    await click(collapseCloseBtn!);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);

    // Collapsed mode renders compact reopen chip and preserves text-xs floor.
    await act(async () => {
      mounted.root.render(
        renderPanel({
          pendingUserInputs: [prompt(recommendedQuestion, freeformQuestion)],
          collapsed: true,
          onToggleCollapsed,
        }),
      );
    });
    expect(document.body.textContent).toContain("Awaiting user input: 2 questions");
    expect(textSizesBelowTextXs(document.body.innerHTML)).toEqual([]);
    const reopenBtn = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Open questions"]',
    );
    expect(reopenBtn).not.toBeNull();
    await click(reopenBtn!);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(2);
  });

  it("ignores digit shortcuts in the host pane when focus is inside a sibling chat surface", async () => {
    const onHostToggleOption = vi.fn();
    const onHostAdvance = vi.fn();
    const q = question("q1", [
      { label: "Alpha", description: "First" },
      { label: "Beta", description: "Second" },
    ]);

    await mount(
      <div>
        <button type="button" role="tab" id="split-pane-tab">
          Side chat tab
        </button>
        <div data-chat-surface="">
          {renderPanel({
            pendingUserInputs: [prompt(q)],
            shortcutsEnabled: true,
            onToggleOption: onHostToggleOption,
            onAdvance: onHostAdvance,
          })}
        </div>
        <div data-chat-surface="">
          <button type="button" id="side-chat-action">
            Side chat button
          </button>
        </div>
      </div>,
    );

    const sideButton = document.getElementById("side-chat-action") as HTMLButtonElement;
    expect(sideButton).not.toBeNull();
    await act(async () => {
      sideButton.focus();
      sideButton.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    expect(onHostToggleOption).not.toHaveBeenCalled();
    expect(onHostAdvance).not.toHaveBeenCalled();

    const splitTab = document.getElementById("split-pane-tab") as HTMLButtonElement;
    expect(splitTab).not.toBeNull();
    await act(async () => {
      splitTab.focus();
      splitTab.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
    });
    expect(onHostToggleOption).not.toHaveBeenCalled();
    expect(onHostAdvance).not.toHaveBeenCalled();
  });
});
