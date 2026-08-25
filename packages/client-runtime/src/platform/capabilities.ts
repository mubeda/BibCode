import {
  type AuthClientPresentationMetadata,
  type AuthEnvironmentScope,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
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
    /** Establishes host-key-checked transport and reads identity without consuming pairing. */
    readonly inspect: (input: {
      readonly target: DesktopSshEnvironmentTarget;
      readonly hostKeyFingerprint: string | null;
      readonly cancellation: AbortSignal;
    }) => Effect.Effect<InspectedSshEnvironment, ConnectionAttemptError>;
    /** Creates and redeems pairing only after the caller accepts the inspected identity. */
    readonly exchange: (
      input: InspectedSshEnvironment,
    ) => Effect.Effect<PreparedSshEnvironment, ConnectionAttemptError>;
    readonly disconnect: (
      target: DesktopSshEnvironmentTarget,
      expectedHostKeyFingerprint: string,
    ) => Effect.Effect<void, ConnectionAttemptError>;
  }
>()("@bibcode/client-runtime/platform/capabilities/SshEnvironmentGateway") {}
