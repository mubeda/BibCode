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

  it("showing the notice marks its request opened", () => {
    render();
    expect(useSendRequestOpenedStore.getState().openedIds).toEqual(["request-1"]);
  });
});
