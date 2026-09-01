import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@bibcode/client-runtime/connection";
import type { ServerConfig } from "@bibcode/contracts";
import { makeTestExecutionEnvironmentCapabilities } from "@bibcode/shared/testSupport";
import { describe, expect, it } from "vite-plus/test";

import { resolveGitManagerAvailability } from "./gitManagerAvailability";

function connection(overrides: Partial<SupervisorConnectionState>): SupervisorConnectionState {
  return { ...AVAILABLE_CONNECTION_STATE, ...overrides };
}

function serverConfig(gitManagerReads: boolean): ServerConfig {
  return {
    environment: {
      capabilities: makeTestExecutionEnvironmentCapabilities({ gitManagerReads }),
    },
  } as ServerConfig;
}

describe("resolveGitManagerAvailability", () => {
  it("keeps a connected environment pending until its config arrives", () => {
    expect(
      resolveGitManagerAvailability(
        connection({ desired: true, phase: "connected", network: "online" }),
        null,
      ),
    ).toMatchObject({ kind: "pending" });
  });

  it("reports an explicitly disconnected environment without requesting a connection", () => {
    expect(
      resolveGitManagerAvailability(
        connection({ desired: false, phase: "available", network: "online" }),
        serverConfig(true),
      ),
    ).toEqual({
      kind: "disconnected",
      reason: "This environment is disconnected.",
    });
  });

  it("names reconnecting and missing-capability states", () => {
    expect(
      resolveGitManagerAvailability(
        connection({ desired: true, phase: "backoff", network: "online" }),
        serverConfig(true),
      ),
    ).toEqual({
      kind: "disconnected",
      reason: "This environment is reconnecting.",
    });
    expect(
      resolveGitManagerAvailability(
        connection({ desired: true, phase: "connected", network: "online" }),
        serverConfig(false),
      ),
    ).toEqual({ kind: "unsupported", missingCapability: "gitManagerReads" });
  });

  it("is ready only for a connected environment with read support", () => {
    expect(
      resolveGitManagerAvailability(
        connection({ desired: true, phase: "connected", network: "online" }),
        serverConfig(true),
      ),
    ).toEqual({ kind: "ready" });
  });
});
