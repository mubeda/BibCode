// @vitest-environment happy-dom

import { EnvironmentId, ProjectId, ThreadId } from "@bibcode/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  buttonProps: [] as Array<Record<string, unknown>>,
  live: null as null | { source: Record<string, unknown> },
  menuOpen: false,
  getTerminalOutput: vi.fn(),
  terminalWrites: 0,
  send: vi.fn(),
  requests: [] as Array<Record<string, unknown>>,
  getAnswer: vi.fn(),
}));

vi.mock("~/state/entities", () => ({
  useThreadShell: () => ({ projectId: "project-a", title: "Chat", worktreePath: null }),
  useProjects: () => [{ id: "project-a", workspaceRoot: "/repo/a" }],
}));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("~/state/server", () => ({ serverEnvironment: { providerUsage: () => null } }));
vi.mock("~/state/sendRequests", () => ({
  useSendRequest: () => h.send,
  useGetTerminalOutput: () => h.getTerminalOutput,
  useSendRequests: () => h.requests,
  useGetAnswer: () => h.getAnswer,
}));
// The composer must never reach the terminal's write command.
vi.mock("~/state/terminal", () => ({
  terminalEnvironment: {
    get write() {
      h.terminalWrites += 1;
      return null;
    },
  },
}));
vi.mock("../agents/useAgentRows", () => ({ useAgentRows: () => [] }));
vi.mock("../../hooks/useAgentFreshness", () => ({ useAgentTerminalSources: () => [] }));
vi.mock("./SendToAgentButton", () => ({
  SendToAgentButton: (props: Record<string, unknown>) => {
    h.buttonProps.push(props);
    const renderLive = props["renderLive"] as
      | undefined
      | ((render: (live: { source: Record<string, unknown> }) => ReactNode) => ReactNode);
    return (
      <span data-send-to-agent>
        <button type="button" aria-label="Send to agent" />
        {h.menuOpen
          ? renderLive?.((live) => {
              h.live = live;
              return <b data-live>{String(live.source["terminalHasText"])}</b>;
            })
          : null}
      </span>
    );
  },
}));

import {
  TerminalSendComposer,
  TerminalSendToAgentContext,
  type TerminalSendToAgentServices,
} from "./TerminalSendComposer";
import { sendSourceKey, useSendToAgentStore } from "~/sendToAgentStore";
import { buildTakeOverContent } from "./handoff.logic";
import {
  NOTHING_TO_ATTACH_REASON,
  resolveActionAvailability,
  submitSendChoice,
} from "./sendToAgent.logic";
import type { SendChoice, SendToAgentSource } from "./sendToAgent.logic";

const threadRef = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("owner"),
};
const baseContentFor = vi.fn(() => null);
const services: TerminalSendToAgentServices = {
  serverSupported: true,
  newPanelProvidersFor: () => [],
  createPanel: vi.fn(),
  revealPanel: () => undefined,
  previewContentFor: baseContentFor,
  openSendTarget: vi.fn(),
  cancelSendRequest: vi.fn(() => Promise.resolve()),
  dismissSendRequest: vi.fn(() => Promise.resolve()),
};

let root: Root;
let container: HTMLDivElement;
let selection = "";

function render(terminalId = "term-1") {
  act(() =>
    root.render(
      <TerminalSendToAgentContext.Provider value={services}>
        <TerminalSendComposer
          threadRef={threadRef}
          terminalId={terminalId}
          terminalLabel="Claude"
          readSelection={() => selection}
        />
      </TerminalSendToAgentContext.Provider>,
    ),
  );
}

const choiceFor = (action: SendChoice["action"]): SendChoice => ({
  source: h.buttonProps.at(-1)!["source"] as SendToAgentSource,
  action,
  target: { kind: "new-panel", selection: { kind: "default", instanceId: "codex" } } as never,
});

const previewContentFor = () =>
  h.buttonProps.at(-1)!["previewContentFor"] as (choice: SendChoice) => {
    leadIn: string;
    attachments: Array<{ label: string; text: string }>;
    loadAttachments?: () => Promise<Array<{ label: string; text: string }>>;
  } | null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.buttonProps.length = 0;
  h.live = null;
  h.menuOpen = false;
  h.terminalWrites = 0;
  h.requests = [];
  h.getAnswer.mockReset();
  h.getAnswer.mockResolvedValue({
    _tag: "Success",
    value: { requestId: "r1", text: "Two bugs.", truncated: false },
  });
  useSendToAgentStore.setState({ notes: {}, pending: {}, panels: {} });
  vi.mocked(services.cancelSendRequest).mockClear();
  h.getTerminalOutput.mockReset();
  h.getTerminalOutput.mockResolvedValue({
    threadId: "owner",
    terminalId: "term-1",
    text: "$ make test\nok",
    truncated: false,
    usedSource: "output",
    fellBack: false,
    startMissing: false,
  });
  baseContentFor.mockClear();
  selection = "";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("TerminalSendComposer", () => {
  it("the_preview_names_the_terminal_as_the_source", () => {
    render();
    expect(h.buttonProps.at(-1)!["source"]).toMatchObject({
      environmentId: "environment-a",
      threadId: "owner",
      terminalId: "term-1",
      projectId: ProjectId.make("project-a"),
      title: "Claude",
      checkout: "/repo/a",
    });
  });

  it("a_selection_of_30_lines_is_attached_and_labelled_as_a_selection", () => {
    selection = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
    render();
    const content = previewContentFor()(choiceFor("second-opinion"));
    expect(content?.attachments).toHaveLength(1);
    expect(content?.attachments[0]).toMatchObject({ label: "Selection from Claude" });
    expect(content?.attachments[0]?.text.split("\n")).toHaveLength(30);
    expect(h.getTerminalOutput).not.toHaveBeenCalled();
  });

  it("opening_the_menu_reads_only_the_output_and_choosing_hand_off_reads_the_conversation", async () => {
    h.menuOpen = true;
    render();
    await act(async () => {});
    const input = { sourceThreadId: "owner", threadId: "owner", terminalId: "term-1" };
    expect(h.getTerminalOutput).toHaveBeenCalledTimes(1);
    expect(h.getTerminalOutput).toHaveBeenCalledWith({
      ...input,
      source: "output",
      part: "handoff",
    });
    expect(h.live?.source["terminalHasText"]).toBe(true);
    const content = previewContentFor()(choiceFor("hand-off"));
    expect(content?.attachments).toEqual([]);
    expect(h.getTerminalOutput).toHaveBeenCalledTimes(1);
    const attachments = (await content?.loadAttachments?.()) ?? [];
    expect(h.getTerminalOutput).toHaveBeenLastCalledWith({
      ...input,
      source: "conversation",
      part: "handoff",
    });
    expect(attachments[0]).toMatchObject({ label: "Recent output of Claude" });
  });

  it("hand_off_attaches_the_conversation_and_second_opinion_its_last_answer", async () => {
    h.getTerminalOutput.mockImplementation(async (input: { part: string }) => ({
      threadId: "owner",
      terminalId: "term-1",
      text:
        input.part === "handoff" ? "[user] Test question\n[assistant] Test answer" : "Test answer",
      truncated: false,
      usedSource: "conversation",
      fellBack: false,
      startMissing: false,
    }));
    h.menuOpen = true;
    render();
    await act(async () => {});
    const handOff = (await previewContentFor()(choiceFor("hand-off"))?.loadAttachments?.()) ?? [];
    expect(handOff[0]).toMatchObject({
      label: "Conversation of Claude",
      text: "[user] Test question\n[assistant] Test answer",
    });
    const secondOpinion =
      (await previewContentFor()(choiceFor("second-opinion"))?.loadAttachments?.()) ?? [];
    expect(secondOpinion[0]).toMatchObject({
      label: "Conversation of Claude",
      text: "Test answer",
    });
    expect(h.getTerminalOutput).toHaveBeenLastCalledWith({
      sourceThreadId: "owner",
      threadId: "owner",
      terminalId: "term-1",
      source: "conversation",
      part: "last-answer",
    });
  });

  it("a_long_conversation_handoff_is_attached_whole_with_its_newest_messages", async () => {
    const text = `[user] ${"q".repeat(4_000)}\n${"[assistant] a\n".repeat(1_800)}[assistant] newest`;
    h.getTerminalOutput.mockResolvedValue({
      threadId: "owner",
      terminalId: "term-1",
      text,
      truncated: true,
      usedSource: "conversation",
      fellBack: false,
      startMissing: false,
    });
    h.menuOpen = true;
    render();
    await act(async () => {});
    const attachments =
      (await previewContentFor()(choiceFor("hand-off"))?.loadAttachments?.()) ?? [];
    expect(attachments[0]).toMatchObject({
      label: "Conversation of Claude",
      text,
      leftOut: null,
      note: null,
    });
  });

  it("a_conversation_whose_start_was_not_read_says_so", async () => {
    h.getTerminalOutput.mockResolvedValue({
      threadId: "owner",
      terminalId: "term-1",
      text: "[user] Test question\n[assistant] Test answer",
      truncated: true,
      usedSource: "conversation",
      fellBack: false,
      startMissing: true,
    });
    h.menuOpen = true;
    render();
    await act(async () => {});
    const attachments =
      (await previewContentFor()(choiceFor("hand-off"))?.loadAttachments?.()) ?? [];
    expect(attachments[0]).toMatchObject({
      label: "Conversation of Claude",
      note: "The start of the conversation is not included.",
    });
  });

  it("the_preview_says_recent_output_was_used_when_the_conversation_could_not_be_read", async () => {
    h.getTerminalOutput.mockResolvedValue({
      threadId: "owner",
      terminalId: "term-1",
      text: "$ make test\nok",
      truncated: false,
      usedSource: "output",
      fellBack: true,
      startMissing: false,
    });
    h.menuOpen = true;
    render();
    await act(async () => {});
    for (const action of ["hand-off", "second-opinion"] as const) {
      const attachments = (await previewContentFor()(choiceFor(action))?.loadAttachments?.()) ?? [];
      expect(attachments[0]).toMatchObject({
        label: "Recent output of Claude, because the conversation could not be read",
        text: "$ make test\nok",
      });
    }
    // The menu's output read, then one conversation read per choice.
    expect(h.getTerminalOutput).toHaveBeenCalledTimes(3);
  });

  it("an_empty_terminal_disables_second_opinion_and_hand_off_with_the_reason", async () => {
    h.getTerminalOutput.mockResolvedValue({
      threadId: "owner",
      terminalId: "term-1",
      text: "",
      truncated: false,
      usedSource: "output",
      fellBack: false,
      startMissing: false,
    });
    h.menuOpen = true;
    render();
    await act(async () => {});
    const source = h.live!.source as unknown as SendToAgentSource;
    for (const action of ["second-opinion", "hand-off"] as const) {
      expect(resolveActionAvailability({ source, action, serverSupported: true })).toEqual({
        disabledReason: NOTHING_TO_ATTACH_REASON,
      });
    }
    expect(
      resolveActionAvailability({ source, action: "review", serverSupported: true }).disabledReason,
    ).toBeNull();
  });

  it("leaves Review, Message and Take over from to the host chat", () => {
    render();
    for (const action of ["review", "message", "take-over"] as const) {
      previewContentFor()(choiceFor(action));
    }
    expect(baseContentFor).toHaveBeenCalledTimes(3);
  });

  it("reads nothing while the menu is closed", () => {
    render();
    expect(h.getTerminalOutput).not.toHaveBeenCalled();
    expect(container.querySelector("[data-live]")).toBeNull();
  });

  it("nothing_is_typed_into_the_terminal", async () => {
    h.menuOpen = true;
    selection = "picked";
    render();
    await act(async () => {});
    const content = previewContentFor()(choiceFor("second-opinion"));
    await content?.loadAttachments?.();
    expect(h.terminalWrites).toBe(0);
  });

  it("the_control_counts_the_answers_waiting_for_this_terminal_only", () => {
    const request = (requestId: string, source: string, state: string) => ({
      requestId,
      source,
      state,
    });
    h.requests = [
      request("r1", "terminal:owner/term-1", "answered"),
      request("r2", "terminal:owner/term-1", "read"),
      request("r3", "terminal:owner/term-2", "answered"),
      request("r4", "thread:owner", "answered"),
    ];
    render();
    expect(h.buttonProps.at(-1)!["waitingAnswers"]).toBe(1);
  });

  describe("answers and requests of this terminal", () => {
    const terminalRequest = (overrides: Record<string, unknown> = {}) => ({
      requestId: "r1",
      projectId: "project-a",
      action: "review",
      source: "terminal:owner/term-1",
      sourceThreadId: "owner",
      target: "thread:target",
      targetThreadId: "target",
      takenOver: null,
      state: "answered",
      reason: null,
      dismissedAt: null,
      ...overrides,
    });
    const notices = () => document.body.querySelectorAll("[data-answer-notice]");
    const trigger = () =>
      container.querySelector<HTMLButtonElement>('button[aria-label^="Send requests"]');
    const open = async () => {
      await act(async () => trigger()!.click());
    };
    const pressed = (text: string) =>
      [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((entry) =>
        entry.textContent?.includes(text),
      );

    it("taking_over_into_a_terminal_sends_the_handoff_of_the_picked_agent_to_the_terminal_itself", async () => {
      const loadHandoff = vi.fn(() =>
        Promise.resolve({ text: "picked agent handoff", leftOut: 0, includedMessages: 3 }),
      );
      baseContentFor.mockImplementation(((choice: SendChoice) =>
        choice.target.kind === "agent"
          ? buildTakeOverContent({
              source: choice.source,
              picked: choice.target.row,
              loadHandoff,
              loadTerminalOutput: null,
            })
          : null) as never);
      render();
      const picked = {
        ref: { environmentId: "environment-a", threadId: "picked" },
        terminalId: null,
        shell: { title: "Picked agent" },
      };
      const choice: SendChoice = {
        source: h.buttonProps.at(-1)!["source"] as SendToAgentSource,
        action: "take-over",
        target: { kind: "agent", row: picked, address: "thread:picked" } as never,
      };
      const content = previewContentFor()(choice)!;
      const attachments = (await content.loadAttachments?.()) ?? [];
      const send = vi.fn(() => Promise.resolve({ kind: "sent" as const }));
      await submitSendChoice(
        { send, createPanel: vi.fn(), newId: () => "request-1" },
        choice,
        {
          leadIn: content.leadIn,
          note: "",
          attachments: attachments.map(({ label, text }) => ({ label, text })),
        },
        () => true,
      );
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "take-over",
          source: "terminal:owner/term-1",
          target: "terminal:owner/term-1",
          takenOver: "thread:picked",
          attachments: [{ label: "Handoff from Picked agent", text: "picked agent handoff" }],
        }),
      );
      expect(loadHandoff).toHaveBeenCalledWith("picked");
      expect(h.terminalWrites).toBe(0);
      baseContentFor.mockReset();
      baseContentFor.mockReturnValue(null as never);
    });

    it("a_terminal_sources_notice_is_on_its_control", async () => {
      h.requests = [terminalRequest()];
      render();
      expect(h.buttonProps.at(-1)!["waitingAnswers"]).toBe(1);
      expect(trigger()?.getAttribute("aria-label")).toBe("Send requests, 1 answer waiting");
      expect(notices()).toHaveLength(0);
      await open();
      expect(notices()).toHaveLength(1);
      expect(document.body.querySelector('[role="status"]')?.contains(notices()[0]!)).toBe(true);
    });

    it("a_terminal_notice_survives_a_reload", async () => {
      h.requests = [terminalRequest()];
      render();
      act(() => root.unmount());
      root = createRoot(container);
      render();
      await open();
      expect(notices()).toHaveLength(1);
    });

    it("dismissing_the_last_row_moves_focus_to_the_send_to_agent_control_and_closes_the_popover", async () => {
      h.requests = [terminalRequest()];
      render();
      await open();
      const dismiss = pressed("Dismiss")!;
      dismiss.focus();
      expect(document.activeElement).toBe(dismiss);
      h.requests = [];
      render();
      await act(async () => {});
      expect(trigger()).toBeNull();
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Send to agent");
      // A later request must not find the popover still open.
      h.requests = [terminalRequest({ requestId: "r2" })];
      render();
      expect(notices()).toHaveLength(0);
    });

    it("the_open_signal_belongs_to_the_terminal_it_was_raised_for", async () => {
      h.requests = [terminalRequest()];
      render();
      await open();
      await act(async () => pressed("Bring back")!.click());
      await act(async () => {});
      expect(h.buttonProps.at(-1)!["openSignal"]).toBe(1);
      render("term-2");
      expect(h.buttonProps.at(-1)!["openSignal"]).toBe(0);
      render("term-1");
      expect(h.buttonProps.at(-1)!["openSignal"]).toBe(0);
    });

    it("a plain request shows its row with Cancel, Open and no notice, and Cancel cancels it", async () => {
      h.requests = [terminalRequest({ action: "message", state: "queued" })];
      render();
      await open();
      expect(notices()).toHaveLength(0);
      expect(document.body.textContent).toContain("Queued for Chat");
      expect(pressed("Open")).toBeDefined();
      await act(async () => pressed("Cancel")!.click());
      expect(services.cancelSendRequest).toHaveBeenCalledWith("r1");
    });

    it("the control names a request that is not answered, not only an answer", () => {
      h.requests = [terminalRequest({ state: "not_answered", reason: "recipient_gone" })];
      render();
      expect(trigger()?.getAttribute("aria-label")).toBe("Send requests, 1 request");
    });

    it("bring_back_opens_the_terminal_composer_with_the_quoted_answer_and_types_nothing", async () => {
      h.requests = [terminalRequest()];
      render();
      const before = (h.buttonProps.at(-1)!["openSignal"] as number | undefined) ?? 0;
      await open();
      await act(async () => pressed("Bring back")!.click());
      await act(async () => {});
      const key = `${sendSourceKey({ environmentId: threadRef.environmentId, threadId: threadRef.threadId, terminalId: "term-1" })}:message`;
      expect(useSendToAgentStore.getState().notes[key]).toBe("Review from Chat:\n\n> Two bugs.");
      expect((h.buttonProps.at(-1)!["openSignal"] as number) > before).toBe(true);
      expect(h.terminalWrites).toBe(0);
      expect(services.dismissSendRequest).toHaveBeenCalledWith("r1");
    });
  });

  it("renders nothing without the host chat's services", () => {
    act(() =>
      root.render(
        <TerminalSendComposer
          threadRef={threadRef}
          terminalId="term-1"
          terminalLabel="Claude"
          readSelection={() => ""}
        />,
      ),
    );
    expect(container.querySelector("[data-send-to-agent]")).toBeNull();
  });
});
