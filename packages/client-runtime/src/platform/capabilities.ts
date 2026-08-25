import {
  type AuthClientPresentationMetadata,
  type AuthEnvironmentScope,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
} from "@bibcode/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { ConnectionAttemptError } from "../connection/model.ts";

export interface PreparedSshEnvironment {
  readonly bootstrap: DesktopSshEnvironmentBootstrap;
  readonly bearerToken: string;
}

export interface ProvisionedSshEnvironment extends PreparedSshEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly descriptor: ExecutionEnvironmentDescriptor;
}

export interface InspectedSshEnvironment {
  readonly bootstrap: DesktopSshEnvironmentBootstrap;
  readonly descriptor: ExecutionEnvironmentDescriptor;
}

export class CloudSession extends Context.Service<
  CloudSession,
  {
    readonly clerkToken: Effect.Effect<string, ConnectionAttemptError>;
  }
>()("@bibcode/client-runtime/platform/capabilities/CloudSession") {}

export class ClientPresentation extends Context.Service<
  ClientPresentation,
  {
    readonly metadata: AuthClientPresentationMetadata;
    readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  }
>()("@bibcode/client-runtime/platform/capabilities/ClientPresentation") {}

export class PrimaryEnvironmentAuth extends Context.Service<
  PrimaryEnvironmentAuth,
  {
    readonly bearerToken: Effect.Effect<Option.Option<string>, ConnectionAttemptError>;
  }
>()("@bibcode/client-runtime/platform/capabilities/PrimaryEnvironmentAuth") {}

export class SshEnvironmentGateway extends Context.Service<
  SshEnvironmentGateway,
  {
    readonly provision: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<ProvisionedSshEnvironment, ConnectionAttemptError>;
    readonly prepare: (input: {
      readonly connectionId: string;
      readonly expectedEnvironmentId: EnvironmentId;
      readonly target: DesktopSshEnvironmentTarget;
    }) => Effect.Effect<PreparedSshEnvironment, ConnectionAttemptError>;
    /** Establishes host-key-checked transport and reads identity without consuming pairing. */
    readonly inspect: (input: {
      readonly connectionId: string;
      readonly expectedEnvironmentId: EnvironmentId;
      readonly target: DesktopSshEnvironmentTarget;
      readonly hostKeyFingerprint: string | null;
      readonly issuePairingToken: boolean;
      readonly cancellation: AbortSignal;
    }) => Effect.Effect<InspectedSshEnvironment, ConnectionAttemptError>;
    /** Consumes an inspected one-time credential only after identity verification succeeds. */
    readonly exchange: (input: {
      readonly bootstrap: DesktopSshEnvironmentBootstrap;
      readonly pairingToken: string;
    }) => Effect.Effect<string, ConnectionAttemptError>;
    readonly disconnect: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, ConnectionAttemptError>;
  }
>()("@bibcode/client-runtime/platform/capabilities/SshEnvironmentGateway") {}
