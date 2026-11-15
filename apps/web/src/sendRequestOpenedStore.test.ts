// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useSendRequestOpenedStore } from "./sendRequestOpenedStore";

beforeEach(() => {
  useSendRequestOpenedStore.setState({ openedIds: [] });
  window.localStorage.clear();
});

describe("sendRequestOpenedStore", () => {
  it("an opened id survives a reload of the store", async () => {
    useSendRequestOpenedStore.getState().markOpened("request-1");
    useSendRequestOpenedStore.getState().markOpened("request-1");
    const stored = window.localStorage.getItem("bibcode:send-request-opened:v1")!;
    expect(JSON.parse(stored).state).toEqual({ openedIds: ["request-1"] });
    // A reload starts with an empty store and the stored text.
    useSendRequestOpenedStore.setState({ openedIds: [] });
    window.localStorage.setItem("bibcode:send-request-opened:v1", stored);
    await useSendRequestOpenedStore.persist.rehydrate();
    expect(useSendRequestOpenedStore.getState().openedIds).toEqual(["request-1"]);
  });

  it("keepOnly drops ids that no request has any more", () => {
    const store = useSendRequestOpenedStore.getState();
    store.markOpened("request-1");
    store.markOpened("request-2");
    useSendRequestOpenedStore.getState().keepOnly(["request-2", "request-3"]);
    expect(useSendRequestOpenedStore.getState().openedIds).toEqual(["request-2"]);
  });
});
