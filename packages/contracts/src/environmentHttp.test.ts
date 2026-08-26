import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import { describe, expect } from "vite-plus/test";

import {
  AuthClientSessionRevokeResult,
  AuthOtherClientSessionsRevokeResult,
  AuthPairingLinkRevokeResult,
  EnvironmentAuthInvalidError,
  EnvironmentHttpCommonError,
  EnvironmentInternalError,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  EnvironmentScopeRequiredError,
} from "./environmentHttp.ts";
import {
  expectDecodeFailure,
  expectEncodeFailure,
  makeInvalidClassInstance,
} from "./test/schemaAssertions.ts";

const commonErrors = [
  new EnvironmentRequestInvalidError({
    code: "invalid_request",
    reason: "invalid_scope",
    traceId: "trace-request",
  }),
  new EnvironmentAuthInvalidError({
    code: "auth_invalid",
    reason: "missing_credential",
    traceId: "trace-auth",
  }),
  new EnvironmentScopeRequiredError({
    code: "insufficient_scope",
    requiredScope: "terminal:operate",
    traceId: "trace-scope",
  }),
  new EnvironmentOperationForbiddenError({
    code: "operation_forbidden",
    reason: "current_session_revoke_not_allowed",
    traceId: "trace-forbidden",
  }),
  new EnvironmentInternalError({
    code: "internal_error",
    reason: "orchestration_dispatch_failed",
    traceId: "trace-internal",
  }),
] as const;

const decodeCommonError = Schema.decodeUnknownSync(EnvironmentHttpCommonError);
const encodeCommonError = Schema.encodeUnknownSync(EnvironmentHttpCommonError);
const decodePairingLinkRevoke = Schema.decodeUnknownSync(AuthPairingLinkRevokeResult);
const decodeClientSessionRevoke = Schema.decodeUnknownSync(AuthClientSessionRevokeResult);
const decodeOtherClientSessionsRevoke = Schema.decodeUnknownSync(
  AuthOtherClientSessionsRevokeResult,
);

describe("environment HTTP errors", () => {
  it("round-trips every common tagged-error alternative", () => {
    for (const error of commonErrors) {
      const encoded = encodeCommonError(error);
      const decoded = decodeCommonError(encoded);
      expect(decoded._tag).toBe(error._tag);
    }
  });

  it.effect("converts every error to its declared HTTP response boundary", () =>
    Effect.gen(function* () {
      const cases = [
        [commonErrors[0], 400],
        [commonErrors[1], 401],
        [commonErrors[2], 403],
        [commonErrors[3], 403],
        [commonErrors[4], 500],
      ] as const;

      for (const [error, expectedStatus] of cases) {
        const response = yield* error[HttpServerRespondable.symbol]();
        assert.strictEqual(response.status, expectedStatus);
        assert.strictEqual(response.body._tag, "Uint8Array");
      }
    }),
  );

  it("reports invalid reasons at the same structured path on decode and encode", () => {
    const invalid = {
      _tag: "EnvironmentRequestInvalidError",
      code: "invalid_request",
      reason: "unknown_reason",
      traceId: "trace-request",
    };
    const expected = {
      rootTag: "AnyOf" as const,
      paths: [["reason"]],
      containsTag: "AnyOf" as const,
    };
    expectDecodeFailure(EnvironmentHttpCommonError, invalid, expected);
    expectEncodeFailure(
      EnvironmentHttpCommonError,
      makeInvalidClassInstance(EnvironmentRequestInvalidError.prototype, invalid),
      expected,
    );
  });
});

describe("environment HTTP result schemas", () => {
  it("round-trips administrator revoke results", () => {
    expect(decodePairingLinkRevoke({ revoked: true }).revoked).toBe(true);
    expect(decodeClientSessionRevoke({ revoked: false }).revoked).toBe(false);
    expect(decodeOtherClientSessionsRevoke({ revokedCount: 2 }).revokedCount).toBe(2);
  });

  it("reports invalid result fields by path", () => {
    const invalid = { revoked: "yes" };
    const expected = {
      rootTag: "Composite" as const,
      paths: [["revoked"]],
      containsTag: "InvalidType" as const,
    };
    expectDecodeFailure(AuthPairingLinkRevokeResult, invalid, expected);
    expectEncodeFailure(AuthPairingLinkRevokeResult, invalid, expected);
  });
});
