import { describe, expect, it } from "vite-plus/test";
import { newerObservedAt, shownCopy } from "./snapshotDisplay.logic";

describe("newerObservedAt", () => {
  it("accepts the first copy and a later copy, and rejects an older one", () => {
    expect(newerObservedAt(null, 10)).toBe(true);
    expect(newerObservedAt(10, 11)).toBe(true);
    expect(newerObservedAt(11, 10)).toBe(false);
    expect(newerObservedAt(10, 10)).toBe(false);
  });
});

describe("shownCopy", () => {
  const stored = { payload: "stored", observedAt: 100 };
  const now = () => 50_000;

  it("stamps a live page with the newest stored copy, so only a later stored copy replaces it", () => {
    const painted = shownCopy(null, "k", null, { answered: true, row: stored }, now);
    expect(painted?.payload).toBe("stored");
    const live = shownCopy(painted, "k", "live", { answered: true, row: stored }, now);
    expect(live).toMatchObject({ payload: "live", observedAt: 100 });
    const same = { payload: "stored", observedAt: 100 };
    expect(shownCopy(live, "k", "live", { answered: true, row: same }, now)?.payload).toBe("live");
    const later = { payload: "poller", observedAt: 101 };
    expect(shownCopy(live, "k", "live", { answered: true, row: later }, now)?.payload).toBe(
      "poller",
    );
  });

  it("keeps a live page that answered before the snapshot read did", () => {
    const live = shownCopy(null, "k", "live", { answered: false, row: null }, now);
    expect(live?.observedAt).toBe(50_000);
    expect(shownCopy(live, "k", "live", { answered: true, row: stored }, now)?.payload).toBe(
      "live",
    );
  });

  it("drops the copy kept for another key", () => {
    const other = shownCopy(null, "a", "live", null, now);
    expect(shownCopy(other, "b", null, null, now)).toBeNull();
  });

  it("returns the previous copy unchanged when nothing new arrived", () => {
    const live = shownCopy(null, "k", "live", { answered: true, row: stored }, now);
    expect(shownCopy(live, "k", "live", { answered: true, row: stored }, now)).toBe(live);
  });
});
