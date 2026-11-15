import { EnvironmentId, ProjectId, ThreadId, type TerminalSummary } from "@bibcode/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AgentRow } from "../sidebar/agentsSection.logic";
import { buildTakeOverContent, type HandoffLoader } from "./handoff.logic";
import {
  NOTHING_TO_ATTACH_REASON,
  resolveActionAvailability,
  type SendToAgentSource,
} from "./sendToAgent.logic";
import {
  isAiTerminal,
  makeTerminalOutputLoader,
  shouldActivateSendPanel,
  terminalAttachment,
  terminalBufferText,
  terminalHasText,
} from "./terminalSource.logic";

const ENVIRONMENT = EnvironmentId.make("environment-a");

const aiSummary = {
  agentStatus: { state: "idle", failed: false },
  command: { executable: "claude", args: [], activity: { provider: "claudeAgent" } },
} as unknown as TerminalSummary;

describe("isAiTerminal", () => {
  it("is true for a summary with an agent status and a launch activity", () => {
    expect(isAiTerminal(aiSummary)).toBe(true);
  });

  it("is false for a plain terminal, or one with only half of the markers", () => {
    expect(isAiTerminal({ command: { executable: "zsh", args: [] } })).toBe(false);
    expect(isAiTerminal({ agentStatus: aiSummary.agentStatus })).toBe(false);
    expect(isAiTerminal({ command: aiSummary.command })).toBe(false);
    expect(isAiTerminal(undefined)).toBe(false);
  });
});

describe("terminalAttachment", () => {
  const output = { text: "$ make test\nok", truncated: false, usedSource: "output" as const };

  it("prefers the selection and labels it as one", () => {
    expect(
      terminalAttachment({ selection: "line 1\nline 2", output, terminalLabel: "Claude" }),
    ).toMatchObject({ label: "Selection from Claude", text: "line 1\nline 2", leftOut: null });
  });

  it("falls back to the output, labelled by the source that was used", () => {
    expect(terminalAttachment({ selection: null, output, terminalLabel: "Claude" })).toMatchObject({
      label: "Recent output of Claude",
      text: "$ make test\nok",
    });
    expect(
      terminalAttachment({
        selection: "  ",
        output: { ...output, usedSource: "conversation" },
        terminalLabel: "Claude",
      })?.label,
    ).toBe("Conversation of Claude");
  });

  it("cuts at 16,000 characters and says how many were left out", () => {
    const attachment = terminalAttachment({
      selection: "x".repeat(16_005),
      output: null,
      terminalLabel: "Claude",
    });
    expect(attachment?.text).toHaveLength(16_000);
    expect(attachment?.leftOut).toBe("5 characters left out");
  });

  it("says when older output was left out by the server", () => {
    expect(
      terminalAttachment({
        selection: null,
        output: { ...output, truncated: true },
        terminalLabel: "Claude",
      })?.note,
    ).toBe("Only the most recent output is included.");
  });

  it("attaches nothing for empty text", () => {
    expect(terminalAttachment({ selection: null, output: null, terminalLabel: "T" })).toBeNull();
    expect(
      terminalAttachment({
        selection: "",
        output: { text: " \n", truncated: false, usedSource: "output" },
        terminalLabel: "T",
      }),
    ).toBeNull();
  });
});

describe("terminalHasText", () => {
  const source = (terminalHasTextValue: boolean): SendToAgentSource => ({
    environmentId: ENVIRONMENT,
    threadId: ThreadId.make("owner"),
    terminalId: "term-1",
    projectId: ProjectId.make("project-a"),
    title: "Claude",
    checkout: "/repo/a",
    messages: [],
    terminalHasText: terminalHasTextValue,
  });

  it("is false without a selection and output, and true with either", () => {
    expect(terminalHasText(null, null)).toBe(false);
    expect(terminalHasText("", { text: "  " })).toBe(false);
    expect(terminalHasText("picked", null)).toBe(true);
    expect(terminalHasText(null, { text: "out" })).toBe(true);
  });

  it("disables Second opinion and Hand off with the reason, and leaves the rest enabled", () => {
    const empty = source(terminalHasText(null, null));
    const availability = (action: Parameters<typeof resolveActionAvailability>[0]["action"]) =>
      resolveActionAvailability({ source: empty, action, serverSupported: true }).disabledReason;
    expect(availability("second-opinion")).toBe(NOTHING_TO_ATTACH_REASON);
    expect(availability("hand-off")).toBe(NOTHING_TO_ATTACH_REASON);
    expect(availability("review")).toBeNull();
    expect(availability("message")).toBeNull();
    expect(availability("take-over")).toBeNull();
  });
});

describe("makeTerminalOutputLoader", () => {
  const picked = {
    key: "owner#terminal:term-1",
    ref: { environmentId: ENVIRONMENT, threadId: ThreadId.make("owner") },
    shell: { title: "Claude" },
    terminalId: "term-1",
  } as unknown as AgentRow;

  const result = (overrides: Record<string, unknown> = {}) => ({
    threadId: ThreadId.make("owner"),
    terminalId: "term-1",
    text: "$ make test",
    truncated: false,
    usedSource: "conversation" as const,
    fellBack: false,
    startMissing: false,
    ...overrides,
  });

  it("the_loader_marks_a_readable_conversation", async () => {
    const read = vi.fn(() => Promise.resolve(result()));
    const loaded = await makeTerminalOutputLoader(read, ThreadId.make("source"))(picked);
    expect(read).toHaveBeenCalledWith({
      sourceThreadId: "source",
      threadId: "owner",
      terminalId: "term-1",
      source: "conversation",
      part: "handoff",
    });
    expect(loaded).toEqual({
      text: "$ make test",
      truncated: false,
      usedSource: "conversation",
      fellBack: false,
      startMissing: false,
    });
  });

  it("the_loader_marks_an_unreadable_conversation", async () => {
    const read = () => Promise.resolve(result({ usedSource: "output", fellBack: true }));
    const loaded = await makeTerminalOutputLoader(read, ThreadId.make("source"))(picked);
    expect(loaded).toMatchObject({ usedSource: "output", fellBack: true });
  });

  it("feeds Take over from, whose preview label follows the source used", async () => {
    const read = () => Promise.resolve(result({ usedSource: "output", fellBack: true }));
    const content = buildTakeOverContent({
      source: {
        environmentId: ENVIRONMENT,
        threadId: ThreadId.make("source"),
        terminalId: null,
        projectId: ProjectId.make("project-a"),
        title: "Mine",
        checkout: "/repo/a",
        messages: [],
        terminalHasText: false,
      },
      picked,
      loadHandoff: vi.fn<HandoffLoader>(),
      loadTerminalOutput: makeTerminalOutputLoader(read, ThreadId.make("source")),
    });
    const attachments = (await content.loadAttachments?.()) ?? [];
    expect(attachments[0]).toMatchObject({
      label: "Recent terminal output",
      text: "$ make test",
    });
  });
});

describe("shouldActivateSendPanel", () => {
  const host = ThreadId.make("host");

  it("keeps the source open when activating the panel would unmount it", () => {
    // A center terminal and a panel that is not the host both lose their preview to activation.
    expect(shouldActivateSendPanel({ hostThreadId: null, sourceUnmountsOnActivate: true })).toBe(
      false,
    );
    expect(shouldActivateSendPanel({ hostThreadId: host, sourceUnmountsOnActivate: false })).toBe(
      false,
    );
  });

  it("activates the new panel for a send from the host's own chat", () => {
    expect(shouldActivateSendPanel({ hostThreadId: null, sourceUnmountsOnActivate: false })).toBe(
      true,
    );
  });
});

type FakeRow = string | { text: string; wrapped: true };
function fakeBuffer(type: "normal" | "alternate", rows: ReadonlyArray<FakeRow>) {
  const lines = rows.map((row) => (typeof row === "string" ? { text: row, wrapped: false } : row));
  return {
    type,
    length: lines.length,
    getLine: (index: number) => {
      const line = lines[index];
      return line === undefined
        ? undefined
        : {
            isWrapped: "wrapped" in line && line.wrapped === true,
            translateToString: (trimRight?: boolean) =>
              trimRight === true ? line.text.trimEnd() : line.text.padEnd(20, " "),
          };
    },
  };
}

describe("terminalBufferText", () => {
  it("a_repainting_tui_gives_clean_lines_from_the_rendered_buffer", () => {
    // The raw stream of this screen reads "identifyth erminal"; the rendered rows are clean.
    const buffer = fakeBuffer("normal", ["> identify the terminal", "", "conversation ok", "", ""]);
    expect(terminalBufferText(buffer)).toEqual({
      text: "> identify the terminal\n\nconversation ok",
      truncated: false,
      usedSource: "output",
    });
  });

  it("wrapped_rows_are_joined_into_one_line", () => {
    const buffer = fakeBuffer("normal", [
      "a long line that is",
      { text: "wrapped here", wrapped: true },
      "next",
    ]);
    expect(terminalBufferText(buffer).text).toBe("a long line that is wrapped here\nnext");
  });

  it("the_end_is_kept_at_the_limit_and_truncated_is_set", () => {
    const rows = Array.from({ length: 5 }, (_, index) => `${index}`.repeat(10));
    const { text, truncated } = terminalBufferText(fakeBuffer("normal", rows), 25);
    expect(Array.from(text)).toHaveLength(25);
    expect(text.endsWith("4444444444")).toBe(true);
    expect(truncated).toBe(true);
  });

  it("the_alternate_buffer_yields_the_visible_screen_and_says_older_output_is_missing", () => {
    const buffer = fakeBuffer("alternate", ["menu", "", "selected: one", ""]);
    expect(terminalBufferText(buffer)).toEqual({
      text: "menu\n\nselected: one",
      truncated: true,
      usedSource: "output",
    });
  });

  it("an_empty_screen_gives_empty_text", () => {
    expect(terminalBufferText(fakeBuffer("normal", ["", ""])).text).toBe("");
  });
});
