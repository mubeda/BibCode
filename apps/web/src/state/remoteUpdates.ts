import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@bibcode/contracts";
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
