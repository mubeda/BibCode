// @effect-diagnostics nodeBuiltinImport:off - Execute actual owned shim source against inert stdio ports only.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";
import {
  cursorQuestionFixturePrompt,
  cursorQuestionFixtureSelection,
  extendOwnedCursorQuestionFixture,
} from "./release-visual-cursor-question-fixture.ts";

function originalCursor() {
  const source = NodeFS.readFileSync(new URL("./test-project.ts", import.meta.url), "utf8");
  const start = source.indexOf("const cursorFixtureSource = String.raw`");
  const end = source.indexOf("const grokFixtureSource", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return NodeVM.runInNewContext(source.slice(start, end) + "\ncursorFixtureSource") as string;
}

function inertChild(
  source: string,
  env: Record<string, string> = {
    CI: "true",
    BIBCODE_E2E_CURSOR_QUESTION_FIXTURE: cursorQuestionFixtureSelection,
  },
) {
  const frames: Array<Record<string, unknown>> = [];
  const inputs: string[] = [];
  let receiveLine = (_line: string) => {};
  const shimSource = NodeFS.readFileSync(new URL("./test-project.ts", import.meta.url), "utf8");
  const textStart = shimSource.indexOf("export function promptTextFromParts(parts) {");
  const textEnd = shimSource.indexOf("export function appendProviderInput", textStart);
  const promptTextFromParts = NodeVM.runInNewContext(
    shimSource.slice(textStart, textEnd).replace(/^export /gm, "") + "\npromptTextFromParts",
  );
  NodeVM.runInNewContext(source.replace(/^import .*;\n/gm, ""), {
    process: {
      argv: [],
      env,
      stdout: { write: (value: string) => frames.push(JSON.parse(value)) },
    },
    readline: {
      createInterface: () => ({
        on: (_name: string, fn: typeof receiveLine) => {
          receiveLine = fn;
        },
      }),
    },
    promptTextFromParts,
    appendProviderInput: (_provider: string, input: string) => inputs.push(input),
  });
  return {
    frames,
    inputs,
    raw: (line: string) => receiveLine(line),
    receive: (message: unknown) => receiveLine(JSON.stringify(message)),
  };
}

const start = (child: ReturnType<typeof inertChild>) => {
  child.receive({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
  child.receive({
    jsonrpc: "2.0",
    id: 2,
    method: "session/prompt",
    params: {
      sessionId: "bibcode-ui-cursor-session",
      prompt: [{ type: "text", text: cursorQuestionFixturePrompt }],
    },
  });
};

describe("owned opt-in Cursor later question fixture", () => {
  it("keeps one original prompt pending for first single and later multiple choices", () => {
    const child = inertChild(
      extendOwnedCursorQuestionFixture(originalCursor(), cursorQuestionFixtureSelection),
    );
    start(child);
    const question = child.frames.find((frame) => frame.method === "cursor/ask_question")!;
    expect(question).toBeDefined();
    expect(question.jsonrpc).toBe("2.0");
    expect(question.params).toEqual({
      sessionId: "bibcode-ui-cursor-session",
      questions: [
        {
          id: "first",
          prompt: "Choose the first scope.",
          allowMultiple: false,
          options: [
            { id: "workspace", label: "Workspace" },
            { id: "project", label: "Project" },
          ],
        },
        {
          id: "later",
          prompt: "Choose the later checks.",
          allowMultiple: true,
          options: [
            { id: "tests", label: "Tests" },
            { id: "docs", label: "Docs" },
            { id: "types", label: "Types" },
          ],
        },
      ],
    });
    expect(child.frames.filter((frame) => frame.id === 2)).toEqual([]);
    child.receive({
      jsonrpc: "2.0",
      id: question.id,
      result: { answers: { first: "Workspace", later: ["Tests", "Docs"] } },
    });
    expect(child.frames.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { stopReason: "end_turn" },
    });
    expect(child.inputs).toEqual([cursorQuestionFixturePrompt]);
  });

  it("binds the original wire question to both owned session and prompt correlation", () => {
    const source = extendOwnedCursorQuestionFixture(
      originalCursor(),
      cursorQuestionFixtureSelection,
    );
    const first = inertChild(source),
      second = inertChild(source);
    start(first);
    second.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "session/load",
      params: { sessionId: "other-owned-session" },
    });
    second.receive({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: {
        sessionId: "other-owned-session",
        prompt: [{ type: "text", text: cursorQuestionFixturePrompt }],
      },
    });
    const firstId = first.frames.find((frame) => frame.method === "cursor/ask_question")!.id;
    const secondId = second.frames.find((frame) => frame.method === "cursor/ask_question")!.id;
    expect(secondId).not.toBe(firstId);
    expect(() =>
      second.receive({
        jsonrpc: "2.0",
        id: firstId,
        result: { answers: { first: "Workspace", later: ["Tests", "Docs"] } },
      }),
    ).toThrow("Owned Cursor question fixture refused.");
    expect(second.frames.some((frame) => frame.id === 3)).toBe(false);
  });

  it.each([
    { firstSession: "owned:a", firstId: "b", secondSession: "owned", secondId: "a:b" },
    { firstSession: "owned", firstId: 2, secondSession: "owned", secondId: "2" },
  ])(
    "keeps distinct valid session/correlation tuples distinct on the original wire",
    ({ firstSession, firstId, secondSession, secondId }) => {
      const source = extendOwnedCursorQuestionFixture(
        originalCursor(),
        cursorQuestionFixtureSelection,
      );
      const request = (sessionId: string, id: string | number) => {
        const child = inertChild(source);
        child.receive({ jsonrpc: "2.0", id: 1, method: "session/load", params: { sessionId } });
        child.receive({
          jsonrpc: "2.0",
          id,
          method: "session/prompt",
          params: { sessionId, prompt: [{ type: "text", text: cursorQuestionFixturePrompt }] },
        });
        return child.frames.find((frame) => frame.method === "cursor/ask_question")!.id;
      };
      expect(request(firstSession, firstId)).not.toBe(request(secondSession, secondId));
    },
  );

  it("keeps default bytes and ordinary owned session behavior unchanged", () => {
    const source = originalCursor();
    expect(extendOwnedCursorQuestionFixture(source)).toBe(source);
    const original = inertChild(source),
      selected = inertChild(
        extendOwnedCursorQuestionFixture(source, cursorQuestionFixtureSelection),
      );
    const messages = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "authenticate", params: { methodId: "cursor_login" } },
      { jsonrpc: "2.0", id: 3, method: "cursor/list_available_models", params: {} },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "session/load",
        params: { sessionId: "owned-resumed-session" },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "session/set_mode",
        params: { sessionId: "owned-resumed-session", modeId: "ask" },
      },
      { jsonrpc: "2.0", id: 6, method: "session/set_config_option", params: {} },
      {
        jsonrpc: "2.0",
        id: 7,
        method: "session/prompt",
        params: {
          sessionId: "owned-resumed-session",
          prompt: [{ type: "text", text: "ordinary owned prompt" }],
        },
      },
      { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "owned-resumed-session" } },
    ];
    for (const message of messages) {
      original.receive(message);
      selected.receive(message);
    }
    expect(selected.frames).toEqual(original.frames);
    expect(selected.inputs).toEqual(original.inputs);
  });

  it("accepts the real frontend's retained first answer and multiple selected labels", () => {
    const source = NodeFS.readFileSync(
      new URL("../../../web/src/pendingUserInput.ts", import.meta.url),
      "utf8",
    );
    const buildAnswers = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(source)
        .replace(/^import[^\n]+\n/gm, "")
        .replace(/^export /gm, "") + "\nbuildPendingUserInputAnswers",
    );
    const child = inertChild(
      extendOwnedCursorQuestionFixture(originalCursor(), cursorQuestionFixtureSelection),
    );
    start(child);
    const question = child.frames.find((frame) => frame.method === "cursor/ask_question")!;
    const questions = (
      question.params as { questions: Array<{ id: string; allowMultiple: boolean }> }
    ).questions;
    // The actual Cursor adapter maps the native allowMultiple flag to this public contract.
    const publicQuestions = questions.map((entry) => ({
      ...entry,
      multiSelect: entry.allowMultiple,
    }));
    const answers = buildAnswers(publicQuestions, {
      first: { selectedOptionLabels: ["Project"] },
      later: { selectedOptionLabels: ["Docs", "Types"] },
    });
    expect(answers).toEqual({ first: "Project", later: ["Docs", "Types"] });
    child.receive({ jsonrpc: "2.0", id: question.id, result: { answers } });
    expect(child.frames.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { stopReason: "end_turn" },
    });
  });

  it("joins the existing original-wire cancellation response and session notification", () => {
    const child = inertChild(
      extendOwnedCursorQuestionFixture(originalCursor(), cursorQuestionFixtureSelection),
    );
    start(child);
    const question = child.frames.find((frame) => frame.method === "cursor/ask_question")!;
    child.receive({ jsonrpc: "2.0", id: question.id, result: { outcome: "cancelled" } });
    expect(child.frames.some((frame) => frame.id === 2)).toBe(false);
    child.receive({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "bibcode-ui-cursor-session" },
    });
    expect(child.frames.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { stopReason: "cancelled" },
    });
    expect(() =>
      child.receive({
        jsonrpc: "2.0",
        id: question.id,
        result: { answers: { first: "Workspace", later: ["Tests", "Docs"] } },
      }),
    ).toThrow("Owned Cursor question fixture refused.");
  });

  const invalidReplies = [
    (id: unknown) => ({
      jsonrpc: "2.0",
      id: "stale-question",
      result: { answers: { first: "Workspace", later: ["Tests", "Docs"] } },
    }),
    (id: unknown) => ({
      jsonrpc: "2.0",
      id,
      result: { answers: { first: "Workspace", later: ["Tests"] } },
    }),
    (id: unknown) => ({
      jsonrpc: "2.0",
      id,
      result: { answers: { first: "Workspace", later: ["Tests", "Tests"] } },
    }),
    (id: unknown) => ({
      jsonrpc: "2.0",
      id,
      result: { answers: { first: "foreign", later: ["Tests", "Docs"] } },
    }),
    (id: unknown) => ({
      jsonrpc: "2.0",
      id,
      result: { answers: { first: "Workspace", later: ["Tests", "foreign"] } },
    }),
    (id: unknown) => ({
      jsonrpc: "2.0",
      id,
      result: { answers: { first: "Workspace", later: "Tests, Docs" } },
    }),
    (id: unknown) => ({
      jsonrpc: "2.0",
      id,
      result: { answers: { first: "Workspace", later: ["Tests", "Docs"], other: "foreign" } },
    }),
    (id: unknown) => ({ jsonrpc: "2.0", id, result: { answers: { later: ["Tests", "Docs"] } } }),
    (id: unknown) => ({ jsonrpc: "2.0", id, error: { code: -1 } }),
    (id: unknown) => ({
      jsonrpc: "2.0",
      id,
      result: { answers: { first: "Workspace", later: ["Tests", "Docs"] } },
      params: { sessionId: "foreign" },
    }),
  ];
  it.each(invalidReplies.map((reply, index) => ({ reply, index })))(
    "refuses invalid reply $index without completing the original prompt",
    ({ reply }) => {
      const child = inertChild(
        extendOwnedCursorQuestionFixture(originalCursor(), cursorQuestionFixtureSelection),
      );
      start(child);
      const id = child.frames.find((frame) => frame.method === "cursor/ask_question")!.id;
      expect(() => child.receive(reply(id))).toThrow("Owned Cursor question fixture refused.");
      expect(child.frames.some((frame) => frame.id === 2)).toBe(false);
    },
  );

  it("refuses duplicate completed replies and replacement sessions while pending", () => {
    const child = inertChild(
      extendOwnedCursorQuestionFixture(originalCursor(), cursorQuestionFixtureSelection),
    );
    start(child);
    expect(() =>
      child.receive({
        jsonrpc: "2.0",
        id: 3,
        method: "session/load",
        params: { sessionId: "foreign" },
      }),
    ).toThrow("Owned Cursor question fixture refused.");
    const complete = inertChild(
      extendOwnedCursorQuestionFixture(originalCursor(), cursorQuestionFixtureSelection),
    );
    start(complete);
    const id = complete.frames.find((frame) => frame.method === "cursor/ask_question")!.id;
    const reply = {
      jsonrpc: "2.0",
      id,
      result: { answers: { first: "Workspace", later: ["Tests", "Docs"] } },
    };
    complete.receive(reply);
    expect(() => complete.receive(reply)).toThrow("Owned Cursor question fixture refused.");
    expect(complete.frames.filter((frame) => frame.id === 2)).toHaveLength(1);
  });

  it.each([
    {
      label: "foreign prompt session",
      message: {
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId: "foreign",
          prompt: [{ type: "text", text: cursorQuestionFixturePrompt }],
        },
      },
    },
    {
      label: "second pending prompt",
      message: {
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId: "bibcode-ui-cursor-session",
          prompt: [{ type: "text", text: "ordinary prompt" }],
        },
      },
    },
    {
      label: "duplicate client correlation",
      message: { jsonrpc: "2.0", id: 2, method: "initialize", params: {} },
    },
    {
      label: "premature cancellation",
      message: {
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: "bibcode-ui-cursor-session" },
      },
    },
    {
      label: "foreign cancellation",
      message: { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "foreign" } },
    },
  ])("refuses $label while retaining original prompt correlation", ({ message }) => {
    const child = inertChild(
      extendOwnedCursorQuestionFixture(originalCursor(), cursorQuestionFixtureSelection),
    );
    start(child);
    expect(() => child.receive(message)).toThrow("Owned Cursor question fixture refused.");
    expect(child.frames.some((frame) => frame.id === 2)).toBe(false);
    expect(child.inputs).toEqual([cursorQuestionFixturePrompt]);
  });

  it("refuses a second opted-in turn after the first one completed", () => {
    const child = inertChild(
      extendOwnedCursorQuestionFixture(originalCursor(), cursorQuestionFixtureSelection),
    );
    start(child);
    const id = child.frames.find((frame) => frame.method === "cursor/ask_question")!.id;
    child.receive({
      jsonrpc: "2.0",
      id,
      result: { answers: { first: "Workspace", later: ["Tests", "Docs"] } },
    });
    expect(() =>
      child.receive({
        jsonrpc: "2.0",
        id: 3,
        method: "session/prompt",
        params: {
          sessionId: "bibcode-ui-cursor-session",
          prompt: [{ type: "text", text: cursorQuestionFixturePrompt }],
        },
      }),
    ).toThrow("Owned Cursor question fixture refused.");
    expect(child.frames.filter((frame) => frame.method === "cursor/ask_question")).toHaveLength(1);
  });

  it.each([
    {},
    { CI: "false", BIBCODE_E2E_CURSOR_QUESTION_FIXTURE: cursorQuestionFixtureSelection },
    { CI: "true", BIBCODE_E2E_CURSOR_QUESTION_FIXTURE: "foreign" },
  ])("refuses absent or foreign CI selection", (env) => {
    expect(() =>
      inertChild(
        extendOwnedCursorQuestionFixture(originalCursor(), cursorQuestionFixtureSelection),
        env,
      ),
    ).toThrow("Owned Cursor question fixture refused.");
  });

  it.each(["", "question-multiselect", "foreign"])(
    "refuses unknown generator selection",
    (selection) => {
      expect(() => extendOwnedCursorQuestionFixture(originalCursor(), selection)).toThrow(
        "Owned Cursor question fixture refused.",
      );
    },
  );

  it("bounds source, frames and calls while containing malformed input", () => {
    const source = originalCursor();
    for (const changed of [
      source.replace('appendProviderInput("cursor"', 'appendProviderInput("foreign"'),
      source + '\nreader.on("line", (line) => {',
      source + " ".repeat(65_536),
    ]) {
      expect(() =>
        extendOwnedCursorQuestionFixture(changed, cursorQuestionFixtureSelection),
      ).toThrow("Owned Cursor question fixture refused.");
    }
    const extended = extendOwnedCursorQuestionFixture(source, cursorQuestionFixtureSelection);
    expect(() =>
      extendOwnedCursorQuestionFixture(extended, cursorQuestionFixtureSelection),
    ).toThrow("Owned Cursor question fixture refused.");
    for (const line of ["{", "null", "[]", " ".repeat(16_385)]) {
      const child = inertChild(extended);
      expect(() => child.raw(line)).toThrow("Owned Cursor question fixture refused.");
      expect(child.frames).toEqual([]);
    }
    const bounded = inertChild(extended);
    for (let id = 1; id <= 128; id++)
      bounded.receive({ jsonrpc: "2.0", id, method: "initialize", params: {} });
    expect(() =>
      bounded.receive({ jsonrpc: "2.0", id: 129, method: "initialize", params: {} }),
    ).toThrow("Owned Cursor question fixture refused.");
    expect(bounded.frames).toHaveLength(128);
  });
});
