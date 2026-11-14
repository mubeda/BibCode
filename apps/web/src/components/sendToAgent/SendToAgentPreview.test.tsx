// @vitest-environment happy-dom

import { EnvironmentId, ProjectId, ThreadId, type SendRequestsSendInput } from "@bibcode/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useSendToAgentStore } from "~/sendToAgentStore";
import type { SendOutcome } from "~/state/sendRequests";
import { SendToAgentPreview } from "./SendToAgentPreview";
import {
  sendChoiceKey,
  submitSendChoice,
  type PreviewAttachment,
  type PreviewDraft,
  type SendChoice,
  type SendToAgentSource,
} from "./sendToAgent.logic";

const source: SendToAgentSource = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("source"),
  terminalId: null,
  projectId: ProjectId.make("project-a"),
  title: "API refactor",
  checkout: "/repo/a",
  messages: [],
  terminalHasText: false,
};
const choiceOf = (action: SendChoice["action"]): SendChoice => ({
  source,
  action,
  target: {
    kind: "agent",
    address: "thread:target",
    row: {} as never,
  },
});

let root: Root;
let container: HTMLDivElement;

interface Harness {
  action?: SendChoice["action"];
  attachments?: ReadonlyArray<PreviewAttachment>;
  send?: (input: SendRequestsSendInput) => Promise<SendOutcome>;
  onSend?: (draft: PreviewDraft) => Promise<SendOutcome>;
  onClose?: () => void;
  onPickAnother?: () => void;
  leadIn?: string;
}

function Host(props: Harness) {
  const [open, setOpen] = useState(true);
  const choice = choiceOf(props.action ?? "message");
  const send = props.send ?? (() => Promise.resolve<SendOutcome>({ kind: "sent" }));
  let counter = 0;
  return (
    <>
      <button type="button" data-reopen onClick={() => setOpen(true)} />
      <SendToAgentPreview
        open={open}
        source={{ key: sendChoiceKey(choice), title: source.title }}
        action={choice.action}
        target={{ title: "Review bot", providerLabel: "Codex", newPanel: false }}
        leadIn={props.leadIn ?? ""}
        initialAttachments={props.attachments ?? []}
        onClose={() => {
          props.onClose?.();
          setOpen(false);
        }}
        onSend={
          props.onSend ??
          ((draft) =>
            submitSendChoice(
              {
                send,
                createPanel: () => Promise.resolve(null),
                newId: () => `id-${(counter += 1)}`,
              },
              choice,
              draft,
            ))
        }
        onPickAnother={props.onPickAnother ?? (() => undefined)}
      />
    </>
  );
}

function render(props: Harness = {}) {
  act(() => root.render(<Host {...props} />));
}

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const textareas = () => [...document.body.querySelectorAll<HTMLTextAreaElement>("textarea")];
const button = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === text,
  );
const body = () => document.body.textContent ?? "";

async function typeInto(field: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const click = (element: HTMLElement | undefined) => act(async () => element!.click());

const attachment = (
  id: string,
  text: string,
  overrides: Partial<PreviewAttachment> = {},
): PreviewAttachment => ({ id, label: `Attachment ${id}`, text, leftOut: null, ...overrides });

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

describe("SendToAgentPreview", () => {
  it("names the source, the target, the note field and each attachment with its size and what was left out", () => {
    render({
      action: "second-opinion",
      attachments: [
        attachment("a", "x".repeat(1_234), {
          label: "Last answer",
          leftOut: "the first 800 characters",
        }),
      ],
    });
    expect(body()).toContain("From API refactor to Review bot (Codex)");
    expect(body()).toContain("Note (optional)");
    expect(body()).toContain("Last answer");
    expect(body()).toContain("1,234 characters");
    expect(body()).toContain("Left out: the first 800 characters");
  });

  it("trimming: removing the oldest part of an 18,000 character attachment sends the shortened text and the note", async () => {
    const send = vi.fn(() => Promise.resolve<SendOutcome>({ kind: "sent" }));
    const text = `${"old ".repeat(2_000)}${"new ".repeat(2_500)}`;
    expect(text.length).toBe(18_000);
    render({ action: "hand-off", send, attachments: [attachment("a", text)] });
    const [note, attached] = textareas();
    await typeInto(note!, "start from the new part");
    const shortened = text.slice(8_000);
    await typeInto(attached!, shortened);
    expect(body()).toContain("10,000 characters");
    await click(button("Send"));
    await flush();
    expect(send).toHaveBeenCalledTimes(1);
    const input = (send.mock.calls[0] as unknown as [SendRequestsSendInput])[0];
    expect(input.note).toBe("start from the new part");
    expect(input.attachments).toEqual([{ label: "Attachment a", text: shortened }]);
  });

  it("removing an attachment sends the note alone", async () => {
    const send = vi.fn(() => Promise.resolve<SendOutcome>({ kind: "sent" }));
    render({ action: "review", send, attachments: [attachment("a", "diff text")] });
    await typeInto(textareas()[0]!, "only this");
    await click(button("Remove"));
    expect(textareas()).toHaveLength(1);
    await click(button("Send"));
    await flush();
    const input = (send.mock.calls[0] as unknown as [SendRequestsSendInput])[0];
    expect(input.attachments).toEqual([]);
    expect(input.note).toBe("only this");
  });

  it("backing out: closing sends nothing, leaves the composer draft unchanged and keeps the note for the next opening", async () => {
    const send = vi.fn(() => Promise.resolve<SendOutcome>({ kind: "sent" }));
    const draftsBefore = useComposerDraftStore.getState();
    render({ send });
    await typeInto(textareas()[0]!, "half written");
    await click(button("Cancel"));
    await flush();
    expect(textareas()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState()).toBe(draftsBefore);
    await click(document.body.querySelector<HTMLElement>("[data-reopen]")!);
    await flush();
    expect(textareas()[0]!.value).toBe("half written");
  });

  it('a Message with an empty or whitespace note disables Send with "Write a message first" and nothing can be sent', async () => {
    const send = vi.fn(() => Promise.resolve<SendOutcome>({ kind: "sent" }));
    render({ send });
    expect(button("Send")!.disabled).toBe(true);
    expect(body()).toContain("Write a message first");
    await typeInto(textareas()[0]!, "   \n");
    expect(button("Send")!.disabled).toBe(true);
    await click(button("Send"));
    expect(send).not.toHaveBeenCalled();
  });

  it("Message sends the note with no attachment", async () => {
    const send = vi.fn(() => Promise.resolve<SendOutcome>({ kind: "sent" }));
    render({ send });
    await typeInto(textareas()[0]!, "hello");
    await click(button("Send"));
    await flush();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ action: "message", note: "hello", attachments: [] }),
    );
  });

  it("a failed send keeps the note and the attachments and says what failed and what to do", async () => {
    const send = vi.fn(() =>
      Promise.resolve<SendOutcome>({ kind: "failed", reason: "storage", message: "disk" }),
    );
    render({ action: "review", send, attachments: [attachment("a", "diff text")] });
    await typeInto(textareas()[0]!, "keep me");
    await click(button("Send"));
    await flush();
    expect(document.body.querySelector('[role="alert"]')!.textContent).toBe(
      "BiBCode could not send this. Try again.",
    );
    expect(textareas()[0]!.value).toBe("keep me");
    expect(textareas()[1]!.value).toBe("diff text");
    expect(button("Send")!.disabled).toBe(false);
  });

  it("connection lost: pressing Send again reuses the request id", async () => {
    const send = vi
      .fn<(input: SendRequestsSendInput) => Promise<SendOutcome>>()
      .mockResolvedValueOnce({ kind: "failed", reason: "unknown_outcome", message: "lost" })
      .mockResolvedValueOnce({ kind: "sent" });
    render({ send });
    await typeInto(textareas()[0]!, "hello");
    await click(button("Send"));
    await flush();
    expect(document.body.querySelector('[role="alert"]')!.textContent).toContain(
      "Press Send again; the agent receives it once.",
    );
    await click(button("Send"));
    await flush();
    expect(send.mock.calls[0]![0].requestId).toBe(send.mock.calls[1]![0].requestId);
  });

  it("an edited retry sends a new request id", async () => {
    const send = vi
      .fn<(input: SendRequestsSendInput) => Promise<SendOutcome>>()
      .mockResolvedValueOnce({ kind: "failed", reason: "unknown_outcome", message: "lost" })
      .mockResolvedValueOnce({ kind: "sent" });
    render({ send });
    await typeInto(textareas()[0]!, "hello");
    await click(button("Send"));
    await flush();
    await typeInto(textareas()[0]!, "hello again");
    await click(button("Send"));
    await flush();
    expect(send.mock.calls[0]![0].requestId).not.toBe(send.mock.calls[1]![0].requestId);
  });

  it('target gone: the preview stays open with its note, says "This agent no longer exists. Pick another agent." and offers Pick another agent', async () => {
    const onPickAnother = vi.fn();
    const send = vi.fn(() =>
      Promise.resolve<SendOutcome>({ kind: "failed", reason: "unknown_thread", message: "" }),
    );
    render({ send, onPickAnother });
    await typeInto(textareas()[0]!, "still here");
    await click(button("Send"));
    await flush();
    expect(document.body.querySelector('[role="alert"]')!.textContent).toBe(
      "This agent no longer exists. Pick another agent.",
    );
    expect(textareas()[0]!.value).toBe("still here");
    await click(button("Pick another agent"));
    expect(onPickAnother).toHaveBeenCalledTimes(1);
  });

  it("Send is disabled while a send is in flight", async () => {
    let finish: (outcome: SendOutcome) => void = () => undefined;
    const send = vi.fn(
      () =>
        new Promise<SendOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    render({ send });
    await typeInto(textareas()[0]!, "hello");
    await click(button("Send"));
    expect(button("Sending")!.disabled).toBe(true);
    await click(button("Sending"));
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => finish({ kind: "sent" }));
    await flush();
  });

  it("a send through a custom submit also clears the note", async () => {
    const onSend = vi.fn(() => Promise.resolve<SendOutcome>({ kind: "sent" }));
    render({ onSend });
    await typeInto(textareas()[0]!, "hello");
    await click(button("Send"));
    await flush();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(
      useSendToAgentStore.getState().notes[sendChoiceKey(choiceOf("message"))],
    ).toBeUndefined();
  });

  it("a successful send closes the preview and clears the note", async () => {
    const onClose = vi.fn();
    render({ onClose });
    await typeInto(textareas()[0]!, "hello");
    expect(useSendToAgentStore.getState().notes[sendChoiceKey(choiceOf("message"))]).toBe("hello");
    await click(button("Send"));
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(textareas()).toHaveLength(0);
    expect(
      useSendToAgentStore.getState().notes[sendChoiceKey(choiceOf("message"))],
    ).toBeUndefined();
  });
  describe("a send that finishes after Cancel and a reopen", () => {
    const key = sendChoiceKey(choiceOf("message"));
    const reopen = () =>
      act(async () => document.querySelector<HTMLElement>("[data-reopen]")!.click());

    it.each([
      ["the default submit", false],
      ["a custom submit", true],
    ])("leaves the new preview, its note and its pending id alone (%s)", async (_name, custom) => {
      let finish: (outcome: SendOutcome) => void = () => undefined;
      const delayed = () =>
        new Promise<SendOutcome>((resolve) => {
          finish = resolve;
        });
      const onClose = vi.fn();
      render(custom ? { onClose, onSend: delayed } : { onClose, send: delayed });
      await typeInto(textareas()[0]!, "first note");
      await click(button("Send"));
      await click(button("Cancel"));
      expect(onClose).toHaveBeenCalledTimes(1);
      await reopen();
      await typeInto(textareas()[0]!, "second note");

      await act(async () => finish({ kind: "sent" }));
      await flush();

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(textareas()[0]!.value).toBe("second note");
      expect(useSendToAgentStore.getState().notes[key]).toBe("second note");
    });

    it("still clears the note it sent when nothing was typed since", async () => {
      let finish: (outcome: SendOutcome) => void = () => undefined;
      const send = () =>
        new Promise<SendOutcome>((resolve) => {
          finish = resolve;
        });
      render({ send });
      await typeInto(textareas()[0]!, "first note");
      await click(button("Send"));
      await click(button("Cancel"));
      await act(async () => finish({ kind: "sent" }));
      await flush();
      expect(useSendToAgentStore.getState().notes[key]).toBeUndefined();
      expect(useSendToAgentStore.getState().pending[key]).toBeUndefined();
    });
  });
});
