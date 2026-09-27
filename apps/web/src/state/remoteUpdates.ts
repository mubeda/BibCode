import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@bibcode/contracts";
import type { RemoteUpdateRunState } from "@bibcode/client-runtime/state/remoteUpdateCoordinator";
import {
  IDLE_REMOTE_UPDATE_CHECK_STATE,
  type RemoteUpdateCheckState,
  createRemoteUpdateEnvironmentAtoms,
} from "@bibcode/client-runtime/state/remoteUpdates";
import { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const remoteUpdateEnvironment = createRemoteUpdateEnvironmentAtoms(connectionAtomRuntime);

const IDLE_CHECK_STATE_ATOM = Atom.make(IDLE_REMOTE_UPDATE_CHECK_STATE).pipe(
  Atom.withLabel("web-remote-update-check:idle"),
);

const NO_RUN_ATOM = Atom.make<RemoteUpdateRunState | null>(null).pipe(
  Atom.withLabel("web-remote-update-run:none"),
);

/** Update-check progress and failure for one environment; idle without one. */
export function useRemoteUpdateCheckState(
  environmentId: EnvironmentId | null,
): RemoteUpdateCheckState {
  return useAtomValue(
    environmentId === null
      ? IDLE_CHECK_STATE_ATOM
      : remoteUpdateEnvironment.checkState(environmentId),
  );
}

/** The environment's update run, whichever view started it; null without one. */
export function useRemoteUpdateRun(
  environmentId: EnvironmentId | null,
): RemoteUpdateRunState | null {
  return useAtomValue(
    environmentId === null ? NO_RUN_ATOM : remoteUpdateEnvironment.run(environmentId),
  );
}
