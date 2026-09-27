import {
  type GitCancelCloneInput,
  type GitCancelCloneResult,
  type GitCloneResult,
  WS_METHODS,
} from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/unstable/rpc";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { currentSession, EnvironmentRpcUnavailableError, requestInSession } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";

/** Where a clone stands, reported to the dialog. */
export interface VcsCloneProgress {
  readonly phase: "cloning" | "reconnecting";
  /**
   * The server keeps the clone across reconnects (`vcsCloneReattach`). Cancel and close must
   * then send `vcs.cancelClone`; an abort alone only stops following the clone.
   */
  readonly reattach: boolean;
}

export interface VcsCloneCommandInput {
  readonly url: string;
  readonly parentDir: string;
  readonly directoryName?: string | undefined;
  readonly onProgress?: ((progress: VcsCloneProgress) => void) | undefined;
}

/** The client stopped following a clone; the clone may still run on the server. */
export class VcsCloneStoppedError extends Schema.TaggedError<VcsCloneStoppedError>()(
  "VcsCloneStoppedError",
  {
    environmentId: Schema.String,
    reason: Schema.Literals(["environment-unavailable", "reattach-unsupported"]),
    message: Schema.String,
  },
) {}

const isRpcClientError = Schema.is(RpcClientError.RpcClientError);
const isEnvironmentRpcUnavailableError = Schema.is(EnvironmentRpcUnavailableError);

/**
 * The connection went away before the server answered: an RPC transport error, no session,
 * or the interrupt Effect's RPC client resumes a pending call with when its socket closes.
 * A server answer (any typed failure) is never a transport loss.
 */
export function isCloneTransportLoss(cause: Cause.Cause<unknown>): boolean {
  return (
    cause.reasons.length > 0 &&
    cause.reasons.every(
      (reason) =>
        Cause.isInterruptReason(reason) ||
        (Cause.isFailReason(reason) &&
          (isRpcClientError(reason.error) || isEnvironmentRpcUnavailableError(reason.error))),
    )
  );
}

type NextSession =
  | {
      readonly _tag: "Session";
      readonly session: RpcSession;
      /** The supervisor that owns `session`, which the caller then treats as known. */
      readonly supervisor: EnvironmentSupervisor["Service"];
    }
  | { readonly _tag: "Stopped"; readonly label: string };

/**
 * Waits, as `subscribe()` does, for a session other than `lost` on the environment's current
 * supervisor, followed through the registry. The registry replaces a supervisor (a changed
 * platform registration, for example) by retiring it without ever reporting a stop, so the wait
 * moves to the replacement and takes its sessions. Ends as `Stopped` when the environment is
 * blocked, disconnected by the user, or removed from the registry. No attempt limit and no timer.
 *
 * `known` is the supervisor the caller last used; it names the environment. Every supervisor,
 * a replacement included, publishes the registry's connection intent from its first state on, so
 * an undesired state on the current supervisor means the user disconnected.
 *
 * A stop names the environment by its current label: the current supervisor's or, once the
 * environment is removed, the last label the registry published for it.
 */
function nextSession(
  registry: EnvironmentRegistry["Service"],
  known: EnvironmentSupervisor["Service"],
  lost: RpcSession | null,
): Effect.Effect<NextSession> {
  const environmentId = known.target.environmentId;
  let label = known.target.label;
  const onCurrentSupervisor = Stream.unwrap(
    EnvironmentSupervisor.pipe(
      Effect.map((supervisor) =>
        Stream.merge(
          SubscriptionRef.changes(supervisor.session).pipe(
            Stream.filter((current) => Option.isSome(current) && current.value !== lost),
            Stream.map((current): NextSession => ({
              _tag: "Session",
              session: Option.getOrThrow(current),
              supervisor,
            })),
          ),
          SubscriptionRef.changes(supervisor.state).pipe(
            Stream.filter((state) => state.phase === "blocked" || !state.desired),
            Stream.map((): NextSession => ({ _tag: "Stopped", label: supervisor.target.label })),
          ),
        ),
      ),
    ),
  );
  const removed = SubscriptionRef.changes(registry.entries).pipe(
    Stream.filter((entries) => {
      const entry = entries.get(environmentId);
      if (entry === undefined) return true;
      label = entry.target.label;
      return false;
    }),
    Stream.map((): NextSession => ({ _tag: "Stopped", label })),
  );
  return Stream.merge(registry.followStream(environmentId, onCurrentSupervisor), removed).pipe(
    Stream.runHead,
    Effect.map(Option.getOrElse((): NextSession => ({ _tag: "Stopped", label }))),
  );
}

export interface CloneDestinationInput {
  readonly url: string;
  readonly parentDir: string;
  readonly directoryName?: string | undefined;
}

/** The server's leaf rule (`clone_destination_leaf`): `directoryName`, else the URL's last
 * path segment without a trailing `.git`. */
export function cloneDestinationLeaf(url: string, directoryName: string | undefined): string {
  if (directoryName !== undefined) {
    return directoryName;
  }
  const segments = url.replace(/[\\/]+$/, "").split(/[\\/:]/);
  return (segments.at(-1) ?? "repository").replace(/(?:\.git)+$/, "");
}

/**
 * The key that holds a clone behind a pending `vcs.cancelClone`: environment, exact URL, and
 * leaf. The parent folder is left out on purpose. Only the server can canonicalize a host path
 * (`/code`, `/code/.`, `~/code`, `C:\\code` and `C:/code` may all name one folder), and the
 * server cancels a live clone only when its URL matches exactly. So a cancel can stop only a clone
 * of the same URL into the same leaf, and holding every such clone, whatever the parent's
 * spelling, costs at most one cancel round trip.
 */
export function pendingCloneCancelKey(environmentId: string, input: CloneDestinationInput): string {
  return JSON.stringify([
    environmentId,
    input.url,
    cloneDestinationLeaf(input.url, input.directoryName),
  ]);
}

/**
 * `vcs.cancelClone` requests still in flight in this client runtime, by
 * {@link pendingCloneCancelKey}. The server keys a cancel by destination (spec ruling 5), so a
 * cancel that is still retrying could stop a later clone of the same URL into the same folder: such
 * a clone waits here until every earlier cancel has settled. One registry per client runtime (a
 * tab or a desktop window).
 */
const pendingCloneCancels = new Map<string, Set<Promise<void>>>();

/** Records a cancel in flight for this clone. The returned function ends the record. */
export function registerCloneCancel(
  environmentId: string,
  input: CloneDestinationInput,
): () => void {
  const key = pendingCloneCancelKey(environmentId, input);
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const pending = pendingCloneCancels.get(key) ?? new Set<Promise<void>>();
  pending.add(settled);
  pendingCloneCancels.set(key, pending);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pending.delete(settled);
    if (pending.size === 0 && pendingCloneCancels.get(key) === pending) {
      pendingCloneCancels.delete(key);
    }
    settle();
  };
}

const awaitPendingCloneCancels = Effect.fn("Vcs.awaitPendingCloneCancels")(function* (
  environmentId: string,
  input: CloneDestinationInput,
) {
  const key = pendingCloneCancelKey(environmentId, input);
  while (true) {
    const pending = pendingCloneCancels.get(key);
    if (pending === undefined || pending.size === 0) {
      return;
    }
    const snapshot = [...pending];
    yield* Effect.promise(() => Promise.all(snapshot));
  }
});

function cloneFields(input: VcsCloneCommandInput) {
  return {
    url: input.url,
    parentDir: input.parentDir,
    ...(input.directoryName === undefined ? {} : { directoryName: input.directoryName }),
  };
}

/**
 * Clone from URL. Without the capability: today's single call. With it: the server keeps the
 * clone when this socket drops (`detach`), and each later session re-attaches (`attach`) until
 * an outcome, a stopped environment, or a session without the capability.
 */
export const cloneWithReattach = Effect.fn("Vcs.cloneWithReattach")(function* (
  input: VcsCloneCommandInput,
) {
  const registry = yield* EnvironmentRegistry;
  let supervisor = yield* EnvironmentSupervisor;
  const environmentId = supervisor.target.environmentId;
  // A cancel of this URL into this leaf may still be retrying: dispatch nothing until every such
  // earlier cancel has settled, so none of them can stop this clone.
  yield* awaitPendingCloneCancels(environmentId, input);
  // The registry may have replaced the supervisor during that wait, so continue on its current
  // one. A clone started while disconnected still fails at once.
  supervisor = yield* registry.run(environmentId, EnvironmentSupervisor).pipe(
    Effect.catchTag("EnvironmentNotRegisteredError", () =>
      Effect.fail(
        new VcsCloneStoppedError({
          environmentId,
          reason: "environment-unavailable",
          message: `Can't reconnect to ${supervisor.target.label}.`,
        }),
      ),
    ),
  );
  const clone = cloneFields(input);
  let session = yield* currentSession().pipe(
    Effect.provideService(EnvironmentSupervisor, supervisor),
  );
  let attach = false;
  while (true) {
    const config = yield* Effect.exit(session.initialConfig);
    if (Exit.isSuccess(config)) {
      if (config.value.environment.capabilities.vcsCloneReattach !== true) {
        if (attach) {
          return yield* new VcsCloneStoppedError({
            environmentId,
            reason: "reattach-unsupported",
            message: `${supervisor.target.label} can no longer resume this clone.`,
          });
        }
        input.onProgress?.({ phase: "cloning", reattach: false });
        return yield* requestInSession(session, environmentId, WS_METHODS.vcsClone, clone);
      }
      input.onProgress?.({ phase: "cloning", reattach: true });
      const result = yield* Effect.exit(
        requestInSession(session, environmentId, WS_METHODS.vcsClone, {
          ...clone,
          detach: true,
          ...(attach ? { attach: true } : {}),
        }),
      );
      if (Exit.isSuccess(result)) {
        return result.value satisfies GitCloneResult;
      }
      if (!isCloneTransportLoss(result.cause)) {
        return yield* Effect.failCause(result.cause);
      }
    } else if (!attach) {
      return yield* Effect.failCause(config.cause);
    }
    input.onProgress?.({ phase: "reconnecting", reattach: true });
    const next: NextSession = yield* nextSession(registry, supervisor, session);
    if (next._tag === "Stopped") {
      return yield* new VcsCloneStoppedError({
        environmentId,
        reason: "environment-unavailable",
        message: `Can't reconnect to ${next.label}.`,
      });
    }
    supervisor = next.supervisor;
    session = next.session;
    attach = true;
  }
});

/**
 * `vcs.cancelClone`, sent on the current session or, while disconnected, on the next one that
 * advertises `vcsCloneReattach`. It runs on its own command lane because the clone holds the
 * destination's serial lane.
 */
export const cancelCloneOnNextSession = Effect.fn("Vcs.cancelCloneOnNextSession")(function* (
  input: GitCancelCloneInput,
) {
  const registry = yield* EnvironmentRegistry;
  let supervisor = yield* EnvironmentSupervisor;
  const environmentId = supervisor.target.environmentId;
  let lost: RpcSession | null = null;
  while (true) {
    const next: NextSession = yield* nextSession(registry, supervisor, lost);
    if (next._tag === "Stopped") {
      return yield* new VcsCloneStoppedError({
        environmentId,
        reason: "environment-unavailable",
        message: `Can't reconnect to ${next.label}.`,
      });
    }
    supervisor = next.supervisor;
    const config = yield* Effect.exit(next.session.initialConfig);
    if (Exit.isFailure(config)) {
      // A session that failed to configure is as good as lost: wait for the next one.
      lost = next.session;
      continue;
    }
    if (config.value.environment.capabilities.vcsCloneReattach !== true) {
      // A host without re-attach has restarted since the clone began, so the clone is gone;
      // sending the RPC would fail as an unknown method and leave the dialog cancelling.
      return yield* new VcsCloneStoppedError({
        environmentId,
        reason: "reattach-unsupported",
        message: `${supervisor.target.label} can no longer resume or cancel this clone.`,
      });
    }
    const result = yield* Effect.exit(
      requestInSession(next.session, environmentId, WS_METHODS.vcsCancelClone, input),
    );
    if (Exit.isSuccess(result)) {
      return result.value satisfies GitCancelCloneResult;
    }
    if (!isCloneTransportLoss(result.cause)) {
      return yield* Effect.failCause(result.cause);
    }
    lost = next.session;
  }
});
