import { EnvironmentId, ProjectId, ThreadId } from "@bibcode/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { AgentRow } from "../sidebar/agentsSection.logic";
import {
  buildHandOffContent,
  buildTakeOverContent,
  formatLeftOutMessages,
  HAND_OFF_LEAD_IN,
  resolveRequestRoles,
  TAKE_OVER_LEAD_IN,
  type HandoffLoader,
  type TerminalOutputLoader,
} from "./handoff.logic";
import {
  TERMINAL_OUTPUT_LOAD_FAILED_MESSAGE,
  TERMINAL_OUTPUT_LOADING_MESSAGE,
} from "./terminalSource.logic";
import { agentAddress, type SendChoice, type SendToAgentSource } from "./sendToAgent.logic";

const ENVIRONMENT = EnvironmentId.make("environment-a");

const source: SendToAgentSource = {
  environmentId: ENVIRONMENT,
  threadId: ThreadId.make("source"),
  terminalId: null,
  projectId: ProjectId.make("project-a"),
  title: "Parser work",
  checkout: "/repo/a",
  messages: [],
  terminalHasText: false,
};

function row(threadId: string, title: string, terminalId: string | null = null): AgentRow {
  return {
    key: terminalId === null ? threadId : `${threadId}#terminal:${terminalId}`,
    ref: { environmentId: ENVIRONMENT, threadId: ThreadId.make(threadId) },
    shell: { title },
    terminalId,
  } as unknown as AgentRow;
}

const loaded = { text: "[user] fix the parser\n[assistant] done", leftOut: 0, includedMessages: 2 };

function loader(result = loaded) {
  return vi.fn<HandoffLoader>(() => Promise.resolve(result));
}

function terminalOutput(overrides: Partial<Awaited<ReturnType<TerminalOutputLoader>>> = {}) {
  return vi.fn<TerminalOutputLoader>(() =>
    Promise.resolve({
      text: "$ make test",
      truncated: false,
      usedSource: "conversation",
      fellBack: false,
      startMissing: false,
      ...overrides,
    }),
  );
}

const agentTarget = (picked: AgentRow) =>
  ({ kind: "agent", row: picked, address: agentAddress(picked) }) as const;

describe("handoff.logic", () => {
  it('Hand off attaches the source\'s handoff text under the label "Handoff from {source title}" and nothing else', async () => {
    const content = buildHandOffContent({ source, loadHandoff: loader() });
    expect(content.attachments).toEqual([]);
    expect(await content.loadAttachments!()).toEqual([
      { id: "handoff", label: "Handoff from Parser work", text: loaded.text, leftOut: null },
    ]);
  });

  it("Hand off reads only the source's own thread", async () => {
    const loadHandoff = loader();
    await buildHandOffContent({ source, loadHandoff }).loadAttachments!();
    expect(loadHandoff.mock.calls).toEqual([[ThreadId.make("source")]]);
  });

  it("Take over from reads the picked agent's handoff text with the source thread as context", async () => {
    const loadHandoff = loader();
    const content = buildTakeOverContent({
      source,
      picked: row("other", "Stuck agent"),
      loadHandoff,
      loadTerminalOutput: null,
    });
    const attachments = await content.loadAttachments!();
    expect(loadHandoff.mock.calls).toEqual([[ThreadId.make("other")]]);
    expect(attachments.map((attachment) => attachment.label)).toEqual(["Handoff from Stuck agent"]);
    expect(content.leadIn).toBe(TAKE_OVER_LEAD_IN);
  });

  it("Take over from sends to the source's own agent and names the picked agent as taken over", () => {
    const picked = row("other", "Stuck agent");
    const choice: SendChoice = { source, action: "take-over", target: agentTarget(picked) };
    expect(resolveRequestRoles(choice, null)).toEqual({
      source: "thread:source",
      target: "thread:source",
      takenOver: "thread:other",
    });
  });

  it("every other action keeps the picked agent, or the new panel, as the target", () => {
    const picked = row("other", "Another agent");
    for (const action of ["review", "second-opinion", "hand-off", "message"] as const) {
      expect(resolveRequestRoles({ source, action, target: agentTarget(picked) }, null)).toEqual({
        source: "thread:source",
        target: "thread:other",
        takenOver: null,
      });
    }
    const newPanel: SendChoice = {
      source,
      action: "hand-off",
      target: { kind: "new-panel", selection: { kind: "chat", instanceId: "codex" } as never },
    };
    expect(resolveRequestRoles(newPanel, "thread:panel-1")).toEqual({
      source: "thread:source",
      target: "thread:panel-1",
      takenOver: null,
    });
  });

  it("a terminal that cannot be notified can still be taken over from", async () => {
    const content = buildTakeOverContent({
      source,
      picked: row("other", "Terminal agent", "term-1"),
      loadHandoff: loader(),
      loadTerminalOutput: terminalOutput(),
    });
    expect(content.leadIn).toBe(TAKE_OVER_LEAD_IN);
    await expect(content.loadAttachments!()).resolves.toHaveLength(1);
  });

  it("a picked terminal without a loader warns that its text cannot be read here yet and attaches nothing", () => {
    const loadHandoff = loader();
    const content = buildTakeOverContent({
      source,
      picked: row("other", "Terminal agent", "term-1"),
      loadHandoff,
      loadTerminalOutput: null,
    });
    expect(content.warning).toBe(
      "This terminal's text cannot be read from here yet. Describe what it was doing in the note.",
    );
    expect(content.attachments).toEqual([]);
    expect(content.loadAttachments).toBeUndefined();
    expect(loadHandoff).not.toHaveBeenCalled();
  });

  it("a picked terminal names the terminal's output, not messages, while reading and when the read fails", () => {
    const content = buildTakeOverContent({
      source,
      picked: row("other", "Terminal agent", "term-1"),
      loadHandoff: loader(),
      loadTerminalOutput: terminalOutput(),
    });
    expect(content.loadFailedMessage).toBe(TERMINAL_OUTPUT_LOAD_FAILED_MESSAGE);
    expect(content.loadingMessage).toBe(TERMINAL_OUTPUT_LOADING_MESSAGE);
  });

  it("a picked chat keeps the messages wording", () => {
    const content = buildTakeOverContent({
      source,
      picked: row("other", "Chat agent"),
      loadHandoff: loader(),
      loadTerminalOutput: null,
    });
    expect(content.loadFailedMessage).toBeUndefined();
    expect(content.loadingMessage).toBeUndefined();
  });

  it('a picked terminal whose conversation is readable attaches it under the label "Terminal conversation" with no fallback note and shows "The start of the conversation is not included." only when startMissing is true', async () => {
    const picked = row("other", "Terminal agent", "term-1");
    const whole = await buildTakeOverContent({
      source,
      picked,
      loadHandoff: loader(),
      loadTerminalOutput: terminalOutput(),
    }).loadAttachments!();
    expect(whole).toEqual([
      {
        id: "terminal-output",
        label: "Terminal conversation",
        text: "$ make test",
        leftOut: null,
        note: null,
      },
    ]);
    const startMissing = await buildTakeOverContent({
      source,
      picked,
      loadHandoff: loader(),
      loadTerminalOutput: terminalOutput({ startMissing: true }),
    }).loadAttachments!();
    expect(startMissing[0]?.note).toBe("The start of the conversation is not included.");
  });

  it('a picked terminal whose conversation is unreadable attaches its recent output under the label "Recent terminal output" with the note "The conversation could not be read, so this is recent terminal output."', async () => {
    const loadTerminalOutput = terminalOutput({
      text: "x".repeat(16_005),
      usedSource: "output",
      fellBack: true,
    });
    const picked = row("other", "Terminal agent", "term-1");
    const [attachment] = await buildTakeOverContent({
      source,
      picked,
      loadHandoff: loader(),
      loadTerminalOutput,
    }).loadAttachments!();
    expect(loadTerminalOutput.mock.calls).toEqual([[picked]]);
    expect(attachment?.label).toBe("Recent terminal output");
    expect(attachment?.note).toBe(
      "The conversation could not be read, so this is recent terminal output.",
    );
    expect(attachment?.text).toHaveLength(16_000);
    expect(attachment?.leftOut).toBe("5 characters left out");
  });

  it("the lead-ins are fixed", () => {
    expect(HAND_OFF_LEAD_IN).toBe(
      "The user is handing work over to you from another BiBCode thread. Below is that thread's first message and its most recent messages. Continue the work from there.",
    );
    expect(TAKE_OVER_LEAD_IN).toBe(
      "The user is continuing in this thread after another agent. Below is that agent's first message and its most recent messages, read from BiBCode's stored history. Continue the work from there.",
    );
    expect(buildHandOffContent({ source, loadHandoff: loader() }).leadIn).toBe(HAND_OFF_LEAD_IN);
  });

  it("the left-out count of the handoff text is shown beside the attachment", async () => {
    expect(formatLeftOutMessages(259)).toBe("259 earlier messages left out");
    expect(formatLeftOutMessages(1)).toBe("1 earlier message left out");
    expect(formatLeftOutMessages(0)).toBeNull();
    const [attachment] = await buildHandOffContent({
      source,
      loadHandoff: loader({ ...loaded, leftOut: 259 }),
    }).loadAttachments!();
    expect(attachment?.leftOut).toBe("259 earlier messages left out");
  });
});
