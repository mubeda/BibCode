import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { remoteHttpClientLayer } from "../rpc/http.ts";
import * as RemoteEnvironmentAuthorization from "./service.ts";

const ENVIRONMENT_ID = EnvironmentId.make("00000000-0000-4000-8000-000000000041");
const DESCRIPTOR = {
  environmentId: ENVIRONMENT_ID,
  label: "Direct environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  storageInstanceId: "00000000-0000-4000-8000-000000000042",
  protocol: { minimum: 1, maximum: 1 },
  capabilities: {
    repositoryIdentity: true,
    worktreeCatalog: false,
    worktreeCatalogRefreshReason: false,
    vcsStatusSummary: false,
    activityProtocolVersion: null,
  },
} satisfies ExecutionEnvironmentDescriptor;

function recordedFetch(responses: ReadonlyArray<Response>) {
  const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
  let responseIndex = 0;
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    const response = responses[responseIndex++];
    return response === undefined
      ? Promise.reject(new Error(`Unexpected fetch call to ${String(input)}`))
      : Promise.resolve(response);
  }) satisfies typeof fetch;
  return { calls, fetchFn };
}

const websocketTicket = () =>
  Response.json({
    ticket: "ticket-1",
    expiresAt: "2026-08-26T12:00:00.000Z",
  });

describe("RemoteEnvironmentAuthorization", () => {
  it.effect("authorizes an identity-checked direct bearer route", () => {
    const fetch = recordedFetch([Response.json(DESCRIPTOR), websocketTicket()]);
    return Effect.gen(function* () {
      const authorization = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
      const result = yield* authorization.authorizeBearer({
        expectedEnvironmentId: ENVIRONMENT_ID,
        httpBaseUrl: "https://environment.example.test",
        wsBaseUrl: "wss://environment.example.test",
        bearerToken: "paired-administrator-session",
      });

      expect(result.descriptor).toEqual(DESCRIPTOR);
      expect(result.httpAuthorization).toEqual({
        _tag: "Bearer",
        token: "paired-administrator-session",
      });
      expect(result.socketUrl).toContain("wsTicket=ticket-1");
      expect(fetch.calls.map(([input]) => String(input))).toEqual([
        "https://environment.example.test/.well-known/bibcode/environment",
        "https://environment.example.test/api/auth/websocket-ticket",
      ]);
    }).pipe(
      Effect.provide(
        RemoteEnvironmentAuthorization.layer.pipe(
          Layer.provide(remoteHttpClientLayer(fetch.fetchFn)),
        ),
      ),
    );
  });

  it.effect("does not refetch an already transport-verified descriptor", () => {
    const fetch = recordedFetch([websocketTicket()]);
    return Effect.gen(function* () {
      const authorization = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
      const result = yield* authorization.authorizeVerifiedBearer({
        identity: {
          routeId: "https:direct",
          environmentId: ENVIRONMENT_ID,
          storageInstanceId: DESCRIPTOR.storageInstanceId,
          descriptor: DESCRIPTOR,
          transportTrust: "system-tls",
        },
        httpBaseUrl: "https://environment.example.test",
        wsBaseUrl: "wss://environment.example.test",
        bearerToken: "paired-administrator-session",
      });

      expect(result.descriptor).toEqual(DESCRIPTOR);
      expect(fetch.calls).toHaveLength(1);
    }).pipe(
      Effect.provide(
        RemoteEnvironmentAuthorization.layer.pipe(
          Layer.provide(remoteHttpClientLayer(fetch.fetchFn)),
        ),
      ),
    );
  });
});
