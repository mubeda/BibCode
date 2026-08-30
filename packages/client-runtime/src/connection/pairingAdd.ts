import { type EnvironmentId, type RemotePairingCodePayload, WS_METHODS } from "@bibcode/contracts";
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
  | "duplicate-storage-identity"
  | "local-persistence-failed";

export class PairingAddError extends Schema.TaggedErrorClass<PairingAddError>()("PairingAddError", {
  reason: Schema.Literals([
    "unreachable",
    "host-identity-mismatch",
    "pairing-rejected",
    "incompatible",
    "duplicate-storage-identity",
    "local-persistence-failed",
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
const POST_BOOTSTRAP_IDENTITY_MISMATCH_DETAIL = IDENTITY_MISMATCH_DETAIL;
const postBootstrapPersistenceError = (target: string): PairingAddError =>
  new PairingAddError({
    reason: "local-persistence-failed",
    detail: `The device credential was created, but ${target} could not be saved locally.`,
  });
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
  return yield* Effect.scoped(
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
          detail: POST_BOOTSTRAP_IDENTITY_MISMATCH_DETAIL,
        });
      }
      const config = yield* session.initialConfig;
      if (
        config.environment.environmentId !== descriptor.environmentId ||
        config.environment.storageInstanceId !== payload.storageInstanceId
      ) {
        return yield* new PairingAddError({
          reason: "host-identity-mismatch",
          detail: POST_BOOTSTRAP_IDENTITY_MISMATCH_DETAIL,
        });
      }
      const verified = {
        credential: authenticated.credential,
        environmentId: descriptor.environmentId,
        storageInstanceId: authenticated.storageInstanceId,
      };
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
      const identity = {
        targetKey: storageIdentityTargetKey(target),
        storageInstanceId: verified.storageInstanceId,
      };
      let registrationWritten = false;
      let identityWritten = false;
      let previousStorageInstanceId: string | null = null;
      let addCompleted = false;
      let cleanupCompleted = false;

      const rollbackLocalWrites = () => {
        return Effect.gen(function* () {
          const cleanupFailures: string[] = [];
          if (identityWritten) {
            const failure = yield* identities
              .rollbackAcceptance(identity, previousStorageInstanceId)
              .pipe(
                Effect.match({
                  onFailure: (cause) => `identity cleanup failed: ${cause.message}`,
                  onSuccess: () => null,
                }),
              );
            if (failure !== null) cleanupFailures.push(failure);
          }
          if (registrationWritten) {
            const failure = yield* registry.rollbackRegistration(registration).pipe(
              Effect.match({
                onFailure: (cause) => `registration cleanup failed: ${cause.message}`,
                onSuccess: () => null,
              }),
            );
            if (failure !== null) cleanupFailures.push(failure);
          }
          cleanupCompleted = true;
          return cleanupFailures;
        });
      };

      const persistAndConfirm = Effect.gen(function* () {
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* registry
              .register(registration)
              .pipe(Effect.mapError(() => postBootstrapPersistenceError("the server connection")));
            registrationWritten = true;
          }),
        );
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            previousStorageInstanceId = yield* identities
              .transition(identity.targetKey, (currentStorageInstanceId) => ({
                result: currentStorageInstanceId,
                mutation: {
                  _tag: "Set" as const,
                  storageInstanceId: identity.storageInstanceId,
                },
              }))
              .pipe(Effect.mapError(() => postBootstrapPersistenceError("the server identity")));
            identityWritten = true;
          }),
        );
        if (authenticated.pairingConfirmationRequired === true) {
          yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              yield* restore(session.client[WS_METHODS.authConfirmPairing]({})).pipe(
                Effect.mapError(
                  (error) =>
                    new PairingAddError({
                      reason: "local-persistence-failed",
                      detail: `The local connection was saved, but the server could not confirm pairing: ${error.message}`,
                    }),
                ),
              );
              addCompleted = true;
            }),
          );
        } else {
          addCompleted = true;
        }
        return registration.target.environmentId as EnvironmentId;
      });

      return yield* persistAndConfirm.pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const cleanupFailures = yield* rollbackLocalWrites();
            const cleanupDetail =
              cleanupFailures.length === 0
                ? " No partial local writes from this attempt remain."
                : ` Local cleanup also failed: ${cleanupFailures.join("; ")}.`;
            return yield* new PairingAddError({
              reason: "local-persistence-failed",
              detail: `${error.detail}${cleanupDetail}`,
            });
          }),
        ),
        Effect.ensuring(
          Effect.suspend(() =>
            addCompleted || cleanupCompleted
              ? Effect.void
              : rollbackLocalWrites().pipe(Effect.ignore),
          ),
        ),
      );
    }),
  ).pipe(
    Effect.mapError((error) => (isPairingAddError(error) ? error : classifyAttemptError(error))),
  );
});
