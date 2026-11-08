import { request, runStream } from "@bibcode/client-runtime/rpc";
import { createGitManagerEnvironmentAtoms } from "@bibcode/client-runtime/state/git-manager";
import {
  runInEnvironment,
  runStreamInEnvironment,
  type AtomCommandResult,
} from "@bibcode/client-runtime/state/runtime";
import {
  WS_METHODS,
  type EnvironmentId,
  type GitManagerOperationEvent,
  type GitManagerOperationRequest,
  type GitSignInInput,
  type GitSignInResult,
} from "@bibcode/contracts";
import { RegistryContext } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { type Atom, type AtomRegistry } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useCallback, useContext } from "react";

import { connectionAtomRuntime } from "../connection/runtime";

export const gitManagerEnvironment = createGitManagerEnvironmentAtoms(connectionAtomRuntime);

export interface GitManagerOperationHandle {
  readonly result: Promise<AtomCommandResult<GitManagerOperationEvent, unknown>>;
  readonly cancel: () => void;
}

/**
 * Runs the operation stream through the environment runtime while exposing an explicit
 * cancellation handle. The RPC stream emits one output chunk per completed Git command.
 */
export function runGitManagerOperation(
  registry: AtomRegistry.AtomRegistry,
  target: {
    readonly environmentId: EnvironmentId;
    readonly input: GitManagerOperationRequest;
  },
  onEvent: (event: GitManagerOperationEvent) => void,
): GitManagerOperationHandle {
  return runAtomUntilSettled(
    registry,
    connectionAtomRuntime.atom(
      runStreamInEnvironment(
        target.environmentId,
        runStream(WS_METHODS.gitManagerRunOperation, target.input),
      ),
    ),
    onEvent,
  );
}

export interface GitSignInHandle {
  readonly result: Promise<AtomCommandResult<GitSignInResult, unknown>>;
  /** Interrupts the request; the server kills the sign-in's Git process and GCM. */
  readonly cancel: () => void;
}

/**
 * Runs `git.signIn` (#325) with an explicit cancellation handle. It sets no client timeout:
 * the server caps a sign-in at 10 minutes.
 */
export function runGitSignIn(
  registry: AtomRegistry.AtomRegistry,
  target: { readonly environmentId: EnvironmentId; readonly input: GitSignInInput },
): GitSignInHandle {
  return runAtomUntilSettled(
    registry,
    connectionAtomRuntime.atom(
      runInEnvironment(target.environmentId, request(WS_METHODS.gitSignIn, target.input)),
    ),
  );
}

/** Mounts `atom` until its effect settles, reporting each new success value to `onValue`. */
function runAtomUntilSettled<A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
  onValue?: (value: A) => void,
): {
  readonly result: Promise<AtomCommandResult<A, unknown>>;
  readonly cancel: () => void;
} {
  let settled = false;
  let unmount: () => void = () => {};
  let unsubscribe: () => void = () => {};
  let settleResult: ((result: AtomCommandResult<A, unknown>) => void) | null = null;
  let lastValue: A | null = null;
  const settle = (result: AtomCommandResult<A, unknown>) => {
    if (settled) return;
    settled = true;
    unsubscribe();
    unmount();
    settleResult?.(result);
  };
  const result = new Promise<AtomCommandResult<A, unknown>>((resolve) => {
    settleResult = resolve;
    try {
      unmount = registry.mount(atom);
      unsubscribe = registry.subscribe(
        atom,
        (emission) => {
          if (emission._tag === "Success" && emission.value !== lastValue) {
            lastValue = emission.value;
            try {
              onValue?.(emission.value);
            } catch {
              // Presentation observers cannot fail or cancel the Git operation.
            }
          }
          if (emission._tag !== "Initial" && !emission.waiting) {
            settle(emission as AtomCommandResult<A, unknown>);
          }
        },
        { immediate: true },
      );
    } catch (defect) {
      settle(AsyncResult.failure(Cause.die(defect)));
    }
  });

  return {
    result,
    cancel: () => settle(AsyncResult.failure(Cause.interrupt())),
  };
}

/** `runGitManagerOperation` bound to the current atom registry. */
export function useRunGitManagerOperation() {
  const registry = useContext(RegistryContext);
  return useCallback(
    (
      target: {
        readonly environmentId: EnvironmentId;
        readonly input: GitManagerOperationRequest;
      },
      onEvent: (event: GitManagerOperationEvent) => void,
    ) => runGitManagerOperation(registry, target, onEvent),
    [registry],
  );
}
