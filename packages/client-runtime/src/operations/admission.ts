import { UpdateMaintenanceActiveError, type ServerUpdatePhase } from "@bibcode/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { SupervisorConnectionState } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";

export type EnvironmentMutationBlockReason =
  | "offline"
  | "stopped"
  | "authenticationRequired"
  | "versionIncompatible"
  | "updating";

export function environmentMutationBlockMessage(reason: EnvironmentMutationBlockReason): string {
  switch (reason) {
    case "offline":
      return "This environment is offline. Cached data is read-only.";
    case "stopped":
      return "This environment is stopped. Start it before making changes.";
    case "authenticationRequired":
      return "This environment requires authentication before changes are allowed.";
    case "versionIncompatible":
      return "This environment uses an incompatible BiBCode version. Update it before making changes.";
    case "updating":
      return "This environment is updating. Changes will be available after it reconnects.";
  }
}

export class EnvironmentMutationBlocked extends Data.TaggedError("EnvironmentMutationBlocked")<{
  readonly reason: EnvironmentMutationBlockReason;
}> {
  override get message(): string {
    return environmentMutationBlockMessage(this.reason);
  }
}

export function serverUpdateBlocksMutations(phase: ServerUpdatePhase | null): boolean {
  return phase === "preparing" || phase === "prepared" || phase === "restarting";
}

const isUpdateMaintenanceActiveError = Schema.is(UpdateMaintenanceActiveError);

/** Maps the server's authoritative admission failure to the shared client presentation reason. */
export function mapEnvironmentMutationError<E>(error: E): E | EnvironmentMutationBlocked {
  return isUpdateMaintenanceActiveError(error)
    ? new EnvironmentMutationBlocked({ reason: "updating" })
    : error;
}

export function resolveEnvironmentMutationBlockReason(input: {
  readonly state: SupervisorConnectionState;
  readonly hasCurrentSession: boolean;
  readonly hasStoppedBinding: boolean;
  readonly updatePhase: ServerUpdatePhase | null;
}): EnvironmentMutationBlockReason | null {
  if (serverUpdateBlocksMutations(input.updatePhase)) return "updating";
  if (input.state.phase === "connected" && input.hasCurrentSession) return null;
  if (input.hasStoppedBinding) return "stopped";
  if (input.state.lastFailure?.reason === "authentication") return "authenticationRequired";
  if (input.state.lastFailure?.reason === "version-incompatible") {
    return "versionIncompatible";
  }
  return "offline";
}

/** Checks the current supervisor generation immediately before a mutation dispatch. */
export const requireEnvironmentMutationAdmission = Effect.fn(
  "EnvironmentMutationAdmission.require",
)(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const state = yield* SubscriptionRef.get(supervisor.state);
  const session = yield* SubscriptionRef.get(supervisor.session);
  const reason = resolveEnvironmentMutationBlockReason({
    state,
    hasCurrentSession: Option.isSome(session),
    hasStoppedBinding: supervisor.environment.bindings.some(
      (binding) => binding.condition === "stopped",
    ),
    updatePhase: null,
  });
  if (reason !== null) {
    return yield* new EnvironmentMutationBlocked({ reason });
  }
});
