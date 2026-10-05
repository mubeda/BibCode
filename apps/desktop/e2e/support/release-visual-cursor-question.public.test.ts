// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Actual question components/callbacks run with inert stdio and geometry ports.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import * as NodeURL from "node:url";
import { expect, it, vi } from "vite-plus/test";
import {
  cursorQuestionFixturePrompt,
  cursorQuestionFixtureSelection,
  extendOwnedCursorQuestionFixture,
} from "./release-visual-cursor-question-fixture.ts";
import {
  runCursorQuestionVisual,
  readCursorQuestionObservation,
  validateCursorQuestionWitness,
} from "./release-visual-cursor-question.ts";

it("runs the public first/later/Submit sequence on actual components and original native fixture reply", async () => {
  const require = NodeModule.createRequire(NodePath.resolve("apps/web/package.json"));
  const { act, createElement, useState } = require("react") as {
    act: (run: () => void | Promise<void>) => Promise<void>;
    createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown;
    useState: <T>(value: T) => [T, (value: T | ((current: T) => T)) => void];
  };
  const { createRoot } = require("react-dom/client") as {
    createRoot: (node: Element) => { render: (value: unknown) => void; unmount: () => void };
  };
  const panelPath = "../../../web/src/components/chat/ComposerPendingUserInputPanel.tsx";
  const actionPath = "../../../web/src/components/chat/ComposerPrimaryActions.tsx";
  const { ComposerPendingUserInputPanel } = await import(panelPath);
  const { ComposerPrimaryActions } = await import(actionPath);
  const source = NodeFS.readFileSync(new NodeURL.URL("./test-project.ts", import.meta.url), "utf8");
  const start = source.indexOf("const cursorFixtureSource = String.raw`");
  const end = source.indexOf("const grokFixtureSource", start);
  const original = NodeVM.runInNewContext(source.slice(start, end) + "\ncursorFixtureSource");
  const textStart = source.indexOf("export function promptTextFromParts(parts) {");
  const textEnd = source.indexOf("export function appendProviderInput", textStart);
  const promptTextFromParts = NodeVM.runInNewContext(
    source.slice(textStart, textEnd).replace(/^export /gm, "") + "\npromptTextFromParts",
  );
  const frames: Array<Record<string, any>> = [];
  let receive = (_line: string) => {};
  NodeVM.runInNewContext(
    extendOwnedCursorQuestionFixture(original, cursorQuestionFixtureSelection).replace(
      /^import .*;\n/gm,
      "",
    ),
    {
      process: {
        argv: [],
        env: { CI: "true", BIBCODE_E2E_CURSOR_QUESTION_FIXTURE: cursorQuestionFixtureSelection },
        stdout: { write: (line: string) => frames.push(JSON.parse(line)) },
      },
      readline: {
        createInterface: () => ({
          on: (_event: string, callback: typeof receive) => {
            receive = callback;
          },
        }),
      },
      promptTextFromParts,
      appendProviderInput: () => {},
    },
  );
  receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} }));
  receive(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: {
        sessionId: "bibcode-ui-cursor-session",
        prompt: [{ type: "text", text: cursorQuestionFixturePrompt }],
      },
    }),
  );
  const wire = frames.find((frame) => frame.method === "cursor/ask_question")!;
  expect(wire).toBeDefined();
  // Native-to-public mapping is separately exercised through the actual CursorSessionRuntime.
  const questions = wire.params.questions.map((question: any) => ({
    id: question.id,
    header: "Question",
    question: question.prompt,
    multiSelect: question.allowMultiple,
    options: question.options.map((option: any) => ({
      label: option.label,
      description: option.label,
    })),
  }));
  const logicSource = NodeFS.readFileSync(
    new NodeURL.URL("../../../web/src/pendingUserInput.ts", import.meta.url),
    "utf8",
  );
  const logic = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(logicSource)
      .replace(/^import[^\n]+\n/gm, "")
      .replace(/^export /gm, "") +
      "\n({derivePendingUserInputProgress,buildPendingUserInputAnswers,togglePendingUserInputOptionSelection})",
  );
  const viewSource = NodeFS.readFileSync(
    new NodeURL.URL("../../../web/src/components/ChatView.tsx", import.meta.url),
    "utf8",
  );
  const toggleStart = viewSource.indexOf(
    "  const onSelectActivePendingUserInputOption = useCallback(",
  );
  const toggleEnd = viewSource.indexOf(
    "  const onChangeActivePendingUserInputCustomAnswer",
    toggleStart,
  );
  const advanceStart = viewSource.indexOf("  const onAdvanceActivePendingUserInput = useCallback(");
  const advanceEnd = viewSource.indexOf(
    "  const onPreviousActivePendingUserInputQuestion",
    advanceStart,
  );
  const callbacks = (scope: object) =>
    NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        viewSource.slice(toggleStart, toggleEnd) + viewSource.slice(advanceStart, advanceEnd),
      ) + "\n({onSelectActivePendingUserInputOption,onAdvanceActivePendingUserInput})",
      {
        ...scope,
        useCallback: (callback: unknown) => callback,
        togglePendingUserInputOptionSelection: logic.togglePendingUserInputOptionSelection,
      },
    );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("location", {
    origin: "http://127.0.0.1:4885",
    pathname: "/local/owned",
    search: "",
    hash: "",
  });
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 960);
  vi.useFakeTimers();
  document.documentElement.className = "";
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const replies: unknown[] = [];
  let completed = false;
  function Harness() {
    const [byRequest, setByRequest] = useState<Record<string, Record<string, unknown>>>({});
    const [index, setIndex] = useState(0);
    const [resolved, setResolved] = useState(false);
    const prompt = { requestId: wire.id, createdAt: "2026-10-05T00:00:00Z", questions };
    const answers = byRequest[wire.id] ?? {};
    const progress = logic.derivePendingUserInputProgress(questions, answers, index);
    const controls = callbacks({
      activePendingUserInput: prompt,
      activePendingProgress: progress,
      activePendingResolvedAnswers: logic.buildPendingUserInputAnswers(questions, answers),
      setPendingUserInputAnswersByRequestId: setByRequest,
      promptRef: { current: "" },
      composerRef: { current: { resetCursorState: () => {} } },
      setActivePendingUserInputQuestionIndex: setIndex,
      onRespondToUserInput: (_request: unknown, answer: unknown) => {
        replies.push(answer);
        receive(JSON.stringify({ jsonrpc: "2.0", id: wire.id, result: { answers: answer } }));
        completed = true;
        setResolved(true);
      },
    });
    return createElement(
      "div",
      null,
      createElement(
        "div",
        { "data-testid": "environment-rail-local", "aria-checked": "true" },
        createElement("i", { "data-status": "connected" }),
      ),
      createElement("button", {
        "data-testid": "thread-card-button-owned",
        "aria-current": "page",
      }),
      createElement(
        "div",
        { "data-center-surface-host": "chat:owned", "data-visible": "true" },
        createElement("div", { "data-message-role": "user" }, cursorQuestionFixturePrompt),
        createElement(
          "form",
          {
            "data-chat-composer-form": "true",
            onSubmit: (event: { preventDefault: () => void }) => {
              event.preventDefault();
              controls.onAdvanceActivePendingUserInput();
            },
          },
          createElement(
            "button",
            {
              type: "button",
              "data-chat-provider-model-picker": "true",
              "aria-label": "Cursor · Cursor Fixture",
            },
            "Cursor Fixture",
          ),
          createElement(ComposerPendingUserInputPanel, {
            pendingUserInputs: resolved ? [] : [prompt],
            respondingRequestIds: [],
            answers,
            questionIndex: index,
            onToggleOption: controls.onSelectActivePendingUserInputOption,
            onAdvance: controls.onAdvanceActivePendingUserInput,
          }),
          createElement(ComposerPrimaryActions, {
            compact: false,
            pendingAction: progress,
            isRunning: !resolved,
            showPlanFollowUpPrompt: false,
            promptHasText: false,
            isSendBusy: false,
            isConnecting: false,
            isEnvironmentUnavailable: false,
            isPreparingWorktree: false,
            hasSendableContent: false,
            onPreviousPendingQuestion: () => {},
            onInterrupt: () => {},
            onImplementPlanInNewThread: () => {},
          }),
        ),
      ),
    );
  }
  let last: Element | null = null;
  const bounds = function (this: Element) {
    last = this;
    return new DOMRect(10, 10, 300, 200);
  };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(bounds);
  vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockImplementation(bounds);
  // Ideal geometry only: after resolution the original form is the unobstructed owned target.
  vi.spyOn(document, "elementFromPoint").mockImplementation(() =>
    completed ? document.querySelector('[data-chat-composer-form="true"]') : last,
  );
  const observe = (phase: "later" | "quiescent") =>
    readCursorQuestionObservation({
      phase,
      theme: "light",
      origin: location.origin,
      threadId: "owned",
      branch: "codex/delivery-retry-light",
    });
  const resolve = (selector: string) => {
    if (selector.startsWith("//")) {
      const label = /normalize-space\(\)="(Workspace|Tests|Docs)"/.exec(selector)?.[1];
      expect(label).toBeDefined();
      return Array.from(
        document.querySelectorAll<HTMLButtonElement>('[data-chat-composer-form="true"] button'),
      ).filter((button) => button.querySelector("span")?.textContent?.trim() === label);
    }
    return Array.from(document.querySelectorAll<HTMLButtonElement>(selector));
  };
  try {
    await act(async () => root.render(createElement(Harness)));
    let captured = 0,
      restored = 0;
    await runCursorQuestionVisual({
      browser: {
        $: (selector: string) => ({
          waitForDisplayed: async () => {
            await act(async () => {
              await vi.advanceTimersByTimeAsync(200);
            });
            expect(resolve(selector)).toHaveLength(1);
          },
          waitForEnabled: async () => expect(resolve(selector)[0]!.disabled).toBe(false),
          click: async () => act(async () => resolve(selector)[0]!.click()),
        }),
        $$: async (selector: string) => resolve(selector),
      } as never,
      owner: { cleanup: async (_role: string, run: () => Promise<void>) => run() } as never,
      verifyOwnedIdentity: async () => {},
      selectCursor: async () => {},
      restoreOriginal: async () => {
        restored++;
      },
      send: async () => {},
      capture: async () => {
        expect(replies).toHaveLength(0);
        const witnessed = observe("later");
        expect(witnessed).toMatchObject({
          themeMatched: true,
          selectedMatched: true,
          expectedTextMatched: true,
          targetInView: true,
          credentialAbsent: true,
          bootShellAbsent: true,
          providerMatched: true,
          laterQuestion: true,
          twoChoices: true,
          explicitSubmit: true,
        });
        validateCursorQuestionWitness("later", witnessed);
        captured++;
      },
      waitOriginalTurnCompleted: async () => {
        expect(completed).toBe(true);
        const form = document.querySelector('[data-chat-composer-form="true"]')!;
        const box = form.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        let contained = true;
        for (let ancestor = form.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor),
            clip = ancestor.getBoundingClientRect();
          if (
            ["hidden", "clip", "auto", "scroll"].includes(style.overflowX) &&
            (box.x < clip.x || box.right > clip.right)
          )
            contained = false;
          if (
            ["hidden", "clip", "auto", "scroll"].includes(style.overflowY) &&
            (box.y < clip.y || box.bottom > clip.bottom)
          )
            contained = false;
        }
        expect({
          positive: box.width > 0 && box.height > 0,
          viewport:
            box.x >= 0 && box.y >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
          hit: hit === form || form.contains(hit),
          contained,
        }).toEqual({ positive: true, viewport: true, hit: true, contained: true });
        const observed = observe("quiescent");
        expect(observed).toEqual({
          themeMatched: true,
          selectedMatched: true,
          expectedTextMatched: true,
          targetInView: true,
          credentialAbsent: true,
          bootShellAbsent: true,
          providerMatched: true,
          turnQuiescent: true,
        });
        validateCursorQuestionWitness("quiescent", observed);
      },
      step: () => {},
    });
    expect(captured).toBe(1);
    expect(restored).toBe(1);
    expect(replies).toEqual([{ first: "Workspace", later: ["Tests", "Docs"] }]);
    expect(frames.at(-1)).toEqual({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
