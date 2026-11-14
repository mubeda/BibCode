import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { sendSourceKey, useSendToAgentStore } from "./sendToAgentStore";

const environmentId = EnvironmentId.make("environment-a");

beforeEach(() => {
  useSendToAgentStore.setState({ notes: {}, pending: {}, panels: {} });
});

describe("sendToAgentStore", () => {
  it("a note is kept per panel after the preview closes", () => {
    const key = sendSourceKey({ environmentId, threadId: ThreadId.make("a"), terminalId: null });
    useSendToAgentStore.getState().setNote(key, "check the retry path");
    expect(useSendToAgentStore.getState().notes[key]).toBe("check the retry path");
  });

  it("two panels keep separate notes", () => {
    const first = sendSourceKey({ environmentId, threadId: ThreadId.make("a"), terminalId: null });
    const second = sendSourceKey({ environmentId, threadId: ThreadId.make("b"), terminalId: null });
    const terminal = sendSourceKey({
      environmentId,
      threadId: ThreadId.make("a"),
      terminalId: "t1",
    });
    const store = useSendToAgentStore.getState();
    store.setNote(first, "one");
    store.setNote(second, "two");
    expect(useSendToAgentStore.getState().notes[first]).toBe("one");
    expect(useSendToAgentStore.getState().notes[second]).toBe("two");
    expect(useSendToAgentStore.getState().notes[terminal]).toBeUndefined();
  });

  it("a request id is reused while the arguments are unchanged", () => {
    let counter = 0;
    const newId = () => `request-${(counter += 1)}`;
    const store = useSendToAgentStore.getState();
    expect(store.requestIdFor("k", "args", newId)).toBe("request-1");
    expect(store.requestIdFor("k", "args", newId)).toBe("request-1");
  });

  it("a changed note gets a new request id", () => {
    let counter = 0;
    const newId = () => `request-${(counter += 1)}`;
    const store = useSendToAgentStore.getState();
    store.requestIdFor("k", "note one", newId);
    expect(store.requestIdFor("k", "note two", newId)).toBe("request-2");
  });

  it("settling a send clears the pending id, the panel and the note", () => {
    const store = useSendToAgentStore.getState();
    store.setNote("k", "note");
    store.requestIdFor("k", "args", () => "request-1");
    store.rememberPanel("k", ThreadId.make("panel"));
    store.settle("k");
    const after = useSendToAgentStore.getState();
    expect(after.notes["k"]).toBeUndefined();
    expect(after.pending["k"]).toBeUndefined();
    expect(after.panelFor("k")).toBeNull();
    expect(after.requestIdFor("k", "args", () => "request-2")).toBe("request-2");
  });
});
