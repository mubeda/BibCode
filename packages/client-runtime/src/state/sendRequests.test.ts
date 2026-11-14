import type { SendRequest } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";

import { applySendRequestsEvent } from "./sendRequests.ts";

function request(id: string, createdAt: string, overrides: Partial<SendRequest> = {}): SendRequest {
  return {
    requestId: id,
    projectId: "project-1",
    action: "message",
    source: "thread:source",
    sourceThreadId: "source",
    target: "thread:target",
    targetThreadId: "target",
    takenOver: null,
    targetMessageId: null,
    state: "queued",
    reason: null,
    answerMessageId: null,
    answeringTurnId: null,
    createdAt,
    updatedAt: createdAt,
    dismissedAt: null,
    ...overrides,
  } as SendRequest;
}

const ids = (list: ReadonlyArray<SendRequest>) => list.map((entry) => entry.requestId);

describe("applySendRequestsEvent", () => {
  it("a snapshot replaces the list", () => {
    const current = [request("old", "2026-11-01T00:00:00.000Z")];
    const next = applySendRequestsEvent(current, {
      type: "snapshot",
      requests: [request("a", "2026-11-02T00:00:00.000Z")],
    });
    expect(ids(next)).toEqual(["a"]);
  });

  it("a page adds its requests to the snapshot and keeps newest first", () => {
    const snapshot = applySendRequestsEvent([], {
      type: "snapshot",
      requests: [request("b", "2026-11-02T00:00:00.000Z")],
    });
    const next = applySendRequestsEvent(snapshot, {
      type: "page",
      requests: [
        request("c", "2026-11-03T00:00:00.000Z"),
        request("a", "2026-11-01T00:00:00.000Z"),
      ],
    });
    expect(ids(next)).toEqual(["c", "b", "a"]);
  });

  it("a snapshot received after pages replaces everything", () => {
    const paged = applySendRequestsEvent([request("a", "2026-11-01T00:00:00.000Z")], {
      type: "page",
      requests: [request("b", "2026-11-02T00:00:00.000Z")],
    });
    const next = applySendRequestsEvent(paged, {
      type: "snapshot",
      requests: [request("c", "2026-11-03T00:00:00.000Z")],
    });
    expect(ids(next)).toEqual(["c"]);
  });

  it("a page arriving after an update does not roll the row back", () => {
    const updated = request("a", "2026-11-01T00:00:00.000Z", {
      state: "read",
      updatedAt: "2026-11-01T00:05:00.000Z",
    });
    const next = applySendRequestsEvent([updated], {
      type: "page",
      requests: [request("a", "2026-11-01T00:00:00.000Z")],
    });
    expect(next).toHaveLength(1);
    expect(next[0]?.state).toBe("read");
  });

  it("a page arriving after a dismissal does not bring the request back", () => {
    const dismissed = request("a", "2026-11-01T00:00:00.000Z", {
      updatedAt: "2026-11-01T00:05:00.000Z",
      dismissedAt: "2026-11-01T00:05:00.000Z",
    });
    const next = applySendRequestsEvent([dismissed], {
      type: "page",
      requests: [request("a", "2026-11-01T00:00:00.000Z")],
    });
    expect(next[0]?.dismissedAt).not.toBeNull();
  });

  it("an upsert replaces the request with the same id and keeps newest first", () => {
    const current = [
      request("b", "2026-11-02T00:00:00.000Z"),
      request("a", "2026-11-01T00:00:00.000Z"),
    ];
    const next = applySendRequestsEvent(current, {
      type: "upsert",
      request: request("a", "2026-11-01T00:00:00.000Z", {
        state: "waiting",
        updatedAt: "2026-11-01T00:01:00.000Z",
      }),
    });
    expect(ids(next)).toEqual(["b", "a"]);
    expect(next[1]?.state).toBe("waiting");
  });

  it("a remove drops only that request", () => {
    const current = [
      request("b", "2026-11-02T00:00:00.000Z"),
      request("a", "2026-11-01T00:00:00.000Z"),
    ];
    expect(ids(applySendRequestsEvent(current, { type: "remove", requestId: "b" }))).toEqual(["a"]);
  });

  it("an upsert of an unknown request adds it", () => {
    const next = applySendRequestsEvent([], {
      type: "upsert",
      request: request("z", "2026-11-04T00:00:00.000Z"),
    });
    expect(ids(next)).toEqual(["z"]);
  });

  describe("timestamps of variable fractional precision", () => {
    // The server trims trailing zeros, so ".1Z" is the earlier instant and sorts after ".11Z".
    const earlier = "2026-11-14T00:00:00.1Z";
    const later = "2026-11-14T00:00:00.11Z";

    it("a dismissal a hundredth of a second later replaces the queued row", () => {
      const current = [request("a", earlier)];
      const next = applySendRequestsEvent(current, {
        type: "upsert",
        request: request("a", earlier, { updatedAt: later, dismissedAt: later }),
      });
      expect(next[0]?.dismissedAt).toBe(later);
    });

    it("an older queued page does not revive a dismissed row", () => {
      const current = [request("a", earlier, { updatedAt: later, dismissedAt: later })];
      const next = applySendRequestsEvent(current, {
        type: "page",
        requests: [request("a", earlier)],
      });
      expect(next[0]?.dismissedAt).toBe(later);
    });

    it("the later instant sorts first even when its text sorts earlier", () => {
      const next = applySendRequestsEvent([], {
        type: "snapshot",
        requests: [request("old", "2026-11-14T00:00:00.1Z"), request("new", later)],
      });
      expect(ids(next)).toEqual(["new", "old"]);
    });

    it("an equal instant written with another precision lets the incoming row win", () => {
      const current = [request("a", "2026-11-14T00:00:00.5Z", { state: "queued" })];
      const next = applySendRequestsEvent(current, {
        type: "upsert",
        request: request("a", "2026-11-14T00:00:00.5Z", {
          state: "waiting",
          updatedAt: "2026-11-14T00:00:00.500Z",
        }),
      });
      expect(next[0]?.state).toBe("waiting");
    });
  });
});
