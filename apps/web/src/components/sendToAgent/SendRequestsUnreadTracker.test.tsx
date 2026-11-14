// @vitest-environment happy-dom

import { scopedThreadKey, scopeThreadRef } from "@bibcode/client-runtime/environment";
import { EnvironmentId, ThreadId, type SendRequest } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  requests: new Map<string, unknown[]>(),
  environments: ["environment-a"] as string[],
}));

vi.mock("~/state/sendRequests", () => ({
  useSendRequests: (environmentId: string | null) =>
    (environmentId === null ? undefined : h.requests.get(environmentId)) ?? [],
}));
vi.mock("~/state/entities", () => ({
  useServerConfigs: () =>
    new Map(
      h.environments.map((id) => [id, { environment: { capabilities: { sendRequests: true } } }]),
    ),
}));

import { useSendRequestOpenedStore } from "~/sendRequestOpenedStore";
import { useSidebarWorkspaceMetaStore } from "~/sidebarWorkspaceMetaStore";
import { SendRequestsUnreadTracker, unreadSourceKeys } from "./SendRequestsUnreadTracker";

const ENV = EnvironmentId.make("environment-a");
const key = (threadId: string) => scopedThreadKey(scopeThreadRef(ENV, ThreadId.make(threadId)));

function request(id: string, overrides: Partial<SendRequest> = {}): SendRequest {
  return {
    requestId: id,
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

const none = new Set<string>();

describe("unreadSourceKeys", () => {
  it("a source thread with an unopened answered request is unread, also an unanswered one", () => {
    expect(
      unreadSourceKeys({ requests: [request("r1")], openedIds: none, environmentId: ENV }),
    ).toEqual([key("source")]);
    expect(
      unreadSourceKeys({
        requests: [
          request("r2", {
            state: "not_answered",
            reason: "turn_failed",
            sourceThreadId: ThreadId.make("other"),
          }),
        ],
        openedIds: none,
        environmentId: ENV,
      }),
    ).toEqual([key("other")]);
  });

  it("an opened notice is no longer counted", () => {
    expect(
      unreadSourceKeys({
        requests: [request("r1")],
        openedIds: new Set(["r1"]),
        environmentId: ENV,
      }),
    ).toEqual([]);
  });

  it("a dismissed request, a Message request and a request still queued count for nothing", () => {
    expect(
      unreadSourceKeys({
        requests: [
          request("r1", { dismissedAt: "2026-11-13T11:00:00.000Z" }),
          request("r2", { action: "message" }),
          request("r3", { state: "queued" }),
          request("r4", { state: "delivered" }),
        ],
        openedIds: none,
        environmentId: ENV,
      }),
    ).toEqual([]);
  });

  it("a request sent from a terminal marks its owning thread, through sourceThreadId", () => {
    expect(
      unreadSourceKeys({
        requests: [request("r1", { source: "terminal:source/t1" })],
        openedIds: none,
        environmentId: ENV,
      }),
    ).toEqual([key("source")]);
  });

  it("an answered request that arrives on a later page is counted", () => {
    const first = [request("r1", { state: "queued" })];
    expect(unreadSourceKeys({ requests: first, openedIds: none, environmentId: ENV })).toEqual([]);
    const withPage = [...first, request("r9", { sourceThreadId: ThreadId.make("late") })];
    expect(unreadSourceKeys({ requests: withPage, openedIds: none, environmentId: ENV })).toEqual([
      key("late"),
    ]);
  });
});

describe("SendRequestsUnreadTracker", () => {
  let root: Root;
  let container: HTMLDivElement;
  const unread = () => useSidebarWorkspaceMetaStore.getState().unreadThreadKeys;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    useSidebarWorkspaceMetaStore.setState({ unreadThreadKeys: [], pinnedThreadKeys: [] });
    useSendRequestOpenedStore.setState({ openedIds: [] });
    h.requests.clear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("after a reload an unopened answered request marks its thread unread and an opened one does not", () => {
    h.requests.set("environment-a", [
      request("r1"),
      request("r2", { sourceThreadId: ThreadId.make("seen") }),
    ]);
    useSendRequestOpenedStore.setState({ openedIds: ["r2"] });
    act(() => root.render(<SendRequestsUnreadTracker />));
    expect(unread()).toEqual([key("source")]);
  });

  it("opening the notice clears the mark the tracker set", () => {
    h.requests.set("environment-a", [request("r1")]);
    act(() => root.render(<SendRequestsUnreadTracker />));
    expect(unread()).toEqual([key("source")]);
    act(() => useSendRequestOpenedStore.getState().markOpened("r1"));
    expect(unread()).toEqual([]);
  });

  it("forgets an opened id once its request has left the list", () => {
    h.requests.set("environment-a", [request("r1")]);
    useSendRequestOpenedStore.setState({ openedIds: ["r1", "never-seen"] });
    act(() => root.render(<SendRequestsUnreadTracker />));
    h.requests.set("environment-a", []);
    // The mocked request list is not reactive; a store change re-renders the tracker.
    act(() => useSendRequestOpenedStore.setState({ openedIds: ["r1", "never-seen"] }));
    expect(useSendRequestOpenedStore.getState().openedIds).toEqual(["never-seen"]);
  });
});
