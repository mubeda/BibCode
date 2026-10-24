import { describe, expect, it } from "vite-plus/test";
import { newerObservedAt, newestCopy, shownCopy } from "./snapshotDisplay.logic";

describe("newestCopy", () => {
  interface Copy {
    readonly name: string;
    readonly state: string;
    readonly revision?: number;
  }
  const live: Copy = { name: "live getChecks", state: "queued", revision: 10 };
  const poller: Copy = { name: "poller row", state: "running", revision: 12 };

  it("keeps the higher revision in both completion orders", () => {
    // An older live getChecks answering after a newer poller row must not
    // turn running back into queued, and the reverse order agrees.
    expect(newestCopy([live, null, poller])).toBe(poller);
    expect(newestCopy([poller, live])).toBe(poller);
    expect(newestCopy([{ ...live, revision: 13 }, poller])?.state).toBe("queued");
  });

  it("ignores missing candidates and ranks an unstamped copy below a stamped one", () => {
    expect(newestCopy([null, undefined])).toBeNull();
    const unstamped: Copy = { name: "older build's checks row", state: "success" };
    expect(newestCopy([unstamped, poller])).toBe(poller);
    expect(newestCopy([poller, unstamped])).toBe(poller);
  });

  it("falls back to the first candidate present when no copy has a revision", () => {
    const liveOnly: Copy = { name: "live", state: "success" };
    const stored: Copy = { name: "stored", state: "running" };
    expect(newestCopy([liveOnly, stored])).toBe(liveOnly);
    expect(newestCopy([null, stored])).toBe(stored);
  });
});

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
