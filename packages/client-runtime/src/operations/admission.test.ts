import { describe, expect, it } from "@effect/vitest";

import type { SupervisorConnectionState } from "../connection/model.ts";
import {
  EnvironmentMutationBlocked,
  environmentMutationBlockMessage,
  resolveEnvironmentMutationBlockReason,
} from "./admission.ts";

function state(overrides: Partial<SupervisorConnectionState> = {}): SupervisorConnectionState {
  return {
    desired: true,
    network: "online",
    phase: "connected",
    stage: null,
    attempt: 1,
    generation: 4,
    lastFailure: null,
    retryAt: null,
    ...overrides,
  };
}

describe("environment mutation admission", () => {
  it("admits only a connected supervisor with a verified current session", () => {
    expect(
      resolveEnvironmentMutationBlockReason({
        state: state(),
        hasCurrentSession: true,
        hasStoppedBinding: false,
        updatePhase: null,
      }),
    ).toBeNull();
    expect(
      resolveEnvironmentMutationBlockReason({
        state: state(),
        hasCurrentSession: false,
        hasStoppedBinding: false,
        updatePhase: null,
      }),
    ).toBe("offline");
  });

  it.each([
    { phase: "offline" as const, network: "offline" as const, reason: "offline" as const },
    { phase: "available" as const, network: "online" as const, reason: "offline" as const },
    { phase: "connecting" as const, network: "online" as const, reason: "offline" as const },
    { phase: "backoff" as const, network: "online" as const, reason: "offline" as const },
  ])("maps $phase to $reason without queuing", ({ phase, network, reason }) => {
    expect(
      resolveEnvironmentMutationBlockReason({
        state: state({ phase, network }),
        hasCurrentSession: false,
        hasStoppedBinding: false,
        updatePhase: null,
      }),
    ).toBe(reason);
  });

  it("uses typed stopped, authentication, and version reasons", () => {
    expect(
      resolveEnvironmentMutationBlockReason({
        state: state({ phase: "available" }),
        hasCurrentSession: false,
        hasStoppedBinding: true,
        updatePhase: null,
      }),
    ).toBe("stopped");
    expect(
      resolveEnvironmentMutationBlockReason({
        state: state({
          phase: "blocked",
          lastFailure: { _tag: "ConnectionBlockedError", reason: "authentication" } as never,
        }),
        hasCurrentSession: false,
        hasStoppedBinding: false,
        updatePhase: null,
      }),
    ).toBe("authenticationRequired");
    expect(
      resolveEnvironmentMutationBlockReason({
        state: state({
          phase: "blocked",
          lastFailure: { _tag: "ConnectionBlockedError", reason: "version-incompatible" } as never,
        }),
        hasCurrentSession: false,
        hasStoppedBinding: false,
        updatePhase: null,
      }),
    ).toBe("versionIncompatible");
  });

  it.each(["preparing", "prepared", "restarting"] as const)(
    "maps authoritative server update phase %s before connected-session admission",
    (updatePhase) => {
      expect(
        resolveEnvironmentMutationBlockReason({
          state: state(),
          hasCurrentSession: true,
          hasStoppedBinding: false,
          updatePhase,
        }),
      ).toBe("updating");
    },
  );

  it("uses the same privacy-safe reason text at command and UI boundaries", () => {
    expect(new EnvironmentMutationBlocked({ reason: "offline" }).message).toBe(
      environmentMutationBlockMessage("offline"),
    );
    expect(environmentMutationBlockMessage("updating")).toContain("updating");
  });
});
