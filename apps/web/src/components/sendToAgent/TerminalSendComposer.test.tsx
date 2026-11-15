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
vi.mock("./SendToAgentButton", () => ({
  SendToAgentButton: (props: Record<string, unknown>) => {
    h.buttonProps.push(props);
    const renderLive = props["renderLive"] as
      | undefined
      | ((render: (live: { source: Record<string, unknown> }) => ReactNode) => ReactNode);
    return (
      <span data-send-to-agent>
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
import { NOTHING_TO_ATTACH_REASON, resolveActionAvailability } from "./sendToAgent.logic";
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
};

let root: Root;
let container: HTMLDivElement;
let selection = "";

function render() {
  act(() =>
    root.render(
      <TerminalSendToAgentContext.Provider value={services}>
        <TerminalSendComposer
          threadRef={threadRef}
          terminalId="term-1"
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

  it("with_no_selection_the_output_is_loaded_once_when_the_menu_opens_and_labelled_with_the_source_used", async () => {
    h.menuOpen = true;
    render();
    await act(async () => {});
    expect(h.getTerminalOutput).toHaveBeenCalledTimes(1);
    expect(h.getTerminalOutput).toHaveBeenCalledWith({
      sourceThreadId: "owner",
      threadId: "owner",
      terminalId: "term-1",
      source: "conversation",
      part: "handoff",
    });
    expect(h.live?.source["terminalHasText"]).toBe(true);
    const content = previewContentFor()(choiceFor("hand-off"));
    expect(content?.attachments).toEqual([]);
    const attachments = (await content?.loadAttachments?.()) ?? [];
    expect(attachments[0]).toMatchObject({ label: "Recent output of Claude" });
    expect(h.getTerminalOutput).toHaveBeenCalledTimes(1);
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
    expect(h.getTerminalOutput).toHaveBeenCalledTimes(1);
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
