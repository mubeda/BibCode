import { describe, expect, it } from "vite-plus/test";

import { removalReachability } from "./_chat.environments.$environmentId_.remove";

describe("environment removal route", () => {
  it("does not treat stopped or setup-required WSL as remotely reachable", () => {
    expect(
      removalReachability({
        phase: "offline",
        targetTag: "UnavailableConnectionTarget",
        detail: "WSL distribution is stopped",
      }),
    ).toBe("stopped");
    expect(
      removalReachability({
        phase: "offline",
        targetTag: "UnavailableConnectionTarget",
        detail: "Server setup required",
      }),
    ).toBe("setup-required");
  });

  it("allows ordinary removal only after a live connection", () => {
    expect(
      removalReachability({
        phase: "connected",
        targetTag: "BearerConnectionTarget",
        detail: null,
      }),
    ).toBe("online");
    expect(
      removalReachability({
        phase: "reconnecting",
        targetTag: "BearerConnectionTarget",
        detail: null,
      }),
    ).toBe("offline");
  });
});
