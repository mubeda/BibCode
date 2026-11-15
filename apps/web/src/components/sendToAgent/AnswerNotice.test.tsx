// @vitest-environment happy-dom

import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import { EnvironmentId, ThreadId, type SendRequest } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  drafts: new Map<string, string>(),
  commands: [] as unknown[],
  targetTitle: "Parser agent" as string | undefined,
  getAnswer: ((_requestId: string) => Promise.resolve(undefined)) as (
    requestId: string,
  ) => Promise<unknown>,
}));

vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getComposerDraft: (ref: { threadId: string }) => {
        const prompt = h.drafts.get(ref.threadId);
        return prompt === undefined ? null : { prompt };
      },
      setPrompt: (ref: { threadId: string }, prompt: string) => h.drafts.set(ref.threadId, prompt),
    }),
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === null ? null : [{ threadId: "target", terminalId: "term-1" }],
  }),
}));
vi.mock("~/state/terminal", () => ({ terminalEnvironment: { metadata: () => ({}) } }));
vi.mock("~/centerPanelStore", () => ({ useCenterPanelStore: { getState: () => ({}) } }));
vi.mock("~/state/entities", () => ({
  useThreadShell: () => (h.targetTitle === undefined ? undefined : { title: h.targetTitle }),
}));
// Any command a notice ran would land here: Bring back must start no turn.
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => (input: unknown) => {
    h.commands.push(input);
    return Promise.resolve({ _tag: "Success", value: undefined });
  },
}));
vi.mock("~/state/sendRequests", () => ({
  useGetAnswer: () => (requestId: string) => h.getAnswer(requestId),
}));

import { useSendRequestOpenedStore } from "~/sendRequestOpenedStore";
import { CenterSurfaceVisibleContext } from "../centerSurfaceVisibility";
import { AnswerNotice, ANSWER_READ_FAILED } from "./AnswerNotice";
import { SendRequestRows } from "./SendRequestRow";

const ENV = EnvironmentId.make("environment-a");
const HOST = scopeThreadRef(ENV, ThreadId.make("source"));

function request(overrides: Partial<SendRequest> = {}): SendRequest {
  return {
    requestId: "request-1",
    projectId: "project-a",
    action: "review",
    source: "thread:source",
    sourceThreadId: ThreadId.make("source"),
    target: "thread:target",
    targetThreadId: ThreadId.make("target"),
    takenOver: null,
    targetMessageId: null,
    state: "answered",
    reason: null,
    answerMessageId: null,
    answeringTurnId: null,
    createdAt: "2026-11-13T10:00:00.000Z",
    updatedAt: "2026-11-13T10:00:01.000Z",
    dismissedAt: null,
    ...overrides,
  } as SendRequest;
}

let root: Root;
let container: HTMLDivElement;
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const button = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) =>
    entry.textContent?.includes(text),
  );

function render(
  props: {
    request?: SendRequest;
    onOpen?: () => void;
    onDismiss?: (id: string) => Promise<void>;
    onBringBack?: (text: string) => void;
  } = {},
) {
  const onDismiss = props.onDismiss ?? vi.fn(() => Promise.resolve());
  act(() =>
    root.render(
      <AnswerNotice
        request={props.request ?? request()}
        hostRef={HOST}
        onOpen={props.onOpen ?? vi.fn()}
        onDismiss={onDismiss}
        {...(props.onBringBack === undefined ? {} : { onBringBack: props.onBringBack })}
      />,
    ),
  );
  return { onDismiss };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.drafts.clear();
  h.commands.length = 0;
  h.targetTitle = "Parser agent";
  h.getAnswer = vi.fn(() =>
    Promise.resolve({
      _tag: "Success",
      value: { requestId: "request-1", text: "Two bugs.\n\nFix both.", truncated: false },
    }),
  ) as never;
  useSendRequestOpenedStore.setState({ openedIds: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("AnswerNotice", () => {
  it("Open on an answer from an AI Terminal passes the terminal id", () => {
    const onOpen = vi.fn();
    render({ request: request({ target: "terminal:target/term-1" }), onOpen });
    act(() => button("Open")?.click());
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ threadId: "target" }), "term-1");
  });

  it("an answered Review names the target and offers Bring back, Open and Dismiss", () => {
    render();
    expect(container.textContent).toContain("Parser agent answered");
    expect(button("Bring back")).toBeDefined();
    expect(button("Open")).toBeDefined();
    expect(button("Dismiss")).toBeDefined();
  });

  it("the right answer: Bring back quotes the text that getAnswer returns for the request, not the target's latest answer", async () => {
    render();
    await act(async () => button("Bring back")!.click());
    await flush();
    expect(h.getAnswer).toHaveBeenCalledWith("request-1");
    expect(h.drafts.get("source")).toBe("Review from Parser agent:\n\n> Two bugs.\n>\n> Fix both.");
  });

  it("Bring back reads the answer by request id, so it works when the target is gone and has no messages loaded", async () => {
    h.targetTitle = undefined;
    render({ request: request({ action: "second-opinion" }) });
    await act(async () => button("Bring back")!.click());
    await flush();
    expect(h.drafts.get("source")).toBe(
      "Second opinion from another agent:\n\n> Two bugs.\n>\n> Fix both.",
    );
  });

  it("the person decides: Bring back drafts after what is already there and sends nothing", async () => {
    h.drafts.set("source", "my own notes");
    render();
    await act(async () => button("Bring back")!.click());
    await flush();
    expect(h.drafts.get("source")).toBe(
      "my own notes\n\nReview from Parser agent:\n\n> Two bugs.\n>\n> Fix both.",
    );
    expect(h.commands).toEqual([]);
  });

  it("Bring back dismisses the request once it has drafted", async () => {
    const { onDismiss } = render();
    await act(async () => button("Bring back")!.click());
    await flush();
    expect(onDismiss).toHaveBeenCalledWith("request-1");
  });

  it("Dismiss removes the notice and leaves the draft alone", async () => {
    h.drafts.set("source", "my own notes");
    const { onDismiss } = render();
    await act(async () => button("Dismiss")!.click());
    await flush();
    expect(onDismiss).toHaveBeenCalledWith("request-1");
    expect(h.drafts.get("source")).toBe("my own notes");
    expect(h.getAnswer).not.toHaveBeenCalled();
  });

  it('a turn that failed: the notice says "did not answer" with Open and no Bring back', () => {
    render({ request: request({ state: "not_answered", reason: "turn_failed" }) });
    expect(container.textContent).toContain("Parser agent did not answer: its turn failed");
    expect(button("Open")).toBeDefined();
    expect(button("Bring back")).toBeUndefined();
    expect(button("Dismiss")).toBeDefined();
  });

  it("Bring back says Reading the answer while it reads, and a failed read says so and drafts nothing", async () => {
    let finish: (value: unknown) => void = () => undefined;
    h.getAnswer = vi.fn(() => new Promise((resolve) => (finish = resolve))) as never;
    render();
    await act(async () => button("Bring back")!.click());
    expect(container.textContent).toContain("Reading the answer");
    await act(async () => finish({ _tag: "Failure" }));
    await flush();
    expect(container.textContent).toContain(ANSWER_READ_FAILED);
    expect(ANSWER_READ_FAILED).toBe("BiBCode could not read the answer. Try again.");
    expect(h.drafts.size).toBe(0);
    expect(button("Bring back")).toBeDefined();
  });

  it("a new notice is announced politely", () => {
    act(() =>
      root.render(
        <SendRequestRows
          environmentId={ENV}
          requests={[request()]}
          onOpen={vi.fn()}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
          renderAnswer={(entry) => (
            <AnswerNotice request={entry} hostRef={HOST} onOpen={vi.fn()} onDismiss={vi.fn()} />
          )}
        />,
      ),
    );
    const region = container.querySelector('[role="status"]')!;
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.querySelector("[data-answer-notice]")).not.toBeNull();
  });

  describe("a terminal source", () => {
    const terminalRequest = (overrides: Partial<SendRequest> = {}) =>
      request({ source: "terminal:source/term-1", ...overrides });

    it("a_terminal_answer_is_quoted_from_the_getAnswer_text", async () => {
      const onBringBack = vi.fn();
      h.getAnswer = vi.fn(() =>
        Promise.resolve({
          _tag: "Success",
          value: { requestId: "request-1", text: "Two bugs.", truncated: true },
        }),
      ) as never;
      render({ request: terminalRequest(), onBringBack });
      await act(async () => button("Bring back")!.click());
      await flush();
      expect(h.getAnswer).toHaveBeenCalledWith("request-1");
      expect(onBringBack).toHaveBeenCalledWith(
        "Review from Parser agent:\n\n> Two bugs.\n\n(The answer was cut at 48,000 characters.)",
      );
    });

    it("bring_back_opens_the_terminal_composer_with_the_quoted_answer_and_types_nothing", async () => {
      const onBringBack = vi.fn();
      const { onDismiss } = render({ request: terminalRequest(), onBringBack });
      await act(async () => button("Bring back")!.click());
      await flush();
      expect(onBringBack).toHaveBeenCalledTimes(1);
      expect(onBringBack.mock.calls[0]![0]).toContain("> Two bugs.");
      // The owner thread's composer is untouched and no command ran: nothing reaches the terminal.
      expect(h.drafts.size).toBe(0);
      expect(h.commands).toEqual([]);
      expect(onDismiss).toHaveBeenCalledWith("request-1");
    });

    it("a_bring_back_that_finishes_after_the_notice_is_gone_does_nothing", async () => {
      let finish: (value: unknown) => void = () => undefined;
      h.getAnswer = vi.fn(() => new Promise((resolve) => (finish = resolve))) as never;
      const onBringBack = vi.fn();
      const { onDismiss } = render({ request: terminalRequest(), onBringBack });
      await act(async () => button("Bring back")!.click());
      act(() => root.render(null));
      await act(async () =>
        finish({
          _tag: "Success",
          value: { requestId: "request-1", text: "late", truncated: false },
        }),
      );
      expect(onBringBack).not.toHaveBeenCalled();
      expect(onDismiss).not.toHaveBeenCalled();
    });

    it("a_not_answered_terminal_request_offers_open_and_no_bring_back", () => {
      render({
        request: terminalRequest({ state: "not_answered", reason: "recipient_gone" }),
        onBringBack: vi.fn(),
      });
      expect(container.textContent).toContain("did not answer: the terminal closed");
      expect(button("Open")).toBeDefined();
      expect(button("Bring back")).toBeUndefined();
    });
  });

  it("showing the notice marks its request opened", () => {
    render();
    expect(useSendRequestOpenedStore.getState().openedIds).toEqual(["request-1"]);
  });

  it("a notice on a hidden surface is not opened until the surface is shown", () => {
    const tree = (visible: boolean) => (
      <CenterSurfaceVisibleContext value={visible}>
        <AnswerNotice request={request()} hostRef={HOST} onOpen={vi.fn()} onDismiss={vi.fn()} />
      </CenterSurfaceVisibleContext>
    );
    act(() => root.render(tree(false)));
    expect(useSendRequestOpenedStore.getState().openedIds).toEqual([]);
    act(() => root.render(tree(true)));
    expect(useSendRequestOpenedStore.getState().openedIds).toEqual(["request-1"]);
  });
});
