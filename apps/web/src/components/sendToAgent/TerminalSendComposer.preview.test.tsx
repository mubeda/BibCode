// @vitest-environment happy-dom

// The composer with the real menu and the real preview: only the data hooks are replaced.
import type { EnvironmentThreadShell } from "@bibcode/client-runtime/state/models";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type SendRequestsSendInput,
} from "@bibcode/contracts";
import { createModelSelection } from "@bibcode/shared/model";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  getTerminalOutput: vi.fn(),
  terminalWrites: 0,
  send: vi.fn(),
  rows: [] as ReadonlyArray<unknown>,
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
vi.mock("../agents/useAgentRows", () => ({ useAgentRows: () => h.rows }));

import { useSendToAgentStore } from "~/sendToAgentStore";
import { buildAgentRows } from "../sidebar/agentsSection.logic";
import { LOAD_FAILED_MESSAGE } from "./SendToAgentPreview";
import {
  TERMINAL_OUTPUT_LOAD_FAILED_MESSAGE,
  TerminalSendComposer,
  TerminalSendToAgentContext,
  type TerminalSendToAgentServices,
} from "./TerminalSendComposer";

const ENVIRONMENT = EnvironmentId.make("environment-a");
const PROJECT = ProjectId.make("project-a");
const AT = "2026-11-13T10:00:00.000Z";

function shell(id: string): EnvironmentThreadShell {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: PROJECT,
    title: id,
    modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "model"),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    session: {
      threadId,
      status: "ready",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: AT,
    },
    latestUserMessageAt: AT,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    conversationPreview: null,
    environmentId: ENVIRONMENT,
  } as EnvironmentThreadShell;
}

const codex = {
  value: "chat:codex",
  selection: { kind: "chat", instanceId: ProviderInstanceId.make("codex") } as const,
  label: "Codex",
  disabledReason: null,
};
const createPanel = vi.fn();
const services: TerminalSendToAgentServices = {
  serverSupported: true,
  newPanelProvidersFor: () => [codex],
  createPanel,
  revealPanel: () => undefined,
  previewContentFor: () => ({ leadIn: "", attachments: [] }),
};
const threadRef = { environmentId: ENVIRONMENT, threadId: ThreadId.make("owner") };

let root: Root;
let container: HTMLDivElement;
let viewport: HTMLButtonElement;
let selection = "";
let centerPanel = false;

function render() {
  act(() =>
    root.render(
      <TerminalSendToAgentContext.Provider value={services}>
        <button type="button" data-viewport ref={(node) => void (viewport = node!)}>
          terminal viewport
        </button>
        <TerminalSendComposer
          threadRef={threadRef}
          terminalId="term-1"
          terminalLabel="Claude"
          readSelection={() => selection}
          viewportFocusTarget={() => viewport}
          inCenterPanel={centerPanel}
        />
      </TerminalSendToAgentContext.Provider>,
    ),
  );
}

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const trigger = () => container.querySelector<HTMLButtonElement>('[aria-label="Send to agent"]')!;
const find = (selector: string, text: string) =>
  [...document.body.querySelectorAll<HTMLElement>(selector)].find((element) =>
    element.textContent?.includes(text),
  );
const note = () => document.body.querySelector<HTMLTextAreaElement>("textarea")!;

async function openMenu() {
  await act(async () => trigger().click());
  await flush();
}
async function choose(action: string, target: string) {
  await openMenu();
  await act(async () => find('[role="menuitem"]', action)!.click());
  await flush();
  const items = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  const item =
    items.find((entry) => entry.textContent === target) ?? find('[role="menuitem"]', target)!;
  await act(async () => item.click());
  await flush();
}
async function typeNote(text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(note(), text);
    note().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const close = {
  Cancel: () => act(async () => find("button", "Cancel")!.click()),
  Escape: () =>
    act(async () => {
      note().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }),
  Send: () => act(async () => find("button", "Send")!.click()),
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.terminalWrites = 0;
  h.rows = buildAgentRows({
    shells: [shell("alpha"), shell("beta")],
    projectTitleById: new Map([[PROJECT, "Project A"]]),
    environmentLabelById: new Map([[ENVIRONMENT, "Local"]]),
    availabilityByEnvironmentId: new Map([[ENVIRONMENT, "live"]]),
  });
  h.send.mockReset();
  h.send.mockResolvedValue({ kind: "sent" });
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
  createPanel.mockReset();
  createPanel.mockResolvedValue(ThreadId.make("panel-1"));
  useSendToAgentStore.setState({ notes: {}, pending: {}, panels: {} });
  selection = "picked text";
  centerPanel = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("TerminalSendComposer with the real menu and preview", () => {
  for (const [name, finish] of Object.entries(close)) {
    it(`a_note_typed_in_the_preview_never_reaches_the_terminal_on_${name}`, async () => {
      render();
      await choose("Message", "beta");
      await typeNote("do not type this");
      await finish();
      await flush();
      expect(h.terminalWrites).toBe(0);
      if (name === "Send") {
        const sent = h.send.mock.calls[0]![0] as SendRequestsSendInput;
        expect(JSON.stringify(sent)).toContain("do not type this");
      }
    });

    it(`focus_returns_to_the_terminal_viewport_after_${name}`, async () => {
      render();
      await choose("Message", "beta");
      await typeNote("a note");
      await finish();
      await flush();
      expect(document.body.querySelector("textarea")).toBeNull();
      expect(document.activeElement).toBe(viewport);
    });
  }

  it("closing_the_preview_keeps_its_note_for_the_same_terminal", async () => {
    render();
    await choose("Message", "beta");
    await typeNote("keep me");
    await close.Cancel();
    await flush();
    await choose("Message", "beta");
    expect(note().value).toBe("keep me");
  });

  it("a_failed_output_read_shows_the_preview_error_and_Retry_and_sends_nothing", async () => {
    selection = "";
    h.getTerminalOutput.mockRejectedValueOnce(new Error("unreadable"));
    render();
    await openMenu();
    const secondOpinion = find('[role="menuitem"]', "Second opinion")!;
    expect(secondOpinion.getAttribute("aria-disabled")).not.toBe("true");
    expect(secondOpinion.textContent).not.toContain("Nothing to attach");
    await act(async () => secondOpinion.click());
    await flush();
    await act(async () => find('[role="menuitem"]', "beta")!.click());
    await flush();
    const alert = document.body.querySelector('[role="alert"]')!.textContent;
    expect(alert).toContain(TERMINAL_OUTPUT_LOAD_FAILED_MESSAGE);
    expect(alert).not.toContain(LOAD_FAILED_MESSAGE);
    expect(find("button", "Send")!.hasAttribute("disabled")).toBe(true);
    await act(async () => find("button", "Retry")!.click());
    await flush();
    expect(document.body.querySelector('[data-attachment="terminal-output"]')).not.toBeNull();
    expect(h.getTerminalOutput).toHaveBeenCalledTimes(2);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("an_empty_terminal_says_there_is_nothing_to_attach_while_a_slow_read_does_not", async () => {
    selection = "";
    let resolveRead!: (value: unknown) => void;
    h.getTerminalOutput.mockReturnValueOnce(new Promise((resolve) => (resolveRead = resolve)));
    render();
    await openMenu();
    const loading = find('[role="menuitem"]', "Second opinion")!;
    expect(loading.textContent).not.toContain("Nothing to attach");
    await act(async () =>
      resolveRead({
        threadId: "owner",
        terminalId: "term-1",
        text: "",
        truncated: false,
        usedSource: "output",
        fellBack: false,
        startMissing: false,
      }),
    );
    await flush();
    expect(find('[role="menuitem"]', "Second opinion")!.textContent).toContain(
      "Nothing to attach yet",
    );
  });

  it("a_center_terminal_creates_the_new_panel_without_activating_it", async () => {
    centerPanel = true;
    render();
    await choose("Message", "Codex");
    await typeNote("hello");
    await close.Send();
    await flush();
    expect(createPanel).toHaveBeenCalledWith(expect.objectContaining({ instanceId: "codex" }), {
      sourceUnmountsOnActivate: true,
    });
  });
});
