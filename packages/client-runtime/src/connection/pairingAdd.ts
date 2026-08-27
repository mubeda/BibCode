import { type EnvironmentId, type RemotePairingCodePayload } from "@bibcode/contracts";
import { classifyPairingEndpoint } from "@bibcode/shared/advertisedEndpoint";
import {
  PairingCodeParseError,
  PairingCodeUnsupportedVersionError,
  parsePairingCode,
} from "@bibcode/shared/pairingCode";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { e2eeSocketUrl } from "../authorization/remote.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { deriveWsBaseUrl, normalizeHttpBaseUrl } from "../environment/endpoint.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
} from "./catalog.ts";
import { computeCompatVerdict } from "./compat.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import {
  BearerConnectionTarget,
  type ConnectionAttemptError,
  type PreparedConnection,
} from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";
import { storageIdentityTargetKey } from "./storageIdentity.ts";

export type PairingAddFailureReason =
  | "unreachable"
  | "host-identity-mismatch"
  | "pairing-rejected"
  | "incompatible"
  | "duplicate-storage-identity";

export class PairingAddError extends Schema.TaggedErrorClass<PairingAddError>()("PairingAddError", {
  reason: Schema.Literals([
    "unreachable",
    "host-identity-mismatch",
    "pairing-rejected",
    "incompatible",
    "duplicate-storage-identity",
  ]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export class PairingLoopbackAcknowledgementRequiredError extends Schema.TaggedErrorClass<PairingLoopbackAcknowledgementRequiredError>()(
  "PairingLoopbackAcknowledgementRequiredError",
  { endpoint: Schema.String },
) {
  override get message(): string {
    return "This pairing code points at the host itself. Confirm you reach it through a tunnel (e.g. SSH port forwarding), then try again.";
  }
}

export interface VerifyPairingCodeInput {
  readonly code: string;
  readonly allowLoopbackTunnel?: boolean;
}

const IDENTITY_MISMATCH_DETAIL = "The server behind this endpoint does not match the pairing code.";
const isPairingCodeParseError = Schema.is(PairingCodeParseError);
const isPairingCodeUnsupportedVersionError = Schema.is(PairingCodeUnsupportedVersionError);
const isPairingAddError = Schema.is(PairingAddError);

const classifyAttemptError = (error: ConnectionAttemptError): PairingAddError => {
  if (error._tag === "ConnectionBlockedError" && error.reason === "host-identity") {
    return new PairingAddError({ reason: "host-identity-mismatch", detail: error.detail });
  }
  if (
    error._tag === "ConnectionBlockedError" &&
    (error.reason === "authentication" || error.reason === "permission")
  ) {
    return new PairingAddError({ reason: "pairing-rejected", detail: error.detail });
  }
  return new PairingAddError({ reason: "unreachable", detail: error.detail });
};

const parsePayload = (
  code: string,
): Effect.Effect<
  RemotePairingCodePayload,
  PairingCodeParseError | PairingCodeUnsupportedVersionError
> =>
  Effect.try({
    try: () => parsePairingCode(code),
    catch: (cause) =>
      isPairingCodeUnsupportedVersionError(cause)
        ? cause
        : isPairingCodeParseError(cause)
          ? cause
          : new PairingCodeParseError({ detail: String(cause) }),
  });

export const verifyAndAddPairingCode = Effect.fn(
  "clientRuntime.connection.pairingAdd.verifyAndAddPairingCode",
)(function* (input: VerifyPairingCodeInput) {
  const payload = yield* parsePayload(input.code);

  switch (classifyPairingEndpoint(payload.endpoint)) {
    case "unconnectable":
      return yield* new PairingAddError({
        reason: "unreachable",
        detail: `The pairing endpoint ${payload.endpoint} is not a connectable address.`,
      });
    case "loopback":
      if (input.allowLoopbackTunnel !== true) {
        return yield* new PairingLoopbackAcknowledgementRequiredError({
          endpoint: payload.endpoint,
        });
      }
      break;
    case "private-network":
    case "public":
      break;
  }

  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const identities = yield* Persistence.AcceptedStorageIdentityStore;
  const entries = yield* SubscriptionRef.get(registry.entries);
  for (const entry of entries.values()) {
    const accepted = yield* identities.get(storageIdentityTargetKey(entry.target));
    if (Option.isSome(accepted) && accepted.value === payload.storageInstanceId) {
      return yield* new PairingAddError({
        reason: "duplicate-storage-identity",
        detail: `${entry.target.label} already uses this server's storage identity.`,
      });
    }
  }

  const httpBaseUrl = yield* Effect.try({
    try: () => normalizeHttpBaseUrl(payload.endpoint),
    catch: () =>
      new PairingAddError({
        reason: "unreachable",
        detail: `The pairing endpoint ${payload.endpoint} is not a valid HTTP URL.`,
      }),
  });
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
    Effect.mapError((error) => {
      const mapped = mapRemoteEnvironmentError(error);
      return new PairingAddError({ reason: "unreachable", detail: mapped.message });
    }),
  );

  if (entries.has(descriptor.environmentId)) {
    return yield* new PairingAddError({
      reason: "duplicate-storage-identity",
      detail: `${descriptor.label} is already saved.`,
    });
  }

  const verdict = computeCompatVerdict(descriptor);
  if (verdict.kind === "server-too-old" || verdict.kind === "client-too-old") {
    return yield* new PairingAddError({
      reason: "incompatible",
      detail:
        verdict.kind === "server-too-old"
          ? `${descriptor.label} runs a protocol older than this app supports. Update the server.`
          : `${descriptor.label} requires a newer app. Update this app.`,
    });
  }

  const sessions = yield* RpcSession.RpcSessionFactory;
  const connectionId = `bearer:${descriptor.environmentId}`;
  const target = new BearerConnectionTarget({
    environmentId: descriptor.environmentId,
    label: payload.name,
    connectionId,
  });
  const prepared: PreparedConnection = {
    environmentId: descriptor.environmentId,
    label: payload.name,
    descriptor,
    httpBaseUrl,
    socketUrl: e2eeSocketUrl(deriveWsBaseUrl(httpBaseUrl)),
    httpAuthorization: null,
    e2ee: {
      hostKey: payload.hostKey,
      auth: { kind: "pairing", token: payload.token },
    },
    target,
  };
  const verified = yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* sessions.connect(prepared);
      yield* session.ready;
      const authenticated = yield* session.e2eeAuthenticated;
      if (authenticated === null || authenticated.credential === undefined) {
        return yield* new PairingAddError({
          reason: "pairing-rejected",
          detail: "The host did not return a device credential.",
        });
      }
      if (
        authenticated.storageInstanceId !== payload.storageInstanceId ||
        (authenticated.environmentId !== undefined &&
          authenticated.environmentId !== descriptor.environmentId)
      ) {
        return yield* new PairingAddError({
          reason: "host-identity-mismatch",
          detail: IDENTITY_MISMATCH_DETAIL,
        });
      }
      const config = yield* session.initialConfig;
      if (
        config.environment.environmentId !== descriptor.environmentId ||
        config.environment.storageInstanceId !== payload.storageInstanceId
      ) {
        return yield* new PairingAddError({
          reason: "host-identity-mismatch",
          detail: IDENTITY_MISMATCH_DETAIL,
        });
      }
      return {
        credential: authenticated.credential,
        environmentId: descriptor.environmentId,
        storageInstanceId: authenticated.storageInstanceId,
      };
    }),
  ).pipe(
    Effect.mapError((error) => (isPairingAddError(error) ? error : classifyAttemptError(error))),
  );

  const registration = new BearerConnectionRegistration({
    target,
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: verified.environmentId,
      label: payload.name,
      httpBaseUrl,
      wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
      hostKey: payload.hostKey,
    }),
    credential: new BearerConnectionCredential({ token: verified.credential }),
  });
  yield* registry.register(registration);
  yield* identities.accept({
    targetKey: storageIdentityTargetKey(target),
    storageInstanceId: verified.storageInstanceId,
  });
  return registration.target.environmentId as EnvironmentId;
});
