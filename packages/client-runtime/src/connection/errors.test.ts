import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@bibcode/contracts";

import {
  credentialMissingError,
  environmentMismatchError,
  mapRemoteEnvironmentError,
  profileMissingError,
} from "./errors.ts";

describe("connection error mapping", () => {
  it("describes missing profiles, credentials, and mismatched environments", () => {
    expect(profileMissingError("profile-1")).toMatchObject({
      reason: "configuration",
      detail: "Connection profile profile-1 is unavailable.",
    });
    expect(credentialMissingError("credential-1")).toMatchObject({
      reason: "authentication",
      detail: "Connection credential credential-1 is unavailable.",
    });
    expect(
      environmentMismatchError({
        expected: EnvironmentId.make("environment-1"),
        actual: EnvironmentId.make("environment-2"),
      }),
    ).toMatchObject({
      reason: "configuration",
      detail: "Connected environment environment-2 does not match environment-1.",
    });
  });

  it("maps every remote environment authorization failure", () => {
    const cases = [
      ["EnvironmentAuthInvalidError", "authentication"],
      ["EnvironmentScopeRequiredError", "permission"],
      ["EnvironmentOperationForbiddenError", "permission"],
      ["EnvironmentRequestInvalidError", "configuration"],
      ["RemoteEnvironmentAuthTimeoutError", "timeout"],
      ["RemoteEnvironmentAuthFetchError", "network"],
      ["EnvironmentInternalError", "remote-unavailable"],
      ["RemoteEnvironmentAuthInvalidJsonError", "remote-unavailable"],
      ["RemoteEnvironmentAuthUndeclaredStatusError", "remote-unavailable"],
    ] as const;

    for (const [tag, reason] of cases) {
      const mapped = mapRemoteEnvironmentError({
        _tag: tag,
        message: `detail:${tag}`,
        traceId: "trace-1",
      } as never);
      expect(mapped.reason).toBe(reason);
      if (tag.startsWith("RemoteEnvironmentAuth")) {
        expect(mapped.detail).toBe(`detail:${tag}`);
      }
    }
  });
});
