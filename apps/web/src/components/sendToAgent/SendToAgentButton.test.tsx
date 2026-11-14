// @vitest-environment happy-dom

import type { EnvironmentThreadShell } from "@bibcode/client-runtime/state/models";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type SendRequestsSendInput,
} from "@bibcode/contracts";
import { createModelSelection } from "@bibcode/shared/model";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useSendToAgentStore } from "~/sendToAgentStore";
import type { SendOutcome } from "~/state/sendRequests";
import { buildAgentRows } from "../sidebar/agentsSection.logic";
import { SendToAgentButton, type SendToAgentButtonProps } from "./SendToAgentButton";
import { resolveCodeReviewPrompt } from "~/codeReview";
import { buildReviewPreviewContent } from "./ReviewScopePicker";
import { buildSecondOpinionContent } from "./attachments.logic";
import {
  buildHandOffContent,
  buildTakeOverContent,
  HAND_OFF_LEAD_IN,
  TAKE_OVER_LEAD_IN,
  type HandoffLoader,
} from "./handoff.logic";
import { buildReviewContent, buildReviewScopeOptions } from "./review.logic";
import { sendChoiceKey, type SendChoice, type SendToAgentSource } from "./sendToAgent.logic";

const ENVIRONMENT = EnvironmentId.make("environment-a");
const PROJECT = ProjectId.make("project-a");
const AT = "2026-11-13T10:00:00.000Z";

function shell(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
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
    ...overrides,
  } as EnvironmentThreadShell;
}

const rows = buildAgentRows({
  shells: [
    shell("alpha"),
    shell("beta"),
    shell("gamma", { worktreePath: "/repo/a-wt", updatedAt: "2026-11-13T09:00:00.000Z" }),
  ],
  projectTitleById: new Map([[PROJECT, "Project A"]]),
  environmentLabelById: new Map([[ENVIRONMENT, "Local"]]),
  availabilityByEnvironmentId: new Map([[ENVIRONMENT, "live"]]),
});

function sourceOf(threadId: string, overrides: Partial<SendToAgentSource> = {}): SendToAgentSource {
  return {
    environmentId: ENVIRONMENT,
    threadId: ThreadId.make(threadId),
    terminalId: null,
    projectId: PROJECT,
    title: `Panel ${threadId}`,
    checkout: "/repo/a",
    messages: [{ id: "m1", role: "assistant", text: "Done.", streaming: false } as never],
    terminalHasText: false,
    ...overrides,
  };
}

const codex = {
  value: "chat:codex",
  selection: { kind: "chat", instanceId: ProviderInstanceId.make("codex") } as const,
  label: "Codex",
  disabledReason: null,
};
const claude = {
  value: "chat:claude",
  selection: { kind: "chat", instanceId: ProviderInstanceId.make("claude") } as const,
  label: "Claude",
  disabledReason: "Claude is not installed",
};

let root: Root;
let container: HTMLDivElement;

function baseProps(overrides: Partial<SendToAgentButtonProps> = {}): SendToAgentButtonProps {
  return {
    source: sourceOf("source"),
    serverSupported: true,
    rows,
    projectRootByProjectId: new Map([[PROJECT, "/repo/a"]]),
    newPanelProvidersFor: () => [codex, claude],
    canNotifyTerminal: () => false,
    ...overrides,
  };
}

function render(...props: SendToAgentButtonProps[]) {
  act(() => {
    root.render(
      <>
        {props.map((entry) => (
          <SendToAgentButton key={entry.source.threadId} {...entry} />
        ))}
      </>,
    );
  });
}

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const triggers = () => [
  ...container.querySelectorAll<HTMLButtonElement>('[aria-label="Send to agent"]'),
];
const find = (selector: string, text: string) =>
  [...document.body.querySelectorAll<HTMLElement>(selector)].find((element) =>
    element.textContent?.includes(text),
  );
const menuItem = (text: string) => find('[role="menuitem"]', text);
const exactItem = (text: string) =>
  [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent === text,
  );

async function key(target: Element, name: string) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key: name, bubbles: true }));
  });
  await flush();
}

async function openAction(label: string) {
  await act(async () => triggers()[0]!.click());
  await flush();
  await act(async () => menuItem(label)!.click());
  await flush();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  useSendToAgentStore.setState({ notes: {}, pending: {}, panels: {} });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("SendToAgentButton", () => {
  it("opens with Enter and reaches an agent with the arrow keys", async () => {
    render(baseProps());
    const trigger = triggers()[0]!;
    act(() => trigger.focus());
    // A browser activates a focused button on Enter; happy-dom does not, so the click is sent too.
    await key(trigger, "Enter");
    await act(async () => trigger.click());
    await flush();
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
    const first = menuItem("Review")!;
    act(() => first.focus());
    await key(first, "ArrowRight");
    expect(document.activeElement?.textContent).toContain("alpha");
    await key(document.activeElement!, "ArrowDown");
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    expect(document.activeElement?.textContent).toContain("beta");
  });

  it("an agent entry is reached and chosen with the keyboard", async () => {
    const onChoose = vi.fn();
    render(baseProps({ onChoose }));
    await act(async () => triggers()[0]!.click());
    await flush();
    const message = menuItem("Message")!;
    act(() => message.focus());
    await key(message, "ArrowRight");
    const beta = menuItem("beta")!;
    act(() => beta.focus());
    await act(async () => beta.click());
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it("choosing an action then an agent calls onChoose with the source, the action and the target", async () => {
    const onChoose = vi.fn();
    const props = baseProps({ onChoose });
    render(props);
    await openAction("Message");
    await act(async () => menuItem("beta")!.click());
    expect(onChoose).toHaveBeenCalledTimes(1);
    const choice = onChoose.mock.calls[0]![0];
    expect(choice.source).toBe(props.source);
    expect(choice.action).toBe("message");
    expect(choice.target).toMatchObject({ kind: "agent", address: "thread:beta" });
  });

  it("asks renderLive for the source and rows only while the menu is open, and chooses with that source", async () => {
    const onChoose = vi.fn();
    const props = baseProps({ onChoose });
    const live = { source: { ...props.source, title: "Live title" }, rows: props.rows };
    const renderLive = vi.fn((draw: (inputs: typeof live) => ReactNode) => draw(live));
    render({ ...props, renderLive });
    expect(renderLive).not.toHaveBeenCalled();
    await openAction("Message");
    expect(renderLive).toHaveBeenCalled();
    await act(async () => menuItem("beta")!.click());
    expect(onChoose.mock.calls[0]![0].source).toBe(live.source);
  });

  it("a disabled entry stays focusable, shows its reason in words, carries it in its accessible name and ignores activation", async () => {
    const onChoose = vi.fn();
    render(baseProps({ onChoose }));
    await openAction("Review");
    const blocked = menuItem("gamma")!;
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    expect(blocked.hasAttribute("disabled")).toBe(false);
    expect(blocked.textContent).toContain(
      "This agent works in another checkout and cannot see these changes",
    );
    expect(blocked.getAttribute("aria-label")).toBe(
      "gamma unavailable. This agent works in another checkout and cannot see these changes",
    );
    act(() => blocked.focus());
    expect(document.activeElement).toBe(blocked);
    await act(async () => blocked.click());
    expect(onChoose).not.toHaveBeenCalled();
  });

  it("each panel's control reports its own panel as the source", async () => {
    const onChoose = vi.fn();
    const first = baseProps({ source: sourceOf("alpha"), onChoose });
    const second = baseProps({ source: sourceOf("beta"), onChoose });
    render(first, second);
    expect(triggers()).toHaveLength(2);
    await act(async () => triggers()[1]!.click());
    await flush();
    await act(async () => menuItem("Message")!.click());
    await flush();
    await act(async () => menuItem("gamma")!.click());
    expect(onChoose.mock.calls[0]![0].source.threadId).toBe("beta");
  });

  it("the control is disabled with the update reason when the environment lacks sendRequests", () => {
    render(baseProps({ serverSupported: false }));
    const trigger = triggers()[0]!;
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    act(() => trigger.click());
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });

  it("the new-panel entry lists the providers and disables an unavailable one with its reason", async () => {
    render(baseProps());
    await openAction("Message");
    expect(exactItem("Codex")!.getAttribute("aria-disabled")).toBeNull();
    const blocked = menuItem("Claude")!;
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    expect(blocked.textContent).toContain("Claude is not installed");
  });

  it('choosing Message and an agent opens the preview, and sending calls the sender with the request id, "message", the source and target addresses, an empty lead-in, the note and no attachments', async () => {
    const send = vi.fn<(input: SendRequestsSendInput) => Promise<SendOutcome>>(() =>
      Promise.resolve({ kind: "sent" }),
    );
    render(
      baseProps({
        send,
        newId: () => "request-1",
        previewContentFor: () => ({ leadIn: "", attachments: [] }),
      }),
    );
    await openAction("Message");
    await act(async () => menuItem("beta")!.click());
    await flush();
    const note = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(document.body.textContent).toContain("From Panel source to beta");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(note, "please check the retry path");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const sendButton = find("button", "Send")!;
    await act(async () => sendButton.click());
    await flush();
    expect(send).toHaveBeenCalledWith({
      requestId: "request-1",
      action: "message",
      source: "thread:source",
      target: "thread:beta",
      leadIn: "",
      note: "please check the retry path",
      attachments: [],
    });
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  describe("Second opinion", () => {
    const longAnswer = `${"old ".repeat(2_000)}${"b".repeat(40_000)}`;
    const opinionSource = sourceOf("source", {
      messages: [
        { id: "m1", role: "user", text: "How do I retry?", streaming: false },
        { id: "m2", role: "assistant", text: longAnswer, streaming: false },
      ] as never,
    });
    const props = (send?: SendToAgentButtonProps["send"]) =>
      baseProps({
        source: opinionSource,
        ...(send === undefined ? {} : { send }),
        newId: () => "request-1",
        previewContentFor: (choice) => buildSecondOpinionContent(choice.source.messages),
      });
    const editAttachment = async (label: string, text: string) => {
      const area = document.body.querySelector<HTMLTextAreaElement>(
        `[data-attachment="last-answer"] textarea`,
      )!;
      expect(label).toBe("last-answer");
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        setter.call(area, text);
        area.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    it("a Second opinion preview shows both attachments with their sizes", async () => {
      render(props());
      await openAction("Second opinion");
      await act(async () => menuItem("beta")!.click());
      await flush();
      const user = document.body.querySelector('[data-attachment="last-user-message"]')!;
      const answer = document.body.querySelector('[data-attachment="last-answer"]')!;
      expect(user.textContent).toContain("15 characters");
      expect(answer.textContent).toContain("16,000 characters");
      expect(answer.textContent).toContain("32,000 characters left out");
    });

    it("trimming: removing the oldest part of the cut answer in a Second opinion preview sends the shortened text", async () => {
      const send = vi.fn<(input: SendRequestsSendInput) => Promise<SendOutcome>>(() =>
        Promise.resolve({ kind: "sent" }),
      );
      render(props(send));
      await openAction("Second opinion");
      await act(async () => menuItem("beta")!.click());
      await flush();
      await editAttachment("last-answer", "b".repeat(100));
      await act(async () => find("button", "Send")!.click());
      await flush();
      const sent = send.mock.calls[0]![0];
      expect(sent.action).toBe("second-opinion");
      expect(sent.attachments).toEqual([
        { label: "The user's last message", text: "How do I retry?" },
        { label: "The agent's last finished answer", text: "b".repeat(100) },
      ]);
    });
  });

  describe("Review", () => {
    const dirtyStatus = {
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature/demo",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "a.ts", insertions: 1, deletions: 0, area: "unstaged" }],
        insertions: 1,
        deletions: 0,
      },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
      defaultRefName: "main",
      aheadOfDefaultCount: 0,
    } as const;
    const reviewContentFor =
      (send: (input: SendRequestsSendInput) => Promise<SendOutcome>) => (choice: SendChoice) =>
        buildReviewPreviewContent({
          options: buildReviewScopeOptions(dirtyStatus),
          pickKey: sendChoiceKey(choice),
          contentFor: (scope) =>
            buildReviewContent({
              scope,
              projectPrompt: "",
              userPrompt: "",
              target: choice.target,
              guardLine: null,
              sourceKey: sendChoiceKey(choice),
              source: choice.source,
              send,
              newId: () => "request-1",
              startNewPanelReview: () =>
                Promise.resolve({
                  threadId: null,
                  created: false,
                  messageId: null,
                  sent: "not-sent",
                }),
            }),
        });

    it('Review to an existing agent sends action "review", the lead-in and the note, no attachments', async () => {
      const send = vi.fn<(input: SendRequestsSendInput) => Promise<SendOutcome>>(() =>
        Promise.resolve({ kind: "sent" }),
      );
      render(baseProps({ send, previewContentFor: reviewContentFor(send) }));
      await openAction("Review");
      await act(async () => menuItem("beta")!.click());
      await flush();
      expect(document.body.textContent).toContain("Uncommitted changes");
      expect(document.body.textContent).toContain("Do not edit files");
      const note = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        setter.call(note, "check the retry path");
        note.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => find("button", "Send")!.click());
      await flush();
      expect(send).toHaveBeenCalledWith({
        requestId: "request-1",
        action: "review",
        source: "thread:source",
        target: "thread:beta",
        leadIn: resolveCodeReviewPrompt({
          project: "",
          user: "",
          scope: { kind: "uncommitted", base: "origin/main" },
        }),
        note: "check the retry path",
        attachments: [],
      });
    });

    it("Review to an agent in another checkout is not offered as enabled", async () => {
      const onChoose = vi.fn();
      render(baseProps({ onChoose }));
      await openAction("Review");
      const blocked = menuItem("gamma")!;
      expect(blocked.getAttribute("aria-disabled")).toBe("true");
      await act(async () => blocked.click());
      expect(onChoose).not.toHaveBeenCalled();
    });
  });

  it("closing the preview returns focus to the control that opened it", async () => {
    render(baseProps({ previewContentFor: () => ({ leadIn: "", attachments: [] }) }));
    await openAction("Message");
    await act(async () => menuItem("beta")!.click());
    await flush();
    await act(async () => find("button", "Cancel")!.click());
    await flush();
    expect(document.body.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(triggers()[0]);
  });

  it("a new-panel target creates the panel once, keeps its id across a retry, and sends to it", async () => {
    const send = vi
      .fn<(input: SendRequestsSendInput) => Promise<SendOutcome>>()
      .mockResolvedValueOnce({ kind: "failed", reason: "unknown_outcome", message: "lost" })
      .mockResolvedValueOnce({ kind: "sent" });
    const createPanel = vi.fn(() => Promise.resolve(ThreadId.make("panel-1")));
    let counter = 0;
    render(
      baseProps({
        send,
        createPanel,
        newId: () => `request-${(counter += 1)}`,
        previewContentFor: () => ({ leadIn: "", attachments: [] }),
      }),
    );
    await openAction("Message");
    await act(async () => exactItem("Codex")!.click());
    await flush();
    const note = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(note, "hello");
      note.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => find("button", "Send")!.click());
    await flush();
    expect(document.body.querySelector('[role="alert"]')!.textContent).toContain(
      "could not confirm the send",
    );
    await act(async () => find("button", "Send")!.click());
    await flush();
    expect(createPanel).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]![0].requestId).toBe(send.mock.calls[1]![0].requestId);
    expect(send.mock.calls[1]![0].target).toBe("thread:panel-1");
  });

  it("a new panel is revealed only after its request was sent", async () => {
    const send = vi
      .fn<(input: SendRequestsSendInput) => Promise<SendOutcome>>()
      .mockResolvedValueOnce({ kind: "failed", reason: "storage", message: "busy" })
      .mockResolvedValueOnce({ kind: "sent" });
    const revealPanel = vi.fn();
    render(
      baseProps({
        send,
        createPanel: () => Promise.resolve(ThreadId.make("panel-1")),
        revealPanel,
        previewContentFor: () => ({ leadIn: "", attachments: [] }),
      }),
    );
    await openAction("Second opinion");
    await act(async () => exactItem("Codex")!.click());
    await flush();
    await act(async () => find("button", "Send")!.click());
    await flush();
    expect(revealPanel).not.toHaveBeenCalled();
    await act(async () => find("button", "Send")!.click());
    await flush();
    expect(revealPanel.mock.calls).toEqual([[ThreadId.make("panel-1")]]);
  });

  it("a send that finishes after its preview was cancelled and another opened reveals nothing", async () => {
    let finish: (outcome: SendOutcome) => void = () => undefined;
    const send = vi.fn(
      () =>
        new Promise<SendOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    const revealPanel = vi.fn();
    render(
      baseProps({
        send,
        createPanel: () => Promise.resolve(ThreadId.make("panel-1")),
        revealPanel,
        previewContentFor: () => ({ leadIn: "", attachments: [] }),
      }),
    );
    await openAction("Second opinion");
    await act(async () => exactItem("Codex")!.click());
    await flush();
    await act(async () => find("button", "Send")!.click());
    await flush();
    await act(async () => find("button", "Cancel")!.click());
    await flush();
    await openAction("Second opinion");
    await act(async () => exactItem("Codex")!.click());
    await flush();
    await act(async () => finish({ kind: "sent" }));
    await flush();
    expect(revealPanel).not.toHaveBeenCalled();
    expect(document.body.querySelector("textarea")).not.toBeNull();
  });

  describe("out-of-tokens hint", () => {
    const hint = {
      kind: "usage-limit",
      text: "Out of usage until 3:30 PM",
      resetsAt: new Date("2026-11-13T15:30:00.000Z"),
    } as const;
    const hintFor = (row: { shell: { title: string } }) =>
      row.shell.title === "beta" ? hint : null;
    const hintedProps = () =>
      baseProps({
        hintFor,
        previewContentFor: (choice) =>
          choice.target.kind === "agent" && choice.action === "take-over"
            ? buildTakeOverContent({
                source: choice.source,
                picked: choice.target.row,
                loadHandoff: () => Promise.resolve({ text: "x", leftOut: 0, includedMessages: 1 }),
                loadTerminalOutput: null,
              })
            : { leadIn: "", attachments: [] },
      });

    it("the hint is shown beside the agent and is part of its accessible name", async () => {
      render(hintedProps());
      await openAction("Message");
      const beta = menuItem("beta")!;
      expect(beta.textContent).toContain("Out of usage until 3:30 PM");
      expect(beta.getAttribute("aria-label")).toBeNull();
      expect(beta.getAttribute("aria-disabled")).toBeNull();
      expect(menuItem("alpha")!.textContent).not.toContain("Out of usage");
    });

    it("picking a hinted agent for Message shows the may-not-answer warning in the preview and Send stays enabled", async () => {
      render(hintedProps());
      await openAction("Message");
      await act(async () => menuItem("beta")!.click());
      await flush();
      expect(document.body.textContent).toContain("This agent may not answer until 3:30 PM.");
      const note = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        setter.call(note, "are you there?");
        note.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(find("button", "Send")!.hasAttribute("disabled")).toBe(false);
    });

    it("the hint can come from the live inputs of the open menu", async () => {
      const props = baseProps({ previewContentFor: () => ({ leadIn: "", attachments: [] }) });
      render({
        ...props,
        renderLive: (renderMenu) => renderMenu({ source: props.source, rows, hintFor }),
      });
      await openAction("Take over from");
      const items = [...document.body.querySelectorAll('[role="menuitem"]')].map(
        (item) => item.textContent ?? "",
      );
      const beta = items.findIndex((text) => text.includes("beta"));
      expect(items[beta]).toContain("Out of usage until 3:30 PM");
      expect(beta).toBeLessThan(items.findIndex((text) => text.includes("alpha")));
    });

    it("picking a hinted agent for Take over from shows no may-not-answer warning", async () => {
      render(hintedProps());
      await openAction("Take over from");
      await act(async () => menuItem("beta")!.click());
      await flush();
      expect(document.body.textContent).toContain("Nothing is sent to beta.");
      expect(document.body.textContent).not.toContain("may not answer");
    });
  });

  describe("Hand off and Take over from", () => {
    const handoffText = "[user] fix the parser\n[assistant] done";
    const loadHandoff = (text = handoffText) =>
      vi.fn<HandoffLoader>(() => Promise.resolve({ text, leftOut: 0, includedMessages: 2 }));
    const sender = () =>
      vi.fn<(input: SendRequestsSendInput) => Promise<SendOutcome>>(() =>
        Promise.resolve({ kind: "sent" }),
      );
    const typeInto = async (area: HTMLTextAreaElement, value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        setter.call(area, value);
        area.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };

    it("Hand off: the source keeps running: only sendRequests.send is called, no interrupt, stop or archive", async () => {
      const send = sender();
      const createPanel = vi.fn(() => Promise.resolve(null));
      const load = loadHandoff();
      const source = sourceOf("source");
      render(
        baseProps({
          source,
          send,
          createPanel,
          newId: () => "request-1",
          previewContentFor: (choice) =>
            buildHandOffContent({ source: choice.source, loadHandoff: load }),
        }),
      );
      await openAction("Hand off");
      await act(async () => menuItem("beta")!.click());
      await flush();
      await act(async () => find("button", "Send")!.click());
      await flush();
      expect(load.mock.calls).toEqual([[ThreadId.make("source")]]);
      expect(createPanel).not.toHaveBeenCalled();
      expect(send.mock.calls).toEqual([
        [
          {
            requestId: "request-1",
            action: "hand-off",
            source: "thread:source",
            target: "thread:beta",
            leadIn: HAND_OFF_LEAD_IN,
            note: "",
            attachments: [{ label: "Handoff from Panel source", text: handoffText }],
          },
        ],
      ]);
    });

    it("Take over from: only getHandoffText for the picked agent and send for the source are called, nothing is sent to the picked agent", async () => {
      const send = sender();
      const load = loadHandoff();
      render(
        baseProps({
          send,
          newId: () => "request-1",
          previewContentFor: (choice) =>
            choice.target.kind === "agent"
              ? buildTakeOverContent({
                  source: choice.source,
                  picked: choice.target.row,
                  loadHandoff: load,
                  loadTerminalOutput: null,
                })
              : null,
        }),
      );
      await openAction("Take over from");
      await act(async () => menuItem("beta")!.click());
      await flush();
      expect(document.body.textContent).toContain(
        "From beta to this agent. Nothing is sent to beta.",
      );
      await act(async () => find("button", "Send")!.click());
      await flush();
      expect(load.mock.calls).toEqual([[ThreadId.make("beta")]]);
      expect(send).toHaveBeenCalledTimes(1);
      const sent = send.mock.calls[0]![0];
      expect(sent).toMatchObject({
        action: "take-over",
        source: "thread:source",
        target: "thread:source",
        takenOver: "thread:beta",
        leadIn: TAKE_OVER_LEAD_IN,
        attachments: [{ label: "Handoff from beta", text: handoffText }],
      });
    });

    it("trimming: removing the oldest part of an 18,000 character handoff text sends the shortened text and the note", async () => {
      const text = `${"old ".repeat(2_000)}${"new ".repeat(2_500)}`;
      expect(text.length).toBe(18_000);
      const send = sender();
      const load = loadHandoff(text);
      render(
        baseProps({
          send,
          previewContentFor: (choice) =>
            buildHandOffContent({ source: choice.source, loadHandoff: load }),
        }),
      );
      await openAction("Hand off");
      await act(async () => menuItem("beta")!.click());
      await flush();
      const [note, attached] = [...document.body.querySelectorAll<HTMLTextAreaElement>("textarea")];
      expect(attached!.value).toBe(text);
      await typeInto(note!, "start from the new part");
      await typeInto(attached!, text.slice(8_000));
      await act(async () => find("button", "Send")!.click());
      await flush();
      const sent = send.mock.calls[0]![0];
      expect(sent.note).toBe("start from the new part");
      expect(sent.attachments).toEqual([
        { label: "Handoff from Panel source", text: text.slice(8_000) },
      ]);
    });
  });
});
