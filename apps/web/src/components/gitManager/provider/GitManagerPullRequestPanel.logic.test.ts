import { describe, expect, it } from "vite-plus/test";

import {
  createPullRequestAction,
  resolveProviderPanePresentation,
} from "./GitManagerPullRequestPanel.logic";

describe("Git Manager provider pane logic", () => {
  it("starts not loaded and never implies an automatic request", () => {
    expect(
      resolveProviderPanePresentation({
        requested: false,
        pending: false,
        error: null,
        result: null,
      }),
    ).toEqual({
      kind: "not-loaded",
      message: "Pull requests and checks load only when you choose Refresh.",
    });
  });

  it("renders provider unavailability as explanatory content", () => {
    expect(
      resolveProviderPanePresentation({
        requested: true,
        pending: false,
        error: null,
        result: { status: "unavailable", pullRequests: [], checks: [] },
      }),
    ).toEqual({
      kind: "unavailable",
      message: "Pull requests or checks are unavailable for this repository provider.",
    });
  });

  it("keeps provider errors distinct from unavailable capability", () => {
    expect(
      resolveProviderPanePresentation({
        requested: true,
        pending: false,
        error: "Provider CLI failed.",
        result: null,
      }),
    ).toEqual({ kind: "error", message: "Provider CLI failed." });
  });

  it("reuses the existing stacked create-pr action shape", () => {
    expect(createPullRequestAction("action-1")).toEqual({
      actionId: "action-1",
      action: "create_pr",
    });
  });
});
