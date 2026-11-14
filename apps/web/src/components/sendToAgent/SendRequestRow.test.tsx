// @vitest-environment happy-dom

import { EnvironmentId, ThreadId, type SendRequest } from "@bibcode/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const shells = vi.hoisted(() => new Map<string, { title: string }>());
vi.mock("~/state/entities", () => ({
  useThreadShell: (ref: { threadId: string } | null) =>
    ref === null ? null : (shells.get(ref.threadId) ?? null),
}));

import {
  describeRequestRow,
  selectRowsForThread,
  SendRequestRows,
  type SendRequestRowsProps,
} from "./SendRequestRow";

const environmentId = EnvironmentId.make("environment-a");

function request(overrides: Partial<SendRequest> = {}): SendRequest {
  return {
    requestId: "request-1",
    projectId: "project-1",
    action: "message",
    source: "thread:source",
    sourceThreadId: ThreadId.make("source"),
    target: "thread:target",
    targetThreadId: ThreadId.make("target"),
    takenOver: null,
    targetMessageId: null,
    state: "queued",
    reason: null,
    answerMessageId: null,
    answeringTurnId: null,
    createdAt: "2026-11-13T10:00:00.000Z",
    updatedAt: "2026-11-13T10:00:00.000Z",
    dismissedAt: null,
    ...overrides,
  } as SendRequest;
}

let root: Root;
let container: HTMLDivElement;

function render(
  requests: ReadonlyArray<SendRequest>,
  overrides: Partial<SendRequestRowsProps> = {},
) {
  const props: SendRequestRowsProps = {
    environmentId,
    requests,
    onOpen: vi.fn(),
    onCancel: vi.fn(() => Promise.resolve()),
    onDismiss: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
  act(() => root.render(<SendRequestRows {...props} />));
  return props;
}

const button = (text: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent === text,
  );
const buttons = () =>
  [...container.querySelectorAll("button")].map((element) => element.textContent);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  shells.set("target", { title: "Codex panel" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  shells.clear();
});

describe("SendRequestRows", () => {
  it("queued shows Open and Cancel", () => {
    render([request()]);
    expect(container.textContent).toContain("Queued for Codex panel");
    expect(buttons()).toEqual(["Open", "Cancel"]);
  });

  it("the target's queue is paused: waiting shows \"Waiting: this agent's queue is paused\" with Open and Cancel and is not a silent queued row", () => {
    render([request({ state: "waiting", reason: "queue_paused" })]);
    expect(container.textContent).toContain("Waiting: this agent's queue is paused");
    expect(container.textContent).not.toContain("Queued for");
    expect(buttons()).toEqual(["Open", "Cancel"]);
  });

  it("Cancel calls onCancel once with the request id and is disabled while it runs", async () => {
    let finish: () => void = () => undefined;
    const onCancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render([request()], { onCancel });
    await act(async () => button("Cancel")!.click());
    await act(async () => button("Cancel")!.click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith("request-1");
    expect(button("Cancel")!.disabled).toBe(true);
    await act(async () => finish());
    expect(button("Cancel")!.disabled).toBe(false);
  });

  it('a cancelled request reads "Cancelled" with Dismiss and no Cancel', () => {
    render([request({ state: "cancelled" })]);
    expect(container.textContent).toContain("Cancelled");
    expect(buttons()).toEqual(["Dismiss"]);
  });

  it('the target is deleted: not answered names "the agent was deleted", offers no Open and no Bring back', () => {
    render([request({ action: "review", state: "not_answered", reason: "target_deleted" })]);
    expect(container.textContent).toContain("did not answer: the agent was deleted");
    expect(buttons()).toEqual(["Dismiss"]);
    expect(container.textContent).not.toContain("Bring back");
  });

  it('a failed or interrupted turn reads "did not answer: its turn failed" or "its turn was interrupted"', () => {
    expect(
      describeRequestRow(request({ state: "not_answered", reason: "turn_failed" }), "Codex").text,
    ).toBe("Codex did not answer: its turn failed");
    expect(
      describeRequestRow(request({ state: "not_answered", reason: "turn_interrupted" }), "Codex")
        .text,
    ).toBe("Codex did not answer: its turn was interrupted");
  });

  it("a chat target shows read when its turn started and never shows delivered", () => {
    render([request({ action: "review", state: "read" })]);
    expect(container.textContent).toContain("Codex panel read it");
    expect(container.textContent).not.toContain("Delivered");
  });

  it("a Message, Hand off or Take over row is not shown once it is read", () => {
    for (const action of ["message", "hand-off", "take-over"] as const) {
      expect(describeRequestRow(request({ action, state: "read" }), "Codex").showRow).toBe(false);
    }
    render([request({ action: "message", state: "read" })]);
    expect(container.querySelector("[data-send-request-state]")).toBeNull();
  });

  it("a Review or Second opinion row stays after it is read and hands its answered and not_answered states to renderAnswer", () => {
    const renderAnswer = vi.fn((entry: SendRequest) => (
      <p data-answer={entry.requestId}>answer for {entry.state}</p>
    ));
    render(
      [
        request({ requestId: "a", action: "review", state: "read" }),
        request({ requestId: "b", action: "second-opinion", state: "answered" }),
        request({ requestId: "c", action: "review", state: "not_answered", reason: "no_answer" }),
      ],
      { renderAnswer: renderAnswer as (entry: SendRequest) => ReactNode },
    );
    expect(container.querySelector('[data-send-request-state="read"]')).not.toBeNull();
    expect(container.querySelector('[data-answer="b"]')).not.toBeNull();
    expect(container.querySelector('[data-answer="c"]')).not.toBeNull();
    expect(renderAnswer.mock.calls.map(([entry]) => entry.requestId)).toEqual(["b", "c"]);
  });

  it("rows of other source threads are not shown", () => {
    const mine = request({ requestId: "mine" });
    const other = request({ requestId: "other", sourceThreadId: ThreadId.make("elsewhere") });
    const terminal = request({
      requestId: "terminal",
      source: "terminal:source/t1",
    });
    expect(
      selectRowsForThread([mine, other, terminal], ThreadId.make("source")).map(
        (entry) => entry.requestId,
      ),
    ).toEqual(["mine"]);
  });

  it("a state change is announced politely", () => {
    render([request()]);
    const region = container.querySelector('[role="status"]');
    expect(region?.getAttribute("aria-live")).toBe("polite");
    render([request({ state: "waiting", reason: "queue_paused" })]);
    expect(container.querySelector('[role="status"]')).toBe(region);
    expect(region?.textContent).toContain("Waiting");
  });
});
