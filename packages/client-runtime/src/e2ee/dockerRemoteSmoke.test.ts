// Opt-in cross-container boundary test. The server and client are started by
// docs/superpowers/plans/2026-08-28-remote-server-stabilization.md.
// @effect-diagnostics globalFetch:off - Every request targets the explicit Docker server URL.
import {
  AuthAccessTokenResult,
  AuthAccessTokenType,
  AuthBrowserSessionResult,
  AuthClientSession,
  AuthClientSessionRevokeResult,
  AuthEnvironmentBootstrapTokenType,
  AuthPairingOfferResult,
  AuthSessionState,
  AuthShareStateResult,
  AuthTokenExchangeGrantType,
  E2eeAuthenticatedMessage,
  ExecutionEnvironmentDescriptor,
  RemoteUpdateInstallError,
  RemoteUpdateSnapshot,
} from "@bibcode/contracts";
import { parsePairingCode } from "@bibcode/shared/pairingCode";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { decodeBase64UrlKey } from "./noise.ts";
import {
  type EncryptedTestSocket,
  openEncryptedTestSocket,
  requestTestRpc,
} from "./testSupport.ts";

const serverUrl = process.env["BIBCODE_DOCKER_SERVER_URL"];
const adminCredential = process.env["BIBCODE_DOCKER_ADMIN_CREDENTIAL"];

const decodeAccessToken = Schema.decodeUnknownSync(AuthAccessTokenResult);
const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const decodeE2eeAuthenticated = Schema.decodeUnknownSync(E2eeAuthenticatedMessage);
const decodeRevoke = Schema.decodeUnknownSync(AuthClientSessionRevokeResult);
const decodeShareState = Schema.decodeUnknownSync(AuthShareStateResult);
const decodeUpdateInstallError = Schema.decodeUnknownSync(RemoteUpdateInstallError);
const decodeUpdateSnapshot = Schema.decodeUnknownSync(RemoteUpdateSnapshot);
const decodeBrowserSession = Schema.decodeUnknownSync(Schema.toCodecJson(AuthBrowserSessionResult));
const decodeClientSessions = Schema.decodeUnknownSync(
  Schema.toCodecJson(Schema.Array(AuthClientSession)),
);
const decodePairingOffer = Schema.decodeUnknownSync(Schema.toCodecJson(AuthPairingOfferResult));
const decodeSession = Schema.decodeUnknownSync(Schema.toCodecJson(AuthSessionState));

const RpcSuccess = Schema.TaggedStruct("Exit", {
  requestId: Schema.String,
  exit: Schema.TaggedStruct("Success", {
    value: Schema.Unknown,
  }),
});
const RpcFailure = Schema.TaggedStruct("Exit", {
  requestId: Schema.String,
  exit: Schema.TaggedStruct("Failure", {
    cause: Schema.Array(
      Schema.TaggedStruct("Fail", {
        error: Schema.Unknown,
      }),
    ),
  }),
});
const decodeRpcSuccess = Schema.decodeUnknownSync(RpcSuccess);
const decodeRpcFailure = Schema.decodeUnknownSync(RpcFailure);

async function fetchJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${serverUrl!}${path}`, init);
  const body: unknown = await response.json();
  expect(response.ok, `${response.status} ${JSON.stringify(body)}`).toBe(true);
  return body;
}

async function exchangeAdministrativeCredential(): Promise<string> {
  const access = decodeAccessToken(
    await fetchJson("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: AuthTokenExchangeGrantType,
        subject_token: adminCredential!,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        client_label: "docker-administrator",
      }),
    }),
  );
  expect(access.scope).toContain("access:write");

  const session = decodeSession(
    await fetchJson("/api/auth/session", {
      headers: { authorization: `Bearer ${access.access_token}` },
    }),
  );
  expect(session).toMatchObject({
    authenticated: true,
    sessionMethod: "bearer-access-token",
  });
  return access.access_token;
}

async function createOffHostOffer(administrator: string, label: string) {
  const offer = decodePairingOffer(
    await fetchJson("/api/auth/pairing-offer", {
      method: "POST",
      headers: {
        authorization: `Bearer ${administrator}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: label,
        label,
        endpoint: serverUrl,
        reach: "another-device",
      }),
    }),
  );
  const payload = parsePairingCode(offer.code);
  expect(payload).toMatchObject({ endpoint: serverUrl, name: label, reach: "another-device" });
  return payload;
}

async function assertDescriptor(): Promise<void> {
  const descriptor = decodeDescriptor(await fetchJson("/.well-known/bibcode/environment"));
  expect(descriptor.capabilities.remoteUpdateControl).toBe(true);
  expect(descriptor.remoteProtocolVersion).toBeGreaterThanOrEqual(1);
  expect(descriptor.remoteUpdateSupport).toEqual({
    installMode: "manual",
    reason: "manual-update-required",
  });
}

async function assertRemoteUpdateRpc(channel: EncryptedTestSocket): Promise<void> {
  for (const [requestId, tag] of [
    ["1", "updater.status"],
    ["2", "updater.check"],
  ] as const) {
    const response = decodeRpcSuccess(await requestTestRpc(channel, requestId, tag));
    expect(response.requestId).toBe(requestId);
    expect(decodeUpdateSnapshot(response.exit.value)).toMatchObject({
      state: "idle",
      support: { installMode: "manual", reason: "manual-update-required" },
    });
  }

  const install = decodeRpcFailure(await requestTestRpc(channel, "3", "updater.install"));
  expect(install.requestId).toBe("3");
  expect(install.exit.cause).toHaveLength(1);
  expect(decodeUpdateInstallError(install.exit.cause[0]!.error)).toMatchObject({
    _tag: "RemoteUpdateInstallError",
    code: "remote_update_manual_required",
  });
}

async function shareState(administrator: string) {
  return decodeShareState(
    await fetchJson("/api/auth/share-state", {
      headers: { authorization: `Bearer ${administrator}` },
    }),
  );
}

async function revokeClient(administrator: string, sessionId: string): Promise<void> {
  const revoked = decodeRevoke(
    await fetchJson("/api/auth/clients/revoke", {
      method: "POST",
      headers: {
        authorization: `Bearer ${administrator}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId }),
    }),
  );
  expect(revoked.revoked).toBe(true);
}

async function assertBrowserPairingRetainsAndRevokesExposure(
  administrator: string,
  e2eeLabel: string,
): Promise<void> {
  const browserLabel = "docker-browser";
  const browserPayload = await createOffHostOffer(administrator, browserLabel);
  const browser = decodeBrowserSession(
    await fetchJson("/api/auth/browser-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: browserPayload.token }),
    }),
  );
  expect(browser.sessionMethod).toBe("browser-session-cookie");
  expect(await shareState(administrator)).toMatchObject({
    desiredExposure: "wide",
    offHostGrantCount: 2,
  });

  const sessions = decodeClientSessions(
    await fetchJson("/api/auth/clients", {
      headers: { authorization: `Bearer ${administrator}` },
    }),
  );
  const e2eeSession = sessions.find((session) => session.client.label === e2eeLabel);
  const browserSession = sessions.find(
    (session) =>
      session.client.label === browserLabel && session.method === "browser-session-cookie",
  );
  expect(e2eeSession).toBeDefined();
  expect(browserSession).toBeDefined();

  await revokeClient(administrator, e2eeSession!.sessionId);
  expect(await shareState(administrator)).toMatchObject({
    desiredExposure: "wide",
    offHostGrantCount: 1,
  });

  await revokeClient(administrator, browserSession!.sessionId);
  expect(await shareState(administrator)).toEqual({
    desiredExposure: "loopback",
    offHostGrantCount: 0,
    legacyGrantCount: 0,
  });
}

describe.skipIf(serverUrl === undefined || adminCredential === undefined)(
  "remote server Docker boundary",
  () => {
    it("pairs, runs E2EE RPC, retains browser exposure, updates, and revokes", async () => {
      await assertDescriptor();
      const administrator = await exchangeAdministrativeCredential();
      const e2eeLabel = "docker-e2ee";
      const payload = await createOffHostOffer(administrator, e2eeLabel);
      const channel = await openEncryptedTestSocket(
        serverUrl!,
        decodeBase64UrlKey(payload.hostKey),
      );
      channel.sendMessage(JSON.stringify({ type: "e2ee_auth", pairing: payload.token }));
      const authenticated = decodeE2eeAuthenticated(JSON.parse(await channel.nextMessage()));
      expect(authenticated).toMatchObject({
        type: "e2ee_authenticated",
        credential: expect.any(String),
        environmentId: expect.any(String),
        storageInstanceId: payload.storageInstanceId,
      });

      await assertRemoteUpdateRpc(channel);
      channel.close();
      await assertBrowserPairingRetainsAndRevokesExposure(administrator, e2eeLabel);
    }, 60_000);
  },
);
